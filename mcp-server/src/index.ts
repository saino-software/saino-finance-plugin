import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
	DB: D1Database;
	MCP: DurableObjectNamespace;
}

type State = {};

const MOVEMENT_STATES = ["TEMPLATE", "PLANNED", "EXECUTED", "VOIDED", "SKIPPED", "FULFILLED"] as const;

// MCP clients (notably Claude Code) JSON-stringify args. z.coerce.boolean uses Boolean(x),
// which makes the string "false" truthy. This helper parses "true"/"false" properly.
const zbool = () => z.preprocess(
	(v) => typeof v === "string" ? v.toLowerCase() === "true" : v,
	z.boolean()
);

export class SainoMCP extends McpAgent<Env, State, {}> {
	server = new McpServer({ name: "Saino Finance", version: "1.2.0" });

	async init() {
		const db = this.env.DB;

		// ─── Accounts ───

		this.server.tool(
			"list_accounts",
			"List all accounts with their current balances",
			{},
			async () => {
				const rows = await db.prepare(`
					SELECT a.id, a.name, at.name as type_name, at.group_name, a.currency_code,
						a.opening_balance, a.is_hidden, a.applies_gmf,
						COALESCE(
							(SELECT SUM(CAST(m.total_amount AS REAL))
							 FROM movements m WHERE m.account_id = a.id AND m.state = 'EXECUTED'),
							0
						) as movements_total
					FROM accounts a
					JOIN account_types at ON a.type_id = at.id
					ORDER BY at.group_name, a.name
				`).all();

				const accounts = rows.results.map((r: any) => ({
					...r,
					balance: (parseFloat(r.opening_balance) + r.movements_total).toString()
				}));

				return { content: [{ type: "text" as const, text: JSON.stringify(accounts, null, 2) }] };
			}
		);

		this.server.tool(
			"create_account",
			"Create a new account",
			{
				name: z.string().describe("Account name (e.g., 'Ahorros BBVA', 'MasterCard Falabella')"),
				typeName: z.string().describe("Account type (e.g., 'Bank Account', 'Credit Card', 'Digital Wallet', 'Cash', 'Loan')"),
				currencyCode: z.string().default("COP").describe("Currency code (COP, USD, EUR)"),
				openingBalance: z.string().default("0").describe("Opening balance"),
				appliesGmf: zbool().default(false).describe("Whether GMF 4x1000 applies"),
				defaultInterestRate: z.string().optional().describe("Annual interest rate for credit cards"),
			},
			async ({ name, typeName, currencyCode, openingBalance, appliesGmf, defaultInterestRate }) => {
				let typeRow: any = await db.prepare("SELECT id FROM account_types WHERE name = ?").bind(typeName).first();
				if (!typeRow) {
					const groupName = inferGroupName(typeName);
					const result = await db.prepare("INSERT INTO account_types (name, group_name) VALUES (?, ?)").bind(typeName, groupName).run();
					typeRow = { id: result.meta.last_row_id };
				}
				const result = await db.prepare(`
					INSERT INTO accounts (name, type_id, currency_code, opening_balance, applies_gmf, default_interest_rate)
					VALUES (?, ?, ?, ?, ?, ?)
				`).bind(name, typeRow.id, currencyCode, openingBalance, appliesGmf ? 1 : 0, defaultInterestRate || null).run();

				return { content: [{ type: "text" as const, text: `Account "${name}" created with ID ${result.meta.last_row_id}` }] };
			}
		);

		this.server.tool(
			"delete_account",
			"Delete an account. Refuses if movements still reference it. Pass reassignToAccountId to migrate movements to another account first (account_id is NOT NULL — there's no detach option).",
			{
				accountId: z.coerce.number(),
				reassignToAccountId: z.coerce.number().optional().describe("If provided, all movements in accountId are moved to this account before delete"),
			},
			async ({ accountId, reassignToAccountId }) => {
				const a: any = await db.prepare("SELECT id, name FROM accounts WHERE id = ?").bind(accountId).first();
				if (!a) return { content: [{ type: "text" as const, text: "Error: Account not found" }] };

				const usage: any = await db.prepare("SELECT COUNT(*) as n FROM movements WHERE account_id = ?").bind(accountId).first();
				const usedBy = usage?.n || 0;

				if (usedBy > 0) {
					if (reassignToAccountId === undefined) {
						return { content: [{ type: "text" as const, text: `Error: ${usedBy} movements still reference account ${accountId}. Pass reassignToAccountId to migrate them, or delete/reassign movements first.` }] };
					}
					if (reassignToAccountId === accountId) {
						return { content: [{ type: "text" as const, text: "Error: reassignToAccountId cannot equal accountId" }] };
					}
					const target: any = await db.prepare("SELECT id, currency_code FROM accounts WHERE id = ?").bind(reassignToAccountId).first();
					if (!target) return { content: [{ type: "text" as const, text: `Error: reassign target account ${reassignToAccountId} not found` }] };
					await db.prepare("UPDATE movements SET account_id = ? WHERE account_id = ?").bind(reassignToAccountId, accountId).run();
				}

				await db.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId).run();
				return { content: [{ type: "text" as const, text: `Deleted account ${accountId} ("${a.name}")` + (usedBy > 0 ? `, reassigned ${usedBy} movements → ${reassignToAccountId}` : "") }] };
			}
		);

		// ─── Movements ───

		this.server.tool(
			"record_expense",
			"Record an expense with one or more items. Each item has a category, amount, and optional quantity/unitPrice for price tracking. Use parentMovementId to link this EXECUTED movement to a PLANNED parent (the parent is NOT auto-marked FULFILLED — call link_to_planned for that).",
			{
				accountId: z.coerce.number().describe("Account ID"),
				date: z.string().describe("Date YYYY-MM-DD"),
				title: z.string().describe("Description (e.g., 'Almuerzo', 'Alkosto compras')"),
				items: z.array(z.object({
					categoryId: z.coerce.number().describe("Category ID"),
					amount: z.string().describe("Amount for this item"),
					memo: z.string().optional().describe("Item description (e.g., 'Arroz Diana 5kg')"),
					quantity: z.string().optional().describe("Quantity purchased"),
					unitPrice: z.string().optional().describe("Price per unit"),
					unitLabel: z.string().optional().describe("Unit label (kg, g, ml, u)"),
				})).describe("Line items"),
				notes: z.string().optional().describe("Optional notes"),
				state: z.enum(MOVEMENT_STATES).default("EXECUTED").describe("Movement state (EXECUTED, PLANNED, TEMPLATE, etc.)"),
				parentMovementId: z.coerce.number().optional().describe("Link to PLANNED/TEMPLATE parent"),
				linkedMovementId: z.coerce.number().optional().describe("Link to another movement (transfer pair, etc.)"),
				budgetId: z.coerce.number().optional().describe("Attach to a specific budget"),
				labelsCsv: z.string().optional().describe("Comma-separated labels"),
			},
			async ({ accountId, date, title, items, notes, state, parentMovementId, linkedMovementId, budgetId, labelsCsv }) => {
				const totalAmount = items.reduce((sum, e) => sum + parseFloat(e.amount), 0);
				const account: any = await db.prepare("SELECT currency_code FROM accounts WHERE id = ?").bind(accountId).first();
				if (!account) return { content: [{ type: "text" as const, text: "Error: Account not found" }] };

				const result = await db.prepare(`
					INSERT INTO movements (state, account_id, total_amount, currency_code, date, title, notes, parent_movement_id, linked_movement_id, budget_id, labels_csv)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).bind(state, accountId, (-totalAmount).toString(), account.currency_code, date, title, notes || "",
					parentMovementId || null, linkedMovementId || null, budgetId || null, labelsCsv || "").run();
				const movementId = result.meta.last_row_id;

				for (const entry of items) {
					await db.prepare(`
						INSERT INTO movement_entries (movement_id, category_id, amount, currency_code, memo, quantity, unit_price, unit_label)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					`).bind(movementId, entry.categoryId, entry.amount, account.currency_code,
						entry.memo || "", entry.quantity || null, entry.unitPrice || null, entry.unitLabel || null).run();
				}

				return { content: [{ type: "text" as const, text: `Expense recorded: "${title}" -$${totalAmount.toLocaleString()} (ID: ${movementId}, state: ${state})` }] };
			}
		);

		this.server.tool(
			"record_income",
			"Record an income. Accepts either an items array (multi-category) or a single amount+categoryId for the simple case.",
			{
				accountId: z.coerce.number().describe("Account ID"),
				date: z.string().describe("Date YYYY-MM-DD"),
				title: z.string().describe("Description (e.g., 'Salario marzo')"),
				items: z.array(z.object({
					categoryId: z.coerce.number().describe("Category ID"),
					amount: z.string().describe("Amount (positive)"),
					memo: z.string().optional(),
				})).optional().describe("Multi-item form (preferred). Use this OR amount+categoryId."),
				amount: z.string().optional().describe("Single-item: total amount (used if items omitted)"),
				categoryId: z.coerce.number().optional().describe("Single-item: category id (used if items omitted)"),
				notes: z.string().optional().describe("Optional notes"),
				state: z.enum(MOVEMENT_STATES).default("EXECUTED"),
				parentMovementId: z.coerce.number().optional(),
				linkedMovementId: z.coerce.number().optional(),
				budgetId: z.coerce.number().optional(),
				labelsCsv: z.string().optional(),
			},
			async ({ accountId, date, title, items, amount, categoryId, notes, state, parentMovementId, linkedMovementId, budgetId, labelsCsv }) => {
				const account: any = await db.prepare("SELECT currency_code FROM accounts WHERE id = ?").bind(accountId).first();
				if (!account) return { content: [{ type: "text" as const, text: "Error: Account not found" }] };

				const effectiveItems = items && items.length > 0
					? items
					: (amount !== undefined && categoryId !== undefined ? [{ categoryId, amount, memo: undefined }] : null);

				if (!effectiveItems) {
					return { content: [{ type: "text" as const, text: "Error: provide items[] or both amount and categoryId" }] };
				}

				const totalAmount = effectiveItems.reduce((sum, e) => sum + parseFloat(e.amount), 0);

				const result = await db.prepare(`
					INSERT INTO movements (state, account_id, total_amount, currency_code, date, title, notes, parent_movement_id, linked_movement_id, budget_id, labels_csv)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).bind(state, accountId, totalAmount.toString(), account.currency_code, date, title, notes || "",
					parentMovementId || null, linkedMovementId || null, budgetId || null, labelsCsv || "").run();
				const movementId = result.meta.last_row_id;

				for (const entry of effectiveItems) {
					await db.prepare(
						"INSERT INTO movement_entries (movement_id, category_id, amount, currency_code, memo) VALUES (?, ?, ?, ?, ?)"
					).bind(movementId, entry.categoryId, entry.amount, account.currency_code, entry.memo || "").run();
				}

				return { content: [{ type: "text" as const, text: `Income recorded: "${title}" +$${totalAmount.toLocaleString()} (ID: ${movementId}, state: ${state})` }] };
			}
		);

		this.server.tool(
			"record_transfer",
			"Record a transfer between accounts. Supports cross-currency.",
			{
				fromAccountId: z.coerce.number().describe("Source account ID"),
				toAccountId: z.coerce.number().describe("Destination account ID"),
				amount: z.string().describe("Amount leaving source"),
				date: z.string().describe("Date YYYY-MM-DD"),
				title: z.string().describe("Description (e.g., 'Pago MasterCard')"),
				toAmount: z.string().optional().describe("Amount arriving at destination (for cross-currency)"),
				notes: z.string().optional().describe("Optional notes"),
			},
			async ({ fromAccountId, toAccountId, amount, date, title, toAmount, notes }) => {
				const fromAcc: any = await db.prepare("SELECT currency_code FROM accounts WHERE id = ?").bind(fromAccountId).first();
				const toAcc: any = await db.prepare("SELECT currency_code FROM accounts WHERE id = ?").bind(toAccountId).first();
				if (!fromAcc || !toAcc) return { content: [{ type: "text" as const, text: "Error: Account not found" }] };

				const destAmount = toAmount || amount;

				const outResult = await db.prepare(`
					INSERT INTO movements (state, account_id, total_amount, currency_code, date, title, notes)
					VALUES ('EXECUTED', ?, ?, ?, ?, ?, ?)
				`).bind(fromAccountId, (-parseFloat(amount)).toString(), fromAcc.currency_code, date, title, notes || "").run();
				const outId = outResult.meta.last_row_id;

				const inResult = await db.prepare(`
					INSERT INTO movements (state, account_id, total_amount, currency_code, date, title, notes)
					VALUES ('EXECUTED', ?, ?, ?, ?, ?, ?)
				`).bind(toAccountId, destAmount, toAcc.currency_code, date, title, notes || "").run();
				const inId = inResult.meta.last_row_id;

				await db.prepare("UPDATE movements SET linked_movement_id = ? WHERE id = ?").bind(inId, outId).run();
				await db.prepare("UPDATE movements SET linked_movement_id = ? WHERE id = ?").bind(outId, inId).run();

				await db.prepare("INSERT INTO movement_entries (movement_id, category_id, amount, currency_code) VALUES (?, 0, ?, ?)").bind(outId, amount, fromAcc.currency_code).run();
				await db.prepare("INSERT INTO movement_entries (movement_id, category_id, amount, currency_code) VALUES (?, 0, ?, ?)").bind(inId, destAmount, toAcc.currency_code).run();

				return { content: [{ type: "text" as const, text: `Transfer: -$${parseFloat(amount).toLocaleString()} → +$${parseFloat(destAmount).toLocaleString()} (IDs: ${outId}, ${inId})` }] };
			}
		);

		this.server.tool(
			"list_movements",
			"List movements for a period, optionally filtered by account, state, or keyword. Supports ordering and pagination. Set includeEntries=false to drop line items and shrink response — preferred for large windows.",
			{
				startDate: z.string().describe("Start date YYYY-MM-DD"),
				endDate: z.string().describe("End date YYYY-MM-DD"),
				accountId: z.coerce.number().optional().describe("Filter by account (omit for all)"),
				state: z.string().optional().describe("Filter by state: EXECUTED, PLANNED, TEMPLATE, VOIDED, SKIPPED, FULFILLED"),
				search: z.string().optional().describe("Keyword filter — matches title or notes (case-insensitive substring)"),
				order: z.enum(["asc", "desc"]).default("desc").describe("Sort order by date"),
				limit: z.coerce.number().default(100).describe("Max rows to return (default 100, hard cap 500)"),
				offset: z.coerce.number().default(0).describe("Pagination offset"),
				includeEntries: zbool().default(true).describe("Include line items per movement (set false to shrink response for big windows)"),
			},
			async ({ startDate, endDate, accountId, state, search, order, limit, offset, includeEntries }) => {
				let query = `SELECT m.*, a.name as account_name FROM movements m JOIN accounts a ON m.account_id = a.id WHERE m.date BETWEEN ? AND ?`;
				const params: any[] = [startDate, endDate];
				if (accountId) { query += " AND m.account_id = ?"; params.push(accountId); }
				if (state) { query += " AND m.state = ?"; params.push(state); }
				if (search) {
					query += " AND (LOWER(m.title) LIKE ? OR LOWER(m.notes) LIKE ?)";
					const needle = `%${search.toLowerCase()}%`;
					params.push(needle, needle);
				}
				const dir = order === "asc" ? "ASC" : "DESC";
				const cappedLimit = Math.min(Math.max(1, limit), 500);
				query += ` ORDER BY m.date ${dir}, m.id ${dir} LIMIT ? OFFSET ?`;
				params.push(cappedLimit, offset);

				const movements = await db.prepare(query).bind(...params).all();
				if (includeEntries) {
					for (const m of movements.results as any[]) {
						const entries = await db.prepare(`
							SELECT me.*, c.name as category_name FROM movement_entries me
							LEFT JOIN categories c ON me.category_id = c.id WHERE me.movement_id = ?
						`).bind(m.id).all();
						m.entries = entries.results;
					}
				}

				return { content: [{ type: "text" as const, text: JSON.stringify(movements.results, null, 2) }] };
			}
		);

		this.server.tool(
			"delete_movement",
			"Delete a movement. If it's a transfer, also deletes the linked pair (breaks the cyclic FK first). If it's a TEMPLATE/PLANNED with descendant movements (parent_movement_id chain), refuses unless detachChildren or deleteChildren is set.",
			{
				movementId: z.coerce.number().describe("Movement ID to delete"),
				detachChildren: zbool().default(false).describe("If true, NULL parent_movement_id on descendants before deleting (orphans them but preserves history)"),
				deleteChildren: zbool().default(false).describe("If true, also delete descendants (recursive). Mutually exclusive with detachChildren."),
			},
			async ({ movementId, detachChildren, deleteChildren }) => {
				const m: any = await db.prepare("SELECT linked_movement_id FROM movements WHERE id = ?").bind(movementId).first();
				if (!m) return { content: [{ type: "text" as const, text: "Error: Movement not found" }] };
				if (detachChildren && deleteChildren) {
					return { content: [{ type: "text" as const, text: "Error: pass detachChildren OR deleteChildren, not both" }] };
				}

				const childRows = await db.prepare("SELECT id FROM movements WHERE parent_movement_id = ?").bind(movementId).all();
				const childIds = (childRows.results as any[]).map(r => r.id);
				if (childIds.length > 0) {
					if (!detachChildren && !deleteChildren) {
						return { content: [{ type: "text" as const, text: `Error: ${childIds.length} movement${childIds.length > 1 ? "s" : ""} reference this as parent. Pass detachChildren=true to orphan or deleteChildren=true to cascade.` }] };
					}
					if (detachChildren) {
						await db.prepare("UPDATE movements SET parent_movement_id = NULL WHERE parent_movement_id = ?").bind(movementId).run();
					} else {
						// Recursive cascade: walk the parent_movement_id tree and delete bottom-up.
						const toDelete: number[] = [];
						const stack: number[] = [...childIds];
						while (stack.length > 0) {
							const id = stack.pop() as number;
							toDelete.push(id);
							const grand = await db.prepare("SELECT id FROM movements WHERE parent_movement_id = ?").bind(id).all();
							for (const g of grand.results as any[]) stack.push(g.id);
						}
						// Detach any cyclic linked_movement_id within the doomed set, then delete.
						for (const id of toDelete) {
							await db.prepare("UPDATE movements SET linked_movement_id = NULL WHERE id = ?").bind(id).run();
						}
						for (const id of toDelete.reverse()) {
							await db.prepare("DELETE FROM movements WHERE id = ?").bind(id).run();
						}
					}
				}

				const linkedId = m.linked_movement_id;
				if (linkedId) {
					// Break the cyclic FK before deleting — both rows reference each other,
					// so SQLite blocks either DELETE under default NO ACTION enforcement.
					await db.prepare("UPDATE movements SET linked_movement_id = NULL WHERE id = ?").bind(movementId).run();
					await db.prepare("UPDATE movements SET linked_movement_id = NULL WHERE id = ?").bind(linkedId).run();
					await db.prepare("DELETE FROM movements WHERE id = ?").bind(linkedId).run();
				}
				await db.prepare("DELETE FROM movements WHERE id = ?").bind(movementId).run();

				const parts = [`Deleted ${movementId}`];
				if (linkedId) parts.push(`+ pair ${linkedId}`);
				if (childIds.length > 0) parts.push(detachChildren ? `(detached ${childIds.length} children)` : `(cascaded ${childIds.length} children)`);
				return { content: [{ type: "text" as const, text: parts.join(" ") }] };
			}
		);

		this.server.tool(
			"update_movement",
			"Update fields on an existing movement. Only the fields you pass are changed. Pass items[] to REPLACE all entries (avoids the total/entries drift bug). Recurrence fields apply to TEMPLATE-state movements. For state transitions prefer update_movement_state; for PLANNED→FULFILLED prefer link_to_planned.",
			{
				movementId: z.coerce.number().describe("Movement ID to update"),
				title: z.string().optional(),
				notes: z.string().optional(),
				date: z.string().optional().describe("YYYY-MM-DD"),
				totalAmount: z.string().optional().describe("Total amount (negative for expense, positive for income). If items[] is also provided, this is ignored — total is recomputed from items."),
				accountId: z.coerce.number().optional(),
				state: z.enum(MOVEMENT_STATES).optional(),
				budgetId: z.coerce.number().nullable().optional().describe("Pass null to detach from budget"),
				parentMovementId: z.coerce.number().nullable().optional(),
				linkedMovementId: z.coerce.number().nullable().optional(),
				labelsCsv: z.string().optional(),
				items: z.array(z.object({
					categoryId: z.coerce.number(),
					amount: z.string(),
					memo: z.string().optional(),
					quantity: z.string().optional(),
					unitPrice: z.string().optional(),
					unitLabel: z.string().optional(),
				})).optional().describe("If provided, deletes existing entries and inserts these. Total is recomputed."),
				recurrenceFrequency: z.enum(["MONTHLY", "BIWEEKLY", "WEEKLY"]).nullable().optional(),
				recurrenceDay: z.coerce.number().nullable().optional(),
				recurrenceCount: z.coerce.number().nullable().optional(),
				recurrenceRate: z.string().nullable().optional(),
				installmentAmount: z.string().nullable().optional(),
			},
			async (args) => {
				const { movementId, items, ...updates } = args;
				const existing: any = await db.prepare("SELECT id, account_id, total_amount, currency_code FROM movements WHERE id = ?").bind(movementId).first();
				if (!existing) return { content: [{ type: "text" as const, text: "Error: Movement not found" }] };

				const fieldMap: Record<string, string> = {
					title: "title", notes: "notes", date: "date", totalAmount: "total_amount",
					accountId: "account_id", state: "state", budgetId: "budget_id",
					parentMovementId: "parent_movement_id", linkedMovementId: "linked_movement_id",
					labelsCsv: "labels_csv",
					recurrenceFrequency: "recurrence_frequency", recurrenceDay: "recurrence_day",
					recurrenceCount: "recurrence_count", recurrenceRate: "recurrence_rate",
					installmentAmount: "installment_amount",
				};

				let recomputedTotal: string | null = null;
				if (items !== undefined) {
					// Determine sign convention from existing movement: keep negative for expense, positive for income.
					const existingTotal = parseFloat(existing.total_amount);
					const sumItems = items.reduce((s, e) => s + parseFloat(e.amount), 0);
					recomputedTotal = (existingTotal < 0 ? -sumItems : sumItems).toString();
				}

				const sets: string[] = [];
				const params: any[] = [];
				for (const [key, col] of Object.entries(fieldMap)) {
					if (key === "totalAmount" && items !== undefined) continue; // recomputed below
					const v = (updates as any)[key];
					if (v !== undefined) { sets.push(`${col} = ?`); params.push(v); }
				}
				if (recomputedTotal !== null) { sets.push("total_amount = ?"); params.push(recomputedTotal); }

				if (sets.length === 0 && items === undefined) {
					return { content: [{ type: "text" as const, text: "Nothing to update" }] };
				}

				if (sets.length > 0) {
					params.push(movementId);
					await db.prepare(`UPDATE movements SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
				}

				if (items !== undefined) {
					await db.prepare("DELETE FROM movement_entries WHERE movement_id = ?").bind(movementId).run();
					const currency = existing.currency_code;
					for (const e of items) {
						await db.prepare(`
							INSERT INTO movement_entries (movement_id, category_id, amount, currency_code, memo, quantity, unit_price, unit_label)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?)
						`).bind(movementId, e.categoryId, e.amount, currency,
							e.memo || "", e.quantity || null, e.unitPrice || null, e.unitLabel || null).run();
					}
				}

				const parts = [`Movement ${movementId} updated`];
				if (sets.length > 0) parts.push(`(${sets.length} field${sets.length > 1 ? "s" : ""})`);
				if (items !== undefined) parts.push(`(${items.length} entries replaced)`);
				return { content: [{ type: "text" as const, text: parts.join(" ") }] };
			}
		);

		this.server.tool(
			"update_movement_state",
			"Change a movement's state (TEMPLATE, PLANNED, EXECUTED, VOIDED, SKIPPED, FULFILLED). Shortcut for update_movement when only the state changes.",
			{
				movementId: z.coerce.number(),
				state: z.enum(MOVEMENT_STATES),
			},
			async ({ movementId, state }) => {
				const existing: any = await db.prepare("SELECT id FROM movements WHERE id = ?").bind(movementId).first();
				if (!existing) return { content: [{ type: "text" as const, text: "Error: Movement not found" }] };
				await db.prepare("UPDATE movements SET state = ? WHERE id = ?").bind(state, movementId).run();
				return { content: [{ type: "text" as const, text: `Movement ${movementId} → ${state}` }] };
			}
		);

		this.server.tool(
			"link_to_planned",
			"Tie an EXECUTED movement to its PLANNED parent: sets executed.parent_movement_id and marks the planned as FULFILLED. Use after recording a real expense that fulfills a planned obligation (e.g., a recurring bill).",
			{
				executedMovementId: z.coerce.number().describe("The actual EXECUTED movement"),
				plannedMovementId: z.coerce.number().describe("The PLANNED movement to mark fulfilled"),
			},
			async ({ executedMovementId, plannedMovementId }) => {
				const exec: any = await db.prepare("SELECT id, state FROM movements WHERE id = ?").bind(executedMovementId).first();
				const plan: any = await db.prepare("SELECT id, state FROM movements WHERE id = ?").bind(plannedMovementId).first();
				if (!exec) return { content: [{ type: "text" as const, text: `Error: executed movement ${executedMovementId} not found` }] };
				if (!plan) return { content: [{ type: "text" as const, text: `Error: planned movement ${plannedMovementId} not found` }] };

				await db.prepare("UPDATE movements SET parent_movement_id = ? WHERE id = ?").bind(plannedMovementId, executedMovementId).run();
				await db.prepare("UPDATE movements SET state = 'FULFILLED' WHERE id = ?").bind(plannedMovementId).run();

				return { content: [{ type: "text" as const, text: `Linked: ${executedMovementId} → parent ${plannedMovementId} (now FULFILLED)` }] };
			}
		);

		this.server.tool(
			"apply_template",
			"Instantiate a TEMPLATE movement into a new PLANNED (or EXECUTED) movement on a given date. Copies title, notes, account, total, and entries; sets parent_movement_id to the template.",
			{
				templateMovementId: z.coerce.number().describe("ID of the TEMPLATE movement"),
				date: z.string().describe("Date for the new movement YYYY-MM-DD"),
				state: z.enum(["PLANNED", "EXECUTED"]).default("PLANNED").describe("Resulting state"),
				budgetId: z.coerce.number().optional().describe("Attach the new movement to a budget"),
			},
			async ({ templateMovementId, date, state, budgetId }) => {
				const t: any = await db.prepare("SELECT * FROM movements WHERE id = ?").bind(templateMovementId).first();
				if (!t) return { content: [{ type: "text" as const, text: "Error: Template movement not found" }] };
				if (t.state !== "TEMPLATE") {
					return { content: [{ type: "text" as const, text: `Warning: source movement ${templateMovementId} state is ${t.state}, not TEMPLATE — proceeding anyway` }] };
				}

				const result = await db.prepare(`
					INSERT INTO movements (state, account_id, total_amount, currency_code, date, title, notes, parent_movement_id, budget_id, labels_csv)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).bind(state, t.account_id, t.total_amount, t.currency_code, date, t.title, t.notes,
					templateMovementId, budgetId || null, t.labels_csv || "").run();
				const newId = result.meta.last_row_id;

				const entries = await db.prepare("SELECT * FROM movement_entries WHERE movement_id = ?").bind(templateMovementId).all();
				for (const e of entries.results as any[]) {
					await db.prepare(`
						INSERT INTO movement_entries (movement_id, category_id, amount, currency_code, memo, quantity, unit_price, unit_label)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					`).bind(newId, e.category_id, e.amount, e.currency_code, e.memo || "", e.quantity, e.unit_price, e.unit_label).run();
				}

				return { content: [{ type: "text" as const, text: `Template ${templateMovementId} → ${state} movement ${newId} on ${date} (${entries.results.length} entries copied)` }] };
			}
		);

		// ─── Categories ───

		this.server.tool(
			"list_categories",
			"List all categories",
			{},
			async () => {
				const rows = await db.prepare("SELECT * FROM categories ORDER BY category_type, sort_order, name").all();
				return { content: [{ type: "text" as const, text: JSON.stringify(rows.results, null, 2) }] };
			}
		);

		this.server.tool(
			"create_category",
			"Create a category",
			{
				name: z.string().describe("Category name"),
				categoryType: z.string().default("EXPENSE").describe("EXPENSE or INCOME"),
				parentId: z.coerce.number().optional().describe("Parent category ID"),
			},
			async ({ name, categoryType, parentId }) => {
				const result = await db.prepare("INSERT INTO categories (name, category_type, parent_id) VALUES (?, ?, ?)")
					.bind(name, categoryType, parentId || null).run();
				return { content: [{ type: "text" as const, text: `Category "${name}" created (ID: ${result.meta.last_row_id})` }] };
			}
		);

		this.server.tool(
			"update_category",
			"Update a category's name, parent, type, sort order, or icon. Only provided fields change.",
			{
				categoryId: z.coerce.number(),
				name: z.string().optional(),
				parentId: z.coerce.number().nullable().optional().describe("Pass null to detach from parent"),
				categoryType: z.string().optional().describe("EXPENSE or INCOME"),
				sortOrder: z.coerce.number().optional(),
				icon: z.string().optional(),
			},
			async (args) => {
				const { categoryId, ...updates } = args;
				const existing: any = await db.prepare("SELECT id FROM categories WHERE id = ?").bind(categoryId).first();
				if (!existing) return { content: [{ type: "text" as const, text: "Error: Category not found" }] };

				const fieldMap: Record<string, string> = {
					name: "name", parentId: "parent_id", categoryType: "category_type",
					sortOrder: "sort_order", icon: "icon",
				};
				const sets: string[] = [];
				const params: any[] = [];
				for (const [key, col] of Object.entries(fieldMap)) {
					const v = (updates as any)[key];
					if (v !== undefined) { sets.push(`${col} = ?`); params.push(v); }
				}
				if (sets.length === 0) return { content: [{ type: "text" as const, text: "Nothing to update" }] };

				params.push(categoryId);
				await db.prepare(`UPDATE categories SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
				return { content: [{ type: "text" as const, text: `Category ${categoryId} updated` }] };
			}
		);

		this.server.tool(
			"delete_category",
			"Delete a category. Refuses if any movement entries still reference it. Pass reassignToCategoryId to migrate entries first.",
			{
				categoryId: z.coerce.number(),
				reassignToCategoryId: z.coerce.number().optional().describe("If provided, all entries pointing at categoryId are reassigned here before delete"),
			},
			async ({ categoryId, reassignToCategoryId }) => {
				const existing: any = await db.prepare("SELECT id, name FROM categories WHERE id = ?").bind(categoryId).first();
				if (!existing) return { content: [{ type: "text" as const, text: "Error: Category not found" }] };
				if (categoryId === 0) return { content: [{ type: "text" as const, text: "Error: cannot delete reserved Transfer category (id=0)" }] };

				const usage: any = await db.prepare("SELECT COUNT(*) as n FROM movement_entries WHERE category_id = ?").bind(categoryId).first();
				const usedBy = usage?.n || 0;

				if (usedBy > 0) {
					if (reassignToCategoryId === undefined) {
						return { content: [{ type: "text" as const, text: `Error: ${usedBy} entries still reference category ${categoryId}. Pass reassignToCategoryId to migrate them first.` }] };
					}
					const target: any = await db.prepare("SELECT id FROM categories WHERE id = ?").bind(reassignToCategoryId).first();
					if (!target) return { content: [{ type: "text" as const, text: `Error: reassign target category ${reassignToCategoryId} not found` }] };
					await db.prepare("UPDATE movement_entries SET category_id = ? WHERE category_id = ?").bind(reassignToCategoryId, categoryId).run();
				}

				const childCount: any = await db.prepare("SELECT COUNT(*) as n FROM categories WHERE parent_id = ?").bind(categoryId).first();
				if ((childCount?.n || 0) > 0) {
					return { content: [{ type: "text" as const, text: `Error: category ${categoryId} has ${childCount.n} child categories. Reassign or delete them first.` }] };
				}

				await db.prepare("DELETE FROM categories WHERE id = ?").bind(categoryId).run();
				return { content: [{ type: "text" as const, text: `Deleted category ${categoryId} ("${existing.name}")` + (usedBy > 0 ? `, reassigned ${usedBy} entries → ${reassignToCategoryId}` : "") }] };
			}
		);

		// ─── Budget ───

		this.server.tool(
			"budget_status",
			"Get budget status: limit, spent, daily allowance, spending by category. Defaults to the OPEN budget covering today; pass budgetId to query a specific (e.g., closed/historical) budget.",
			{
				budgetId: z.coerce.number().optional().describe("Specific budget to query. Omit to use the active OPEN budget covering today."),
			},
			async ({ budgetId }) => {
				const today = new Date().toISOString().split("T")[0];
				const budget: any = budgetId
					? await db.prepare("SELECT * FROM budgets WHERE id = ?").bind(budgetId).first()
					: await db.prepare("SELECT * FROM budgets WHERE start_date <= ? AND end_date >= ? AND state = 'OPEN'").bind(today, today).first();
				if (!budget) return { content: [{ type: "text" as const, text: JSON.stringify({ hasBudget: false, message: budgetId ? `Budget ${budgetId} not found` : "No active budget" }) }] };

				const spent: any = await db.prepare(`
					SELECT COALESCE(SUM(ABS(CAST(total_amount AS REAL))), 0) as total FROM movements
					WHERE budget_id = ? AND state = 'EXECUTED' AND CAST(total_amount AS REAL) < 0
				`).bind(budget.id).first();

				const totalSpent = spent?.total || 0;
				const limit = parseFloat(budget.spending_limit);
				const remaining = limit - totalSpent;
				// daysLeft is meaningful only for the active budget; for historical ones we cap at 1.
				const refDate = today < budget.end_date ? today : budget.end_date;
				const daysLeft = Math.max(1, Math.ceil((new Date(budget.end_date).getTime() - new Date(refDate).getTime()) / 86400000));

				const byCategory = await db.prepare(`
					SELECT c.name as category, SUM(CAST(me.amount AS REAL)) as total
					FROM movement_entries me JOIN movements m ON me.movement_id = m.id
					LEFT JOIN categories c ON me.category_id = c.id
					WHERE m.budget_id = ? AND m.state = 'EXECUTED' AND CAST(m.total_amount AS REAL) < 0
					GROUP BY me.category_id ORDER BY total DESC
				`).bind(budget.id).all();

				return { content: [{ type: "text" as const, text: JSON.stringify({
					hasBudget: true, budgetId: budget.id, state: budget.state,
					period: `${budget.start_date} to ${budget.end_date}`,
					limit, spent: totalSpent, remaining, daysLeft,
					dailyAllowance: Math.round(Math.max(0, remaining / daysLeft)),
					percentUsed: Math.round((totalSpent / limit) * 100),
					byCategory: byCategory.results
				}, null, 2) }] };
			}
		);

		this.server.tool(
			"list_budgets",
			"List budgets with filters. By default returns the most recent 12, newest first. Use state=OPEN/CLOSED to filter, includeStats=true to attach spent/remaining per budget.",
			{
				state: z.enum(["OPEN", "CLOSED"]).optional().describe("Filter by state"),
				startAfter: z.string().optional().describe("Only budgets whose start_date >= this YYYY-MM-DD"),
				endBefore: z.string().optional().describe("Only budgets whose end_date <= this YYYY-MM-DD"),
				includeStats: zbool().default(false).describe("Attach spent/remaining/percentUsed per budget"),
				limit: z.coerce.number().default(12).describe("Max rows (default 12, hard cap 100)"),
			},
			async ({ state, startAfter, endBefore, includeStats, limit }) => {
				let q = "SELECT * FROM budgets WHERE 1=1";
				const params: any[] = [];
				if (state) { q += " AND state = ?"; params.push(state); }
				if (startAfter) { q += " AND start_date >= ?"; params.push(startAfter); }
				if (endBefore) { q += " AND end_date <= ?"; params.push(endBefore); }
				const cap = Math.min(Math.max(1, limit), 100);
				q += " ORDER BY start_date DESC LIMIT ?";
				params.push(cap);

				const rows = await db.prepare(q).bind(...params).all();
				const budgets = rows.results as any[];

				if (includeStats) {
					for (const b of budgets) {
						const s: any = await db.prepare(`
							SELECT COALESCE(SUM(ABS(CAST(total_amount AS REAL))), 0) as total FROM movements
							WHERE budget_id = ? AND state = 'EXECUTED' AND CAST(total_amount AS REAL) < 0
						`).bind(b.id).first();
						const totalSpent = s?.total || 0;
						const lim = parseFloat(b.spending_limit);
						b.spent = totalSpent;
						b.remaining = lim - totalSpent;
						b.percentUsed = lim > 0 ? Math.round((totalSpent / lim) * 100) : 0;
					}
				}

				return { content: [{ type: "text" as const, text: JSON.stringify(budgets, null, 2) }] };
			}
		);

		this.server.tool(
			"create_budget",
			"Create a new budget for a date range. Refuses by default if the period overlaps an existing OPEN budget — pass allowOverlap=true to bypass.",
			{
				startDate: z.string().describe("Start date YYYY-MM-DD (inclusive)"),
				endDate: z.string().describe("End date YYYY-MM-DD (inclusive)"),
				spendingLimit: z.string().describe("Spending limit (positive number as string)"),
				currencyCode: z.string().default("COP").describe("Currency code"),
				state: z.enum(["OPEN", "CLOSED"]).default("OPEN"),
				allowOverlap: zbool().default(false).describe("Allow overlap with existing OPEN budgets"),
			},
			async ({ startDate, endDate, spendingLimit, currencyCode, state, allowOverlap }) => {
				if (startDate > endDate) {
					return { content: [{ type: "text" as const, text: "Error: startDate must be <= endDate" }] };
				}
				if (parseFloat(spendingLimit) <= 0) {
					return { content: [{ type: "text" as const, text: "Error: spendingLimit must be > 0" }] };
				}

				if (!allowOverlap && state === "OPEN") {
					const overlap: any = await db.prepare(`
						SELECT id, start_date, end_date FROM budgets
						WHERE state = 'OPEN' AND start_date <= ? AND end_date >= ?
					`).bind(endDate, startDate).first();
					if (overlap) {
						return { content: [{ type: "text" as const, text: `Error: overlaps existing OPEN budget ${overlap.id} (${overlap.start_date} to ${overlap.end_date}). Pass allowOverlap=true to force.` }] };
					}
				}

				const result = await db.prepare(`
					INSERT INTO budgets (start_date, end_date, spending_limit, currency_code, state)
					VALUES (?, ?, ?, ?, ?)
				`).bind(startDate, endDate, spendingLimit, currencyCode, state).run();

				return { content: [{ type: "text" as const, text: `Budget ${result.meta.last_row_id} created (${startDate} to ${endDate}, limit ${spendingLimit} ${currencyCode}, ${state})` }] };
			}
		);

		this.server.tool(
			"update_budget",
			"Update fields on an existing budget. Only the fields you pass are changed. For closing prefer close_budget (it sweeps unfulfilled PLANNEDs to SKIPPED).",
			{
				budgetId: z.coerce.number(),
				startDate: z.string().optional(),
				endDate: z.string().optional(),
				spendingLimit: z.string().optional(),
				currencyCode: z.string().optional(),
				state: z.enum(["OPEN", "CLOSED"]).optional(),
				alert50: z.coerce.number().optional().describe("0 or 1 — fired flag"),
				alert75: z.coerce.number().optional(),
				alert90: z.coerce.number().optional(),
				alert100: z.coerce.number().optional(),
			},
			async (args) => {
				const { budgetId, ...updates } = args;
				const existing: any = await db.prepare("SELECT id FROM budgets WHERE id = ?").bind(budgetId).first();
				if (!existing) return { content: [{ type: "text" as const, text: "Error: Budget not found" }] };

				const fieldMap: Record<string, string> = {
					startDate: "start_date", endDate: "end_date", spendingLimit: "spending_limit",
					currencyCode: "currency_code", state: "state",
					alert50: "alert_50", alert75: "alert_75", alert90: "alert_90", alert100: "alert_100",
				};
				const sets: string[] = [];
				const params: any[] = [];
				for (const [k, col] of Object.entries(fieldMap)) {
					const v = (updates as any)[k];
					if (v !== undefined) { sets.push(`${col} = ?`); params.push(v); }
				}
				if (sets.length === 0) return { content: [{ type: "text" as const, text: "Nothing to update" }] };

				params.push(budgetId);
				await db.prepare(`UPDATE budgets SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
				return { content: [{ type: "text" as const, text: `Budget ${budgetId} updated (${sets.length} field${sets.length > 1 ? "s" : ""})` }] };
			}
		);

		this.server.tool(
			"close_budget",
			"Close a budget: sets state=CLOSED. By default also sweeps unfulfilled PLANNEDs in the budget to SKIPPED (skipped = 'didn't happen', distinct from VOIDED). Pass sweepPlanned=false to skip the sweep.",
			{
				budgetId: z.coerce.number(),
				sweepPlanned: zbool().default(true).describe("Mark unfulfilled PLANNEDs in this budget as SKIPPED"),
			},
			async ({ budgetId, sweepPlanned }) => {
				const b: any = await db.prepare("SELECT id, state FROM budgets WHERE id = ?").bind(budgetId).first();
				if (!b) return { content: [{ type: "text" as const, text: "Error: Budget not found" }] };
				if (b.state === "CLOSED") return { content: [{ type: "text" as const, text: `Budget ${budgetId} is already CLOSED` }] };

				let swept = 0;
				if (sweepPlanned) {
					const result = await db.prepare(
						"UPDATE movements SET state = 'SKIPPED' WHERE budget_id = ? AND state = 'PLANNED'"
					).bind(budgetId).run();
					swept = result.meta.changes || 0;
				}

				await db.prepare("UPDATE budgets SET state = 'CLOSED' WHERE id = ?").bind(budgetId).run();
				return { content: [{ type: "text" as const, text: `Budget ${budgetId} closed` + (sweepPlanned ? ` (${swept} unfulfilled PLANNED → SKIPPED)` : "") }] };
			}
		);

		this.server.tool(
			"delete_budget",
			"Delete a budget. Refuses if any movements still reference it. Pass detachMovements=true to NULL the budget_id on those movements first.",
			{
				budgetId: z.coerce.number(),
				detachMovements: zbool().default(false).describe("If true, set budget_id=NULL on referencing movements before delete"),
			},
			async ({ budgetId, detachMovements }) => {
				const b: any = await db.prepare("SELECT id FROM budgets WHERE id = ?").bind(budgetId).first();
				if (!b) return { content: [{ type: "text" as const, text: "Error: Budget not found" }] };

				const usage: any = await db.prepare("SELECT COUNT(*) as n FROM movements WHERE budget_id = ?").bind(budgetId).first();
				const usedBy = usage?.n || 0;

				if (usedBy > 0) {
					if (!detachMovements) {
						return { content: [{ type: "text" as const, text: `Error: ${usedBy} movements still reference budget ${budgetId}. Pass detachMovements=true to NULL them first.` }] };
					}
					await db.prepare("UPDATE movements SET budget_id = NULL WHERE budget_id = ?").bind(budgetId).run();
				}

				await db.prepare("DELETE FROM budgets WHERE id = ?").bind(budgetId).run();
				return { content: [{ type: "text" as const, text: `Deleted budget ${budgetId}` + (usedBy > 0 ? ` (detached ${usedBy} movements)` : "") }] };
			}
		);

		this.server.tool(
			"activate_budget",
			"Set a budget to OPEN. By default closes any other OPEN budget that overlaps this one's date range (sweeping its unfulfilled PLANNEDs to SKIPPED). Use this to switch periods cleanly.",
			{
				budgetId: z.coerce.number(),
				closeOverlapping: zbool().default(true).describe("Close any other OPEN budget that overlaps this one's range"),
			},
			async ({ budgetId, closeOverlapping }) => {
				const b: any = await db.prepare("SELECT id, start_date, end_date, state FROM budgets WHERE id = ?").bind(budgetId).first();
				if (!b) return { content: [{ type: "text" as const, text: "Error: Budget not found" }] };

				const closed: number[] = [];
				let sweptTotal = 0;
				if (closeOverlapping) {
					const others = await db.prepare(`
						SELECT id FROM budgets
						WHERE id != ? AND state = 'OPEN' AND start_date <= ? AND end_date >= ?
					`).bind(budgetId, b.end_date, b.start_date).all();
					for (const o of others.results as any[]) {
						const sweep = await db.prepare(
							"UPDATE movements SET state = 'SKIPPED' WHERE budget_id = ? AND state = 'PLANNED'"
						).bind(o.id).run();
						sweptTotal += sweep.meta.changes || 0;
						await db.prepare("UPDATE budgets SET state = 'CLOSED' WHERE id = ?").bind(o.id).run();
						closed.push(o.id);
					}
				}

				if (b.state !== "OPEN") {
					await db.prepare("UPDATE budgets SET state = 'OPEN' WHERE id = ?").bind(budgetId).run();
				}

				const parts = [`Budget ${budgetId} active`];
				if (closed.length > 0) parts.push(`closed overlapping [${closed.join(", ")}]`);
				if (sweptTotal > 0) parts.push(`(${sweptTotal} PLANNED → SKIPPED)`);
				return { content: [{ type: "text" as const, text: parts.join(" ") }] };
			}
		);

		// ─── Templates (recurring movement definitions) ───

		this.server.tool(
			"create_template",
			"Create a recurring TEMPLATE movement. TEMPLATEs don't affect balances themselves — they're definitions used by apply_template to generate PLANNEDs each period. Three flavors: subscription (recurrenceFrequency only), installments (recurrenceFrequency + recurrenceCount + installmentAmount), loan (recurrenceFrequency + recurrenceRate).",
			{
				accountId: z.coerce.number(),
				title: z.string().describe("e.g. 'Netflix', 'Cuota Pathfinder', 'Hipotecario'"),
				items: z.array(z.object({
					categoryId: z.coerce.number(),
					amount: z.string(),
					memo: z.string().optional(),
				})).describe("Line items defining the recurring expense/income"),
				kind: z.enum(["EXPENSE", "INCOME"]).default("EXPENSE").describe("Sign of the resulting total when generated"),
				notes: z.string().optional(),
				labelsCsv: z.string().optional(),
				date: z.string().optional().describe("Reference/anchor date for the template (defaults to today). Doesn't fire on this date — apply_template generates PLANNEDs separately."),
				recurrenceFrequency: z.enum(["MONTHLY", "BIWEEKLY", "WEEKLY"]),
				recurrenceDay: z.coerce.number().optional().describe("Day of month (MONTHLY) or day of week 1-7 (WEEKLY/BIWEEKLY)"),
				recurrenceCount: z.coerce.number().optional().describe("Total cuotas (installments only)"),
				recurrenceRate: z.string().optional().describe("Annual interest rate (loans / installments with interest)"),
				installmentAmount: z.string().optional().describe("Per-cuota amount (stored so budget can read it without computing entries)"),
			},
			async ({ accountId, title, items, kind, notes, labelsCsv, date, recurrenceFrequency, recurrenceDay, recurrenceCount, recurrenceRate, installmentAmount }) => {
				const account: any = await db.prepare("SELECT currency_code FROM accounts WHERE id = ?").bind(accountId).first();
				if (!account) return { content: [{ type: "text" as const, text: "Error: Account not found" }] };

				const sumItems = items.reduce((s, e) => s + parseFloat(e.amount), 0);
				const total = (kind === "EXPENSE" ? -sumItems : sumItems).toString();
				const refDate = date || new Date().toISOString().split("T")[0];

				const result = await db.prepare(`
					INSERT INTO movements (state, account_id, total_amount, currency_code, date, title, notes, labels_csv,
						recurrence_frequency, recurrence_day, recurrence_count, recurrence_rate, installment_amount)
					VALUES ('TEMPLATE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`).bind(accountId, total, account.currency_code, refDate, title, notes || "", labelsCsv || "",
					recurrenceFrequency, recurrenceDay ?? null, recurrenceCount ?? null, recurrenceRate ?? null, installmentAmount ?? null).run();
				const templateId = result.meta.last_row_id;

				for (const e of items) {
					await db.prepare(`
						INSERT INTO movement_entries (movement_id, category_id, amount, currency_code, memo)
						VALUES (?, ?, ?, ?, ?)
					`).bind(templateId, e.categoryId, e.amount, account.currency_code, e.memo || "").run();
				}

				return { content: [{ type: "text" as const, text: `Template ${templateId} created: "${title}" (${recurrenceFrequency}${recurrenceCount ? `, ${recurrenceCount} cuotas` : ""}${recurrenceRate ? `, rate ${recurrenceRate}` : ""})` }] };
			}
		);

		// ─── Reports ───

		this.server.tool(
			"spending_by_category",
			"Spending breakdown by category for a date range",
			{
				startDate: z.string().describe("Start date YYYY-MM-DD"),
				endDate: z.string().describe("End date YYYY-MM-DD"),
				accountId: z.coerce.number().optional().describe("Filter by account"),
			},
			async ({ startDate, endDate, accountId }) => {
				let query = `
					SELECT c.name as category, c.id as category_id, SUM(CAST(me.amount AS REAL)) as total,
						COUNT(DISTINCT me.movement_id) as tx_count
					FROM movement_entries me JOIN movements m ON me.movement_id = m.id
					LEFT JOIN categories c ON me.category_id = c.id
					WHERE m.state = 'EXECUTED' AND CAST(m.total_amount AS REAL) < 0 AND m.date BETWEEN ? AND ?
				`;
				const params: any[] = [startDate, endDate];
				if (accountId) { query += " AND m.account_id = ?"; params.push(accountId); }
				query += " GROUP BY me.category_id ORDER BY total DESC";

				const rows = await db.prepare(query).bind(...params).all();
				const grandTotal = rows.results.reduce((sum: number, r: any) => sum + r.total, 0);

				return { content: [{ type: "text" as const, text: JSON.stringify({
					period: `${startDate} to ${endDate}`, grandTotal,
					categories: rows.results.map((r: any) => ({ ...r, percentage: Math.round((r.total / grandTotal) * 100) }))
				}, null, 2) }] };
			}
		);

		this.server.tool(
			"price_history",
			"Track price changes for a product or category over time",
			{
				search: z.string().describe("Search term (matches entry memo or category name)"),
				limit: z.coerce.number().default(20).describe("Max results"),
			},
			async ({ search, limit }) => {
				const rows = await db.prepare(`
					SELECT m.date, m.title, me.memo, me.quantity, me.unit_price, me.unit_label,
						me.amount, c.name as category, a.name as account_name
					FROM movement_entries me JOIN movements m ON me.movement_id = m.id
					LEFT JOIN categories c ON me.category_id = c.id JOIN accounts a ON m.account_id = a.id
					WHERE me.unit_price IS NOT NULL AND m.state = 'EXECUTED' AND (me.memo LIKE ? OR c.name LIKE ?)
					ORDER BY m.date DESC LIMIT ?
				`).bind(`%${search}%`, `%${search}%`, limit).all();

				return { content: [{ type: "text" as const, text: JSON.stringify(rows.results, null, 2) }] };
			}
		);
	}
}

function inferGroupName(typeName: string): string {
	const l = typeName.toLowerCase();
	if (l.includes("credit card") || l.includes("loan")) return "Liability";
	if (l.includes("investment") || l.includes("property")) return "Asset";
	if (l.includes("cash") || l.includes("wallet")) return "Cash";
	return "Bank Account";
}

export default SainoMCP.serve("/mcp", { binding: "MCP" });

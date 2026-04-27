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
	server = new McpServer({ name: "Saino Finance", version: "1.1.0" });

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
			"Delete a movement. If it's a transfer, also deletes the linked pair (breaks the cyclic FK first).",
			{ movementId: z.coerce.number().describe("Movement ID to delete") },
			async ({ movementId }) => {
				const m: any = await db.prepare("SELECT linked_movement_id FROM movements WHERE id = ?").bind(movementId).first();
				if (!m) return { content: [{ type: "text" as const, text: "Error: Movement not found" }] };

				const linkedId = m.linked_movement_id;
				if (linkedId) {
					// Break the cyclic FK before deleting — both rows reference each other,
					// so SQLite blocks either DELETE under default NO ACTION enforcement.
					await db.prepare("UPDATE movements SET linked_movement_id = NULL WHERE id = ?").bind(movementId).run();
					await db.prepare("UPDATE movements SET linked_movement_id = NULL WHERE id = ?").bind(linkedId).run();
					await db.prepare("DELETE FROM movements WHERE id = ?").bind(linkedId).run();
				}
				await db.prepare("DELETE FROM movements WHERE id = ?").bind(movementId).run();

				return { content: [{ type: "text" as const, text: `Deleted ${movementId}` + (linkedId ? ` + pair ${linkedId}` : "") }] };
			}
		);

		this.server.tool(
			"update_movement",
			"Update fields on an existing movement. Only the fields you pass are changed. For state transitions prefer update_movement_state; for PLANNED→FULFILLED prefer link_to_planned.",
			{
				movementId: z.coerce.number().describe("Movement ID to update"),
				title: z.string().optional(),
				notes: z.string().optional(),
				date: z.string().optional().describe("YYYY-MM-DD"),
				totalAmount: z.string().optional().describe("Total amount (negative for expense, positive for income)"),
				accountId: z.coerce.number().optional(),
				state: z.enum(MOVEMENT_STATES).optional(),
				budgetId: z.coerce.number().nullable().optional().describe("Pass null to detach from budget"),
				parentMovementId: z.coerce.number().nullable().optional(),
				linkedMovementId: z.coerce.number().nullable().optional(),
				labelsCsv: z.string().optional(),
			},
			async (args) => {
				const { movementId, ...updates } = args;
				const existing: any = await db.prepare("SELECT id FROM movements WHERE id = ?").bind(movementId).first();
				if (!existing) return { content: [{ type: "text" as const, text: "Error: Movement not found" }] };

				const fieldMap: Record<string, string> = {
					title: "title", notes: "notes", date: "date", totalAmount: "total_amount",
					accountId: "account_id", state: "state", budgetId: "budget_id",
					parentMovementId: "parent_movement_id", linkedMovementId: "linked_movement_id",
					labelsCsv: "labels_csv",
				};

				const sets: string[] = [];
				const params: any[] = [];
				for (const [key, col] of Object.entries(fieldMap)) {
					const v = (updates as any)[key];
					if (v !== undefined) {
						sets.push(`${col} = ?`);
						params.push(v);
					}
				}
				if (sets.length === 0) return { content: [{ type: "text" as const, text: "Nothing to update" }] };

				params.push(movementId);
				await db.prepare(`UPDATE movements SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
				return { content: [{ type: "text" as const, text: `Movement ${movementId} updated (${sets.length} field${sets.length > 1 ? "s" : ""})` }] };
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
			"Get current budget status: limit, spent, daily allowance, spending by category",
			{},
			async () => {
				const today = new Date().toISOString().split("T")[0];
				const budget: any = await db.prepare("SELECT * FROM budgets WHERE start_date <= ? AND end_date >= ? AND state = 'OPEN'").bind(today, today).first();
				if (!budget) return { content: [{ type: "text" as const, text: JSON.stringify({ hasBudget: false, message: "No active budget" }) }] };

				const spent: any = await db.prepare(`
					SELECT COALESCE(SUM(ABS(CAST(total_amount AS REAL))), 0) as total FROM movements
					WHERE budget_id = ? AND state = 'EXECUTED' AND CAST(total_amount AS REAL) < 0
				`).bind(budget.id).first();

				const totalSpent = spent?.total || 0;
				const limit = parseFloat(budget.spending_limit);
				const remaining = limit - totalSpent;
				const daysLeft = Math.max(1, Math.ceil((new Date(budget.end_date).getTime() - new Date(today).getTime()) / 86400000));

				const byCategory = await db.prepare(`
					SELECT c.name as category, SUM(CAST(me.amount AS REAL)) as total
					FROM movement_entries me JOIN movements m ON me.movement_id = m.id
					LEFT JOIN categories c ON me.category_id = c.id
					WHERE m.budget_id = ? AND m.state = 'EXECUTED' AND CAST(m.total_amount AS REAL) < 0
					GROUP BY me.category_id ORDER BY total DESC
				`).bind(budget.id).all();

				return { content: [{ type: "text" as const, text: JSON.stringify({
					hasBudget: true, period: `${budget.start_date} to ${budget.end_date}`,
					limit, spent: totalSpent, remaining, daysLeft,
					dailyAllowance: Math.round(Math.max(0, remaining / daysLeft)),
					percentUsed: Math.round((totalSpent / limit) * 100),
					byCategory: byCategory.results
				}, null, 2) }] };
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

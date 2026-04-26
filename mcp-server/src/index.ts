import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
	DB: D1Database;
	MCP: DurableObjectNamespace;
}

type State = {};

export class SainoMCP extends McpAgent<Env, State, {}> {
	server = new McpServer({ name: "Saino Finance", version: "1.0.0" });

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
				appliesGmf: z.boolean().default(false).describe("Whether GMF 4x1000 applies"),
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
			"Record an expense with one or more items. Each item has a category, amount, and optional quantity/unitPrice for price tracking.",
			{
				accountId: z.number().describe("Account ID"),
				date: z.string().describe("Date YYYY-MM-DD"),
				title: z.string().describe("Description (e.g., 'Almuerzo', 'Alkosto compras')"),
				items: z.array(z.object({
					categoryId: z.number().describe("Category ID"),
					amount: z.string().describe("Amount for this item"),
					memo: z.string().optional().describe("Item description (e.g., 'Arroz Diana 5kg')"),
					quantity: z.string().optional().describe("Quantity purchased"),
					unitPrice: z.string().optional().describe("Price per unit"),
					unitLabel: z.string().optional().describe("Unit label (kg, g, ml, u)"),
				})).describe("Line items"),
				notes: z.string().optional().describe("Optional notes"),
			},
			async ({ accountId, date, title, items, notes }) => {
				const totalAmount = items.reduce((sum, e) => sum + parseFloat(e.amount), 0);
				const account: any = await db.prepare("SELECT currency_code FROM accounts WHERE id = ?").bind(accountId).first();
				if (!account) return { content: [{ type: "text" as const, text: "Error: Account not found" }] };

				const result = await db.prepare(`
					INSERT INTO movements (state, account_id, total_amount, currency_code, date, title, notes)
					VALUES ('EXECUTED', ?, ?, ?, ?, ?, ?)
				`).bind(accountId, (-totalAmount).toString(), account.currency_code, date, title, notes || "").run();
				const movementId = result.meta.last_row_id;

				for (const entry of items) {
					await db.prepare(`
						INSERT INTO movement_entries (movement_id, category_id, amount, currency_code, memo, quantity, unit_price, unit_label)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					`).bind(movementId, entry.categoryId, entry.amount, account.currency_code,
						entry.memo || "", entry.quantity || null, entry.unitPrice || null, entry.unitLabel || null).run();
				}

				return { content: [{ type: "text" as const, text: `Expense recorded: "${title}" -$${totalAmount.toLocaleString()} (ID: ${movementId})` }] };
			}
		);

		this.server.tool(
			"record_income",
			"Record an income",
			{
				accountId: z.number().describe("Account ID"),
				date: z.string().describe("Date YYYY-MM-DD"),
				title: z.string().describe("Description (e.g., 'Salario marzo')"),
				amount: z.string().describe("Amount"),
				categoryId: z.number().describe("Category ID"),
				notes: z.string().optional().describe("Optional notes"),
			},
			async ({ accountId, date, title, amount, categoryId, notes }) => {
				const account: any = await db.prepare("SELECT currency_code FROM accounts WHERE id = ?").bind(accountId).first();
				if (!account) return { content: [{ type: "text" as const, text: "Error: Account not found" }] };

				const result = await db.prepare(`
					INSERT INTO movements (state, account_id, total_amount, currency_code, date, title, notes)
					VALUES ('EXECUTED', ?, ?, ?, ?, ?, ?)
				`).bind(accountId, amount, account.currency_code, date, title, notes || "").run();

				await db.prepare(
					"INSERT INTO movement_entries (movement_id, category_id, amount, currency_code) VALUES (?, ?, ?, ?)"
				).bind(result.meta.last_row_id, categoryId, amount, account.currency_code).run();

				return { content: [{ type: "text" as const, text: `Income recorded: "${title}" +$${parseFloat(amount).toLocaleString()} (ID: ${result.meta.last_row_id})` }] };
			}
		);

		this.server.tool(
			"record_transfer",
			"Record a transfer between accounts. Supports cross-currency.",
			{
				fromAccountId: z.number().describe("Source account ID"),
				toAccountId: z.number().describe("Destination account ID"),
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
			"List movements for a period, optionally filtered by account or state. Supports ordering and pagination for large result sets.",
			{
				startDate: z.string().describe("Start date YYYY-MM-DD"),
				endDate: z.string().describe("End date YYYY-MM-DD"),
				accountId: z.number().optional().describe("Filter by account (omit for all)"),
				state: z.string().optional().describe("Filter by state: EXECUTED, PLANNED, TEMPLATE, VOIDED, SKIPPED, FULFILLED"),
				order: z.enum(["asc", "desc"]).default("desc").describe("Sort order by date"),
				limit: z.number().default(100).describe("Max rows to return (default 100, max 1000)"),
				offset: z.number().default(0).describe("Pagination offset"),
			},
			async ({ startDate, endDate, accountId, state, order, limit, offset }) => {
				let query = `SELECT m.*, a.name as account_name FROM movements m JOIN accounts a ON m.account_id = a.id WHERE m.date BETWEEN ? AND ?`;
				const params: any[] = [startDate, endDate];
				if (accountId) { query += " AND m.account_id = ?"; params.push(accountId); }
				if (state) { query += " AND m.state = ?"; params.push(state); }
				const dir = order === "asc" ? "ASC" : "DESC";
				const cappedLimit = Math.min(limit, 1000);
				query += ` ORDER BY m.date ${dir}, m.id ${dir} LIMIT ? OFFSET ?`;
				params.push(cappedLimit, offset);

				const movements = await db.prepare(query).bind(...params).all();
				for (const m of movements.results as any[]) {
					const entries = await db.prepare(`
						SELECT me.*, c.name as category_name FROM movement_entries me
						LEFT JOIN categories c ON me.category_id = c.id WHERE me.movement_id = ?
					`).bind(m.id).all();
					m.entries = entries.results;
				}

				return { content: [{ type: "text" as const, text: JSON.stringify(movements.results, null, 2) }] };
			}
		);

		this.server.tool(
			"delete_movement",
			"Delete a movement. If it's a transfer, deletes both sides.",
			{ movementId: z.number().describe("Movement ID to delete") },
			async ({ movementId }) => {
				const m: any = await db.prepare("SELECT * FROM movements WHERE id = ?").bind(movementId).first();
				if (!m) return { content: [{ type: "text" as const, text: "Error: Movement not found" }] };
				if (m.linked_movement_id) await db.prepare("DELETE FROM movements WHERE id = ?").bind(m.linked_movement_id).run();
				await db.prepare("DELETE FROM movements WHERE id = ?").bind(movementId).run();
				return { content: [{ type: "text" as const, text: `Deleted ${movementId}` + (m.linked_movement_id ? ` + pair ${m.linked_movement_id}` : "") }] };
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
				parentId: z.number().optional().describe("Parent category ID"),
			},
			async ({ name, categoryType, parentId }) => {
				const result = await db.prepare("INSERT INTO categories (name, category_type, parent_id) VALUES (?, ?, ?)")
					.bind(name, categoryType, parentId || null).run();
				return { content: [{ type: "text" as const, text: `Category "${name}" created (ID: ${result.meta.last_row_id})` }] };
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
				accountId: z.number().optional().describe("Filter by account"),
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
				limit: z.number().default(20).describe("Max results"),
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

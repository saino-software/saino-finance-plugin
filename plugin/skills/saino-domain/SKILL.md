---
name: saino-domain
description: Use when the user asks anything about their personal finances in Saino — registering money in/out, querying balances, budgets, categories, prices, or accounts. Triggered by mentions of "gasté", "compré", "transferí", "balance", "presupuesto", "categoría", or any Saino MCP tool call.
---

# Saino Finance Domain

Saino is a personal finance system. Every financial event is a **Movement**. The data lives in a Cloudflare D1 database accessed through the `saino-finance` MCP server (tools prefixed `mcp__saino-finance__`).

## Core concept: Movement

A movement is any financial event. There is no separate concept for "transactions", "transfers", "planned expenses", or "subscriptions" — they are all movements distinguished by **state**:

| State | Affects balance? | Meaning |
|---|---|---|
| `EXECUTED` | Yes | A real money movement that happened |
| `PLANNED` | No | An expected future movement inside a budget |
| `TEMPLATE` | No | A recurring pattern (subscription, installment plan) that generates PLANNEDs |
| `VOIDED` | No | An EXECUTED movement that was reversed |
| `SKIPPED` | No | A PLANNED movement the user chose not to do |
| `FULFILLED` | No | A PLANNED movement marked as done by the user (even if partially) |

**Key invariant**: `movements.total_amount = SUM(movement_entries.amount)` for that movement. The total is denormalized for fast balance queries.

## Sign convention

- `total_amount < 0` → expense or transfer outgoing
- `total_amount > 0` → income or transfer incoming

## Movements have entries

A single movement can span multiple categories. Example: an Alkosto receipt is one movement with line items for Comida, Aseo, Higiene Personal. Each line item is a row in `movement_entries` with its own category, amount, optional quantity/unit_price for price tracking.

**Rule**:
- For account balance / total spent → query `movements.total_amount`
- For category breakdown / price tracking → query `movement_entries.amount` (or `unit_price`)

## Transfers are ATOMIC PAIRS

A transfer between two accounts is **two linked movements**, never one. The outgoing side has negative amount in source currency; the incoming side has positive amount in destination currency. They are linked via `linked_movement_id`. Always create, edit, void, and delete them together.

For details, see the `working-with-transfers` skill.

## Budgets

A budget has a period (month) and a spending limit. PLANNED movements link to a budget via `budget_id`. The budget tracks daily allowance, alerts at 50/75/90/100%, and grouping of planned items.

For details, see the `managing-budgets` skill.

## Recurring movements and credit card installments

A TEMPLATE movement with a `recurrence_frequency` generates PLANNED movements when budgets open. Credit card purchases with installments are TEMPLATEs that store the installment amount (capital per cuota) and annual interest rate.

For details, see the `understanding-recurring` skill.

## When the user mentions...

| User says | You probably need |
|---|---|
| "registra un gasto" / "compré X" | `record_expense` (see `recording-movements`) |
| "transferí" / "pagué la tarjeta" | `record_transfer` (see `working-with-transfers`) |
| "cómo voy con el presupuesto" / "cuánto puedo gastar" | `budget_status` (see `managing-budgets`) |
| "qué tan caro está el arroz" / "cómo cambió el precio" | `price_history` (see `reporting-and-stats`) |
| "cuánto gasté en comida" / "gastos por categoría" | `spending_by_category` (see `reporting-and-stats`) |
| "lista mis cuentas" / "cuál es mi balance" | `list_accounts` |
| "qué transacciones tengo en X" | `list_movements` |
| "borra esta cuenta vieja" | `delete_account({ accountId, reassignToAccountId? })` — refuses if movements exist; pass reassign to migrate them (account_id is NOT NULL — there's no detach option) |
| "crea un budget para X mes" / "cierra el mes" | `create_budget` / `close_budget` / `activate_budget` (see `managing-budgets`) |
| "agrega esta nueva suscripción / cuota" | `create_template` (see `understanding-recurring`) |
| "corrige el monto de este movement" | `update_movement` — pass `items` to also replace entries (avoids `total_amount`/entries drift) |

## Always

- **Confirm before destructive ops** (delete, edit). Don't just do it because the user mentioned it.
- **Use ISO dates** (`YYYY-MM-DD`) when calling tools.
- **Default currency is COP** (Colombian Peso) unless the user says otherwise.
- **Account IDs are opaque numbers**. List accounts first if you don't know which ID to use.
- **Categorize thoughtfully** when registering a multi-line expense. List categories if unsure (`list_categories`), but don't over-fragment — a $50k almuerzo is one entry under "Comer fuera", not three.

## Never

- Compute account balance from entries. Use `movements.total_amount`.
- Compute category spend from `movements`. Use `movement_entries.amount` (a single movement may cover multiple categories).
- Treat a transfer as a single movement. It is always a pair.
- Add IVA on top of prices when registering Colombian receipts. Retail prices on the receipt **already include IVA** — the line totals after discount are what the customer paid.
- Touch movements with `state = TEMPLATE` as if they were real expenses. They never affect balance.

---
name: reporting-and-stats
description: Use when the user asks for spending analysis, category breakdowns, price trends, month-over-month comparisons, or any aggregated finance report. Triggered by "cuánto gasté en", "qué tan caro está", "comparado con el mes pasado", "tendencia", "top gastos", "subió el precio de".
---

# Reporting and Stats

Pick the right tool — the tools already aggregate correctly. See `saino-domain` for the underlying model.

## Tool selection (the rule)

| Question | Tool | Source |
|---|---|---|
| Account balance / total spent on account | `list_accounts` | `movements.total_amount` |
| Category breakdown | `spending_by_category` | `movement_entries.amount` |
| Price-per-unit over time | `price_history` | `movement_entries.unit_price` |
| Browse / list transactions | `list_movements` | both |

Multi-category movements (e.g. Alkosto factura) get **undercounted** if you sum `total_amount` per category yourself. Always use `spending_by_category` for breakdowns.

## `spending_by_category`

```typescript
spending_by_category({ startDate, endDate, accountId? })
// → { period, grandTotal, categories: [{ category, total, tx_count, percentage }] }
```

`tx_count` is `COUNT(DISTINCT movement_id)` — handy for "how many trips to the supermarket".

## `price_history`

```typescript
price_history({ search: "arroz", limit?: 20 })
// → rows DESC by date with quantity, unit_price, unit_label, amount
```

Only returns entries where `unit_price IS NOT NULL`. If empty, suggest the user record quantity/unit on next purchase (see `recording-movements`).

## `list_movements`

```typescript
list_movements({
  startDate, endDate,
  accountId?, state?,
  order?: "asc"|"desc",  // default desc
  limit?: number,         // default 100, max 1000
  offset?: number
})
```

Each movement returned with entries embedded. Paginate large ranges.

## `list_accounts`

Returns each account with computed balance (`opening_balance + sum of EXECUTED movements`). Use for net worth, current card debt, finding account IDs.

## Composing reports

| Request | Steps |
|---|---|
| Compare months | `spending_by_category` ×2, diff in your response |
| Top N expensive items YTD | `list_movements` (paginate) → sort entries by `abs(amount)` |
| Overspend vs average | `spending_by_category` for current + last 3-6 months → average |

## Currency

`spending_by_category` doesn't auto-convert. For mixed USD/COP, show per-currency subtotals. Default account is COP.

## Time defaults

- "este mes" / "cómo voy" → 1st of current month → today
- "el mes pasado" → 1st → last day of previous month
- "este año" → Jan 1 → today
- Unclear → ask, don't guess

## Anti-patterns

- ❌ Summing `total_amount` per category yourself — undercounts multi-category movements. Use `spending_by_category`.
- ❌ Computing balance from `list_movements`. Use `list_accounts`.
- ❌ Pulling all movements to answer category questions. One `spending_by_category` call beats paginated `list_movements`.
- ❌ Expecting `price_history` to return data when user logged a flat amount (no quantity/unit_price).
- ❌ Mixing currencies in a single total without conversion.

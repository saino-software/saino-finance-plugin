---
name: managing-budgets
description: Use when the user asks how their monthly budget is going, what they can spend today, what's planned for the month, or wants to plan a future expense. Triggered by "cómo voy", "cuánto me queda", "cuánto puedo gastar", "tengo planeado", "presupuesto", "me alcanza para".
---

# Managing Budgets

A budget = period (month) + spending limit + planned items + alerts. Powers daily allowance.

## Lifecycle

| Phase | What happens |
|---|---|
| **Open** | TEMPLATEs (subscriptions, installments) auto-generate PLANNED items for the period |
| **Active** | User records EXECUTED movements; some link to PLANNED via `parent_movement_id`. Alerts fire at 50/75/90/100% |
| **Close** | Unfulfilled PLANNEDs become `state=SKIPPED` (NOT VOIDED — skipped = "didn't happen", voided = "I reversed something I did") |

## `budget_status` — most-used tool

Returns `{ hasBudget, period, limit, spent, remaining, daysLeft, dailyAllowance, percentUsed, byCategory }`.

Call whenever user asks "cómo voy", "cuánto puedo gastar".

If `hasBudget=false`, no active budget — record movements still works, but daily allowance / alerts / planned items don't.

## Daily allowance

```
dailyAllowance = max(0, (limit - totalSpent) / daysRemaining)
```

`totalSpent` includes:
- All EXECUTED movements with this `budget_id`, negative `total_amount`
- **Plus** transfers TO liability accounts during period (debt payments)

Excludes: income, asset-to-asset transfers, VOIDED, movements with no `budget_id`.

## Planned items

A PLANNED movement is intent (future expected expense), not history. Linked to budget via `budget_id`. Never affects balance.

**Sources** (derived from parent TEMPLATE, not stored as enum):
- Manual (`parent_movement_id IS NULL`)
- Auto-subscription (parent is recurring TEMPLATE)
- Auto-credit-card (parent is installment TEMPLATE)
- Auto-loan (parent is loan TEMPLATE)

**Fulfillment**: link an EXECUTED to a PLANNED by setting `parent_movement_id`. Supports partial (sum of EXECUTEDs < planned) and multiple EXECUTEDs per PLANNED.

**Progress** (calculated, not stored):
- `PENDING` — no children, date ≥ today
- `OVERDUE` — no children, date < today
- `PARTIAL` — sum of children > 0 and < planned
- `COMPLETED` — sum ≥ planned, OR `state=FULFILLED`

## Alerts

`alert_50/75/90/100` flags fire once per period when crossed. Won't re-notify if you go below and back up.

## Common queries

| User says | You do |
|---|---|
| "Cómo voy este mes" | `budget_status` |
| "Cuánto me queda hoy" | `budget_status` → `dailyAllowance` |
| "Cuánto en comida" | `budget_status.byCategory`, or `spending_by_category` for detail |
| "Qué tengo planeado" | `list_movements` with `state=PLANNED`, date range |
| "Cancelar Netflix" | Find recurring TEMPLATE via `list_movements state=TEMPLATE`, then `update_movement_state({ movementId, state: "VOIDED" })` to stop generating PLANNEDs without losing history |

## Anti-patterns

- ❌ Adding planned amounts to `spent` to estimate "future spent". `spent` is past, not projected.
- ❌ Counting VOIDED / SKIPPED as spending.
- ❌ Manually computing `dailyAllowance` instead of using `budget_status` — you'll forget to count debt payments.
- ❌ Creating a PLANNED without `budget_id`. Floats, never appears in reports.
- ❌ Filling planned items as `state=EXECUTED`. They're intent, not history.

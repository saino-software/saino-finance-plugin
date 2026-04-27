---
name: reconciling-statements
description: Use when the user pastes or uploads a batch of bank or credit card movements for review and registration. Triggered by "estos son los movimientos", "extracto", "pásame estas transacciones", a long list of dated amounts, or a PDF/CSV of an account statement.
---

# Reconciling Statements

Batch workflow for registering 2-week / monthly statements. Process-heavy. **Follow phases in order. Pause for user confirmation between phases. Never register anything without confirmation.**

## Phase 1 — Normalize & triage

Build a markdown table from the input (paste / PDF / CSV / verbal): `date | description | amount | account | proposed category | notes`.

Triage by amount:

| Range | Strategy |
|---|---|
| ≲ $50k | Single-item expense, quick batch |
| $50k–$500k | Single-item, but ask if multi-category. Match to TEMPLATEs if recurring |
| ≳ $500k or supermarket / dept. store | **Drill in** — likely multi-category factura. Ask for the receipt |

Skip transfers and known recurring (they have their own flow).

## Phase 2 — Dedupe

Call `list_movements` for the period + account. Cross-reference: same date + same amount + similar description → likely duplicate, skip. Critical because the user may have registered things during the period.

## Phase 3 — Categorize per account

**One account at a time.** Don't jump between accounts — category context is account-specific (Rappi on TC vs Cash means different things).

For each tx: propose category, mark uncertain ones with `?`. Show as a markdown table for confirmation BEFORE registering.

## Phase 4 — Drill into large purchases

For each "large" tx flagged in Phase 1:

1. Ask for the receipt: "¿tienes la factura de Alkosto del 15?"
2. Parse into items, map each to a category.
3. Build the `items` array for `record_expense`.
4. Show preview table: `Producto | Cant | Categoría | Total`.
5. Wait for confirmation, then register.

For weighed/measurable items (kg, L, u), fill `quantity` + `unit_price` + `unit_label` so price tracking works.

## Phase 5 — Register in batches

After Phase 3 batch is confirmed: loop through txs in chronological order, call `record_expense` / `record_income` / `record_transfer`. Collect movement IDs for the final summary.

## Phase 6 — Reconcile against budget

After all registered:
- `budget_status` → show updated daily allowance
- Highlight new alerts triggered (50/75/90/100%)
- `spending_by_category` for the period → show impact
- Diff against prior months → flag overspending

## Phase 7 — Link fulfilled planned items

For each new EXECUTED, suggest matches against active PLANNEDs:
- `list_movements` with `state=PLANNED` for active budget
- Match by category + amount + date proximity
- Confirm with user before linking

Then call `link_to_planned({ executedMovementId, plannedMovementId })` — sets `parent_movement_id` on the executed and marks the planned as `FULFILLED` in one step.

## Phase 8 — Summary

End with: total registered (per account), period total spent, budget impact (before/after `dailyAllowance`), anomalies worth flagging.

## Pacing

Long workflow. Pause between phases. The user may need to look up a receipt mid-conversation. Don't dump everything at once.

## STOP and ask when

- Multiple plausible categories (Rappi → Comer fuera vs Mercado)
- "Large" purchase without receipt — drill in or accept as single-line, user's call
- Tx doesn't match any account in system
- Looks like a duplicate but slightly different

## MOVE FAST when

- Recurring with clear TEMPLATE match
- Small consistent expenses (parking, lunch) with obvious category
- Already-confirmed batch in this conversation

## Anti-patterns

- ❌ Auto-register without confirmation. He needs to verify, especially ambiguous ones.
- ❌ Treat $1.5M Alkosto as a single "Compras" line. Always drill in.
- ❌ Skip dedupe. Pollutes the budget.
- ❌ Mix accounts in a single round-trip.
- ❌ Forget the budget impact summary at the end.
- ❌ Treat a transfer to MasterCard as just a transfer. It IS spending (debt payment) — see `working-with-transfers`.
- ❌ Add IVA on top of receipt totals. Colombian retail prices already include IVA.

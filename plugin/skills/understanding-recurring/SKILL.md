---
name: understanding-recurring
description: Use when the user asks about subscriptions, recurring expenses, credit card installments, cuotas, loan payments, or anything that repeats on a schedule. Triggered by "suscripciones", "cuotas", "cuánto debo en X tarjeta", "préstamo", "Netflix mensual", "cancelar suscripción", "compré a 12 cuotas".
---

# Recurring Movements & Installments

A TEMPLATE represents a repeating pattern. Never affects balance. When a budget opens, generates a PLANNED for that period.

## Two TEMPLATE flavors

### 1. Simple recurring (Netflix, gym, rent)

```
state=TEMPLATE
account_id, total_amount: -45000
recurrence_frequency: MONTHLY
recurrence_day: 15
(no installment fields — runs forever until cancelled)
```

### 2. Credit card installment (compras a cuotas)

```
state=TEMPLATE
account_id: <credit card>
parent_movement_id: <original purchase EXECUTED>
total_amount: -150000  (capital per cuota, French amortization)
recurrence_frequency: MONTHLY
recurrence_count: 12          (total cuotas)
recurrence_rate: 0.28         (annual interest)
installment_amount: 150000    (stored — needed at budget open before children exist)
```

The original purchase is a separate EXECUTED movement that hit the card balance immediately. The TEMPLATE is the **plan to pay it off**.

## TEMPLATE lifecycle

| State | Meaning |
|---|---|
| TEMPLATE | Active, generating PLANNEDs |
| VOIDED | Cancelled. Stops generating. Existing PLANNEDs in current period stay |
| FULFILLED | (Installments) all cuotas paid off |

Cancel via state change (no `edit_movement` yet — workaround: delete, but loses history).

## Installment math (calculated, not stored)

- `currentInstallment` = count of EXECUTED children with `parent_movement_id = template`
- `remainingBalance` = `(recurrence_count - currentInstallment) * installment_amount`
- `isPaidOff` = `currentInstallment >= recurrence_count`

`installment_amount` is **stored** because budget opening needs it before any EXECUTEDs exist for the new month.

## Credit card monthly payment

Budget opening generates ONE composite PLANNED per card with three entries:

| Component | Source |
|---|---|
| Capital | SUM of all active TEMPLATEs' `installment_amount` due this month |
| Interest | `current_card_balance * monthly_rate` |
| Insurance | Card-level fixed monthly charge |

**Insurance is per CARD, not per installment.** A card with 3 active installment plans = 1 insurance charge/month, not 3.

## Paying the card

> "Pagué $1.5M a MasterCard desde Ahorros BBVA"

Single `record_transfer`. Payment is distributed FIFO across pending cuotas:
1. Capital → reduces card debt (already in transfer)
2. Interest + insurance → real expenses, budget by category
3. Each cuota's capital share paid oldest-first

No `pay_credit_card` tool yet. For now: record the transfer; user marks cuotas manually.

## Loans

Like installments but simpler: one TEMPLATE per loan, monthly PLANNED, each payment is a transfer to the loan account. No insurance, no card-level aggregation.

## Common queries

| User says | You do |
|---|---|
| "Cuáles son mis suscripciones" | `list_movements state=TEMPLATE`, filter `recurrence_count IS NULL` (vs installments) |
| "Cuántas cuotas me quedan en X" | Find installment TEMPLATE, count EXECUTED children, subtract from `recurrence_count` |
| "Cuánto debo en MasterCard" | `list_accounts` → card balance (already aggregates) |
| "Qué cuotas pago este mes" | `list_movements state=PLANNED` for current budget |

## Anti-patterns

- ❌ Treating TEMPLATE as an actual expense. Never affects balance.
- ❌ Recording each cuota as separate tx without `parent_movement_id`. Breaks installment progress tracking.
- ❌ Adding insurance per installment. It's per card, per month.
- ❌ Computing installment amount on the fly from balance + rate. Use stored `installment_amount`.
- ❌ Deleting a TEMPLATE with EXECUTED children. Orphans them. Cancel via state, don't delete.

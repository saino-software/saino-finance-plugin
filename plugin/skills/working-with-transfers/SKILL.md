---
name: working-with-transfers
description: Use when the user mentions moving money between accounts, paying a credit card or loan, sending money abroad, withdrawing cash from an ATM, or any movement that involves two accounts. Triggered by "transferí", "pasé", "mandé", "pagué la tarjeta", "abono", "retiré del cajero".
---

# Working with Transfers

A transfer is **never one movement**. Always **two linked movements** — created, edited, voided, deleted together. Atomic pair.

## Anatomy

| Field | Outgoing | Incoming |
|---|---|---|
| `account_id` | Source | Destination |
| `total_amount` | Negative, source currency | Positive, dest currency |
| `linked_movement_id` | → incoming ID | → outgoing ID |
| Entries | One, `category_id = NULL` | Same |

Both share `date`, `title`, `notes`. `record_transfer` inserts both atomically.

## Same-currency

```typescript
record_transfer({
  fromAccountId, toAccountId,
  amount: "500000",
  date: "2026-04-26",
  title: "Transfer a Nequi"
})
// Both sides ±500000 COP. No `toAmount` needed.
```

## Cross-currency

```typescript
record_transfer({
  fromAccountId, toAccountId,
  amount: "200",          // USD leaving
  toAmount: "840000",     // COP arriving
  date, title
})
// Exchange rate (toAmount/amount) is derived, not stored.
```

## Transfers as DEBT PAYMENTS — critical for budget math

When destination is a **liability account** (credit card, loan), the outgoing side counts as **spending** in the active budget — even though it's technically a transfer.

| Source → Dest | Counts as spending? |
|---|---|
| Bancolombia → MasterCard (paying card) | **Yes** |
| Bancolombia → Préstamo BBVA (paying loan) | **Yes** |
| Bancolombia → Nequi (asset to asset) | No |
| Cash → Ahorros (deposit) | No |

Liability = `account_types.group_name = 'Liability'`.

## GMF (4x1000)

If source has `applies_gmf=true`, bank charges 0.4%. MCP does NOT auto-add. Register as separate expense, category "Impuestos / GMF", amount = `transfer * 0.004`.

## Edit / delete

`delete_movement({ movementId })` — auto-deletes the linked pair. Call once with either side's ID.

No `edit_movement` exists yet. To change a transfer: delete + recreate.

## Quick reference

| Scenario | Action |
|---|---|
| Pay credit card | `record_transfer` (bank → card) |
| Pay a loan | `record_transfer` (bank → loan account) |
| Move savings → checking | `record_transfer` (both asset; not spending) |
| Send USD abroad | `record_transfer` with `toAmount` |
| ATM withdrawal | `record_transfer` (bank → Cash account) |
| Receive money from someone | `record_income`, or `record_transfer` from Receivable |

## Anti-patterns

- ❌ `record_expense` outgoing + `record_income` incoming as two separate movements. They're structurally linked.
- ❌ Editing one side and leaving the other untouched.
- ❌ Treating Bancolombia → Nequi as spending. It is NOT.
- ❌ Forgetting that Bancolombia → MasterCard IS spending (debt payment).
- ❌ Computing the FX rate manually for cross-currency. Pass both `amount` and `toAmount`; let the system derive.

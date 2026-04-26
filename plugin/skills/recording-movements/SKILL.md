---
name: recording-movements
description: Use when the user wants to register a new expense, income, or receipt — a single purchase, a supermarket factura, pharmacy, restaurant, salary, or anything that affects an account balance. Triggered by "gasté", "compré", "pagué" (not "pagué la tarjeta" — that's a transfer), "recibí", "me llegó", or pasting a receipt.
---

# Recording Movements

Creates new EXECUTED movements. For transfers see `working-with-transfers`. Domain basics in `saino-domain`.

## Two flows

| Input | Tool call shape |
|---|---|
| Quick spend ("85k almuerzo Nequi") | `record_expense` with one item |
| Multi-item factura (Alkosto, Carulla, pharmacy with mixed categories) | `record_expense` with `items` array, one per product/category |
| Income (salary, refund) | `record_income` (single category, positive sign auto) |

## `record_expense`

```typescript
record_expense({
  accountId, date,        // YYYY-MM-DD
  title,                  // "Almuerzo Rappi", "Alkosto compras"
  items: [{
    categoryId,
    amount,               // line total (already discounted, IVA-included for CO retail)
    memo?,                // "Arroz Diana 5kg"
    quantity?, unitPrice?, unitLabel?  // for price tracking
  }],
  notes?
})
```

Tool sums `items[].amount`, stores movement with `total_amount = -sum`, inserts each item as `movement_entry`.

## When to fill quantity/unitPrice/unitLabel

**Fill** for measurable things you'll buy again — groceries (kg/L), gas (gal), anything where price-per-unit matters over time.

**Skip** for one-off services — lunch, haircut, parking. No "unit" to compare.

Weighed item example: `quantity="1.86", unitLabel="kg", unitPrice="10140", amount="18860"`.

**Canonical units**: prefer `kg`, `L`, `gal`, `u`. Convert before storing — `700ml` → `quantity="0.7", unitLabel="L"`. Mixing `ml` and `L` for the same product breaks `price_history` joins.

Without quantity/unitPrice, `price_history` returns nothing for the product.

## GMF (4x1000)

Colombian banks tax outgoing money from `applies_gmf=true` accounts (debit accounts like Bancolombia) at 0.4%. **Credit cards never trigger GMF** — they're not source-of-funds. Tool does NOT auto-add. If user mentions it or you see it on a statement, register as a separate item with category "Impuestos / GMF".

## Shorthand normalization

Colombian Spanish uses informal shorthand for amounts. Normalize before passing to the tool:
- `"85k"`, `"85 mil"` → `"85000"`
- `"2 lucas"`, `"2M"`, `"2 millones"` → `"2000000"`
- `"1.5M"` → `"1500000"`

## Categorize thoughtfully

**Don't over-fragment**:
- ❌ Lunch as 3 items (plato + bebida + postre)
- ✅ Lunch as 1 item, "Comer fuera"

**Do split** when categories genuinely differ:
- Supermarket: food + cleaning + cosmetics → 3 items, 3 categories
- Pharmacy: medicines + snacks → 2 items

Call `list_categories` once at start of conversation, cache the relevant IDs.

## Account selection

Call `list_accounts` once to find IDs by name (case-insensitive substring match). If multiple match, ask. Common: Bancolombia, Nequi, Daviplata, MasterCard Falabella, Mastercard Davivienda, Cash COP.

## Confirmation policy

| Input | Confirm before saving? |
|---|---|
| Single-item quick spend ("85k almuerzo Nequi") | No — just register |
| Multi-item factura, multiple categories | **Yes** — show parsed table, wait for "ok" |
| Anything you had to guess a category for | Yes — confirm just the ambiguous lines |

Wrong multi-item imports are expensive to fix. Wrong single-item is one `delete_movement` away.

## Anti-patterns

- ❌ Adding IVA on top of receipt totals. CO retail prices already include IVA — line totals after discount are what was paid.
- ❌ Calling `record_expense` for a transfer (use `record_transfer`, see `working-with-transfers`).
- ❌ Passing `amount` as number instead of string. The MCP expects strings.
- ❌ Fragmenting a single-purpose purchase into multiple items "to be safe". Over-categorization breaks reports.
- ❌ Skipping quantity/unitPrice on staples — loses price-tracking signal forever for that purchase.

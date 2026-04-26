# Transfers — Functional Specification

**Status:** Draft
**Date:** 2026-04-07
**Depends on:** movement-unification.md (Movement aggregate, Entry, state lifecycle)

---

## What is a Transfer?

A transfer represents money moving from one account to another. Unlike an expense or an income, a transfer is not a single movement. It is always a **pair** of movements: one outgoing from the source account and one incoming to the destination account. These two movements are permanently linked and behave as a single unit for every operation the user performs.

The outgoing side carries a negative amount (money leaving the source account). The incoming side carries a positive amount (money arriving at the destination account). Together, the pair is a net-zero event in the user's total wealth -- money did not appear or disappear, it just changed location.

### The atomic pair rule

The two sides of a transfer are always created together, edited together, voided together, and deleted together. There is no valid state in which one side exists without the other. Any operation that touches one side must also touch its linked counterpart. The system enforces this atomically -- if either side fails, neither side is applied.

---

## Same-Currency Transfers

When both accounts use the same currency, the transfer is straightforward. Both sides carry the same amount.

**Example:** The user moves $500,000 COP from Ahorros BBVA to Nequi. The system creates:

- An outgoing movement of -$500,000 COP on Ahorros BBVA
- An incoming movement of +$500,000 COP on Nequi

The user only needs to enter the amount once. The system copies it to both sides.

---

## Cross-Currency Transfers

When the source and destination accounts have different currencies, each side records the amount in its own account's currency. The user must provide both amounts because only they know the actual rate their bank applied.

**Example:** The user sends $200 USD from Checking (USD) to Nequi (COP), and Nequi receives $840,000 COP. The system creates:

- An outgoing movement of -$200 USD on Checking
- An incoming movement of +$840,000 COP on Nequi

The app derives the implied exchange rate from these two amounts ($840,000 / $200 = 4,200 COP per USD) and displays it for the user's reference. The exchange rate is never stored -- it is always calculated from the two amounts. If the user changes either amount, the displayed rate updates immediately.

### Entering cross-currency amounts

On the transfer form, the app detects that the two selected accounts have different currencies and shows two amount fields. The user may fill them in any order. As long as both amounts are provided, the transfer is valid. If the user changes one amount, the other does not auto-adjust -- both are independent inputs. The user controls both sides.

---

## Creating a Transfer

The user selects "Transfer" as the movement type, then chooses:

1. **Source account** -- where the money leaves
2. **Destination account** -- where the money arrives
3. **Amount** -- a single amount for same-currency, or two amounts for cross-currency
4. **Date** -- the date the transfer occurred (or is expected to occur)
5. **Notes** -- optional free-text description

The system creates both movements atomically and links them to each other.

Transfers do not require a category. The entries on each side have a null category by default, because a transfer is not spending -- it is a reallocation.

---

## Editing a Transfer

When the user opens a transfer for editing, the app presents a unified form showing both sides. Edits always apply to both movements as a single operation.

### What can be changed

**Amount:** The user can change the amount on either side. In a same-currency transfer, changing the amount updates both sides. In a cross-currency transfer, the user can adjust either side independently, and the implied exchange rate recalculates.

**Date:** Changing the date updates both sides to the same new date. A transfer always has one date -- both movements share it.

**Notes:** The user can update the notes. Both sides share the same notes.

**Source account:** The user can change which account the money leaves from. If the new source account has a different currency than before, the transfer may become cross-currency (or return to same-currency), and the app adjusts the form accordingly:

- If the transfer was same-currency and the new source has a different currency than the destination, the app prompts for a second amount.
- If the transfer was cross-currency and the new source now matches the destination's currency, the transfer becomes same-currency and the app collapses to a single amount field, keeping the destination amount.

**Destination account:** Same logic as changing the source account, but in reverse.

### What cannot be changed

A transfer cannot be converted into a regular expense or income. If the user wants to do that, they must delete the transfer and create a new movement. Similarly, a regular expense or income cannot be converted into a transfer.

---

## Deleting a Transfer

Deleting a transfer removes both movements from the system. The user sees a single delete action; behind the scenes, both the outgoing and incoming movements are deleted together. If the transfer had an associated GMF charge (described below), that charge is also deleted.

There is no way to delete just one side of a transfer.

---

## Voiding a Transfer

Voiding is a soft-delete: the movements remain in the system for historical reference, but they stop affecting account balances. When the user voids a transfer, both sides move to the voided state simultaneously. If there was a GMF charge, it is also voided.

A voided transfer can be distinguished from an active one in the transaction list, but the user does not need to manage the two sides independently.

---

## GMF (Gravamen a los Movimientos Financieros)

### What is GMF?

GMF is a Colombian financial tax, commonly known as the "4x1000" (four per thousand). It applies to withdrawals and outgoing transfers from certain bank accounts. The tax rate is 0.4% of the outgoing amount. For example, a $1,000,000 COP transfer from a taxed account incurs a $4,000 COP GMF charge.

### Which accounts are affected?

Each account has a property indicating whether GMF applies. The user sets this when creating or editing an account. Most Colombian savings and checking accounts are subject to GMF, but some accounts are exempt (for example, one savings account per person can be declared GMF-exempt up to a monthly limit, and digital wallets like Nequi or Daviplata are typically exempt).

### How GMF works on transfers

When a transfer goes **out** from an account marked as "applies GMF," the system automatically calculates the 4x1000 tax and creates a **separate expense movement** for the GMF charge. This expense is linked to the transfer but is not part of the transfer pair itself. It stands on its own as an expense on the source account, categorized under a system-defined GMF category.

**Example:** The user transfers $1,000,000 COP from Ahorros BBVA (GMF applies) to Nequi. The system creates:

- Outgoing movement: -$1,000,000 COP on Ahorros BBVA
- Incoming movement: +$1,000,000 COP on Nequi
- GMF expense: -$4,000 COP on Ahorros BBVA (category: GMF / Impuestos)

The GMF charge is calculated as: outgoing amount multiplied by 0.004, rounded to the currency's standard precision.

### GMF on edit

When the user edits a transfer:

- **Amount changes:** If the outgoing amount changes, the GMF charge recalculates to match the new amount.
- **Source account changes to a GMF account:** If the original source was exempt but the new source applies GMF, the system creates the GMF expense.
- **Source account changes away from a GMF account:** If the original source applied GMF but the new source is exempt, the system deletes the GMF expense.
- **Source account stays the same:** The GMF charge persists, recalculated if the amount changed.

### GMF on delete and void

When a transfer is deleted, any associated GMF charge is also deleted. When a transfer is voided, any associated GMF charge is also voided. The GMF charge follows the lifecycle of its parent transfer.

### GMF on regular expenses

GMF is not exclusive to transfers. When the user records a regular expense from a GMF account, the same 4x1000 charge applies. The behavior is identical: a separate GMF expense movement is created alongside the original expense, and it follows the same edit/delete/void rules.

---

## Transfers as Debt Payments

### The budget problem with liability accounts

In a typical budget, an expense reduces the user's available spending money. A transfer between two asset accounts (like savings to checking) does not -- it is just moving money around. However, transfers **to liability accounts** (credit cards, loans) behave more like spending from the budget's perspective.

When the user pays their credit card bill by transferring money from checking to the credit card, their available cash decreases. Even though the money did not leave the user's net worth (it reduced a debt), the cash that was available for daily spending is now gone. The budget's daily allowance should reflect this reduction.

### How it works

When a transfer's destination is a **liability account** (an account with a negative-balance nature, such as a credit card or a loan), the outgoing side of the transfer counts as spending for budget purposes. Specifically:

- The outgoing movement is included in the budget's "total spent" calculation.
- This means the daily allowance (remaining budget divided by remaining days) decreases when the user pays a credit card bill.
- The user sees the payment reflected in their budget summary alongside regular expenses.

This only applies to the outgoing side. The incoming side (the credit card receiving the payment) is not double-counted.

### Why this matters for the user

Without this rule, a user who budgets $3,000,000 COP per month and pays a $1,200,000 COP credit card bill on day 5 would see their daily allowance calculated as if they still had $3,000,000 to spend over the remaining days. In reality, they only have $1,800,000 of spending power left. By counting debt payments as budget spending, the daily allowance accurately reflects the cash the user has available.

### Transfers between asset accounts

Transfers between two asset accounts (for example, savings to checking, or checking to an investment account) do **not** count as budget spending. They are pure reallocations and have no effect on the daily allowance.

---

## Transfers and the Movement Lifecycle

### Planned transfers

A transfer can exist in the planned state. When a budget period opens and there are recurring transfer templates (for example, a monthly credit card payment), the system generates planned transfer pairs -- one planned outgoing movement and one planned incoming movement, linked to each other. Both share the same expected date and amount.

### Recurring transfers

A transfer can be set up as a recurring template. The template consists of a linked pair of template movements. When each budget period opens, the system generates a new pair of planned movements from the template. The planned pair follows the same atomic rules: they are fulfilled together, voided together, and edited together.

### Fulfilling a planned transfer

When the user records the actual transfer that fulfills a planned one, the system creates a new pair of executed movements linked to each other and pointing back to their respective planned movements. The planned movements' fulfillment progress updates accordingly. If the actual amount differs from the planned amount, the executed movements carry the real amount.

---

## Summary of Transfer Rules

1. A transfer is always a pair of linked movements -- one outgoing, one incoming.
2. Both sides are created, edited, voided, and deleted atomically.
3. Same-currency transfers share one amount; cross-currency transfers have independent amounts per side.
4. The exchange rate is derived, never stored.
5. GMF (4x1000) is a separate expense movement, auto-created when the source account is subject to GMF.
6. GMF follows the transfer's lifecycle: it recalculates on edit, and is deleted or voided with the transfer.
7. GMF also applies to regular expenses from GMF accounts, not only transfers.
8. Transfers to liability accounts (credit cards, loans) count as budget spending for daily allowance purposes.
9. Transfers between asset accounts do not affect the budget.
10. Planned and recurring transfers follow the same atomic pair rules as executed transfers.

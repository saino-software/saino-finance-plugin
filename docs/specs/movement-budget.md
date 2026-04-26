# Budget Domain — Functional Specification

**Status:** Draft
**Date:** 2026-04-07
**Companion spec:** movement-unification.md (Movement aggregate redesign)

---

## What Is a Budget?

A budget is a spending plan for a specific period. It represents the user's intention to limit spending within a date range — typically one calendar month, though the system allows arbitrary start and end dates to accommodate biweekly pay cycles or custom periods.

A budget has three essential properties: a period (start date through end date), a spending limit (the maximum the user intends to spend), and a currency. Everything else — planned expenses, spending totals, daily allowance — is derived from the movements that belong to the budget.

A budget does not own its planned expenses. It is not a container. Instead, each movement that belongs to a budget carries a reference back to it. This means the budget itself is a lightweight entity: it defines the boundaries, and the movements define the content.

---

## Budget Lifecycle

A budget moves through two states: open and closed.

### Opening a Budget

The user opens a budget by specifying a period and a spending limit. Opening a budget triggers a chain of automatic actions:

1. The system scans all active recurring templates (subscriptions, installment plans, loan schedules) and generates planned expenses for any that fall within the new budget's period.

2. For credit cards, the system calculates the total monthly obligation — the sum of installment payments due, plus interest computed on the current outstanding balance, plus any fixed monthly charges like insurance. This becomes a single planned expense with a detailed breakdown.

3. For loans, the system generates planned expenses from the amortization schedule — one per loan payment due within the period.

4. All generated planned expenses are linked to the budget and to their source template.

The user can also add manual planned expenses at any point while the budget is open.

### Active Period

While a budget is open, it is the active budget. The user records real expenses throughout the period. The budget screen shows spending progress, daily allowance, and the status of each planned item.

There is at most one open budget at a time. The system does not enforce this as a hard rule — the user could theoretically have overlapping budgets — but the interface guides them toward a single active period.

### Closing a Budget

When the user closes a budget, the system handles unfulfilled planned items:

- Any planned expense that was never executed is marked as **skipped**. Skipping means "this expense did not happen." It is not a reversal — nothing is undone, no balances change. The planned item simply records that the user chose not to spend that money, or that the expected expense never materialized.

- Partially fulfilled planned expenses remain as they are. The executed portions already affected balances. The unfulfilled remainder is informational — it tells the user they spent less than expected on that item.

- The user can reopen a closed budget if they realize they need to make corrections.

The distinction between skipped and voided matters. Voiding is for executed movements — it reverses something that already happened and affected balances. Skipping is for planned movements — it acknowledges that something expected never occurred. The two operations have different semantic weight and appear differently in reports.

---

## Planned Expenses

A planned expense is a movement in the planned state that belongs to a budget. It represents money the user expects to spend during the budget period.

### Sources of Planned Expenses

Planned expenses come from four sources. The source determines how the item appears on the budget screen, how it behaves, and what information it carries.

**Manual entries.** The user creates these by hand for one-off expected expenses: a birthday gift, a doctor's visit, a home repair. Manual planned expenses have no parent template — they exist only within this budget period and do not recur automatically.

**Subscriptions.** These are generated automatically from recurring templates when the budget opens. A subscription is a repeating obligation with no end date or a far-future end date: Netflix, gym membership, internet service. The planned expense carries a link to its parent template, and the template's nature (open-ended recurrence) identifies it as a subscription.

**Credit card installments.** These are generated from installment plan templates — a finite series of payments for a specific purchase. The planned expense for "cuota 3 of 12 — Samsung Galaxy" is generated automatically and linked to the installment template. The template knows the total number of payments, so the system can display progress (e.g., "3 of 12") and the remaining balance.

**Loan payments.** These are generated from loan amortization schedules. Each planned expense represents a single payment with its capital and interest breakdown, calculated using the French amortization system.

### How the System Identifies the Source

The source is not stored as an explicit label. Instead, the system infers it from the structure:

- A planned expense with no parent template is manual.
- A planned expense whose parent template has an open-ended recurrence is a subscription.
- A planned expense whose parent template has a finite payment count is an installment.
- A planned expense whose parent template is linked to a loan account is a loan payment.

This inference-based approach avoids redundant data. The template already carries all the information needed to classify its children.

### Display Grouping

The budget screen groups planned expenses by source. Each group has its own visual treatment:

- **Subscriptions** appear as a list with the service name and monthly amount. Since these tend to be stable month over month, the user can scan them quickly.
- **Installments** show the purchase name, the current payment number out of the total, and the remaining balance. This gives the user a sense of progress and how much longer the commitment lasts.
- **Loan payments** show the loan name, the capital and interest split, and the outstanding principal.
- **Manual items** appear in their own section, since these are the expenses the user is actively planning and most likely to adjust.

---

## Fulfillment

Fulfillment is the act of linking a real expense to a planned one. It answers the question: "Did this expected expense actually happen, and for how much?"

### How Fulfillment Works

Fulfillment is manual. The user decides which planned item a real expense corresponds to. The system does not attempt to match expenses to planned items automatically — the user knows best whether a given grocery trip covers the planned "weekly groceries" item or is an unrelated purchase.

When the user records or edits an expense, they can optionally select a planned item to fulfill. The real expense then carries a reference to the planned item as its parent.

### Partial and Multiple Fulfillment

A single planned item can be fulfilled by multiple real expenses. For example, a planned expense of 100,000 for groceries might be covered by three separate supermarket trips of 35,000, 40,000, and 30,000. Each trip is a separate executed movement that points back to the same planned item.

The total fulfilled amount can also exceed the planned amount. If the user planned 100,000 for groceries but spent 120,000 across several trips, the planned item shows as over-fulfilled. This is not an error — it is useful information for the user to see where they exceeded their expectations.

A single real expense cannot fulfill multiple planned items. The relationship is many-to-one: many executions can point to one planned item, but each execution points to at most one.

### Fulfillment Progress

The system calculates a fulfillment progress for each planned item based on its current state and the real expenses linked to it:

- **Pending:** No real expenses linked, and the planned date has not passed yet. The expense is expected but there is still time.
- **Overdue:** No real expenses linked, and the planned date has already passed. The user expected to spend this money by now but has not recorded anything.
- **Partially fulfilled:** Some real expenses are linked, but their total is less than the planned amount. The user has started spending against this item but has not reached the full amount.
- **Completed:** The total of linked real expenses meets or exceeds the planned amount. The expectation has been met.

This progress is always calculated, never stored. It is derived from the current data each time the budget screen is displayed. This ensures consistency — if the user edits or deletes an executed movement, the progress updates immediately without requiring a separate reconciliation step.

---

## Daily Allowance

The daily allowance tells the user how much they can spend per remaining day without exceeding their budget. It is the single most actionable number on the budget screen.

### Formula

Daily allowance equals the spending limit minus total spent so far, divided by the number of days remaining in the budget period (including today).

### What Counts as "Total Spent"

Total spent includes all executed movements linked to this budget. This covers:

- Direct expenses recorded against the budget.
- The outgoing side of transfers to liability accounts, such as credit card payments and loan payments. When the user transfers money from their checking account to pay off a credit card, that transfer reduces the available budget just as much as a direct expense does.

Transfers between asset accounts (e.g., moving money from checking to savings) do not count as spending. The money is still the user's — it just moved.

### Edge Cases

- If the budget is overspent (total spent exceeds the spending limit), the daily allowance is negative. The interface displays this clearly so the user knows they have exceeded their plan.
- On the last day of the period, the daily allowance equals whatever remains of the spending limit.
- If the period has already ended (the user is viewing a closed budget), the daily allowance is not displayed — it is only meaningful for the active period.

---

## Budget Alerts

The app notifies the user as spending approaches the budget limit. Alerts serve as early warnings so the user can adjust their behavior before overspending.

### Thresholds

The system defines four alert thresholds: 50%, 75%, 90%, and 100% of the spending limit. When total spending crosses one of these thresholds, the app sends a notification.

### One-Time Delivery

Each threshold triggers a notification only once per budget period. If the user spends past 75% of their limit, they receive one notification — not a notification every time they record an expense while above 75%.

To enforce this, the budget tracks which thresholds have already been notified. When a new expense is recorded and the total spending crosses a threshold that has not yet been notified, the system sends the alert and marks that threshold as delivered. If spending later drops below a threshold (for example, because the user voids an expense), the threshold remains marked — the user is not re-notified if spending crosses it again.

### Notification Content

Each alert includes:

- The threshold reached (e.g., "75% of your budget").
- The actual amount spent and the spending limit.
- The daily allowance at the time of the notification, so the user immediately knows how to adjust.

---

## Life Without a Budget

Budgets are entirely optional. The core financial tracking features of the app work without them.

When no budget exists:

- Movements are recorded normally. Expenses, income, and transfers all function as expected.
- Account balances update correctly.
- Reports by category, by account, and over time are fully available.
- Recurring templates still generate their planned items, but those items are not associated with any budget. They appear in a general "upcoming" view rather than a budget screen.

What is not available without a budget:

- **Daily allowance** requires a spending limit and a time period. Without a budget, there is no limit to divide.
- **Planned item grouping by source** is a budget-screen feature. Without a budget, planned items still exist but are displayed in a simpler list.
- **Budget alerts** require a spending limit to measure against.
- **Fulfillment tracking** still works at the individual planned-item level (the user can still link expenses to planned items), but the budget-level overview of fulfilled versus unfulfilled items is not available.

The app does not pressure the user to create a budget. It is a tool for those who want spending discipline, not a requirement for using the app.

---

## Interaction with Credit Card Payments

Credit card payments deserve special attention because they sit at the intersection of budgeting and debt management.

When a credit card payment is due, the budget shows a planned expense that combines capital (the installment portions being paid off), interest (calculated on the current balance), and any fixed charges like insurance. This planned expense appears in the installments group on the budget screen.

When the user makes the payment — a single transfer from their bank account to the credit card — the system distributes the payment across pending planned items using a first-in, first-out approach. The oldest obligations are paid first. The capital portion is a transfer (it reduces debt but is not a budget expense in the category sense), while interest and insurance are genuine expenses that count against the budget and are categorized accordingly.

This means a credit card payment affects the budget in two ways: the total transfer amount reduces the daily allowance (money left the bank account), and the interest and insurance portions appear as categorized expenses in spending reports.

---

## Interaction with Recurring Templates

Recurring templates and budgets are connected but independent. A template defines a pattern. A budget defines a time window. When both exist, opening a budget instantiates the pattern within the window.

If the user creates a new recurring template mid-period (e.g., they subscribe to a new streaming service), the system generates a planned expense for the current budget if the template's next occurrence falls within the remaining period.

If the user cancels a recurring template, existing planned expenses already generated for the current budget are not automatically removed. The user must manually skip or delete them. This is intentional — the user may have already partially fulfilled the planned item, and automatic deletion could lose that information.

If a template's amount changes (e.g., a subscription price increase), future planned expenses reflect the new amount. Existing planned expenses for the current period are not retroactively updated — they represent what was expected at the time the budget was opened.

---

## Summary of Key Principles

1. **The budget is a boundary, not a container.** It defines a period and a limit. Movements belong to it by reference, not by containment.

2. **Fulfillment is manual and many-to-one.** The user links real expenses to planned ones. Multiple real expenses can fulfill a single plan. The system does not guess.

3. **Progress is calculated, not stored.** Fulfillment status, daily allowance, and spending totals are always derived from current data.

4. **Skipping is not voiding.** Skipping a planned expense means it never happened. Voiding an executed expense means reversing something that did happen.

5. **Budgets are optional.** The app works fully without them. They add discipline, not dependency.

6. **Alert thresholds fire once.** The user gets one notification per threshold per period, not a stream of reminders.

7. **Source is inferred, not labeled.** The type of a planned expense's parent template determines how it is displayed and grouped.

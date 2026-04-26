# Movement Reporting -- Functional Specification

**Status:** Draft
**Date:** 2026-04-07
**Depends on:** movement-unification.md (Movement aggregate, Entry value object, Budget model)

---

## Purpose

This document describes every report that Saino Finance provides to the user, what data each report displays, how that data is derived from movements and entries, and the rules that govern what counts as "spending."

---

## 1. Dashboard

The dashboard is the first screen the user sees when opening the app. It provides a snapshot of the user's financial position and recent activity.

### Account balances

Each account appears as a card showing its name and current balance. The balance equals the account's opening balance plus the sum of all executed movement totals for that account. Only movements in the EXECUTED state affect the balance. Movements in PLANNED, TEMPLATE, VOIDED, or FULFILLED states are excluded.

Each balance is displayed in the account's native currency. No conversion is applied here.

### Net worth

A single figure at the top of the dashboard. It is the sum of all account balances, each converted to the user's default currency using the stored exchange rate for that currency pair. Liability accounts (credit cards, loans) have negative balances, so they reduce net worth.

### Daily allowance

If the user has an active (OPEN) budget, the dashboard shows how much they can spend today without exceeding the budget. The formula is:

    daily allowance = (spending limit - total spent so far) / days remaining in the budget period (including today)

"Total spent so far" follows the spending rules described later in this document. If the allowance is zero or negative, the dashboard shows a warning indicating the budget is exhausted.

### Spent today

The sum of all executed expense movements dated today. This uses movement totals, not entries. Transfers between non-liability accounts are excluded. This gives the user a quick sense of their day.

### Monthly budget progress

A horizontal bar showing how much of the budget's spending limit has been consumed. The bar fills proportionally as spending approaches the limit. If spending exceeds the limit, the bar overflows with a distinct color to signal overspending. The bar also shows a secondary marker for planned but not yet executed amounts, so the user can see how much is already committed.

### Recent transactions

A list of the last N executed movements across all accounts, ordered by date descending (most recent first). Each item shows the title, amount, account name, and date. Tapping a movement opens its detail view with the full entry breakdown.

### Upcoming planned items

A list of the next planned movements from the active budget, ordered by expected date ascending (soonest first). Each item shows the title, expected amount, expected date, and fulfillment progress (pending, partial, overdue, or completed). This helps the user anticipate upcoming expenses.

---

## 2. Spending by Category

This report answers the question: "Where is my money going?"

### How it works

For a selected date range, the report groups all spending by category and shows the total amount per category, typically as a pie chart or ranked list. The default period is the current month.

This report uses entry amounts, not movement totals. This distinction matters because a single movement can contain entries in different categories. For example, a supermarket receipt for $150 might have $100 in groceries and $50 in cleaning products. The category report must attribute $100 to groceries and $50 to cleaning, not the full $150 to whichever category appears first.

Only entries from executed movements are included. Entries from planned, voided, or template movements are excluded.

### Drill-down

Tapping a category shows the individual entries that contributed to that category's total. Each item in the drill-down shows the entry memo, amount, the parent movement's title and date, and the account. The user can tap through to the full movement detail if needed.

### Filtering

The report supports filtering by account. When an account filter is active, only entries from movements belonging to that account are included. The user can also select a custom date range.

### Transfers in category reports

Transfer movements typically have no category on their entries. They do not appear in category spending reports. If a user assigns a category to a transfer entry (an unusual but allowed case), it would appear in the report like any other entry.

---

## 3. Category Trend

This report answers the question: "How is my spending in a specific category changing over time?"

### How it works

The user selects a category. The report shows the total amount spent in that category per month, displayed as a bar chart or line chart spanning multiple months. This allows the user to spot patterns -- for example, discovering that dining-out expenses have been growing steadily, or that utility costs spike every winter.

Like the spending-by-category report, this uses entry amounts, not movement totals, to handle multi-category movements correctly.

### Period and granularity

The default view shows the last 6 months, but the user can expand the range. Granularity is always monthly -- no weekly or daily breakdowns.

### Comparison

Each bar or data point represents one calendar month. The current month (which is still in progress) is visually distinguished from completed months so the user does not draw false conclusions from incomplete data.

---

## 4. Price Tracking

This report answers the question: "How has the price of a specific product changed over time?"

### How it works

When the user records a purchase with quantity, unit price, and unit label on a movement entry (for example, "5 kg of Arroz Diana at $4,200/kg"), the app stores this structured data. The price tracking report aggregates these records to show how the unit price of a product changes over time.

For example, if the user buys "Arroz Diana 5kg" at $4,200/kg in March and $4,500/kg in April, the report shows a 7% increase. This is valuable in economies with significant inflation or for tracking volatile commodity prices (gasoline, cooking oil, meat).

### Filtering and grouping

The report can be filtered by category (e.g., show all price-tracked items in "Groceries") or by product name, which matches against the entry memo field. The unit label (kg, gallon, liter, unit) determines how prices are compared -- the app only compares entries with the same unit label.

### Display

Each tracked product shows a timeline of unit prices with dates. The report highlights significant price changes (percentage increase or decrease) between consecutive purchases.

### Requirements on input

Price tracking only works for entries where the user has filled in quantity, unit price, and unit label. Entries without this data are simply ignored by the report. The app does not attempt to infer unit prices from total amounts.

---

## 5. Budget Report

This report answers the question: "How is my budget performing this period, and how does it compare to previous periods?"

### Period summary

At the top, the report shows the budget's key figures for the current (or selected) period:

- **Spending limit:** the total amount the user set as their budget cap.
- **Total spent:** the sum of all executed movements that count as spending (see spending rules below).
- **Total planned:** the sum of all planned movements still pending in the budget.
- **Remaining:** the spending limit minus total spent. If negative, the budget is overspent.

### Breakdown by planned item

Below the summary, each planned item in the budget is listed with:

- **Expected amount:** what the planned movement originally anticipated.
- **Actual (fulfilled) amount:** the sum of executed movements that fulfilled this planned item. This may differ from the expected amount -- the user might pay more or less than planned.
- **Status:** pending (not yet due), overdue (past due date, not fulfilled), partially fulfilled, completed, or skipped (voided).

### Grouping by source

Planned items are organized into groups based on their origin:

- **Manual:** planned items the user created directly in the budget.
- **Subscriptions:** planned items generated from recurring templates (monthly services, memberships).
- **Credit card installments:** planned items generated from installment plan templates (cuotas).
- **Loan payments:** planned items generated from loan amortization templates.

This grouping helps the user understand how much of their budget is committed to fixed obligations versus discretionary spending.

### Fulfillment summary

The report shows counts: how many planned items were fulfilled, how many were skipped, how many are still pending. This gives a quick sense of budget discipline.

### Historical comparison

The report can show the current period side by side with one or more previous periods. This lets the user compare: "I spent $X on groceries last month and $Y this month," or "My total spending has been trending up over the last three months." The comparison uses the same spending rules as the current period, applied retroactively to closed budgets.

---

## 6. Debt Overview

This report answers the question: "How much do I owe, and what are my obligations?"

### Liability account balances

The report lists all liability accounts (credit cards, loans) with their current balance. The balance is calculated the same way as any account balance: opening balance plus executed movement totals. For liability accounts, the balance is typically negative (representing money owed).

### Credit card installment plans

For each credit card, the report shows all active installment plans. An installment plan is a template movement with a recurrence rule that has a finite count. For each plan, the report shows:

- **Original purchase:** what was bought, when, and for how much.
- **Total installments:** the number of cuotas in the plan.
- **Completed installments:** how many cuotas have been paid (EXECUTED children of the template).
- **Remaining installments:** total minus completed.
- **Remaining balance:** the original purchase amount minus the sum of capital payments already made.

### Monthly debt obligation

A single total showing how much the user must pay across all debts this month. This is the sum of:

- All credit card cuotas (capital portions) due this month.
- Interest charges on outstanding credit card balances.
- Insurance charges on credit cards.
- Loan payments due this month (capital plus interest).

This figure represents the user's fixed monthly commitment and helps them understand how much of their income is spoken for before discretionary spending.

---

## Spending Rules

These rules define what counts as "spending" across all budget-related reports (dashboard allowance, budget progress, budget report). They apply uniformly.

### What counts as spending

1. **Executed expense movements linked to the budget.** Any executed movement with a negative amount (money leaving an account) that belongs to the budget counts as spending. This is the most common case: groceries, dining, utilities, subscriptions.

2. **Transfers to liability accounts.** When the user transfers money from a checking account to a credit card (a debt payment), this consumes budget. The outgoing side of the transfer (the negative movement on the checking account) counts as spending. The rationale: the user is deploying money to service debt, and that money is no longer available for other purposes.

### What does not count as spending

1. **Transfers between non-liability accounts.** Moving money from savings to checking, or from one checking account to another, is not spending. The money is still available to the user; it has simply moved. Neither side of such a transfer counts as spending.

2. **Income.** Money received (positive movements) does not reduce or offset spending. If the user earns $1,000 and spends $500, spending is $500, not -$500.

3. **Voided movements.** Movements in the VOIDED state are excluded from all calculations.

4. **Planned movements.** Only EXECUTED movements affect spending totals. Planned movements appear in the "total planned" figure but not in "total spent."

### Determining liability accounts

An account is a liability account based on its account type (credit card, loan). The domain knows which accounts are liabilities. The user configures this when creating the account, and it does not change.

---

## Movement Total vs. Entry Amounts

The movement aggregate maintains a strict invariant: the movement's total amount always equals the sum of its entry amounts. This invariant is enforced by the domain on every create and edit operation.

Because of this invariant, the system has two correct ways to compute monetary sums, and the choice depends on whether category breakdown is needed:

### Use movement totals when...

- Computing account balances. The balance is the sum of executed movement totals for an account. No category information is needed, so joining entries would add cost without benefit.
- Computing budget totals (total spent, total planned). These are aggregate figures across all categories.
- Computing the daily allowance. This is derived from the budget total.
- Listing recent transactions on the dashboard. Display only, no category grouping.

### Use entry amounts when...

- Reporting spending by category. A single movement can span multiple categories, so the entries must be examined individually.
- Tracking category trends over time. Same reason as above.
- Tracking unit prices. The quantity, unit price, and unit label live on entries, not on the movement.
- Drilling down into a category to see individual line items.

### Why both exist

The movement total is a denormalized cache of the entry sum. It exists to make balance and budget queries fast (single-table scan, no joins). The entries exist to preserve the category-level detail that the user entered. Both are always consistent thanks to the domain invariant.

---

## Time Filtering

All reports support filtering by date range. The movement's date field is used for filtering: for executed movements, this is the actual transaction date; for planned movements, it is the expected date.

### Defaults

- Dashboard: shows current state (balances are cumulative; recent transactions and upcoming items use sensible limits).
- Spending by category: current calendar month.
- Category trend: last 6 calendar months.
- Price tracking: all time (since the user wants to see long-term trends).
- Budget report: current budget period.
- Debt overview: current state (balances are cumulative; monthly obligation is for the current month).

### Custom ranges

The user can override the default period on any report by selecting a custom start and end date. When a custom range is active, the report's header clearly shows the selected dates so the user is never confused about what they are looking at.

---

## Currency Handling in Reports

### Native currency display

All per-account figures are shown in the account's native currency. If the user has a USD checking account and a COP savings account, the checking account balance appears in USD and the savings balance in COP. No implicit conversion happens at the account level.

### Net worth and cross-account aggregation

When the report must produce a single total across accounts in different currencies (net worth, total debt obligation), all amounts are converted to the user's default currency. The conversion uses stored exchange rates -- the rates the user has entered for each currency pair. The app does not fetch live rates from the internet.

### Category reports across currencies

If the user has expenses in multiple currencies within the same category (for example, dining in USD while traveling and dining in COP at home), the category report shows sub-totals per currency. A grand total in the default currency may also be shown, using the stored exchange rates, but the per-currency breakdown is always visible so the user can verify the math.

---

## Summary of Reports and Their Data Sources

- **Dashboard (balances, allowance, progress):** movement totals, single-table queries, no entry joins.
- **Dashboard (recent transactions, upcoming items):** movement totals and dates, no entry joins.
- **Spending by category:** entry amounts grouped by category, joined with movements for date and state filtering.
- **Category trend:** entry amounts grouped by category and month, joined with movements for date and state filtering.
- **Price tracking:** entry unit price, quantity, and unit label, joined with movements for date ordering.
- **Budget report (summary):** movement totals for totals; entry amounts for per-category breakdown.
- **Budget report (planned item detail):** planned movement totals vs. executed children totals.
- **Debt overview (balances):** movement totals per liability account.
- **Debt overview (installments):** template movements with recurrence rules, their executed children.
- **Debt overview (monthly obligation):** planned movement totals for liability accounts in the current period.

# Recurring Movements — Functional Specification

**Status:** Draft
**Date:** 2026-04-07
**Depends on:** movement-unification.md (Movement aggregate, state lifecycle, budget opening), movement-transfers.md (transfer pairs, debt payments)

---

## What is a Recurring Movement?

A recurring movement is a template that represents something the user pays or receives on a regular schedule. Examples include a Netflix subscription, monthly rent, a biweekly salary deposit, or a gym membership. It is not a real expense or a real income -- it is a pattern. The system uses this pattern to generate planned items automatically whenever a new budget period opens.

The user defines the template once. From that point forward, every time a budget period opens, the system creates the appropriate planned items without the user having to enter them manually. The template stays active until the user cancels it.

---

## Creating a Recurring Movement

To create a recurring movement, the user provides:

1. **Title** -- a descriptive name for the obligation (for example, "Netflix," "Rent," or "Gym").
2. **Amount** -- the expected amount per occurrence. This is the default; the actual amount when fulfilled may differ.
3. **Account** -- the account the movement will affect (for example, the checking account from which rent is paid).
4. **Category** -- the budget category this expense or income belongs to (for example, Entertainment, Housing, or Salary).
5. **Frequency** -- how often the movement repeats: monthly, biweekly, or weekly.
6. **Expected day** -- the day of the month the user expects the charge or deposit. For monthly frequency, this is a single day (for example, the 15th). For biweekly and weekly frequencies, the system uses this as the starting reference point.

Once created, the template enters the active state and begins generating planned items immediately for the current budget period, if one is open. If no budget period is currently open, the template waits and generates its planned items the next time one opens.

---

## Frequency and Scheduling

### Monthly

A monthly template generates one planned item per budget period. The planned item's expected date is set to the template's expected day within the period's month. If the expected day exceeds the number of days in the month (for example, day 31 in a 30-day month), the system uses the last day of the month.

### Biweekly

A biweekly template generates two planned items per budget period. The first falls on the expected day. The second falls roughly 14 days later. If the second date would fall outside the current budget period, it is clamped to the last day of the period.

### Weekly

A weekly template generates four planned items per budget period, spaced roughly 7 days apart starting from the expected day. If any generated date would fall outside the budget period, it is omitted -- only dates within the period are created.

### Date edge cases

Budget periods do not always align with calendar months. A budget period might run from the 15th of one month to the 14th of the next. The scheduling rules work relative to the budget period boundaries, not necessarily to calendar month boundaries. If a template's expected day falls outside the period, the system adjusts the date to the nearest valid day within the period. The goal is that the user sees the right number of planned items for their budget period, placed at approximately the right dates.

---

## Generation of Planned Items

### When does generation happen?

The system generates planned items from active templates at two moments:

1. **When a budget period opens.** The budget opening process queries all active templates and generates planned items for the new period. Each generated planned item is linked back to its parent template through the parent relationship, so the user can trace any planned item back to the template that created it.

2. **When a new template is created while a budget period is already open.** The system immediately generates planned items for the remainder of the current period. Only dates that have not yet passed are generated. For example, if the user creates a monthly template on the 20th with an expected day of the 15th, and the current budget period runs the full month, no planned item is generated for this period because the 15th has already passed. If the expected day were the 25th instead, a planned item would be generated for the 25th.

### How generation works

For each active template, the system:

1. Determines which dates fall within the budget period based on the template's frequency and expected day.
2. Creates one planned movement per date, copying the amount, account, category, and title from the template.
3. Links each planned movement to the template via the parent relationship.
4. Assigns the budget period's identifier to each planned movement.

### Avoiding duplicates

If the user has manually created a planned item in the same budget period that matches a template (same account, similar amount, same category, and a date close to the expected date), the system does not attempt to detect or prevent the duplicate. Manual planned items and template-generated planned items are independent. The user is responsible for deleting or skipping any redundant items.

This is a deliberate choice. Automatic deduplication would require fuzzy matching on amounts and dates, which is fragile and confusing when it guesses wrong. It is safer and more transparent to let the user manage overlaps manually. In practice, once a user sets up a template, they stop creating manual planned items for that obligation, so duplicates are rare.

---

## Editing a Recurring Movement

The user can edit a template at any time. Changes to the template affect only future planned items. Planned items that have already been generated for the current or past budget periods are not retroactively modified.

### What can be changed

- **Amount:** The new amount will be used for planned items generated in future budget periods. Already-generated planned items keep their original amounts.
- **Account:** Same rule -- future planned items use the new account.
- **Category:** Same rule -- future planned items use the new category.
- **Title:** Updates the template's display name. Already-generated planned items keep their original titles.
- **Frequency:** The user can change from monthly to biweekly, or vice versa. The change takes effect on the next budget period opening. The current period's planned items are not regenerated.
- **Expected day:** Same as frequency -- takes effect on the next budget period.

### Regenerating the current period

If the user wants the current period to reflect the updated template, they can manually delete the existing planned items and trigger a regeneration. The system does not do this automatically, because the user may have already fulfilled some of the planned items, and regenerating would create confusing duplicates.

---

## Cancelling a Recurring Movement

The user can cancel an active template. Cancellation means the template stops generating new planned items in future budget periods. It does not affect planned items that have already been generated for the current period -- those remain and can be individually fulfilled, skipped, or voided by the user.

### Reactivation

A cancelled template can be reactivated. When reactivated, it resumes generating planned items starting from the next budget period that opens. If a budget period is currently open, the system generates planned items for the remainder of that period (using the same rules as creating a new template mid-period).

### Cancellation is not deletion

Cancelling a template does not remove it from the system. The user can still see it in their list of recurring movements, clearly marked as cancelled. This preserves the historical link between the template and all the planned items it generated over its lifetime. The user can delete a cancelled template permanently if they want, but this is a separate action.

---

## Recurring Transfers

A recurring movement can also be a transfer. For example, a monthly rent payment that goes from a checking account to a landlord's account, or a monthly credit card payment. When the template represents a transfer, it follows all the rules from the transfers specification: it generates a linked pair of planned movements (one outgoing, one incoming) each time a budget period opens. The pair follows the atomic rules -- they are fulfilled together, voided together, and edited together.

---

## Credit Card Installments as Recurring Movements

### What is an installment plan?

When the user makes a purchase on a credit card using installments (known as "cuotas" in Latin America), they agree to pay the purchase price over a fixed number of months. For example, the user buys a phone for $3,600,000 COP in 12 cuotas on their Visa BBVA credit card.

This is a special kind of recurring movement. It shares the fundamental behavior of a template -- it generates planned items each month -- but it has a finite lifespan and carries additional financial information that a regular subscription does not.

### What the system creates

When the user records a credit card purchase with installments, the system creates two things:

1. **The purchase itself** -- an executed expense on the credit card account for the full purchase price. This immediately affects the credit card's balance. The purchase carries the category of whatever was bought (for example, Technology for a phone). This is the real event: the user bought something, and the card now carries the debt.

2. **The installment template** -- a recurring movement template linked to the purchase. This template represents the installment plan. It carries the monthly cuota amount and is linked to the purchase through the parent relationship, so the user can always trace the installment plan back to the original purchase.

### Installment-specific information

The installment template carries financial details beyond what a regular recurring movement needs:

- **Number of installments** -- the total number of cuotas (for example, 12).
- **Annual interest rate** -- the rate the credit card charges on this installment plan. Different purchases on the same card may have different rates.
- **Installment amount** -- the calculated monthly cuota, determined using French amortization (equal payments over the life of the plan, where each payment covers a decreasing portion of interest and an increasing portion of capital). This amount is stored directly on the template at the time of creation.

The installment amount must be stored on the template, not derived at query time. The budget opening service needs to know the cuota amount in order to generate planned items for a new period. If the amount were calculated on demand, the service would need to query historical executions to determine the current balance before it could calculate the cuota -- an unnecessary complexity that couples generation to execution history. Storing the amount on the template keeps generation simple and self-contained.

### Monthly generation

Each time a budget period opens, the system checks all active installment templates. For each one that has not yet been fully paid off, it generates a planned item for that month's cuota. The planned item carries the cuota amount and is linked to the installment template.

---

## Installment Lifecycle

### States

An installment template moves through three effective states:

- **Active** -- the template is still generating cuotas. Not all installments have been paid.
- **Paid off** -- all cuotas have been executed. The template stops generating new planned items.
- **Cancelled** -- the user manually cancelled the installment plan (for example, because they paid off the debt early in a lump sum, or because the purchase was returned).

### Tracking progress

The current installment number and remaining balance are not stored as separate fields on the template. They are calculated from execution history:

- **Current installment number** equals the count of executed movements that are children of planned items generated by this template. If the template is for 12 cuotas and 5 have been executed, the user is on installment 5 of 12.
- **Remaining balance** equals the original purchase amount minus the sum of capital portions from all executed cuotas. As each cuota is paid, the remaining balance decreases.
- **Paid off** is true when the current installment number equals the total number of installments.

When an installment template is paid off, it stops generating planned items. The system checks this condition during budget opening: if the count of executed cuotas equals the total installment count, the template is skipped.

### Display

The user can see all their installment plans in a dedicated view. Each plan shows the original purchase, the total number of cuotas, how many have been paid, the remaining balance, and the monthly cuota amount. Paid-off installments are visually distinguished from active ones.

---

## Credit Card Monthly Payment

### The monthly obligation

Each credit card has a monthly obligation that goes beyond individual installment cuotas. When a budget period opens, the system calculates the total monthly payment the user owes for each credit card. This payment has three components:

**Capital** -- the sum of all installment cuotas due this month across all active installment plans on the card. If the user has three active installment plans on their Visa, and this month's cuotas are $150,000, $80,000, and $200,000, the capital component is $430,000.

**Interest** -- calculated on the card's current total outstanding balance (not per installment, but on the aggregate debt) multiplied by the monthly interest rate. The monthly rate is derived from the card's annual rate. Interest is calculated at the moment the budget period opens, using the card's balance at that point. This means that if the user paid extra capital last month, this month's interest is lower.

**Insurance** -- a fixed monthly charge defined at the card level, not per installment. Some credit cards charge a monthly insurance fee (for example, $12,000 COP per month). This is a flat amount regardless of the number of installments or the outstanding balance.

### The planned payment

The system combines these three components into a single planned item for the card's monthly payment. This planned item uses multiple entries to break down the components:

- One entry for the capital portion, without a budget category (because capital is a debt reduction, not spending).
- One entry for the interest portion, assigned to an interest category (because interest is a real cost the user is paying).
- One entry for the insurance portion, assigned to an insurance category (because insurance is also a real cost).

The total of the planned item is the sum of all three components. This gives the user a clear picture of their total monthly credit card obligation and how it breaks down.

---

## Paying the Credit Card

### The payment as a transfer

When the user pays their credit card bill, they record a transfer from a bank account (for example, Ahorros BBVA) to the credit card account (for example, Visa BBVA). This follows the transfer rules from the transfers specification: it creates a linked pair of movements, one outgoing from the bank account and one incoming to the credit card.

### Distribution across pending cuotas

A single credit card payment typically covers multiple installment cuotas plus interest and insurance. The system distributes the payment across pending obligations using a FIFO rule (first in, first out): the oldest pending cuotas are satisfied first.

The distribution works as follows:

1. The system collects all pending planned items for the credit card, ordered by date (oldest first), then by creation date as a tiebreaker.
2. It applies the payment amount to each pending item in order until the payment is fully distributed or all pending items are covered.
3. For each cuota that the payment covers, the system decomposes the amount into its constituent parts: the capital portion (which reduces the card's debt) and the interest and insurance portions (which are real expenses that affect the budget).

### Capital versus expenses

This decomposition matters because capital and interest have fundamentally different natures:

- **Capital** is not spending. It reduces the credit card's outstanding balance. From a budget perspective, the cash left the user's bank account, but it went toward paying off a debt, not toward consumption. The capital portion is handled as a transfer (debt reduction).
- **Interest and insurance** are real expenses. The user is paying the bank for the privilege of borrowing money and for card insurance. These affect the budget and are categorized accordingly.

The system generates the appropriate executed movements to reflect this decomposition. All generated movements are linked back to the planned payment item.

### Overpayment

If the user pays more than the total of all pending cuotas plus interest and insurance, the extra amount is applied as additional capital reduction. This reduces the outstanding balance beyond what was scheduled, which in turn reduces the interest calculated in the next budget period. The system does not generate a separate planned item for the overpayment -- it simply reduces the card's balance.

### Underpayment

If the user pays less than the full monthly obligation, the system distributes what was paid using the same FIFO order. Some cuotas may be partially fulfilled. The remaining unpaid balance carries forward. The user can see which planned items are still pending or partially fulfilled.

---

## Loan Payments

### How loans differ from credit cards

Loan payments follow a similar pattern to credit card installments, but with a simpler structure. A loan is typically a single debt with a fixed repayment schedule, rather than an aggregation of multiple independent purchases. There is no concept of multiple installment plans on a single loan -- the loan itself is the installment plan.

### The loan template

When the user sets up a loan, they create a recurring movement template on the loan account. The template carries the same installment-specific information as a credit card installment: number of payments, annual interest rate, and the calculated monthly payment amount (using French amortization).

### Monthly generation

Each budget period, the system generates a planned item for the loan payment. The planned item represents the monthly obligation: capital plus interest, as determined by the amortization schedule. Unlike credit cards, there is no insurance component and no aggregation of multiple plans.

### Paying the loan

The loan payment is a transfer from a bank account to the loan account. Each payment covers capital and interest, with the split determined by the amortization schedule. Early in the loan's life, most of the payment goes to interest. Later, most goes to capital. The system tracks this automatically based on how many payments have been executed.

### Early payoff

If the user pays more than the scheduled monthly amount, the extra goes to capital reduction, similar to credit card overpayment. This shortens the loan's effective life and reduces future interest. The template's total installment count does not change, but the loan may reach a zero balance before all installments are generated. At that point, the template stops generating new planned items.

---

## Summary of Recurring Movement Rules

1. A recurring movement is a template, not a real expense or income. It generates planned items automatically when budget periods open.
2. Templates carry a frequency (monthly, biweekly, or weekly), an expected day, and an amount. These define when and how many planned items are generated per period.
3. Creating a template while a budget period is open generates planned items immediately for the remainder of that period.
4. Editing a template affects only future planned items. Already-generated items are not retroactively changed.
5. Cancelling a template stops future generation but does not remove already-generated planned items.
6. Cancelled templates can be reactivated.
7. Duplicate detection between manual planned items and template-generated items is deliberately not automated. The user manages overlaps manually.
8. Credit card installments are a specialized form of recurring movement with a finite lifespan, an interest rate, and a stored cuota amount.
9. Installment progress (current installment number, remaining balance, paid-off status) is calculated from execution history, not stored separately.
10. The credit card monthly payment is a composite planned item combining capital (sum of cuotas), interest (on total card balance), and insurance (flat card-level charge).
11. Credit card payments are distributed across pending cuotas using FIFO. Each cuota is decomposed into capital (transfer / debt reduction) and interest/insurance (real expenses).
12. Loan payments follow the same pattern as credit card installments but are simpler: one plan per loan, no aggregation, no insurance.
13. Overpayments on credit cards and loans reduce the outstanding balance ahead of schedule, lowering future interest.

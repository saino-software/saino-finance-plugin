# Movement Lifecycle — Functional Specification

**Status:** Draft
**Date:** 2026-04-07
**Companion spec:** movement-unification.md (structure and schema)
**Audience:** Product owner, design review

---

## What Is a Movement?

A movement is any event that represents money entering, leaving, or moving between the user's accounts. Every financial event in Saino Finance -- a coffee purchase, a salary deposit, a transfer from checking to savings, a Netflix subscription, a planned grocery budget line, a credit card installment plan -- is a movement.

Movements differ not in *kind* but in *state*. A subscription template and a real purchase are the same concept at different points in their lifecycle. This document defines what those states are, what the user can do in each one, and what happens when movements are created, changed, or removed.

---

## The Six States

A movement exists in exactly one of six states at any time. The states fall into two groups: those that affect the user's account balances, and those that do not.

### States that never affect balance

**TEMPLATE** -- A repeating pattern. The user defines it once (for example, "Netflix, $15.99, monthly on the 5th") and the system generates individual planned occurrences from it each budget period. A template is not money that moved; it is a recipe for future movements.

**PLANNED** -- An expected future movement within a specific budget period. The user sees it as "I expect to spend $200 on groceries this month." Planned movements inform the budget and daily allowance calculations but do not touch account balances. A planned movement may have been generated automatically from a template, or created manually by the user.

**SKIPPED** -- A planned movement the user decided not to do. For example, the user had planned a haircut this month but chose to postpone it. Skipping is a conscious decision about a future intention. The movement remains visible in the budget history as "not done" but has no financial effect.

**FULFILLED** -- A planned movement the user manually marked as done, even though no executed movement was linked to it. This covers cases where the user paid in cash outside the app, or considers the obligation satisfied for other reasons. Fulfilled movements do not affect balances directly -- the user is simply saying "this is handled, stop reminding me."

### States that affect balance (or once did)

**EXECUTED** -- A real money movement that happened. The user bought something, received a deposit, or transferred funds. Executed movements are the only state that changes account balances. An executed movement may stand alone (a direct expense) or may be linked to a planned movement it fulfills.

**VOIDED** -- An executed movement that the user reversed or cancelled. The movement no longer affects the account balance, but it remains in the history as a record of what happened and was undone. Voiding is about *reversing something real*, not about *deciding not to do something planned* -- that distinction is why SKIPPED and VOIDED are separate states.

### State flow diagram

```
TEMPLATE ──generates──> PLANNED ──executes──> EXECUTED
                           │                      │
                           ├──> SKIPPED            ├──> VOIDED
                           │                       
                           └──> FULFILLED          
```

A template generates planned movements. A planned movement can become skipped, fulfilled, or linked to an executed movement. An executed movement can become voided. No other transitions exist.

---

## What the User Can Do in Each State

### TEMPLATE

A template is a living pattern that the system uses to generate planned movements each budget period. The user has full control over it.

**Edit.** The user can change any field on a template: amount, account, title, category, recurrence frequency, day of month, or end date. Changes to a template affect only *future* generation. Planned movements that were already generated from this template in past or current budget periods remain unchanged. If the user wants to update an existing planned occurrence, they must edit that planned movement directly.

**Delete.** The user can delete a template entirely. When a template is deleted, the system must decide what to do with its children -- the planned movements it already generated. The rule is: planned movements that have not yet been executed remain as-is but become orphaned (they lose their link to the deleted template but are not automatically removed). The user may want to keep some of those planned items even if the recurring pattern is gone. Planned movements that have already been fulfilled or linked to executed movements are obviously unaffected. If the user wants to remove the planned children too, they must delete them individually or use a bulk action.

**Cancel (stop generating).** The user can deactivate a template without deleting it. A cancelled template stops generating new planned movements in future budget periods, but it and its history remain visible. This is useful when a subscription ends but the user wants to keep the record. Cancellation is reversible -- the user can reactivate the template later.

**Duplicate.** The user can create a copy of a template with all its fields pre-filled. The copy is a new, independent template with no link to the original. This is a convenience for creating similar recurring patterns quickly (for example, duplicating a "Gym membership" template to create a "Swimming pool membership" template).

### PLANNED

A planned movement represents an expectation for the current or a future budget period. The user can act on it in several ways.

**Edit.** The user can change any field: amount, date, title, category, account, notes. If the planned movement was generated from a template, editing it does not change the template -- it is a one-time override for this specific occurrence. This is how the user handles "this month's electricity bill will be higher than usual."

**Delete.** The user can remove a planned movement. If the planned movement has executed children linked to it (movements that fulfilled it), those executed movements are *not* deleted -- they represent real money that moved and must remain in the ledger. The executed movements simply become unlinked (they lose their reference to the deleted plan but continue to affect balances). If the user truly wants to reverse those executed movements, they must void or delete them separately.

**Skip.** The user can mark a planned movement as skipped. The state changes to SKIPPED. This means "I chose not to do this." The movement remains in the budget view with a visual indicator (strikethrough, grayed out) so the user can see what they decided to skip. If the planned movement has a template parent, skipping does not affect the template -- next period's occurrence will still be generated.

**Fulfill manually.** The user can mark a planned movement as fulfilled. The state changes to FULFILLED. This means "this is done, but I am not recording the actual transaction in the app." This is useful for cash payments, payments made through another app, or situations where the user simply wants to close out the planned item without creating a matching executed movement.

**Execute (link to a real transaction).** When the user records a real expense or income, the app can offer to link it to an existing planned movement. Alternatively, the user can open a planned movement and choose "Record actual payment," which creates a new executed movement pre-filled with the planned amounts. The planned movement does not change state when linked to an executed child -- its fulfillment progress is calculated dynamically (pending, partial, completed, overdue). Multiple executed movements can fulfill a single planned movement (partial payments). The planned movement transitions to FULFILLED only when the user explicitly marks it so.

**Duplicate.** The user can duplicate a planned movement to create another planned movement in the same or a different budget period. The copy has no link to the original.

### EXECUTED

An executed movement is a real financial event. Editing is allowed but carries more weight because it changes the historical record and account balances.

**Edit.** The user can change the amount, date, title, category, account, or notes of an executed movement. All edits take effect immediately and recalculate the account balance. If the executed movement is part of a transfer pair, editing one side automatically updates the other side (the system keeps both sides consistent). The user should be aware that changing the amount or account of an executed movement rewrites financial history -- the app may show a confirmation warning for significant changes.

**Delete.** The user can delete an executed movement. The account balance is recalculated as if the movement never happened. If the executed movement was linked to a planned movement (as a fulfillment), the planned movement's fulfillment progress is recalculated -- it may go from "completed" back to "partial" or "pending." The planned movement itself is *not* deleted or changed in state; it simply reflects that it has one fewer fulfillment. If the executed movement is part of a transfer pair, deleting one side deletes both sides.

**Void.** The user can void an executed movement instead of deleting it. Voiding changes the state to VOIDED. The movement no longer affects account balances, but it remains visible in the transaction history with a "voided" indicator. This is preferable to deletion when the user wants an audit trail ("I returned this purchase" or "this charge was reversed by my bank"). If the executed movement is part of a transfer pair, voiding one side voids both sides. If the executed movement was linked to a planned movement, the planned movement's fulfillment progress is recalculated, just as with deletion.

**Duplicate.** The user can duplicate an executed movement to quickly create another similar one. The copy is a new executed movement with today's date and the same amount, category, and account. It has no link to the original. This is a shortcut for recurring manual entries ("I buy the same coffee every morning").

### VOIDED

A voided movement is a historical record of something that was reversed. The user's options are intentionally limited.

**View.** The user can view all details of a voided movement, including when it was originally executed and when it was voided.

**Delete.** The user can delete a voided movement to remove it from history entirely. This is a permanent action. Since the voided movement was already not affecting balances, deletion only removes the audit trail.

**Undo void.** The user can reverse the voiding, returning the movement to EXECUTED state. This restores its effect on the account balance. This handles the case where the user voided something by mistake.

A voided movement cannot be edited. If the user needs to change the details, they should undo the void first, edit the movement, and optionally void it again.

### SKIPPED

A skipped movement is a planned movement the user chose not to do. It has limited options.

**View.** The user can see the details of what was skipped and when.

**Undo skip.** The user can return the movement to PLANNED state. This is for cases where circumstances changed and the user now wants to do the thing they previously skipped.

**Delete.** The user can remove the skipped record entirely.

A skipped movement cannot be edited. If the user wants to revive it with different details, they should undo the skip and then edit the resulting planned movement.

### FULFILLED

A fulfilled movement is a planned movement the user manually marked as done. Its options are similar to skipped.

**View.** The user can see the details and when it was marked fulfilled.

**Undo fulfillment.** The user can return the movement to PLANNED state. This is for cases where the user marked something as done prematurely.

**Delete.** The user can remove the fulfilled record.

A fulfilled movement cannot be edited. Undo the fulfillment first, then edit.

---

## Cascade Rules on Deletion

Deletion can have consequences for related movements. The guiding principle is: *executed movements (real money) are never silently removed as a side effect of deleting something else.* The user must explicitly choose to delete or void real transactions.

### Deleting a TEMPLATE

When the user deletes a template:

- Planned movements generated from this template that are still in PLANNED state become orphaned. They lose their parent link but remain in the budget. The user can delete them individually if desired.
- Planned movements that are in SKIPPED or FULFILLED state are similarly orphaned but preserved.
- Executed movements that fulfilled any of those planned movements are completely unaffected.

Rationale: The template is a recipe. Destroying the recipe does not undo the meals already cooked or the ingredients already bought.

The app should warn the user: "This template has N planned items in current/future budgets. They will remain but will no longer be regenerated. Delete anyway?"

### Deleting a PLANNED movement

When the user deletes a planned movement:

- Executed movements linked to it (as fulfillments) are *not* deleted. They become unlinked -- standalone executed movements with no parent reference. Their effect on account balances is unchanged.
- The planned movement is removed from budget calculations.

Rationale: The plan may be gone, but the money already moved. The user must void or delete executed movements explicitly if they want to reverse real transactions.

### Deleting an EXECUTED movement

When the user deletes an executed movement:

- The account balance is recalculated immediately.
- If the executed movement was linked to a planned movement, the planned movement's fulfillment progress is recalculated. For example, if the planned amount was $100 and two executed payments of $60 and $40 fulfilled it, deleting the $40 payment changes the progress from "completed" to "partial ($60 of $100)."
- The planned movement itself is not deleted or changed in state.
- If the executed movement is part of a transfer pair, the linked movement on the other account is also deleted.

### Deleting a VOIDED movement

When the user deletes a voided movement:

- No balance impact (it was already voided).
- If it was linked to a planned movement, no change (a voided movement was already not counting toward fulfillment).
- The record is simply removed from history.

### Deleting a SKIPPED or FULFILLED movement

When the user deletes a skipped or fulfilled movement:

- No balance impact.
- If it had a template parent, the template is unaffected.
- The record is removed from budget history.

---

## Transfer Pairs and Lifecycle

A transfer is two linked movements: one outgoing (negative amount on the source account) and one incoming (positive amount on the destination account). They share a lifecycle.

**Symmetry rule:** Any state change on one side of a transfer pair must be applied to the other side. The user never sees the two sides in different states.

- Voiding a transfer voids both sides.
- Deleting a transfer deletes both sides.
- Editing a transfer amount on one side updates the other side. For cross-currency transfers, the user may edit either side's amount independently (since the currencies differ), but both sides remain linked.
- Skipping a planned transfer skips both sides.

The user interacts with a transfer as a single concept. The two-movement structure is an internal detail.

---

## Duplication Summary

Duplication is always a convenience shortcut. The copy is independent -- no parent link, no transfer link, no template link to the original.

| Source state | Result state | Pre-filled fields | What changes |
|---|---|---|---|
| TEMPLATE | TEMPLATE | All fields including recurrence rule | New ID, no children |
| PLANNED | PLANNED | Amount, category, account, title | New ID, date defaults to same, no parent link |
| EXECUTED | EXECUTED | Amount, category, account, title | New ID, today's date, no parent link |
| VOIDED | Not allowed | -- | User should undo void first |
| SKIPPED | Not allowed | -- | User should undo skip first |
| FULFILLED | Not allowed | -- | User should undo fulfillment first |

Duplicating a transfer creates a new independent transfer pair (both sides are duplicated).

---

## Differences Between VOIDED and SKIPPED

Because these two states can seem similar, here is the distinction stated plainly:

**VOIDED** answers the question: "I did this, but I need to undo it." The money moved and then the movement was reversed. Example: the user bought a shirt, returned it, and voided the purchase.

**SKIPPED** answers the question: "I was going to do this, but I decided not to." The money never moved. Example: the user had budgeted for a haircut but postponed it to next month.

A movement can only be voided from EXECUTED state. A movement can only be skipped from PLANNED state. There is no path from PLANNED to VOIDED or from EXECUTED to SKIPPED.

---

## Fulfillment: How Plans Connect to Reality

When the user executes a planned movement, the system does not *transform* the planned movement into an executed one. Instead, it creates a *new* executed movement that references the planned movement as its parent. The planned movement remains as a historical record of what was expected.

This design has practical consequences:

- The actual amount may differ from the planned amount. The user planned $200 for groceries but spent $187.50. Both numbers are preserved.
- The actual date may differ. The user planned to pay rent on the 1st but paid on the 3rd.
- Multiple executed movements can fulfill one planned movement. The user planned $500 for medical expenses and made three separate payments of $200, $150, and $150.
- The planned movement's fulfillment progress is always calculated, never stored. It is the ratio of the sum of its executed children to its own amount.
- The user can mark a planned movement as FULFILLED at any time, regardless of how much has been executed against it. This is a manual override that says "I consider this done."

---

## Summary of Allowed Actions by State

| Action | TEMPLATE | PLANNED | EXECUTED | VOIDED | SKIPPED | FULFILLED |
|---|---|---|---|---|---|---|
| View | Yes | Yes | Yes | Yes | Yes | Yes |
| Edit | Yes | Yes | Yes (with warning) | No | No | No |
| Delete | Yes | Yes | Yes | Yes | Yes | Yes |
| Void | -- | -- | Yes | -- | -- | -- |
| Skip | -- | Yes | -- | -- | -- | -- |
| Fulfill | -- | Yes | -- | -- | -- | -- |
| Execute | -- | Yes | -- | -- | -- | -- |
| Duplicate | Yes | Yes | Yes | No | No | No |
| Undo (reverse state) | -- | -- | -- | Yes (to EXECUTED) | Yes (to PLANNED) | Yes (to PLANNED) |
| Cancel/deactivate | Yes | -- | -- | -- | -- | -- |
| Reactivate | Yes | -- | -- | -- | -- | -- |

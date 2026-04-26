# Movement Domain Redesign — Spec

**Status:** Draft — pending user review
**Date:** 2026-04-02
**Goal:** Unify Transaction, PlannedItem, RecurringObligation, and CreditCardInstallment into a single `Movement` aggregate with state-based lifecycle.

---

## Problem

Four concepts that are variations of the same thing are modeled as independent entities:

| Current Concept | What it really is |
|-----------------|-------------------|
| Transaction (EXPENSE/INCOME) | Money movement affecting an account |
| Transaction (TRANSFER) | Hack — single entity with `TransferPair` pretending to be two-sided |
| PlannedItem | A future expected movement — separate entity inside Budget aggregate |
| RecurringObligation | A template for repeating movements — separate entity in Planning context |
| CreditCardInstallment | A finite repeating payment plan — separate entity with own table |

This causes: 22 TRANSFER conditionals across 4 layers, duplicated entry models, business logic in ViewModels, and a 4-command pipeline for recurring → executed.

---

## Design Decisions (Agreed)

| Decision | Choice |
|----------|--------|
| Unified concept name | `Movement` |
| Transfer model | Atomic — 2 linked Movements (EXPENSE + INCOME) |
| State lifecycle | `TEMPLATE → PLANNED → EXECUTED → VOIDED` |
| Entries | Value objects with identity (own table), NOT sub-movements |
| Fulfillment | PLANNED generates NEW EXECUTED (parent stays as historical record) |
| Partial fulfillment | Multiple EXECUTED children allowed per PLANNED |
| Fulfillment status | PLANNED state is `PLANNED | VOIDED | FULFILLED`; progress (PENDING/PARTIAL/OVERDUE/COMPLETED) is calculated |
| Linking relationships | `parentMovementId` for hierarchy (template→planned→executed), `linkedMovementId` for transfer pairs |
| Budget relationship | `budgetId` as FK on Movement; Budget is NOT aggregate of planned items |
| Categories on transfers | Nullable `categoryId` on Entry; transfers don't need categories |
| Migration approach | Schema-first (rename + extend existing tables) |
| Installments | Modeled as TEMPLATE that generates PLANNEDs |
| Payment allocation | FIFO (oldest first), single transfer distributed by domain service |

---

## 1. Movement Aggregate Root

```
Movement
├── id: MovementId
├── state: TEMPLATE | PLANNED | EXECUTED | VOIDED | FULFILLED
├── accountId: AccountId
├── totalAmount: Money            (invariante: = SUM(entries.amount))
├── date: LocalDate               (real if EXECUTED, expected if PLANNED/TEMPLATE)
├── title: String
├── notes: String
├── labels: Set<Label>
├── entries: List<Entry>          (≥1)
│
├── linkedMovementId: MovementId? (transfer pair — the other side)
├── parentMovementId: MovementId? (chain: TEMPLATE→PLANNED→EXECUTED)
├── budgetId: BudgetId?           (if belongs to a budget period)
├── recurrenceRule: RecurrenceRule? (TEMPLATE only: frequency, day, count, annualRate)
│
├── createdAt: Instant
```

### State meanings

| State | Affects balance | Accepts children | Description |
|-------|:-:|:-:|-------------|
| TEMPLATE | No | Generates PLANNEDs | Recurring pattern (subscription, installment) |
| PLANNED | No | Accepts EXECUTEDs | Expected future movement |
| EXECUTED | Yes | — | Real money movement |
| VOIDED | No | — | Cancelled/skipped |
| FULFILLED | No | — | PLANNED manually marked as done by user |

### Domain rules

- `isTransfer` = `linkedMovementId != null`
- `isCrossCurrency` = transfer where linked Movement has different currency
- `isRecurring` = `recurrenceRule != null`
- `fulfillmentProgress` (calculated for PLANNED):
  - COMPLETED: totalExecuted >= totalAmount OR state == FULFILLED
  - PARTIAL: totalExecuted > 0 AND totalExecuted < totalAmount
  - OVERDUE: no executed children AND date < today
  - PENDING: no executed children AND date >= today
- `void()`: EXECUTED → VOIDED (stops affecting balance)
- `skip()`: PLANNED → VOIDED
- `fulfill()`: PLANNED → FULFILLED (user decides "done" even if partial)
- `linkTo(other)`: sets linkedMovementId bidirectionally

### What disappears

- `TransferPair` value object
- `TransactionType` enum (EXPENSE/INCOME/TRANSFER)
- `PlannedItem` as separate entity
- `RecurringObligation` as separate entity
- `CreditCardInstallment` as separate entity
- `FulfillmentStatus` stored enum — replaced by calculated progress

---

## 2. Entry (Value Object with Identity)

```
Entry
├── id: EntryId
├── movementId: MovementId
├── categoryId: CategoryId?       (nullable: transfers don't need category)
├── amount: Money
├── memo: String
├── quantity: BigDecimal?
├── unitPrice: BigDecimal?
├── unitLabel: String?
```

### Invariant

`Movement.totalAmount == SUM(entries.amount)` — enforced by domain.

### Query model: when to use `movements` vs `movement_entries`

The system has two levels of granularity for monetary data. The rule is:
**if the calculation needs category breakdown, query entries. Otherwise, query movements.**

| Calculation | Source table | Column | Filter | Why |
|---|---|---|---|---|
| Account balance | `movements` | `total_amount` | `account_id = X AND state = 'EXECUTED'` | Only needs total per movement, no category breakdown |
| Daily allowance (remaining) | `movements` | `total_amount` | `budget_id = X AND state = 'EXECUTED'` | Budget-level total, no category needed |
| Budget total spent | `movements` | `total_amount` | `budget_id = X AND state = 'EXECUTED'` | Aggregate across all categories |
| Budget total planned | `movements` | `total_amount` | `budget_id = X AND state = 'PLANNED'` | Same — aggregate total |
| Budget spent by category | `movement_entries` | `amount` | `JOIN movements ON state = 'EXECUTED' AND budget_id = X WHERE category_id = Y` | Needs to split multi-entry movements by category |
| Reports by category | `movement_entries` | `amount` | `JOIN movements ON state = 'EXECUTED' WHERE category_id = Y AND date BETWEEN ...` | Category-level grouping |
| Reports by category + account | `movement_entries` | `amount` | `JOIN movements ON state = 'EXECUTED' WHERE category_id = Y AND account_id = X` | Cross-dimension drill-down |
| Price tracking (unit cost over time) | `movement_entries` | `unit_price` | `category_id = Y ORDER BY movement.date` | Tracks unit price history per product/category |
| Dashboard recent transactions | `movements` | `total_amount` | `state = 'EXECUTED' ORDER BY date DESC LIMIT N` | Display only, no category breakdown |
| Account detail (tx list) | `movements` | `total_amount` | `account_id = X AND state = 'EXECUTED' ORDER BY date DESC` | List display, entries loaded on detail view |
| Transaction detail (line items) | `movement_entries` | `amount, memo, quantity, unit_price` | `movement_id = X` | Full breakdown shown on detail screen |

#### Why two levels exist

A single Movement can span multiple categories (e.g., a supermarket receipt with groceries + cleaning + hygiene).
`movements.total_amount` is the **denormalized sum** of all its entries — it exists so that
balance and budget queries can run on a single table without joining entries.

#### Invariant

`Movement.totalAmount == SUM(entries.amount)` — enforced by the domain aggregate root on every
mutation (create, edit). If violated, the domain throws `IllegalStateException`. This guarantees
that queries on `movements.total_amount` and queries on `SUM(movement_entries.amount)` produce
consistent results.

#### Anti-patterns to avoid

- **Never** compute balance from entries — use `movements.total_amount`. Joining entries for
  balance is slower and adds no value since balance doesn't need category breakdown.
- **Never** compute category spend from `movements` — a movement with mixed categories
  (e.g., $100 groceries + $50 cleaning) would be attributed entirely to whichever category
  is "first", losing the split.
- **Never** store `total_amount` on entries or derive `total_amount` at query time — the
  aggregate root owns this invariant, not the database.

### What Entry is NOT

- Not a sub-Movement (no account, no state, no balance impact)
- Not shared between transfer pairs (each side has own entries)

---

## 3. Transfer — Atomic Pair

A transfer creates 2 linked Movements atomically:

```
Movement A (outgoing):
├── accountId: Source account
├── totalAmount: -amount in source currency
├── state: EXECUTED
├── linkedMovementId: → Movement B
├── entries: [{amount, categoryId: null}]

Movement B (incoming):
├── accountId: Destination account
├── totalAmount: +amount in destination currency
├── state: EXECUTED
├── linkedMovementId: → Movement A
├── entries: [{amount, categoryId: null}]
```

### Rules

- Edit one → edit both (domain service coordinates)
- Delete one → delete both
- Void one → void both
- Cross-currency: each Movement has amount in its account's currency
- Balance = `SUM(totalAmount) WHERE accountId = X AND state = EXECUTED` — no UNION ALL

### What disappears

- `transfer_to_account_id`, `transfer_to_amount`, `transfer_to_currency`, `conversion_rate` columns
- The UNION ALL in balance query
- 22 `if (type == TRANSFER)` conditionals

---

## 4. Chain: TEMPLATE → PLANNED → EXECUTED

### Recurring expense example

```
Movement TEMPLATE
├── recurrenceRule: {frequency: MONTHLY, dayOfMonth: 15}
├── totalAmount: $100, accountId: Checking
│
└── generates (on budget open) →
    Movement PLANNED
    ├── parentMovementId: → TEMPLATE
    ├── budgetId: → Budget March
    ├── date: Mar 15
    │
    └── fulfilled by →
        Movement EXECUTED
        ├── parentMovementId: → PLANNED
        ├── date: Mar 16 (actual date, may differ)
        ├── totalAmount: -$105 (actual amount, may differ)
```

### parentMovementId chain

- EXECUTED.parentMovementId → PLANNED (what it fulfills)
- PLANNED.parentMovementId → TEMPLATE (what generated it)
- PLANNED without parentMovementId = manually created
- EXECUTED without parentMovementId = direct expense (not planned)

### Recurring transfer (e.g., credit card payment)

A TEMPLATE with `linkedMovementId` generates paired PLANNEDs and paired EXECUTEDs.

---

## 5. Budget — Simplified

```
Budget
├── id: BudgetId
├── period: BudgetPeriod (startDate, endDate)
├── spendingLimit: Money
├── state: OPEN | CLOSED
```

Budget is NOT an aggregate of planned items. Movements PLANNED point to Budget via `budgetId`.

### Derived queries

- `totalSpent = SUM(movements.totalAmount) WHERE budgetId = X AND state = EXECUTED`
- `totalPlanned = SUM(movements.totalAmount) WHERE budgetId = X AND state = PLANNED`
- `dailyAllowance = (spendingLimit - totalSpent) / daysRemaining`

### Lifecycle

- `open()` → creates Budget, triggers generation of PLANNEDs from active TEMPLATEs
- `close()` → state = CLOSED
- `reopen()` → state = OPEN

---

## 6. Credit Card Installments as TEMPLATE

A purchase on credit card at 10 installments:

```
Movement EXECUTED (the purchase)
├── accountId: Visa BBVA
├── totalAmount: -$1,800,000
├── entries: [{categoryId: "Technology", amount: $1,800,000}]
│
└── generates →
    Movement TEMPLATE (the installment plan)
    ├── parentMovementId: → purchase EXECUTED
    ├── accountId: Visa BBVA
    ├── totalAmount: $150,000 (capital portion per cuota)
    ├── recurrenceRule: {frequency: MONTHLY, count: 10, annualRate: 0.28}
    │
    └── generates PLANNEDs per budget period (capital only)
```

### Installment state (calculated, not stored)

- `currentInstallment` = count of EXECUTED children
- `remainingBalance` = purchase amount - SUM(EXECUTED children capital)
- `isPaidOff` = currentInstallment >= recurrenceRule.count

### Table `credit_card_installments` disappears

---

## 7. Credit Card Monthly Payment — FIFO Distribution

### Two levels of planned items for credit cards

**Level 1 — Per-installment (TEMPLATE generates):**
Each installment TEMPLATE generates a PLANNED with capital-only amount.

**Level 2 — Card-level monthly (budget opening generates):**
A domain service calculates the total monthly obligation:

```
PLANNED monthly payment for Visa:
├── Capital: SUM(installment cuotas due this month)
├── Interest: current_total_balance × monthly_rate (calculated at generation time)
├── Insurance: fixed monthly charge (card-level, not per-installment)
├── Total: capital + interest + insurance
├── entries:
│   ├── {amount: capital, categoryId: null, memo: "Capital"}
│   ├── {amount: interest, categoryId: "Interest", memo: "Interest"}
│   └── {amount: insurance, categoryId: "Insurance", memo: "Insurance"}
```

### When user pays (single transfer to card)

`CreditCardPaymentService` distributes FIFO:

1. Orders pending PLANNEDs by `date ASC, createdAt ASC`
2. Interest and insurance are real expenses (affect budget by category)
3. Capital is a transfer (reduces card debt, not a budget expense)
4. Generates: transfer for capital + expense movements for interest/insurance
5. All generated EXECUTEDs point to the PLANNED via parentMovementId

### Early payment saves interest

If user pays cuotas ahead of schedule, the balance drops sooner. Next month's PLANNED is generated with lower interest (calculated on current balance, not projected balance).

### Insurance is card-level

Insurance is a single monthly charge on the total card balance — NOT per installment. It appears once in the monthly PLANNED, not in each installment's PLANNED.

---

## 8. Schema

### `movements` table (renamed from `transactions`)

```sql
movements (
    id                  INTEGER PRIMARY KEY,
    state               TEXT NOT NULL,  -- TEMPLATE, PLANNED, EXECUTED, VOIDED, FULFILLED
    account_id          INTEGER NOT NULL REFERENCES accounts(id),
    total_amount        TEXT NOT NULL,
    currency_code       TEXT NOT NULL,
    date                TEXT NOT NULL,
    title               TEXT NOT NULL DEFAULT '',
    notes               TEXT NOT NULL DEFAULT '',
    labels_csv          TEXT NOT NULL DEFAULT '',

    linked_movement_id  INTEGER REFERENCES movements(id),
    parent_movement_id  INTEGER REFERENCES movements(id),
    budget_id           INTEGER REFERENCES budgets(id),

    recurrence_frequency TEXT,
    recurrence_day       INTEGER,
    recurrence_count     INTEGER,
    recurrence_rate      TEXT,

    created_at          TEXT NOT NULL
)
```

### `movement_entries` table (renamed from `transaction_entries`)

```sql
movement_entries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    movement_id     INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
    category_id     INTEGER REFERENCES categories(id),
    amount          TEXT NOT NULL,
    currency_code   TEXT NOT NULL,
    memo            TEXT NOT NULL DEFAULT '',
    quantity        TEXT,
    unit_price      TEXT,
    unit_label      TEXT
)
```

### `budgets` table (renamed from `spending_limits`)

```sql
budgets (
    id              INTEGER PRIMARY KEY,
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    spending_limit  TEXT NOT NULL,
    currency_code   TEXT NOT NULL,
    state           TEXT NOT NULL
)
```

### Tables that disappear

- `planned_items` → migrated to `movements` with state PLANNED
- `planned_item_entries` → migrated to `movement_entries`
- `recurring_obligations` → migrated to `movements` with state TEMPLATE
- `credit_card_installments` → migrated to `movements` with state TEMPLATE + recurrenceRule

### Columns that disappear from main table

- `type` (EXPENSE/INCOME/TRANSFER) — sign of amount + linkedMovementId
- `transfer_to_account_id` — replaced by linkedMovementId
- `transfer_to_amount`, `transfer_to_currency`, `conversion_rate` — live in linked Movement
- `related_transaction_id` — replaced by linkedMovementId
- `status` (CLEARED/PENDING/VOID) — replaced by state
- `is_planned` — derived from parentMovementId

---

## 9. Domain Services

### `TransferService`
Creates atomic transfer pairs. Coordinates edit/delete/void on both sides.

### `BudgetOpeningService` (refactored)
On budget open: queries active TEMPLATEs, generates PLANNED Movements for the period. Calculates credit card monthly obligations (interest on current balance, insurance, cuota sums).

### `CreditCardPaymentService`
Distributes a single payment to a credit card across pending PLANNEDs using FIFO. Decomposes each cuota into: transfer (capital) + expenses (interest, insurance). Generates all EXECUTED Movements atomically.

### `AmortizationCalculator` (unchanged)
French amortization system. Calculates capital/interest split per cuota based on current balance and rate.

---

## 10. Migration Strategy

Schema-first (Approach C): rename + extend existing tables via Room migration.

### Phase 1: Schema migration
1. Rename `transactions` → `movements`, add new columns (state, parent_movement_id, linked_movement_id, budget_id, recurrence_*)
2. Rename `transaction_entries` → `movement_entries`
3. Rename `spending_limits` → `budgets`, simplify columns
4. Migrate `planned_items` data into `movements` as state=PLANNED
5. Migrate `recurring_obligations` data into `movements` as state=TEMPLATE
6. Migrate `credit_card_installments` data into `movements` as state=TEMPLATE with recurrence
7. Convert existing TRANSFER transactions into pairs (split 1 row into 2 linked rows)
8. Drop old tables

### Phase 2: Domain layer
Rewrite Movement aggregate, Entry value object, domain services.

### Phase 3: Application layer
Rewrite commands, queries, DTOs. Eliminate duplicated entry building logic.

### Phase 4: View layer
Simplify ViewModels and Screens. Remove TRANSFER conditionals. Adapt to new DTOs.

---

## Open Items (Deferred)

- **Liability accounts auto-generating PLANNEDs**: Loans, mortgages generate amortized PLANNEDs. Keep current BudgetOpeningService logic, adapt to Movement model.
- **GMF tax**: Currently creates a sibling transaction. In new model, could be an additional EXECUTED linked via parentMovementId or a separate expense Movement.
- **Labels/tags**: No changes needed — labels stay on Movement.
- **Bluecoins import**: Needs adapter update for new schema. One-time migration.

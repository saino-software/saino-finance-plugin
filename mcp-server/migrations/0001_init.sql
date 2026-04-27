-- Saino Finance MCP — Initial Schema
-- Based on Movement Unification spec

-- Account types
CREATE TABLE IF NOT EXISTS account_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    group_name TEXT NOT NULL DEFAULT 'Bank Account' -- Asset, Liability, etc.
);

-- Accounts
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type_id INTEGER NOT NULL REFERENCES account_types(id),
    currency_code TEXT NOT NULL DEFAULT 'COP',
    opening_balance TEXT NOT NULL DEFAULT '0',
    is_hidden INTEGER NOT NULL DEFAULT 0,
    applies_gmf INTEGER NOT NULL DEFAULT 0,
    default_interest_rate TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Categories (hierarchical)
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES categories(id),
    category_type TEXT NOT NULL DEFAULT 'EXPENSE', -- EXPENSE, INCOME
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- Movements (unified: expense, income, transfer, planned, template)
CREATE TABLE IF NOT EXISTS movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state TEXT NOT NULL DEFAULT 'EXECUTED', -- TEMPLATE, PLANNED, EXECUTED, VOIDED, SKIPPED, FULFILLED
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    total_amount TEXT NOT NULL,
    currency_code TEXT NOT NULL,
    date TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    labels_csv TEXT NOT NULL DEFAULT '',

    -- Relationships
    linked_movement_id INTEGER REFERENCES movements(id), -- transfer pair
    parent_movement_id INTEGER REFERENCES movements(id), -- template→planned→executed chain
    budget_id INTEGER REFERENCES budgets(id),

    -- Recurrence (TEMPLATE only)
    recurrence_frequency TEXT,  -- MONTHLY, BIWEEKLY, WEEKLY
    recurrence_day INTEGER,
    recurrence_count INTEGER,  -- for installments: total cuotas
    recurrence_rate TEXT,      -- annual interest rate

    -- Installment helper (stored, not derived — needed at budget open time)
    installment_amount TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Movement entries (line items)
CREATE TABLE IF NOT EXISTS movement_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    movement_id INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id),
    amount TEXT NOT NULL,
    currency_code TEXT NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    quantity TEXT,
    unit_price TEXT,
    unit_label TEXT
);

-- Budgets
CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    spending_limit TEXT NOT NULL,
    currency_code TEXT NOT NULL DEFAULT 'COP',
    state TEXT NOT NULL DEFAULT 'OPEN', -- OPEN, CLOSED
    alert_50 INTEGER NOT NULL DEFAULT 0,
    alert_75 INTEGER NOT NULL DEFAULT 0,
    alert_90 INTEGER NOT NULL DEFAULT 0,
    alert_100 INTEGER NOT NULL DEFAULT 0
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_movements_account ON movements(account_id);
CREATE INDEX IF NOT EXISTS idx_movements_state ON movements(state);
CREATE INDEX IF NOT EXISTS idx_movements_date ON movements(date);
CREATE INDEX IF NOT EXISTS idx_movements_parent ON movements(parent_movement_id);
CREATE INDEX IF NOT EXISTS idx_movements_linked ON movements(linked_movement_id);
CREATE INDEX IF NOT EXISTS idx_movements_budget ON movements(budget_id);
CREATE INDEX IF NOT EXISTS idx_entries_movement ON movement_entries(movement_id);
CREATE INDEX IF NOT EXISTS idx_entries_category ON movement_entries(category_id);

-- Seed: Transfer category (ID=0, used for transfer entries)
INSERT OR IGNORE INTO categories (id, name, parent_id, category_type, icon, sort_order)
VALUES (0, 'Transfer', NULL, 'EXPENSE', 'swap_horiz', 0);

DELETE FROM movement_entries;
DELETE FROM movements;
DELETE FROM budgets;
DELETE FROM accounts;
DELETE FROM account_types;
DELETE FROM categories WHERE id != 0;
DELETE FROM sqlite_sequence WHERE name IN ('movement_entries','movements','budgets','accounts','account_types','categories');

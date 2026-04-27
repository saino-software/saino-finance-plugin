"""
Migrate the Android Saino Finance SQLite DB to the new D1 Movement schema.

Generates SQL files that can be applied to D1 via:
    npx wrangler d1 execute saino-finance --remote --file=migrations/data_NN_*.sql

Mapping:
- account_types -> account_types
- accounts -> accounts
- categories -> categories
- spending_limits -> budgets
- transactions (EXPENSE/INCOME) -> movements (state=EXECUTED)
- transactions (TRANSFER) -> 2 linked movements (atomic pair)
- transaction_entries -> movement_entries
- planned_items -> movements (state=PLANNED|SKIPPED|FULFILLED)
- planned_item_entries -> movement_entries
- recurring_obligations -> movements (state=TEMPLATE, VOIDED if cancelled)
- credit_card_installments -> movements (state=TEMPLATE, FULFILLED if paid_off)

Discarded: pending_transactions, exchange_rates, source_account_mappings,
budget_category_lines (empty), planned_expenses (empty/legacy)
"""

import sqlite3
import os
import sys

SRC_DB = r'C:/Dev/saino-finance/docs/findings/saino_backup_2026-04-26.db'
OUT_DIR = r'C:/Dev/saino-mcp/migrations'
CHUNK_SIZE = 500  # rows per SQL file for large tables


def esc(s):
    """SQL-escape a string value."""
    if s is None:
        return 'NULL'
    if isinstance(s, (int, float)):
        return str(s)
    if isinstance(s, bool):
        return '1' if s else '0'
    return "'" + str(s).replace("'", "''") + "'"


def write_sql(filename, statements):
    """Write SQL statements to a file."""
    path = os.path.join(OUT_DIR, filename)
    with open(path, 'w', encoding='utf-8') as f:
        for stmt in statements:
            f.write(stmt + ';\n')
    print(f"Wrote {len(statements)} statements to {filename}")


def write_chunked(prefix, statements):
    """Write SQL in multiple chunked files."""
    for i in range(0, len(statements), CHUNK_SIZE):
        chunk = statements[i:i + CHUNK_SIZE]
        suffix = f"_{i // CHUNK_SIZE:03d}"
        write_sql(f"{prefix}{suffix}.sql", chunk)


def main():
    src = sqlite3.connect(SRC_DB)
    src.row_factory = sqlite3.Row
    cur = src.cursor()

    statements = []

    # ─── 0. CLEAR ───
    print("\n=== Clear D1 ===")
    clear = [
        "DELETE FROM movement_entries",
        "DELETE FROM movements",
        "DELETE FROM budgets",
        "DELETE FROM accounts",
        "DELETE FROM account_types",
        "DELETE FROM categories WHERE id != 0",  # keep Transfer category
        "DELETE FROM sqlite_sequence WHERE name IN ('movement_entries','movements','budgets','accounts','account_types','categories')",
    ]
    write_sql("data_00_clear.sql", clear)

    # ─── 1. ACCOUNT TYPES ───
    print("\n=== account_types ===")
    s = []
    for r in cur.execute("SELECT id, name, account_group FROM account_types"):
        s.append(
            f"INSERT INTO account_types (id, name, group_name) VALUES "
            f"({r['id']}, {esc(r['name'])}, {esc(r['account_group'] or 'Bank Account')})"
        )
    write_sql("data_01_account_types.sql", s)

    # ─── 2. ACCOUNTS ───
    print("\n=== accounts ===")
    s = []
    for r in cur.execute("""
        SELECT id, name, type_id, currency, opening_balance, is_hidden, applies_gmf,
               default_interest_rate
        FROM accounts
    """):
        s.append(
            f"INSERT INTO accounts (id, name, type_id, currency_code, opening_balance, "
            f"is_hidden, applies_gmf, default_interest_rate) VALUES "
            f"({r['id']}, {esc(r['name'])}, {r['type_id']}, {esc(r['currency'])}, "
            f"{esc(r['opening_balance'])}, {1 if r['is_hidden'] else 0}, "
            f"{1 if r['applies_gmf'] else 0}, {esc(r['default_interest_rate'])})"
        )
    write_sql("data_02_accounts.sql", s)

    # ─── 3. CATEGORIES ───
    print("\n=== categories ===")
    s = []
    for r in cur.execute("SELECT id, name, parent_id, category_type, icon, sort_order FROM categories"):
        if r['id'] == 0:  # already seeded
            continue
        s.append(
            f"INSERT INTO categories (id, name, parent_id, category_type, icon, sort_order) VALUES "
            f"({r['id']}, {esc(r['name'])}, {esc(r['parent_id'])}, "
            f"{esc(r['category_type'] or 'EXPENSE')}, {esc(r['icon'])}, {r['sort_order'] or 0})"
        )
    write_sql("data_03_categories.sql", s)

    # ─── 4. BUDGETS (from spending_limits) ───
    print("\n=== budgets ===")
    s = []
    for r in cur.execute("""
        SELECT id, start_date, end_date, status, limit_amount, currency,
               alert_50, alert_75, alert_90, alert_100
        FROM spending_limits
    """):
        state = 'OPEN' if r['status'] in ('OPEN', 'ACTIVE') else 'CLOSED'
        s.append(
            f"INSERT INTO budgets (id, start_date, end_date, spending_limit, currency_code, "
            f"state, alert_50, alert_75, alert_90, alert_100) VALUES "
            f"({r['id']}, {esc(r['start_date'])}, {esc(r['end_date'])}, "
            f"{esc(r['limit_amount'])}, {esc(r['currency'] or 'COP')}, {esc(state)}, "
            f"{1 if r['alert_50'] else 0}, {1 if r['alert_75'] else 0}, "
            f"{1 if r['alert_90'] else 0}, {1 if r['alert_100'] else 0})"
        )
    write_sql("data_04_budgets.sql", s)

    # Build planned_item lookup: tx_id -> planned_item_id (for FULFILLED chain)
    planned_by_tx = {}
    for r in cur.execute("SELECT id, linked_transaction_id, status FROM planned_items"):
        if r['linked_transaction_id'] and r['status'] == 'FULFILLED':
            planned_by_tx[r['linked_transaction_id']] = r['id']

    # ID offsets: planned_items get IDs > max(transaction_id) to avoid collision
    # We need to allocate new IDs for the "incoming" side of transfers
    src_max_tx = cur.execute("SELECT COALESCE(MAX(id),0) FROM transactions").fetchone()[0]
    src_max_planned = cur.execute("SELECT COALESCE(MAX(id),0) FROM planned_items").fetchone()[0]
    src_max_recurring = cur.execute("SELECT COALESCE(MAX(id),0) FROM recurring_obligations").fetchone()[0]
    src_max_inst = cur.execute("SELECT COALESCE(MAX(id),0) FROM credit_card_installments").fetchone()[0]

    # ID layout in destination:
    #   1 .. src_max_tx                    -> transactions (EXECUTED)
    #   100000 .. 100000+src_max_tx        -> transfer "incoming" side (paired)
    #   200000 .. 200000+src_max_planned   -> planned_items (PLANNED)
    #   300000 .. 300000+src_max_recurring -> recurring_obligations (TEMPLATE)
    #   400000 .. 400000+src_max_inst      -> installments (TEMPLATE)
    TX_BASE = 0
    TRANSFER_IN_BASE = 100000
    PLANNED_BASE = 200000
    RECURRING_BASE = 300000
    INSTALLMENT_BASE = 400000

    print(f"\nID base offsets: tx=0, transfer_in={TRANSFER_IN_BASE}, "
          f"planned={PLANNED_BASE}, recurring={RECURRING_BASE}, installment={INSTALLMENT_BASE}")

    # ─── 5. MOVEMENTS from transactions ───
    print("\n=== movements (from transactions) ===")
    movements = []
    entries = []
    transfer_links = []  # (out_id, in_id) pairs for UPDATE later

    # Get account currency map
    acc_currency = {r['id']: r['currency']
                    for r in cur.execute("SELECT id, currency FROM accounts")}

    # Pre-compute totals per tx (avoid cursor reset inside loop)
    tx_totals = {}
    for r in cur.execute("SELECT transaction_id, SUM(CAST(amount AS REAL)) as total FROM transaction_entries GROUP BY transaction_id"):
        tx_totals[r['transaction_id']] = r['total'] or 0

    tx_rows = list(cur.execute("""
        SELECT id, type, status, account_id, date, notes, title, is_planned,
               transfer_to_account_id, conversion_rate, transfer_to_amount,
               transfer_to_currency, related_transaction_id, labels_csv, created_at
        FROM transactions
    """).fetchall())

    fulfillment_updates = []  # (tx_id, planned_id) to UPDATE after planned movements exist

    for r in tx_rows:
        tx_id = r['id']
        state = 'VOIDED' if r['status'] == 'VOID' else 'EXECUTED'
        currency = acc_currency.get(r['account_id'], 'COP')
        total = tx_totals.get(tx_id, 0)

        if r['type'] == 'EXPENSE':
            total_amount = -abs(total)
        elif r['type'] == 'INCOME':
            total_amount = abs(total)
        elif r['type'] == 'TRANSFER':
            total_amount = -abs(total)  # outgoing side
        else:
            total_amount = total

        # Parent link if this tx fulfills a planned_item — applied as UPDATE later
        if tx_id in planned_by_tx:
            fulfillment_updates.append((tx_id, PLANNED_BASE + planned_by_tx[tx_id]))

        movements.append((
            tx_id, state, r['account_id'], total_amount, currency,
            r['date'], r['title'] or '', r['notes'] or '',
            r['labels_csv'] or '', None, None, None,
            r['created_at']
        ))

        # If TRANSFER, create the incoming side
        if r['type'] == 'TRANSFER' and r['transfer_to_account_id']:
            in_id = TRANSFER_IN_BASE + tx_id
            in_currency = r['transfer_to_currency'] or acc_currency.get(r['transfer_to_account_id'], currency)
            in_amount = float(r['transfer_to_amount']) if r['transfer_to_amount'] else abs(total)
            movements.append((
                in_id, state, r['transfer_to_account_id'], in_amount, in_currency,
                r['date'], r['title'] or '', r['notes'] or '',
                r['labels_csv'] or '', None, None, None,
                r['created_at']
            ))
            transfer_links.append((tx_id, in_id))
            # Mirror entry on the incoming side (category=0 for transfer)
            entries.append((in_id, 0, in_amount, in_currency, '', None, None, None))

    # Generate INSERT statements
    s = []
    for m in movements:
        s.append(
            f"INSERT INTO movements (id, state, account_id, total_amount, currency_code, "
            f"date, title, notes, labels_csv, linked_movement_id, parent_movement_id, "
            f"budget_id, created_at) VALUES ({m[0]}, {esc(m[1])}, {m[2]}, {esc(str(m[3]))}, "
            f"{esc(m[4])}, {esc(m[5])}, {esc(m[6])}, {esc(m[7])}, {esc(m[8])}, "
            f"{esc(m[9])}, {esc(m[10])}, {esc(m[11])}, {esc(m[12] or '')})"
        )
    write_chunked("data_05_movements_tx", s)

    # Update linked_movement_id for transfer pairs
    s = []
    for out_id, in_id in transfer_links:
        s.append(f"UPDATE movements SET linked_movement_id = {in_id} WHERE id = {out_id}")
        s.append(f"UPDATE movements SET linked_movement_id = {out_id} WHERE id = {in_id}")
    write_chunked("data_06_transfer_links", s)

    # ─── 6. MOVEMENT_ENTRIES from transaction_entries ───
    print("\n=== movement_entries (from transaction_entries) ===")
    s = []
    for r in cur.execute("""
        SELECT transaction_id, category_id, amount, currency_code, memo,
               quantity, unit_price, unit_label
        FROM transaction_entries
    """):
        s.append(
            f"INSERT INTO movement_entries (movement_id, category_id, amount, "
            f"currency_code, memo, quantity, unit_price, unit_label) VALUES "
            f"({r['transaction_id']}, {esc(r['category_id'])}, {esc(r['amount'])}, "
            f"{esc(r['currency_code'])}, {esc(r['memo'] or '')}, "
            f"{esc(r['quantity'])}, {esc(r['unit_price'])}, {esc(r['unit_label'])})"
        )
    # Add transfer-incoming-side entries
    for e in entries:
        s.append(
            f"INSERT INTO movement_entries (movement_id, category_id, amount, "
            f"currency_code, memo, quantity, unit_price, unit_label) VALUES "
            f"({e[0]}, {e[1]}, {esc(str(e[2]))}, {esc(e[3])}, {esc(e[4])}, "
            f"{esc(e[5])}, {esc(e[6])}, {esc(e[7])})"
        )
    write_chunked("data_07_movement_entries", s)

    # ─── 7. PLANNED_ITEMS as movements ───
    print("\n=== movements (from planned_items) ===")
    s = []
    state_map = {'PENDING': 'PLANNED', 'OVERDUE': 'PLANNED', 'PARTIAL': 'PLANNED',
                 'SKIPPED': 'SKIPPED', 'FULFILLED': 'FULFILLED', 'COMPLETED': 'FULFILLED'}
    for r in cur.execute("""
        SELECT id, budget_id, name, type, expected_amount, currency, expected_date,
               category_id, account_id, source, status, linked_transaction_id, notes
        FROM planned_items
    """):
        new_id = PLANNED_BASE + r['id']
        state = state_map.get(r['status'], 'PLANNED')
        amount = r['expected_amount']
        # Sign: EXPENSE negative, INCOME positive
        try:
            amt_val = float(amount)
            if r['type'] == 'EXPENSE':
                amt_val = -abs(amt_val)
            else:
                amt_val = abs(amt_val)
            amount = str(amt_val)
        except (ValueError, TypeError):
            pass

        s.append(
            f"INSERT INTO movements (id, state, account_id, total_amount, currency_code, "
            f"date, title, notes, budget_id) VALUES ({new_id}, {esc(state)}, "
            f"{r['account_id']}, {esc(amount)}, {esc(r['currency'] or 'COP')}, "
            f"{esc(r['expected_date'])}, {esc(r['name'] or '')}, {esc(r['notes'] or '')}, "
            f"{esc(r['budget_id'])})"
        )
        # Single entry mirror
        s.append(
            f"INSERT INTO movement_entries (movement_id, category_id, amount, "
            f"currency_code, memo) VALUES ({new_id}, {esc(r['category_id'])}, "
            f"{esc(amount)}, {esc(r['currency'] or 'COP')}, '')"
        )
    write_chunked("data_08_planned_movements", s)

    # ─── 8. PLANNED_ITEM_ENTRIES (only 1 row, but handle it) ───
    print("\n=== movement_entries (from planned_item_entries) ===")
    s = []
    # Note: this OVERWRITES the simple entry inserted above for that planned item
    for r in cur.execute("""
        SELECT planned_item_id, category_id, amount, currency_code, memo,
               quantity, unit_price, unit_label
        FROM planned_item_entries
    """):
        new_movement_id = PLANNED_BASE + r['planned_item_id']
        # Delete the placeholder single-entry first
        s.append(f"DELETE FROM movement_entries WHERE movement_id = {new_movement_id}")
        s.append(
            f"INSERT INTO movement_entries (movement_id, category_id, amount, "
            f"currency_code, memo, quantity, unit_price, unit_label) VALUES "
            f"({new_movement_id}, {esc(r['category_id'])}, {esc(r['amount'])}, "
            f"{esc(r['currency_code'])}, {esc(r['memo'] or '')}, "
            f"{esc(r['quantity'])}, {esc(r['unit_price'])}, {esc(r['unit_label'])})"
        )
    write_sql("data_09_planned_entries.sql", s)

    # ─── 9. RECURRING_OBLIGATIONS as TEMPLATEs ───
    print("\n=== movements (from recurring_obligations) ===")
    s = []
    for r in cur.execute("""
        SELECT id, name, type, amount, currency, frequency, expected_day,
               category_id, account_id, status, created_at
        FROM recurring_obligations
    """):
        new_id = RECURRING_BASE + r['id']
        state = 'VOIDED' if r['status'] in ('CANCELLED', 'CANCELED') else 'TEMPLATE'
        try:
            amt_val = float(r['amount'])
            if r['type'] == 'EXPENSE':
                amt_val = -abs(amt_val)
            else:
                amt_val = abs(amt_val)
            amount = str(amt_val)
        except (ValueError, TypeError):
            amount = r['amount']

        s.append(
            f"INSERT INTO movements (id, state, account_id, total_amount, currency_code, "
            f"date, title, recurrence_frequency, recurrence_day, created_at) VALUES "
            f"({new_id}, {esc(state)}, {r['account_id']}, {esc(amount)}, "
            f"{esc(r['currency'] or 'COP')}, {esc(r['created_at'][:10] if r['created_at'] else '2026-01-01')}, "
            f"{esc(r['name'] or '')}, {esc(r['frequency'])}, {esc(r['expected_day'])}, "
            f"{esc(r['created_at'])})"
        )
        s.append(
            f"INSERT INTO movement_entries (movement_id, category_id, amount, "
            f"currency_code, memo) VALUES ({new_id}, {esc(r['category_id'])}, "
            f"{esc(amount)}, {esc(r['currency'] or 'COP')}, '')"
        )
    write_sql("data_10_recurring.sql", s)

    # ─── 10. CREDIT_CARD_INSTALLMENTS as TEMPLATEs ───
    print("\n=== movements (from credit_card_installments) ===")
    s = []
    for r in cur.execute("""
        SELECT id, account_id, transaction_id, description, total_amount, currency,
               installments, annual_rate, installment_amount, status, start_date
        FROM credit_card_installments
    """):
        new_id = INSTALLMENT_BASE + r['id']
        state = 'FULFILLED' if r['status'] == 'PAID_OFF' else 'TEMPLATE'
        amount = '-' + str(abs(float(r['installment_amount'])))
        s.append(
            f"INSERT INTO movements (id, state, account_id, total_amount, currency_code, "
            f"date, title, parent_movement_id, recurrence_frequency, recurrence_count, "
            f"recurrence_rate, installment_amount) VALUES "
            f"({new_id}, {esc(state)}, {r['account_id']}, {esc(amount)}, "
            f"{esc(r['currency'] or 'COP')}, {esc(r['start_date'])}, "
            f"{esc(r['description'] or 'Installment')}, {esc(r['transaction_id'])}, "
            f"'MONTHLY', {r['installments']}, {esc(r['annual_rate'])}, "
            f"{esc(str(abs(float(r['installment_amount']))))})"
        )
        s.append(
            f"INSERT INTO movement_entries (movement_id, category_id, amount, "
            f"currency_code, memo) VALUES ({new_id}, NULL, {esc(amount)}, "
            f"{esc(r['currency'] or 'COP')}, 'Cuota')"
        )
    write_sql("data_11_installments.sql", s)

    # ─── 11. FULFILLMENT CHAIN UPDATEs (set parent_movement_id on EXECUTED tx → planned) ───
    print("\n=== fulfillment chain updates ===")
    s = []
    for tx_id, planned_id in fulfillment_updates:
        s.append(f"UPDATE movements SET parent_movement_id = {planned_id} WHERE id = {tx_id}")
    write_sql("data_12_fulfillment_links.sql", s)

    src.close()
    print("\nDone. Apply with:")
    print("  cd C:/Dev/saino-mcp")
    print("  for f in migrations/data_*.sql; do npx wrangler d1 execute saino-finance --remote --file=$f; done")


if __name__ == '__main__':
    main()

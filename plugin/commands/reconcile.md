---
description: Start the batch reconciliation workflow for a bank/credit card statement. Triages, dedupes, drills into large purchases, registers, then reports budget impact.
argument-hint: [optional: paste the statement text or path to a file]
---

The user wants to reconcile a batch of movements from a bank or credit card statement. Follow the **`reconciling-statements`** skill workflow strictly — it has 8 phases, do them in order.

Quick reminder of the phases:

1. **Normalize**: build a working table from whatever input format the user gave (paste, PDF, CSV, verbal).
2. **Dedupe**: `list_movements` for the period and account; flag anything that already exists.
3. **Categorize per account**: one account at a time; show table for confirmation.
4. **Drill into large purchases**: ask for receipts; parse into multi-item entries.
5. **Register in batches**: actual MCP calls.
6. **Reconcile against budget**: `budget_status`; show updated daily allowance.
7. **Link fulfilled planned items**: suggest matches against active PLANNEDs.
8. **Summary**: totals, budget impact, anomalies.

Start by asking for the statement if not provided. Then proceed phase by phase, pausing for confirmation between phases for anything destructive.

Do NOT register anything until the user confirms. The whole point is the human-in-the-loop verification.

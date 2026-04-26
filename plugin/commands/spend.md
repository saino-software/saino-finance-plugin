---
description: Quickly record an expense from a short natural-language description (e.g., "85k almuerzo nequi"). Parses amount, account, and category from the input.
argument-hint: [amount] [description] [account] [category?]
---

The user wants to register a quick one-off expense. The arguments are loose — parse them out:

- **Amount**: usually first number, supports `85k` `85.000` `85000` notations. Convert to integer.
- **Account**: a name like `Nequi`, `Bancolombia`, `MasterCard Falabella`. Use `mcp__saino-finance__list_accounts` if you don't know the ID. Match case-insensitive substring.
- **Category**: optional. If given, find via `list_categories`. If not given, infer from description (almuerzo → "Comer fuera", uber → "Transporte", etc.).
- **Date**: today unless the user says otherwise.

Workflow:
1. Parse the args. If anything is ambiguous (multiple matching accounts, no obvious category), **ask**.
2. Show a one-line preview: `→ -$85,000 Almuerzo / Comer fuera / Nequi / 2026-04-26`
3. Wait for "ok" / "sí" / nothing-but-a-period (silent confirmation).
4. Call `mcp__saino-finance__record_expense` with single item.
5. Reply with the new movement ID and the updated daily allowance (call `budget_status` and show only that field).

If the input was clear (e.g., `/saino-spend 85k almuerzo nequi`), feel free to skip preview and register directly. If anything is fuzzy, preview first.

Don't list categories unless asked. Don't dump tool output as JSON.

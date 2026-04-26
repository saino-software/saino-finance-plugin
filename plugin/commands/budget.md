---
description: Show current budget status — daily allowance, total spent, breakdown by category, alerts.
---

Call `mcp__saino-finance__budget_status` and present the result as a clean summary:

- Period and limit
- **Daily allowance** (highlighted)
- Spent vs remaining (with percentage bar like `[████████░░░░] 67%`)
- Days left in period
- Top categories by spend (table with category, total, % of budget)
- Active alerts (which thresholds have already fired)

If `hasBudget: false`, say so and offer to help create one.

Be concise. The user wants a glance, not a wall of JSON.

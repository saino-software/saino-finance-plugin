---
description: Show price history for a product or category — how the unit price changed over time.
argument-hint: [search term — product or category, e.g., "arroz", "gasolina", "Comida"]
---

Call `mcp__saino-finance__price_history` with the user's search term.

Present the result as:
1. A table sorted by date DESC: `Fecha | Producto | Cant | Unidad | P/U | Tienda`
2. A summary line: `Última compra: $X/unidad. Hace 6 meses: $Y/unidad. Cambio: +Z%`
3. If only one or two data points exist, say so and remind the user that price tracking improves as they record more purchases with quantity + unit price.

Don't include rows where `unit_price` is missing — they're noise for this report.

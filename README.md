# Saino Finance Plugin

A Claude Code plugin for personal finance management, backed by a Cloudflare Workers MCP server.

## What this is

Two things in one repo:

1. **`plugin/`** — A Claude Code plugin with skills (domain knowledge) and slash commands. Installable in any Claude Code session.
2. **`mcp-server/`** — A Cloudflare Workers MCP server that exposes financial tools (record expenses, manage budgets, query reports, track prices) to Claude. Backed by a D1 SQLite database.

The plugin connects to the MCP server. Together they let you manage your finances by talking to Claude — on PC, mobile, or anywhere Claude runs.

## Why

Mobile apps for personal finance force you into rigid, tap-heavy workflows. This project replaces that with conversational finance:

- "Acabo de gastar 85k en almuerzo en Nequi" → registered.
- "¿Cómo voy con el presupuesto este mes?" → daily allowance + breakdown.
- "Pásame esta factura de Alkosto y distribúyela en categorías" → parsed, categorized, recorded.
- "¿Subió el precio del arroz?" → price history chart.

## Architecture

```
Claude (PC, mobile, web)
    ↓ MCP over HTTPS
Cloudflare Worker (saino-mcp.saino.software)
    ↓ Cloudflare Access (Service Token auth)
Worker code (TypeScript, McpAgent)
    ↓ D1 binding
D1 SQLite database (Movement schema)
```

All Cloudflare resources are managed via Terraform in `infra/`.

## Repo layout

```
saino-finance-plugin/
├── plugin/              # Claude Code plugin (skills, commands, MCP config)
├── mcp-server/          # Cloudflare Worker source code
├── infra/               # Terraform for all Cloudflare resources
├── docs/                # Functional specs (source of truth for the domain model)
└── scripts/             # One-time scripts (gitignored — for personal use)
```

## Status

Work in progress. See `docs/specs/` for the domain model.

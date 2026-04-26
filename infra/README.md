# Infrastructure (Terraform)

All Cloudflare resources for Saino Finance MCP, managed declaratively.

## Resources managed

- **D1 database** (`saino-finance`) — SQLite at the edge
- **D1 schema** — applied via `wrangler d1 execute` from a `null_resource`
- **Worker** (`saino-mcp`) — deployed via Wrangler from `mcp-server/`
- **Custom domain** — `saino-mcp.saino.software` → Worker
- **Zero Trust Access Application** — protects the Worker URL
- **Access Policies**:
  - `email-allow` — login flow for browser-based access (your Google email)
  - `service-token-auth` — for Claude Code MCP authentication
- **Service Token** — credentials Claude uses to authenticate

## Setup

1. Install Terraform (>= 1.6)
2. Create `terraform.tfvars` from `terraform.tfvars.example`:
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   # Fill in your Cloudflare account ID, API token, zone ID, email
   ```
3. Init and apply:
   ```bash
   terraform init
   terraform plan
   terraform apply
   ```

## What gets versioned

- `*.tf` files
- `terraform.tfvars.example` (template, no secrets)

## What does NOT get versioned

- `terraform.tfvars` (contains secrets)
- `*.tfstate` (contains current state, may have secrets)
- `.terraform/` (provider downloads)

## Outputs

After apply:
- D1 database ID
- Worker URL
- Custom domain
- Access App AUD (audience tag)
- Service Token Client ID (Client Secret is sensitive — see `terraform output -raw service_token_client_secret`)

## Note on Worker deployment

Terraform creates the D1 database and Access resources. The Worker code itself is deployed via `wrangler deploy` from `mcp-server/` (Wrangler is the right tool for code uploads). Terraform manages the bindings and routing.

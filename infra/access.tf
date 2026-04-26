# Cloudflare Zero Trust Access — protects the MCP Worker URL.

resource "cloudflare_zero_trust_access_application" "saino_mcp" {
  account_id       = var.cloudflare_account_id
  name             = "Saino MCP"
  domain           = var.domain_name
  type             = "self_hosted"
  session_duration = "24h"

  # Skip identity providers when the request matches a Service Auth policy
  skip_interstitial = true
}

# Service Token for machine-to-machine auth (Claude Code).
resource "cloudflare_zero_trust_access_service_token" "claude" {
  account_id = var.cloudflare_account_id
  name       = "claude-code"
}

# Policy 1: Service Auth for Claude (no identity provider login)
resource "cloudflare_zero_trust_access_policy" "service_token" {
  account_id     = var.cloudflare_account_id
  application_id = cloudflare_zero_trust_access_application.saino_mcp.id
  name           = "claude-service-token"
  decision       = "non_identity"
  precedence     = 1

  include = [
    {
      service_token = {
        token_id = cloudflare_zero_trust_access_service_token.claude.id
      }
    }
  ]
}

# Policy 2: Allow owner email for browser-based access
resource "cloudflare_zero_trust_access_policy" "email_allow" {
  account_id     = var.cloudflare_account_id
  application_id = cloudflare_zero_trust_access_application.saino_mcp.id
  name           = "owner-email"
  decision       = "allow"
  precedence     = 2

  include = [
    {
      email = {
        email = var.owner_email
      }
    }
  ]
}

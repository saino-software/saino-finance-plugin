variable "cloudflare_api_token" {
  description = "Cloudflare API token with permissions: Account:D1:Edit, Account:Workers Scripts:Edit, Account:Access:Edit, Zone:DNS:Edit"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the domain (saino.software)"
  type        = string
}

variable "domain_name" {
  description = "Custom domain for the MCP Worker"
  type        = string
  default     = "saino-mcp.saino.software"
}

variable "owner_email" {
  description = "Email allowed via the email-allow Access policy (browser login)"
  type        = string
}

variable "access_team_name" {
  description = "Cloudflare Access team name (the part before .cloudflareaccess.com)"
  type        = string
  default     = "sainosoftware"
}

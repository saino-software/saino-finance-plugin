output "d1_database_id" {
  description = "D1 database UUID — needed in mcp-server/wrangler.jsonc"
  value       = cloudflare_d1_database.saino_finance.id
}

output "d1_database_name" {
  value = cloudflare_d1_database.saino_finance.name
}

output "worker_url" {
  description = "Public URL of the deployed Worker"
  value       = "https://${var.domain_name}"
}

output "access_app_aud" {
  description = "Audience tag for the Access application (used to validate JWTs)"
  value       = cloudflare_zero_trust_access_application.saino_mcp.aud
}

output "service_token_client_id" {
  description = "Client ID for the Claude service token"
  value       = cloudflare_zero_trust_access_service_token.claude.client_id
}

output "service_token_client_secret" {
  description = "Client Secret for the Claude service token (sensitive — only shown on creation)"
  value       = cloudflare_zero_trust_access_service_token.claude.client_secret
  sensitive   = true
}

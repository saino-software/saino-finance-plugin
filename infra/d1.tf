# D1 SQLite database for Saino Finance.
# Schema is applied via wrangler in a null_resource because the D1 provider
# does not manage schema directly.

resource "cloudflare_d1_database" "saino_finance" {
  account_id = var.cloudflare_account_id
  name       = "saino-finance"
}

# Apply schema via wrangler. Re-runs whenever the schema file hash changes.
resource "null_resource" "d1_schema" {
  triggers = {
    schema_hash   = filesha256("${path.module}/../mcp-server/schema/0001_init.sql")
    database_id   = cloudflare_d1_database.saino_finance.id
    database_name = cloudflare_d1_database.saino_finance.name
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/../mcp-server"
    command     = "npx wrangler d1 execute ${self.triggers.database_name} --remote --file=schema/0001_init.sql"

    environment = {
      CLOUDFLARE_API_TOKEN  = var.cloudflare_api_token
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
    }
  }

  depends_on = [cloudflare_d1_database.saino_finance]
}

# The Worker code itself is uploaded via wrangler from mcp-server/.
# Terraform manages the resources around it: D1 binding, Durable Object, custom domain.
# We use null_resource to invoke wrangler deploy, parameterized with the D1 ID Terraform manages.

resource "null_resource" "worker_deploy" {
  triggers = {
    # Re-deploy when source or wrangler config changes
    source_hash   = sha256(join("", [
      for f in fileset("${path.module}/../mcp-server/src", "**/*.ts") :
      filesha256("${path.module}/../mcp-server/src/${f}")
    ]))
    config_hash   = filesha256("${path.module}/../mcp-server/wrangler.jsonc")
    d1_id         = cloudflare_d1_database.saino_finance.id
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/../mcp-server"
    command     = "npx wrangler deploy"

    environment = {
      CLOUDFLARE_API_TOKEN  = var.cloudflare_api_token
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
    }
  }

  depends_on = [null_resource.d1_schema]
}

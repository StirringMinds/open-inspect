# =============================================================================
# Cloudflare Container Sandbox Infrastructure
# =============================================================================

locals {
  use_cloudflare_backend = var.sandbox_provider == "cloudflare"
}

module "cloudflare_sandbox_infra" {
  count  = local.use_cloudflare_backend ? 1 : 0
  source = "../../modules/cloudflare-sandbox"

  cloudflare_api_token  = var.cloudflare_api_token
  cloudflare_account_id = var.cloudflare_account_id
  worker_name           = module.control_plane_worker.worker_name
  control_plane_path    = "${var.project_root}/packages/control-plane"
  source_hash           = "${local.control_plane_script_path}-${timestamp()}"
  environment_variables = {
    SANDBOX_PROVIDER    = var.sandbox_provider
    SANDBOX_SLEEP_AFTER = var.sandbox_sleep_after
  }
}

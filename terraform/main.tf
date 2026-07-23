resource "cloudflare_pages_project" "this" {
  account_id        = var.cloudflare_account_id
  name              = var.project_name
  production_branch = "main"
}

resource "cloudflare_pages_domain" "this" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.this.name
  domain       = var.custom_domain
}

# CNAME that routes the custom domain to the Pages project
# Issue #23: renamed from cloudflare_record (v4) to cloudflare_dns_record (v5)
# alongside the provider version bump in providers.tf. The `moved` block
# below tells Terraform this is the same resource under a new type/name, so
# `terraform plan` should show an in-place move, not a destroy+recreate.
resource "cloudflare_dns_record" "pages_cname" {
  zone_id = var.zone_id
  name    = var.custom_domain
  type    = "CNAME"
  content = cloudflare_pages_project.this.subdomain
  proxied = true
  ttl     = 1 # "Automatic" TTL when proxied, matching the v4 resource's implicit default
}

moved {
  from = cloudflare_record.pages_cname
  to   = cloudflare_dns_record.pages_cname
}

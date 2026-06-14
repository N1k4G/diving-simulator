output "pages_dev_url" {
  description = "Default Cloudflare Pages URL"
  value       = "https://${cloudflare_pages_project.this.subdomain}"
}

output "custom_domain_url" {
  description = "Custom domain URL"
  value       = "https://${var.custom_domain}"
}

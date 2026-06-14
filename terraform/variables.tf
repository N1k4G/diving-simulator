variable "cloudflare_api_token" {
  description = "Cloudflare API token with Cloudflare Pages and DNS edit permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (find in the right sidebar of any zone dashboard)"
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone ID for the domain (find in the right sidebar of the zone dashboard)"
  type        = string
}

variable "project_name" {
  description = "Cloudflare Pages project name"
  type        = string
  default     = "diving-simulator"
}

variable "custom_domain" {
  description = "Custom domain to attach to the Pages project"
  type        = string
  default     = "scuba.gorman.monster"
}

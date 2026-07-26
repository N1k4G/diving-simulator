terraform {
  required_version = ">= 1.5"

  cloud {
    organization = "Infrastruktur"
    workspaces {
      name = "diving-simulator"
    }
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      # Issue #23: v5 renames cloudflare_record -> cloudflare_dns_record (see
      # main.tf and the `moved` block below). DO NOT run `terraform apply`
      # with this version bump before running `terraform plan` in the live
      # HCP workspace ("Infrastruktur/diving-simulator") and confirming it
      # shows an in-place state move (via the `moved` block), not a
      # destroy/recreate of the production DNS record for scuba.gorman.monster.
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

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
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

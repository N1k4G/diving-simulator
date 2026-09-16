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
      source = "cloudflare/cloudflare"
      # Issue #23: v5 renames cloudflare_record -> cloudflare_dns_record (see
      # main.tf and the `moved` block below). DO NOT run `terraform apply`
      # with this version bump before running `terraform plan` in the live
      # HCP workspace ("Infrastruktur/diving-simulator") and confirming it
      # shows an in-place state move (via the `moved` block), not a
      # destroy/recreate of the production DNS record for scuba.gorman.monster.
      #
      # Floor raised from ~> 5.0 to >= 5.20, < 6.0 (2026-09-16). cloudflare_
      # pages_project — the resource right next to the one this issue is
      # about — had a documented forces-replacement bug in early v5.x
      # (upstream #5146: any update destroy/recreates the project). >= 5.20
      # is the first release with the fix upstream cites for this exact
      # resource ("fix pages_project: fix source.config drift for API-
      # populated fields by preserving computed state values"). The open
      # ~> 5.0 constraint could re-resolve to the buggy 5.1.0 on a future
      # re-init. Applied against the live workspace on 2026-09-16 (run
      # run-r8tWZdNA3JmywgiM): cloudflare_pages_project.this resolved as an
      # in-place update — id/name no-op/unchanged, only the build_config
      # sub-fields the v5 state upgrader can't carry forward from v4 state
      # showed known-after-apply — not the replacement bug's signature
      # (which shows id itself changing under a `# forces replacement`
      # marker).
      #
      # This range is a floor, not a pin: it still admits every future 5.x.
      # What actually decides which build reaches production is
      # .terraform.lock.hcl, which IS committed — it has to be, now that the
      # workspace auto-applies. Raise the provider by running
      # `terraform init -upgrade` and reviewing the lock diff in a PR, never
      # by widening this constraint and letting a run resolve whatever is
      # newest.
      version = ">= 5.20, < 6.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

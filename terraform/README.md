# Terraform

Manages the Cloudflare Pages project and DNS record for
`scuba.gorman.monster`, applied via HCP Terraform Cloud (workspace
`Infrastruktur/diving-simulator`). There is no CI workflow for
`terraform plan`/`apply` — runs happen through the HCP workspace directly.

## Provider v5 migration (issue #23)

`providers.tf`/`main.tf` are staged for the Cloudflare provider v4 → v5
migration: `cloudflare_record` renamed to `cloudflare_dns_record`, with a
`moved` block so Terraform treats it as an in-place rename rather than a
destroy/recreate.

**This has not been applied.** Before merging or running `apply` against the
live workspace:

1. Run `terraform plan` in the HCP workspace and confirm it reports a
   resource *move* (via the `moved` block), not a destroy+create, for
   `cloudflare_dns_record.pages_cname`.
2. Double-check `cloudflare_pages_project`/`cloudflare_pages_domain` against
   the actual v5 provider schema — they weren't renamed, but attribute-level
   changes are possible and weren't independently verified here.
3. Only apply once the plan output confirms no destructive change to the
   production DNS record.

`cloudflare_pages_project`/`cloudflare_pages_domain` (`account_id`, custom
domain default in `variables.tf`) are unchanged.

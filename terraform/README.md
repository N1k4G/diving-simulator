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

**Plan confirmed, not yet applied.** `terraform plan` was run in the live HCP
workspace (2026-09-16) and reported no diff at all for
`cloudflare_dns_record.pages_cname` — the `moved` block resolved as a clean
in-place rename, not a destroy+create, for the production DNS record. That
was the one thing this migration could not ship without.

The plan did show a change adjacent to it: `cloudflare_pages_project.this`
gained a `build_config` block with several sub-attributes reported as *known
after apply*. `id` and `name` were `no-op` with their existing values
unchanged, which rules out the specific destructive bug this resource had in
early v5.x (upstream #5146 — forces replacement on any update, with a
`# forces replacement` marker and `id` itself changing; neither appeared
here). What's left matches a separate, documented, non-destructive cause: the
v5 state upgrader cannot carry every `build_config` field forward from
v4-shaped state, so those fields populate on the next real `apply`. The fix
upstream cites for this exact resource landed in 5.20.0; `providers.tf` now
floors on `>= 5.20, < 6.0` (was the open `~> 5.0`, which could have
re-resolved to the buggy 5.1.0 on a future re-init with no lock file
committed to prevent it — see `.gitignore`).

Before running `apply` against the live workspace:

1. Re-run `terraform plan` against the raised floor and confirm the same
   shape holds: no diff for `cloudflare_dns_record.pages_cname`, and no
   `# forces replacement` / changing `id` anywhere in the
   `cloudflare_pages_project.this` diff.
2. Only apply once that plan output is in hand and reviewed — this is
   production DNS and a production Pages project.

`cloudflare_pages_project`'s resource-type and top-level arguments are
otherwise unchanged by the v4 → v5 rename. `cloudflare_pages_domain` needed
one attribute rename beyond the resource-type renames above: v5 renamed its
`domain` argument to `name` (verified via `terraform validate` against the
real provider schema, fetched locally with `terraform init -backend=false
-upgrade` — no state or live infrastructure touched; re-verified against
5.25.0 on 2026-09-16 after the floor was raised).

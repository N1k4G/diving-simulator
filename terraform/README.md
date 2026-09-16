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

**Plan confirmed clean, not yet applied.** `terraform plan` was run against
the live HCP workspace on 2026-09-16, with the raised provider floor below
(resolved 5.25.0, run `run-ZAqvvGau1zjJEpDd`):

```
Plan: 0 to add, 1 to change, 0 to destroy.

  # cloudflare_pages_project.this will be updated in-place
  ~ resource "cloudflare_pages_project" "this" {
      + build_config           = (known after apply)
        id                     = "diving-simulator"
        name                   = "diving-simulator"
        # (13 unchanged attributes hidden)
    }
```

`0 to destroy` is the number that mattered. Specifically:

- `cloudflare_dns_record.pages_cname` refreshed with **no diff at all**. The
  production DNS record is untouched.
- The one change is `~ update in-place`, not `-/+ must be replaced`, and `id`
  carries no `~` prefix and no `# forces replacement` marker. That is the
  exact signature separating this from the destructive bug this resource had
  in early v5.x (upstream #5146, where any update replaces the project and
  `id` itself changes to `(known after apply)`).
- What remains — `build_config` populating on first apply — is the documented
  non-destructive case: v5's state upgrader cannot carry every `build_config`
  field forward from v4-shaped state. Upstream's fix for this exact resource
  landed in 5.20.0, which is why `providers.tf` now floors on
  `>= 5.20, < 6.0` (was the open `~> 5.0`, which could re-resolve to the buggy
  5.1.0 on a future re-init — no lock file is committed to prevent it, see
  `.gitignore`).

Two things worth knowing that this README previously assumed otherwise:

- **The rename is already reflected in state.** `terraform state list` returns
  `cloudflare_dns_record.pages_cname`, not the old `cloudflare_record.*` —
  v5.19+ ships automatic state upgraders that performed it transparently. The
  `moved` block in `main.tf` therefore has nothing left to do. It is harmless
  to keep (and conventional to retain for a release cycle), but it is not what
  made this safe, and a future reader should not expect a plan to report a
  move.
- **`cloudflare_pages_domain.this` reported `Drift detected (update)`** during
  refresh, but produces no planned action — refresh reconciled it against the
  API and the config now matches.

Before running `apply` against the live workspace:

1. Re-run `terraform plan` and confirm the shape above still holds — in
   particular `0 to destroy`, no diff for `cloudflare_dns_record.pages_cname`,
   and no `# forces replacement` / changing `id`.
2. Only apply once that plan output is in hand and reviewed — this is
   production DNS and a production Pages project.

`cloudflare_pages_project`'s resource-type and top-level arguments are
otherwise unchanged by the v4 → v5 rename. `cloudflare_pages_domain` needed
one attribute rename beyond the resource-type renames above: v5 renamed its
`domain` argument to `name` (verified via `terraform validate` against the
real provider schema, fetched locally with `terraform init -backend=false
-upgrade` — no state or live infrastructure touched; re-verified against
5.25.0 on 2026-09-16 after the floor was raised).

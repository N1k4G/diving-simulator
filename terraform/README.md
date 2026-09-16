# Terraform

Manages the Cloudflare Pages project and DNS record for
`scuba.gorman.monster`, applied via HCP Terraform Cloud (workspace
`Infrastruktur/diving-simulator`). There is no CI workflow for
`terraform plan`/`apply` — runs happen through the HCP workspace directly.

## How changes reach production

The workspace **auto-applies**: every push to `main` uploads a configuration
version, plans, and applies without anyone confirming in the HCP UI.

The review gate is therefore the pull request, not the run. Whatever is merged
here is what production gets, so `terraform/` changes need reviewing as
carefully as the plan output used to be.

Two things make that safe enough to be worth the trade:

- **`.terraform.lock.hcl` is committed** (and deliberately not gitignored).
  The version constraint in `providers.tf` is a floor admitting every future
  5.x; without a committed lock file each run would resolve to whatever is
  newest at that moment, so an unrelated app merge could pull a fresh provider
  and auto-apply its behaviour to production DNS. The lock file is what makes
  a provider change a reviewable diff instead of a surprise. Hashes are
  recorded for `linux_amd64` (HCP's runners) as well as `windows_amd64` —
  `terraform providers lock -platform=linux_amd64 -platform=windows_amd64`.
- **Drift no longer accumulates.** The 2026-09-16 apply absorbed the deployment
  metadata Cloudflare had moved on (`latest_deployment`, domain validation
  status); the run after it reported zero drift entries. Runs no longer carry
  a growing gap between state and reality.

### The plan is never empty — do not read `1 to change` as a signal

Every run plans exactly one change:

```
cloudflare_pages_project.this will be updated in-place
  + build_config = (known after apply)
```

This is permanent and cannot be confirmed away. `build_config` is
`Optional+Computed` in the provider schema, `main.tf` does not set it, and
Cloudflare returns nothing for it (this is a direct-upload project with no
build command). So state holds `null`, Terraform cannot promise the value and
plans it unknown, the apply writes `null` back, and the next run plans it
again. Verified on 2026-09-16: state serial 10 still has
`build_config: null` immediately after a successful apply.

Two consequences worth internalising:

- **It is why auto-apply exists here.** A perpetual diff means every merge
  produces a run awaiting confirmation forever. That is precisely how ~30 runs
  queued up between July and September, each holding the lock from the next.
  Confirming a no-op by hand on every merge was never going to hold.
- **"The plan is not empty" carries no information.** Reviewing a
  `terraform/` change means reading the attribute-level diff, not the change
  count. One in-place update with only `build_config` unknown is the floor,
  not a finding.

Worth fixing upstream or with an explicit `build_config` block someday; until
then it is noise that has to be recognised rather than removed.

Auto-apply was enabled on 2026-09-16, after ~30 unconfirmed runs had queued up
since 2026-07-26. A waiting run holds the workspace lock, so the backlog also
blocked itself: the oldest run stayed `planned` and everything behind it sat
`pending`. If auto-apply is ever turned back off, put a notification on
waiting runs in its place.

### Raising the provider version

Do it deliberately, never by widening the constraint:

```
cd terraform
terraform init -upgrade
terraform providers lock -platform=linux_amd64 -platform=windows_amd64
```

Then open a PR with the lock diff and review the resulting plan **before**
merging — merging is what applies it.

## Provider v5 migration (issue #23)

`providers.tf`/`main.tf` are staged for the Cloudflare provider v4 → v5
migration: `cloudflare_record` renamed to `cloudflare_dns_record`, with a
`moved` block so Terraform treats it as an in-place rename rather than a
destroy/recreate.

**Applied 2026-09-16** (run `run-r8tWZdNA3JmywgiM`, provider 5.25.0) after the
plan below was confirmed clean. The plan was first verified on
`run-ZAqvvGau1zjJEpDd` and re-verified attribute-by-attribute on the applied
run; the apply finished `0 add / 1 change / 0 destroy`, matching the plan
exactly:

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
- What remains is `build_config`, which is non-destructive either way. The
  reading recorded here beforehand — that it would *populate on first apply*,
  v5's state upgrader having failed to carry it forward from v4-shaped state —
  turned out to be wrong: the apply ran, and state serial 10 still holds
  `build_config: null`. It is a permanent no-op diff, not a migration
  leftover; see "The plan is never empty" above for the actual mechanism. The
  provider floor still matters for the separate replacement bug, whose fix
  landed in 5.20.0, which is why `providers.tf` floors on
  `>= 5.20, < 6.0` (was the open `~> 5.0`, which could re-resolve to the buggy
  5.1.0 on a future re-init). The floor rules out the known-bad releases; the
  committed lock file is what fixes the exact build.

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

### Reviewing a change to this directory

Auto-apply means the merge is the apply, so the checks that used to happen at
the HCP confirmation prompt have moved earlier. Before approving a PR that
touches `terraform/`, get a plan (open it in the HCP UI against the branch, or
run `terraform plan` locally) and confirm:

1. `0 to destroy`, and no `-/+ must be replaced`.
2. No diff at all for `cloudflare_dns_record.pages_cname` — that is production
   DNS for `scuba.gorman.monster`.
3. No `# forces replacement` marker and no `id` changing to
   `(known after apply)` on `cloudflare_pages_project.this`. That pair is the
   signature of upstream #5146, which destroys and recreates the Pages
   project.
4. If `.terraform.lock.hcl` changed, the provider version moved — treat the
   plan as untrusted until you have read the provider's changelog for the
   range.

`cloudflare_pages_project`'s resource-type and top-level arguments are
otherwise unchanged by the v4 → v5 rename. `cloudflare_pages_domain` needed
one attribute rename beyond the resource-type renames above: v5 renamed its
`domain` argument to `name` (verified via `terraform validate` against the
real provider schema, fetched locally with `terraform init -backend=false
-upgrade` — no state or live infrastructure touched; re-verified against
5.25.0 on 2026-09-16 after the floor was raised).

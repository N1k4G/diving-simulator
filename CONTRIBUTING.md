# Contributing

Thanks for your interest in improving the Diving Simulator! This is a plain
HTML/CSS/JS project with no build step — you can open `src/diving-simulator.html`
directly in a browser to run it.

## Development setup

```bash
npm install        # dev tooling: ESLint, Playwright, husky
```

A `husky` pre-commit hook lints staged `src/*.js` with `--max-warnings=0`, so
your commit will be blocked if lint fails.

## Useful commands

| Command | What it does |
|---------|--------------|
| `npm run lint` | ESLint over `src/*.js` |
| `npm test` | Runs the in-browser test suite headless via Playwright |
| `npm run screenshots` | Captures review screenshots to `screenshots/` |
| `npm run license-check` | Fails if any dependency's license isn't in the allowlist below |

### License allowlist (issue #40)

None of this project's npm packages are shipped (`pages deploy src/` only
deploys `src/`, and every current dependency is dev/CI tooling), so there's
no legal *requirement* to vet their licenses — but a copyleft dev dependency
(GPL/LGPL/AGPL/MPL) sneaking in via `npm install some-tool` is still worth
catching early, since it complicates the story even for tooling. `npm run
license-check` (backed by `license-checker`, CI-gated in both `pr.yml` and
`deploy.yml`) allowlists: `MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0,
0BSD, CC0-1.0, CC-BY-3.0, Python-2.0, WTFPL, Unlicense, BlueOak-1.0.0` — all
permissive, matching what's actually present in the current dependency tree
plus a couple of common permissive licenses left in as headroom. If a
legitimate new dependency needs a license outside this list, extend the
allowlist in `package.json`'s `license-check` script with justification in
the PR description rather than removing the check.

## Tests

The automated suite lives in `src/diving-simulator-tests.html` (runnable in a
browser) and runs headless under Playwright via `npm test`. Please add or update
tests when you change physics, gas, decompression, or `gameAPI` behavior, and
make sure `npm run lint` and `npm test` both pass before opening a PR.

## Pull requests

If you have write access to this repository, branch directly off `main`
(e.g. `feature/your-change`). Otherwise — the usual case for outside
contributors — use the fork workflow:

1. **Fork** the repository to your own account.
2. Clone your fork and create a branch off `main`
   (e.g. `feature/your-change`).
3. Keep changes focused; match the style of the surrounding code.
4. Ensure lint and tests pass locally (`npm run lint` and `npm test`).
5. Push to your fork and open a pull request against `N1k4G/diving-simulator`'s
   `main` branch.

CI (`.github/workflows/pr.yml`) runs lint, tests, and review screenshots on
every PR — including PRs from forks. `main` is protected, so all changes land
through a reviewed, green PR.

### A note on release tagging and fast merges

`deploy.yml`'s `release` job uses `concurrency: production-deploy` (needed so
production deploys never run concurrently). A side effect: if two PRs merge to
`main` in quick succession, only the *latest* queued workflow run survives —
the middle run (and its release tag) is skipped. Lint/tests/deploy for that
PR still ran and succeeded via the run that superseded it in the queue; only
the discrete GitHub Release/tag for that specific commit is skipped. This is
an accepted tradeoff given this repo's merge frequency, not a bug — if you
notice a version number "jump," that's why.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License (see [LICENSE](LICENSE)).

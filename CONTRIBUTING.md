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

## License

By contributing, you agree that your contributions will be licensed under the
MIT License (see [LICENSE](LICENSE)).

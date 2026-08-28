#!/usr/bin/env bash
# Runs once as pwuser after the container is created.
set -euo pipefail

cd "$(dirname "$0")/.."

# The named node_modules volume arrives root-owned on first create.
if [ ! -w node_modules ]; then
  sudo chown "$(id -u):$(id -g)" node_modules
fi

# The bind-mounted worktree carries the host's ownership, which git refuses to
# act on until it is declared safe — husky would fail on the first commit.
git config --global --add safe.directory "$PWD"

# A worktree checked out by a Windows git sits on disk as CRLF while the blobs
# are LF. This git has no autocrlf, so it reads that difference as content: the
# first edit to any file turns into a whole-file rewrite in the diff, and the
# line-ending churn lands in the commit. Match the checkout instead of fighting
# it — the eol=lf attributes in .gitattributes still override this for the
# scripts and hooks that have to be LF to run.
if [ -z "$(git config --get core.autocrlf)" ] &&
   git ls-files --eol -- README.md package.json | grep -q 'w/crlf'; then
  git config --global core.autocrlf true
fi

# The image carries the browser build; the lockfile carries the client that
# drives it. If they disagree, every visual guard measures a different renderer
# than CI does and says nothing about it.
image_version="${PLAYWRIGHT_IMAGE_VERSION:?not set — see .devcontainer/devcontainer.json}"
locked="$(node -p "require('./package-lock.json').packages['node_modules/playwright-core'].version")"
if [ "$locked" != "$image_version" ]; then
  echo "playwright-core is pinned to $locked in package-lock.json, but this container is built" >&2
  echo "on the v$image_version image. Set \"image\" to mcr.microsoft.com/playwright:v$locked-noble" >&2
  echo "and PLAYWRIGHT_IMAGE_VERSION to $locked in .devcontainer/devcontainer.json, then rebuild." >&2
  exit 1
fi

# The claim this container makes is that a run here predicts a run in CI, so
# the Node the workflows install is the Node it has to be running.
ci_node="$(grep -oP "(?<=node-version: ')[0-9]+" .github/workflows/pr.yml | head -n 1)"
here_node="$(node -p 'process.versions.node.split(".")[0]')"
if [ -n "$ci_node" ] && [ "$ci_node" != "$here_node" ]; then
  echo "this container runs Node $here_node but .github/workflows/pr.yml installs Node $ci_node." >&2
  echo "Point the node feature in .devcontainer/devcontainer.json at $ci_node, or move both" >&2
  echo "together — a container on a different major than CI cannot vouch for a CI run." >&2
  exit 1
fi

npm ci

# husky sets core.hooksPath by writing the repository config. On a worktree
# bind-mounted from a Windows drive that mount reports a fixed owner, git's
# chmod of config.lock is refused, and git discards the whole write — husky
# swallows it and npm ci still exits 0, so the pre-commit lint gate would go
# missing quietly. No ownership fix applies: 9p/drvfs serves uid from a mount
# option, so chown cannot move it. The global config lives on the container
# filesystem, which this user does own, so put the hooks path there instead.
# A repository-level value, once one can be written, still takes precedence.
if [ -z "$(git config --get core.hooksPath)" ]; then
  git config --global core.hooksPath .husky
  echo "NOTE: husky could not write .git/config — this worktree is owned by uid $(stat -c %u .git)," >&2
  echo "      not $(id -u). core.hooksPath is set in the container's global config instead," >&2
  echo "      so the pre-commit lint gate still runs. The 'chmod on .git/config.lock'" >&2
  echo "      error above is that same write, and is expected here." >&2
fi

cat <<EOF

node $(node -v), npm $(npm -v), playwright $locked, $(grep -oP '(?<=^PRETTY_NAME=").*(?=")' /etc/os-release)

This container exists to match CI's renderer: the visual guards measure here what
they measure on ubuntu-latest.

Do not capture performance here — test:perf and wp06:perf hit software rendering
and their numbers are not comparable with the committed baselines.
EOF

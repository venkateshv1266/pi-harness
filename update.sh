#!/usr/bin/env bash
# Update an existing install: fast-forward the repo, then re-apply the
# components recorded in ~/.pi/agent/.pi-harness.json.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

if [ -d .git ] && [ -n "$(git status --porcelain)" ] && [ "${1:-}" != "--force" ]; then
  echo "error: the repository has local changes. Commit or stash them, or pass --force." >&2
  exit 1
fi

if [ -d .git ]; then
  git pull --ff-only
fi

exec node "$REPO_DIR/scripts/setup.mjs" --update "$@"

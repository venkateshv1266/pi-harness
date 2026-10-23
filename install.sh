#!/usr/bin/env bash
# Install the selected pi-harness components into ~/.pi/agent.
# Run ./install.sh --help for flags, or read docs/install.md.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$REPO_DIR/scripts/setup.mjs" "$@"

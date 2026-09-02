#!/usr/bin/env bash
# Owner maintenance: pull the LIVE extensions, generic rules, and add-rule skill
# from ~/.pi/agent/ back into this repo, ready to commit and push.
#
# The repo's rules/ file list IS the allowlist: only those rule files sync back
# (the live rules dir also holds private/work rules that must not be published).
# To publish a new generic rule: copy it into rules/ once, after that it syncs
# automatically.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="${HOME}/.pi/agent"

# 1. Extensions (full sync; the repo mirrors the whole extensions dir)
rsync -a --delete \
  --exclude='node_modules' \
  --exclude='.cmux-session.lock' \
  --exclude='.DS_Store' \
  "$AGENT/extensions/" "$REPO_DIR/extensions/"

# 2. Generic rules (allowlist-driven, per file)
for f in "$REPO_DIR"/rules/*.md; do
  name="$(basename "$f")"
  if [ -f "$AGENT/rules/$name" ]; then
    cp "$AGENT/rules/$name" "$f"
  else
    echo "WARN: no live source for rules/$name — removed live? Delete it from the repo."
  fi
done

# 3. Skills (each has its own live location)
cp "$AGENT/skills/add-rule/SKILL.md" "$REPO_DIR/skills/add-rule/SKILL.md"
cp "$AGENT/skills/add-rule/scripts/validate-rule.js" "$REPO_DIR/skills/add-rule/scripts/validate-rule.js"
cp "${HOME}/.agents/skills/add-mcp-server/SKILL.md" "$REPO_DIR/skills/add-mcp-server/SKILL.md"

echo "Synced. Review with 'git diff', then commit and push."

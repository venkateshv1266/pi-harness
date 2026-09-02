#!/usr/bin/env bash
# Install the extensions, generic TTSR rules, and the add-rule skill from this
# repo into ~/.pi/agent/. Safe to re-run.
#
# NOTE: rules are copied WITHOUT --delete so your own rules are never removed.
# Same-named rules may be shadowed by yours (first-wins) — review rules/ first.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="${HOME}/.pi/agent"

if ! command -v pi >/dev/null 2>&1; then
  echo "error: pi is not installed. See https://github.com/earendil-works/pi-coding-agent" >&2
  exit 1
fi

# 1. Extensions
mkdir -p "$AGENT/extensions"
rsync -a --exclude='node_modules' --exclude='.DS_Store' "$REPO_DIR/extensions/" "$AGENT/extensions/"
find "$AGENT/extensions" -maxdepth 2 -name package.json -not -path '*/node_modules/*' | while read -r pkg; do
  dir="$(dirname "$pkg")"
  echo ">> npm install in $dir"
  (cd "$dir" && npm install --silent)
done

# 2. Generic TTSR rules
mkdir -p "$AGENT/rules"
rsync -a "$REPO_DIR/rules/" "$AGENT/rules/"
echo ">> installed $(ls "$REPO_DIR/rules" | wc -l | tr -d ' ') TTSR rules"

# 3. Subagent definitions
mkdir -p "$AGENT/agents"
rsync -a "$REPO_DIR/agents/" "$AGENT/agents/"
echo ">> installed $(ls "$REPO_DIR/agents"/*.md | grep -v README | wc -l | tr -d ' ') agents"

# 4. Skills (add-rule: authoring TTSR rules; add-mcp-server: wiring MCP servers)
mkdir -p "$AGENT/skills"
rsync -a --exclude='node_modules' "$REPO_DIR/skills/" "$AGENT/skills/"

# 5. Model-role defaults for the shipped agents (@smol/@slow/@plan/@task).
#    Adds missing keys only — never overwrites your own choices.
node -e '
const fs = require("fs");
const p = process.env.HOME + "/.pi/agent/settings.json";
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
const defaults = {
  smolModel: "openrouter/openai/gpt-5.6-luna",
  slowModel: "openrouter/z-ai/glm-5.3",
  planModel: "openrouter/openai/gpt-5.6-terra",
  taskModel: "openrouter/z-ai/glm-5.3-flash",
};
const added = Object.keys(defaults).filter((k) => !s[k]);
for (const k of added) s[k] = defaults[k];
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
console.log(added.length
  ? ">> set model roles: " + added.join(", ") + " (add-only; existing keys untouched)"
  : ">> model roles already configured — left untouched");
'

echo
echo "Done. Restart pi (or /reload + /ttsr-reload in an open session) to arm everything."
echo "See rules/ in this repo — remove any you don't want before installing."

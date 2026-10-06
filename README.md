# pi-harness

My [pi coding agent](https://github.com/earendil-works/pi-coding-agent) setup:
32 extensions, 9 subagent definitions, 21 generic TTSR rules, 4 skills, and
3 themes. Clone this repo and run `./install.sh` to get the same setup.

This README is the index. Each component documents itself next to its code —
directory extensions own a `README.md`, single-file extensions have a sibling
`.md`, and every other directory has its own README.

## Prerequisites

- **Node.js >= 22.15.0** (pi uses `zlib.createZstdDecompress`, which older
  Node versions lack — pi will crash on startup below this version)
- **pi >= 0.87.0** installed globally: `npm i -g @earendil-works/pi-coding-agent`
  (the extensions use `turn_end` boundary results and `context_edit` drafts,
  both added in 0.87.0)
- `rsync` (present on macOS; on Linux install it via your package manager)

## Setup

```bash
git clone https://github.com/venkateshv1266/pi-harness.git
cd pi-harness
./install.sh
```

Then restart pi (or run `/reload` in an open session). Pi auto-discovers the
installed extensions, themes, rules, and agents in `~/.pi/agent/`. The
installer is add-only for settings: it seeds the model-role aliases and the
router tiers but never overwrites keys you have already set.

To uninstall an extension, delete its file (or directory) from
`~/.pi/agent/extensions/` and `/reload`.

## What's in this repo

| Path | What it is | Docs |
|---|---|---|
| `extensions/` | 32 pi extensions — delegation, models, judgment/guardrails, context/memory, supervision, session UX, integrations | [`extensions/README.md`](extensions/README.md) |
| `agents/` | 9 user-scope subagent definitions | [`agents/README.md`](agents/README.md) |
| `rules/` | 21 generic TTSR stream rules | [`rules/README.md`](rules/README.md) |
| `skills/` | 4 skills: add-rule, add-agent, add-mcp-server, code-review | [`skills/README.md`](skills/README.md) |
| `themes/` | 3 custom pi themes | [`themes/README.md`](themes/README.md) |
| `utils/` | Shared helpers (decision contract, role resolution, Jev client + ask CLI) + the omp-stats dashboard | [`utils/README.md`](utils/README.md) |
| `scripts/` + `bin/` | YubiKey Git notification wrappers + installer, settings migration | [`scripts/README.md`](scripts/README.md) |
| `docs/` | Extension README template and postmortems | [`docs/README.md`](docs/README.md) |

Common entry points:

- **Models** — [roles](extensions/README.md#model-roles), [route-ahead](extensions/README.md#model-router),
  [failover](extensions/README.md#model-fallback), [OpenRouter guardrails](extensions/README.md#openrouter-guardrail-header)
- **Delegation** — [delegate](extensions/delegate/README.md) with the
  [one-shot engine](extensions/subagent/README.md) and
  [persistent engine](extensions/persistent-subagent/README.md)
- **Judgment and guardrails** — [ask-jev](extensions/ask-jev/README.md) (Jev
  tools: cheap file judgments, log triage, assumption validation),
  [jev-guard](extensions/jev-guard/README.md) (bash command gate + injection screen)
- **Memory and context** — [jev-memory](extensions/jev-memory/README.md),
  [jev-context-curator](extensions/jev-context-curator/README.md),
  [ttsr](extensions/ttsr/README.md), [recite](extensions/recite/README.md),
  [course-check](extensions/course-check/README.md) (periodic Jev trajectory supervision)
- **Settings UI** — [`/setup`](extensions/setup/README.md) changes most of the
  above without memorizing individual commands
- **MCP servers** — pi's built-in MCP support plus
  [mcp-cookie-gate](extensions/README.md#mcp-cookie-gate) (pre-call SSO cookie
  hooks); walkthrough: [add-mcp-server](skills/add-mcp-server/SKILL.md)

## Updating an existing setup

Already installed? Pull and re-run the installer:

```bash
cd pi-harness
git pull
./install.sh
```

`install.sh` is idempotent — it overwrites the copies in `~/.pi/agent/` with
the repo versions and re-runs `npm install` for the subdirectory extensions.
It never *deletes* anything, so your own extensions, themes, rules, and agents
are safe. Then `/reload` + `/ttsr-reload` (or restart pi) to arm the new code.

One caveat: if an extension was **removed or renamed** in the repo, the old
copy stays behind in `~/.pi/agent/extensions/` — delete it manually and
`/reload`.

## Optional components

- **YubiKey alerts for Git in cmux** — `./scripts/install-yubikey-notifications.sh`
  wraps SSH and GPG so a hardware touch alerts. Behavior, sound override, and
  revert steps: [scripts/README.md](scripts/README.md).
- **Usage dashboard** — `/stats [port]` launches the omp-stats dashboard after a
  one-time `bun install` under `~/.pi/agent/utils/omp-stats/`; see
  [the stats section](extensions/README.md#stats).
- **web-search keys** — fully optional; without keys the tools fall back to free
  DuckDuckGo scraping + Jina Reader. See
  [the web-search section](extensions/README.md#web-search).
- **MCP servers** — declare them in `~/.pi/agent/mcp.json` (walkthrough:
  [add-mcp-server](skills/add-mcp-server/SKILL.md)); pre-call SSO auth hooks
  live in [mcp-cookie-gate](extensions/README.md#mcp-cookie-gate).

## Not included (on purpose)

- **`~/.pi/agent/mcp.json`** — your MCP server config: it names your
  servers, endpoints, and env wiring. pi simply finds no servers until
  you write one. Shape and walkthrough:
  [add-mcp-server](skills/add-mcp-server/SKILL.md).
- **Most TTSR rule content** — `rules/` ships the generic, shareable subset.
  Rules referencing employer infra, internal docs, or personal context stay
  local in `~/.pi/agent/rules/`. Author your own with the
  [add-rule](skills/add-rule/SKILL.md) skill.
- **Project-local agents** (`.pi/agents/` in work repos) — those encode
  team/project-specific workflows; the nine generic user-scope agents ship in
  `agents/`.
- **`auth.json`, `settings.json`, prompts, personal skills** — account and
  session state, not shareable setup.

## Maintenance (repo owner)

After tweaking things live in `~/.pi/agent/`, pull them back into the repo,
review the docs, then commit and push. See `AGENTS.md` for the complete
workflow:

```bash
./sync.sh
git status --short
git diff
# Update the README that documents the change (this index or the directory README).
git add README.md extensions/README.md  # and any other relevant files
git diff --cached --check
git commit -m "type(scope): describe the change"
git push origin "$(git branch --show-current)"
```

`sync.sh` mirrors the whole `extensions/` dir, refreshes the allowlisted
`themes/` and rules in the repo (their file lists are the allowlists —
private/work rules stay local), refreshes the shipped agent definitions, and
refreshes both skills. `node_modules/`, lock files, and transient dotfiles are
excluded on both `install.sh` and `sync.sh`.

Note to self: keep this repo free of machine/employer-specific details —
server names, endpoints, internal doc names, and personal paths belong in
local config (`mcp.json`, rules, agents), not in extension code.

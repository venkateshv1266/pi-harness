# Compatibility and credentials

Every component declares its tier, dependencies, and required environment variables in
[`harness.json`](../harness.json). The installer reads that file, so this page is a human view of the
same data.

## What each tier means

| Tier | Installs by default | Runs with pi alone | Needs |
|---|---|---|---|
| `core` | yes | yes | Node and pi |
| `subagents` | with the recommended preset | no | model roles (`@smol`, `@slow`, `@plan`, `@task`) |
| `jev` | no | no | `JEV_API_KEY` (and usually `JEV_BASE_URL`) |
| `integrations` | no | no | your own Grafana / Redash / Snowflake / Linear / Orca setup |
| `local` | never | no | macOS, YubiKey, or Orca terminals |

## Component matrix

| Component | Tier | Needs | What it does |
|---|---|---|---|
| `ttsr` | core | — | TTSR stream rules engine and context registry. |
| `recite` | core | — | Tail recitation of the live goal and todo block. |
| `repo-agents-guard` | core | — | Blocks repo tool calls until the nearest AGENTS.md is read. |
| `setup` | core | — | Interactive /setup settings UI. |
| `claude-compat` | core | — | Reads CLAUDE.md alongside AGENTS.md. |
| `confirm-destructive` | core | — | Confirms destructive shell commands. |
| `custom-footer` | core | — | Status footer with model, context, and cost. |
| `dirty-repo-guard` | core | — | Warns before branching from a dirty tree. |
| `handoff` | core | — | Writes a handoff brief for the next session or agent. |
| `model-fallback` | core | — | Retries a turn on provider failure with a fallback model. |
| `model-roles` | core | — | Resolves @smol, @slow, @plan, @task role aliases. |
| `model-router` | core | — | Routes each turn to a fast, mid, or deep tier. |
| `plugins` | core | — | Loads Claude marketplace plugin skills. |
| `rewind` | core | — | Checkpoint and rewind the working tree. |
| `summarize` | core | — | On-demand conversation summary. |
| `todo` | core | — | Session todo list tool. |
| `web-search` | core | — | Web search and fetch; falls back to free providers without keys. |
| `delegate` | subagents | requires subagent, requires persistent-subagent | Single spawn door; routes between one-shot and persistent engines. |
| `subagent` | subagents | — | One-shot engine: blocking children, parallel batches, chains. |
| `persistent-subagent` | subagents | — | Persistent engine: named, steerable, resumable children. |
| `ask-jev` | jev | JEV_API_KEY | Jev as tools: log triage, test triage, diff review, extraction, typed decisions. |
| `jev-guard` | jev | — | Bash command gate and prompt-injection screen. |
| `jev-memory` | jev | JEV_API_KEY | Persistent memory, session search, and skills. |
| `jev-context-curator` | jev | JEV_API_KEY | GoalSpec-first context curation and evidence ledger. |
| `course-check` | jev | JEV_API_KEY | Periodic trajectory supervision. |
| `decision-tuner` | jev | — | Tunes decision thresholds from outcome logs. |
| `decisions-report` | jev | — | Summarizes recorded routing decisions. |
| `observatory` | integrations | — | Web dashboard over sessions, decisions, rules, and improvements. |
| `refine` | integrations | JEV_API_KEY, requires ttsr | Prompt-refinement loop over captured failures. |
| `mcp-cookie-gate` | integrations | — | Pre-call SSO cookie and OAuth re-login hooks for MCP servers. |

## Environment variables

| Variable | Used by | Required |
|---|---|---|
| `JEV_API_KEY` | `ask-jev`, `jev-memory`, `jev-context-curator`, `course-check`, `refine`, and the optional classifier in `ttsr` / `model-router` / `jev-guard` | only for the `jev` tier |
| `JEV_BASE_URL` | same | has a default in `utils/jev-client.ts` |
| `JEV_MODEL` | same | has a default |
| `OPENROUTER_API_KEY` | the optional OpenRouter model-role preset | only if you choose that preset; any provider pi is logged into works |
| `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY` | `web-search` | optional; free fallbacks are used without them |
| `MCP_SERVERS_ROOT` | `mcp-cookie-gate` | optional; defaults to `~/.pi/agent/mcp.json` |
| `OBSERVATORY_HOST`, `OBSERVATORY_PORT` | `observatory` | optional |
| `BUN_BIN` | `observatory` tests and server | only if Bun is not on `PATH` |

Everything else in the code is a tuning knob with a default. The installer never writes secrets; it
only tells you which variables are still missing.

The core tier requires no model credentials of its own: it uses the provider pi is already
authenticated with. `./install.sh --list-models` shows the providers and models the installer can see.

## Behaviour when a dependency is absent

- **No `JEV_API_KEY`** — Jev-backed tools stay registered but return a clear "Jev unavailable" result.
  TTSR still works without the optional classifier; rules fire from their regex triggers.
- **No model roles** — `delegate` reports that no role is configured instead of guessing a model.
- **No MCP servers** — `mcp-cookie-gate` has nothing to gate and stays inert.
- **No Bun** — observatory and its tests are skipped; every other extension is Node-only.

If a component cannot degrade cleanly, it belongs in a higher tier and must be opt-in. That is the
line reviewers enforce.

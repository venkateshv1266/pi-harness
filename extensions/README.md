# Extensions

All pi extensions in this repo. `install.sh` copies this directory into
`~/.pi/agent/extensions/`, where pi auto-discovers direct `.ts` files and
subdirectories with an `index.ts` entry point. To uninstall one, delete it from
`~/.pi/agent/extensions/` and `/reload`.

**Docs layout:** directory extensions ship their own `README.md` (linked
below); every single-file extension is documented in a section on this page.
New docs follow
[`docs/extension-readme-template.md`](../docs/extension-readme-template.md).

## Directory extensions

| Extension | Docs | What it does |
|---|---|---|
| `delegate` | [README](delegate/README.md) | The only spawn door in root sessions — validates the call shape and routes each delegation between the one-shot and persistent engines, logging every decision. |
| `subagent` | [README](subagent/README.md) | One-shot engine behind `delegate`: blocking isolated children, parallel task batches (≤8), sequential chains, per-agent tool allowlists. |
| `persistent-subagent` | [README](persistent-subagent/README.md) | Persistent engine behind `delegate`: named, steerable, resumable children with on-disk sessions; idle-unload and transparent resume. |
| `jev-context-curator` | [README](jev-context-curator/README.md) | GoalSpec-first context curation: Jev classification, verifier-approved evidence ledger, `curator_find` + `jev_recall`, GoalSpec-carrying compaction. |
| `jev-memory` | [README](jev-memory/README.md) | Persistent memory, session search, and skills with Jev-gated admission, review, correction adjudication, and search rerank. |
| `recite` | [README](recite/README.md) | Tail recitation — keeps a compact goal/todo block at the model's most-attended position, exactly one live copy. |
| `ttsr` | [README](ttsr/README.md) | Time-Traveling Stream Rules with zero idle token cost, plus the context registry (`/ttsr`, `/contexts`, `context_list`). |
| `course-check` | [README](course-check/README.md) | Periodic Jev supervision — every N turns, judge the trajectory against the session goal; off-track verdicts inject a rethink nudge. |
| `decision-tuner` | [README](decision-tuner/README.md) | Weekly auto-run of the decision report plus prune/reword proposals, surfaced in `/setup → Decisions`. |
| `setup` | [README](setup/README.md) | `/setup` — full-screen settings window plus a command/rule/MCP cheat sheet; extensible via `setup.ts`. |
| `refine` | [README](refine/README.md) | `/refine` plus a background self-improvement loop: proposes rules/notes, stages rules for one-glance arming. |

## Single-file extensions

| Extension | What it does |
|---|---|
| [`claude-compat`](#claude-compat) | Surfaces Claude Code resources (`.claude/CLAUDE.md`, `.claude/skills/`) from the repo tree. |
| [`cmux-session`](#cmux-session) | cmux lifecycle/telemetry bridge; machine-managed, do not edit. |
| [`confirm-destructive`](#confirm-destructive) | Confirmation prompts before session switch and fork. |
| [`custom-footer`](#custom-footer) | Two-line status footer (dir, branch, tokens, context %, cost, model); `/footer` toggles. |
| [`decisions-report`](#decisions-report) | `/decisions-report` joins decision logs to outcomes and flags prune/reword candidates. |
| [`dirty-repo-guard`](#dirty-repo-guard) | Blocks session switch/fork while the repo has uncommitted changes. |
| [`handoff`](#handoff) | `/handoff <goal>` distills the conversation into a fresh focused session. |
| [`mcp-cookie-gate`](#mcp-cookie-gate) | Pre-call SSO cookie checks before `mcp__grafana-*`/`mcp__redash-*` tool calls; blocks the call and launches browser re-auth. |
| [`model-fallback`](#model-fallback) | Switches to a fallback model on provider-attributable failures; loops and transport errors are guarded. |
| [`model-roles`](#model-roles) | `/roles` assigns the `@smol`/`@slow`/`@plan`/`@task`/`@designer` role settings. |
| [`model-router`](#model-router) | Route-ahead: Jev classifies each new task and picks the tier before the first token. |
| [`openrouter-guardrail-header`](#openrouter-guardrail-header) | Sticky header with daily/monthly OpenRouter usage vs configured caps. |
| [`plugins`](#plugins) | `/plugins` browses and installs skills from local Claude plugin marketplaces. |
| [`repo-agents-guard`](#repo-agents-guard) | Blocks repo-targeting tool calls until the nearest `AGENTS.md` is read. |
| [`rewind`](#rewind) | `/rewind` checkpoints edits and restores code and/or conversation to any prompt. |
| [`stats`](#stats) | `/stats [port]` launches the omp-stats usage dashboard. |
| [`summarize`](#summarize) | `/summarize [role]` scrollable summary overlay; `/summarize view` reopens the cached one. |
| [`todo`](#todo) | `todo` tool + `/todos` — todo state persisted in session entries, not files. |
| [`web-search`](#web-search) | `web_search` + `web_fetch` tools with keyless defaults, optional Tavily/Brave. |

---
## claude-compat

Surfaces Claude Code resources — `.claude/CLAUDE.md` and `.claude/skills/` — from the repo tree.

**What it does** — Walks from the cwd to the filesystem root collecting each directory's `.claude/CLAUDE.md` (injected as system-prompt context) and `.claude/skills/<name>/SKILL.md` (registered as skill paths). Useful in repos that already carry Claude Code config: pi applies it without duplication.

**How it works** — `session_start` refreshes the cache and notifies; `resources_discover` recomputes and returns `{ skillPaths }`; `before_agent_start` appends the cached CLAUDE.md under `## Project-local Claude context (.claude/CLAUDE.md)` inside a `<project_instructions>` block. The innermost `.claude` wins (context files deduped by realpath); `~/.claude` counts only when home is an ancestor of the cwd. Skills whose names collide with pi's default global skill dirs (`~/.pi/agent/skills`, `~/.agents/skills`) are skipped in favor of pi-native, and the skipped count is surfaced in the notification.

**Caveats** — No settings, env vars, or off switch — removing the extension is the only disable. Hooks and `.claude/` contexts are not discovered: only `CLAUDE.md` and `skills/`.

## cmux-session

Bridges pi session lifecycle, telemetry, and notifications into cmux. **Machine-managed — do not hand-edit.**

**What it does** — Forwards pi events to the cmux CLI (`hooks pi …`): session start, prompt submit, tool start/end (including subagent start/stop), compaction pre/post, completion notifications, and stop. Installed and overwritten in place by `cmux hooks pi install` (header marker `cmux-pi-session-extension-marker v2`).

**Configuration** — Environment (all read at runtime):

| Env var | Default | Effect |
|---|---|---|
| `CMUX_PI_CMUX_BIN` | `cmux` (via PATH) | cmux binary to invoke |
| `CMUX_PI_HOOKS_DISABLED` | unset | `1` disables the bridge entirely |
| `CMUX_SURFACE_ID` | unset | Required for event delivery; without it events are silently dropped |
| `CMUX_WORKSPACE_ID` / `CMUX_PANEL_ID` | unset | Optional targeting |
| `CMUX_SOCKET_PASSWORD` | unset | Forwarded only to cmux CLI child processes |
| `CMUX_AGENT_LAUNCH_KIND/_EXECUTABLE/_ARGV_B64/_CWD` | set by the extension if absent | Launch context for cmux |

**How it works** — `session_start` → `hooks pi session-start` plus a resume binding; `before_agent_start` → prompt-submit; `tool_execution_start`/`end` → PreToolUse/PostToolUse and SubagentStart/SubagentStop; `session_before_compact`/`session_compact` → PreCompact/PostCompact; `agent_end` holds the last assistant message for the completion notification (published immediately on pi < 0.80.5); `agent_settled` (pi ≥ 0.80.5) drains the queue → `hooks pi notification` + `hooks pi stop`; `session_shutdown` → stop if not already stopped, clears the resume binding.

**Caveats** — `install.sh` copies this file only when the `cmux` binary is on PATH and removes any stale installed copy otherwise — its hooks would fail on every event without the binary.

## openrouter-guardrail-header

Sticky header showing daily and monthly OpenRouter usage against configured caps.

**What it does** — Renders a full-width top band: `💰 Guardrails` with `D: $used/$limit (pct%)` and `M: $used/$limit (pct%)`. Usage combines credit and BYOK spend for the active key. Colors: error ≥90%, warning ≥75%, success below; muted when no limit is known. Loading and unavailable states render as notices instead of numbers.

**Configuration**

| Key | Default | Effect |
|---|---|---|
| `openrouterGuardrails.dailyLimit` | unset (`install.sh` seeds `75`) | Daily cap; falls back to the key's `daily_limit` |
| `openrouterGuardrails.monthlyLimit` | unset (`install.sh` seeds `500`) | Monthly cap; falls back to the key's `monthly_limit` |

Limit fallback chain: setting → the key's per-period limit → the key's `limit` when `limit_reset` matches the period → `—` (percentage shown only when the limit is > 0). Also editable in `/setup` → Guardrails.

**How it works** — `GET /api/v1/key` on the OpenRouter API with the key from pi's provider auth (10 s timeout). Refreshes every 5 minutes and immediately on `session_start`; settings are re-read on every refresh, so cap edits need no `/reload`.

**Caveats** — No env vars; the key comes from pi's provider auth, not `OPENROUTER_API_KEY`. Non-TUI sessions render nothing.

## model-roles

`/roles` assigns the model-role settings consumed as `@smol` / `@slow` / `@plan` / `@task` / `@designer`.

**What it does** — Interactive flow: role picker (alias, purpose, current value) → searchable model picker → thinking level. One-liner and clear subcommands for scripting.

**Commands and tools**

| Command | What it does |
|---|---|
| `/roles` | Full interactive flow (TUI) |
| `/roles <role> <model:thinking>` | One-liner; `<role>` is the settings key case-insensitively (`smolModel`, not `smol`) |
| `/roles <role>` | Interactive, starting at the model picker |
| `/roles clear [role]` | Delete a key; the picker lists configured roles |

**Configuration** — Written keys (top level of `~/.pi/agent/settings.json`): `smolModel`, `slowModel`, `planModel`, `taskModel`, `designerModel`. The resolver also honors read-only aliases: `fastModel` (after `smolModel`), `reasoningModel` (after `slowModel`), and nested `modelRoles.{smol,slow,plan,task,designer}` (lowest priority). Model refs resolve exact `provider/id` → exact id → substring; the `:thinking` suffix is restricted to `minimal low medium high xhigh max`.

Env precedence per role (example `@smol`): `PI_SMOL_MODEL` → `PI_FAST_MODEL` → `smolModel` → `fastModel` → `modelRoles.smol` → `PI_MODEL` → `defaultModel`. `@plan` chains through `PI_SLOW_MODEL`/`slowModel` before its own keys; an unknown `@role` falls back to `PI_MODEL` → `defaultModel`. Env vars affect `@role` consumers (subagent spawns, router tier refs) but not the router's tier defaults, which read settings only.

**How it works** — Writes are an immediate read-modify-write of `settings.json`; consumers that re-read per call pick changes up without a reload. `install.sh` seeds `smol`/`slow`/`plan`/`task` add-only (it never overwrites keys you set, and seeds no `designer` default).

**Caveats** — The interactive confirmation reminds you to restart pi or `/reload`; re-reading consumers don't need it. The nested `modelRoles.*` block has no writer in this repo — it is honored by the resolver only.

## repo-agents-guard

Blocks repo-targeting tool calls until the repo's nearest `AGENTS.md` has been read.

**What it does** — Gates path tools (`read`/`edit`/`write`/`grep`/`find`/`ls` via their `path` argument), shell tools (`bash`/`powershell`: the session cwd, literal absolute/`~` tokens, and args of `cd`, `git -C`, `git --git-dir`, `git --work-tree`), and subagent launches (`subagent`/`subagent_spawn`/`delegate`: the session cwd, the launch `cwd`, and absolute/`~` tokens anywhere in the input) until the target repository's nearest `AGENTS.md` is read.

**How it works** — Only a successful `read` of the exact nearest `AGENTS.md` clears a repo — tracked per tool-call id and confirmed on a non-error tool result; failed reads don't clear and can be retried. An `AGENTS.md` that pi already preloaded into system context counts as read, but only when it is itself the nearest file — a closer `AGENTS.md` still requires its own read. The `AGENTS.md` read itself is always allowed. Any other tool with a string `cwd` argument falls under the same rule.

**Caveats** — Does not intercept user `!`/`!!` shell commands or paths hidden inside shell variables (literal assignments like `d=~/repo` are caught). No env or setting can disable it — removing the extension is the only off switch.
## web-search

LLM-callable `web_search` and `web_fetch` tools with keyless default backends.

**What it does** — Registers two tools the model can call: `web_search` returns ranked title/URL/snippet results; `web_fetch` returns a URL's content as clean markdown. Search backend is auto-selected: Tavily if `TAVILY_API_KEY` is set, Brave if `BRAVE_SEARCH_API_KEY` is set, otherwise keyless DuckDuckGo HTML scraping. Fetching goes through Jina Reader with a raw-fetch fallback. Notifies `Web search loaded (backend: <name>)` at session start.

**Commands and tools**

| Tool | Params | Behavior |
|---|---|---|
| `web_search` | `query` (string), `max_results` (optional number, default 5, clamped 1–10) | Empty query → tool error. Requests time out at 15 s. Returns `Results (backend: <name>)` or `No results (backend: <name>)`. |
| `web_fetch` | `url` (string, absolute http/https required) | Jina Reader (`https://r.jina.ai/<url>`, 30 s timeout); on failure retries a raw fetch + tag-stripped text (20 s timeout). Output truncated at 20 000 chars with a `[truncated at 20k chars]` note. |

**Configuration**

| Env var | Default | Effect |
|---|---|---|
| `TAVILY_API_KEY` | unset | Tavily search (highest priority) |
| `BRAVE_SEARCH_API_KEY` | unset | Brave search when Tavily unset |
| (neither set) | — | DuckDuckGo HTML scraping, no key |

No settings.json keys and no state files.

**How it works** — Backend selection is re-evaluated per call from env. DuckDuckGo results are regex-parsed from the HTML page and `uddg` redirect params are decoded to real URLs. Tool results render collapsed to a 5-line preview, expandable like the bash tool. Install as `extensions/web-search.ts` for auto-discovery.

**Caveats** — No failover between search backends: if the selected one errors, the tool call fails even when another backend is available. DuckDuckGo scraping depends on the page's HTML layout and can silently return no results after markup changes. Both tools cap output at 20 000 chars.

## rewind

Claude-Code-style checkpointing with `/rewind` to restore code and/or conversation.

**What it does** — Tracks every file the agent modifies via the `edit` and `write` tools, snapshots all tracked files at each user prompt, and stores the pre-session "original" of each tracked file. `/rewind` lists the prompts on the active branch and restores code and/or conversation to a chosen point.

**Commands and tools**

| Command | What it does |
|---|---|
| `/rewind` | Interactive, takes no args. Pick a prompt (`#N <preview> · N files/no files`), then an action: restore code and conversation, conversation only, code only, summarize from here, never mind. Code actions show how many files will change. |

**Configuration** — No settings or env vars. State in `~/.pi/agent/rewind/<sessionId>/`: `manifest.json` (tracked paths, originals, checkpoints keyed by user-message id, prompt text), `originals/<fileId>`, `checkpoints/<entryId>/<fileId>`. Persisted after every tracked change and on session shutdown; survives `/resume`, `/fork`, restarts, and `/reload`.

**How it works** — The original is captured from disk just before a path's first `edit`/`write` (`@` prefixes stripped, resolved against the session cwd). A checkpoint is written when a user message ends; a duplicate (retry, auto-compaction re-run) keeps the earliest snapshot. The restore target for a checkpoint is its snapshot if present, else the original. Conversation rewind navigates the session tree to the selected prompt's parent — rewound messages are never deleted and stay reachable via `/tree` — and puts the prompt text back in the editor for editing/re-sending; rewinding at the first prompt navigates to the prompt itself without pre-filling. "Summarize from here" navigates to the selected prompt with summarize enabled. Restoring writes captured content, re-applies saved permission bits (best-effort), and deletes files that did not exist at the checkpoint.

**Caveats** — Files modified through `bash` (sed/awk/…) are not tracked; use git. Directories are never checkpointed. Symlinked/hard-linked paths are restored best-effort and may be skipped. Failed restores are logged to stderr and skipped; the reported count reflects what actually changed. Non-interactive (print/json) mode silently does nothing. Session-scoped local undo, not a git replacement.

## mcp-cookie-gate

Pre-call SSO cookie checks for MCP servers, layered on pi's built-in MCP support.

**What it does** — Before any `mcp__<grafana-*>` or `mcp__<redash-*>` tool call, runs the matching `check-*-cookies.sh` hook (under `$MCP_SERVERS_ROOT`, default `~/mcp-servers`). The hook validates SSO cookies and launches browser re-auth when they expired; exit 0 allows the call, anything else blocks it with the hook output shown to the model.

**How it works** — `session_start` reads `~/.pi/agent/mcp.json` plus the project `.pi/mcp.json` override to resolve server env; a `tool_call` handler matches the server-name prefix against `AUTH_HOOKS` and spawns the hook detached (its own process group) with stdin `{"tool_name": …}` and an env of denylist-filtered `process.env` merged with the server's configured env, so URL/cookie-file vars reach the hook. The 120 s timeout and `session_shutdown` SIGKILL the whole process group, reaping wrapper-script grandchildren.

**Caveats** — A new brand with its own `check-*-cookies.sh` needs one line added to `AUTH_HOOKS`. The hook's exit code is the contract: 0 allow, non-zero block. Removing the extension removes cookie-SSO re-auth for grafana/redash MCP servers.

## model-fallback

Automatic switch to a configured fallback model after repeated provider failures, with auto-resume.

**What it does** — Counts consecutive failures per model (HTTP 429 or ≥500 responses, and stream errors that end a turn with `stopReason: "error"`; aborts, cancels, and other 4xx never count). At `failThreshold` consecutive failures, pi switches to that model's configured fallback, optionally with a thinking level. If a run dies on an error after a mid-run switch, it auto-resumes by sending a short continuation marker, capped at 2 resumes.

**Commands and tools**

| Command | What it does |
|---|---|
| `/fallback` | List pairs, threshold, auto-resume cap, shared-infra window, current fail counts, config path |
| `/fallback add [primary] [fallback] [thinking]` | Add a pair. Omitted args open pickers (fuzzy type-to-filter model picker in TUI, plain select otherwise; thinking picker always a select). `thinking` ∈ minimal, low, medium, high, xhigh, max. Primary and fallback must differ. |
| `/fallback remove [primary]` | Remove a pair; matches exact key, then substring. Omitted arg opens a picker. |

**Configuration** — `~/.pi/agent/settings.json` → `modelFallback`:

| Key | Default | Effect |
|---|---|---|
| `modelFallback.failThreshold` | `1` | Consecutive failures before switching |
| `modelFallback."<primary>"` | none | Fallback ref, `provider/model` or `provider/model:thinking` |
| `modelFallback` as a bare string | none | Fallback applied to every model |

Primary matching tries exact `provider/model`, then bare model id, then any key contained in the model id. Refs resolve the same way (registry `provider/model` lookup, then bare id, then substring). No env vars and no state files; fail counts are in-memory and reset on restart.

**How it works** — Transport-level errors (fetch failed, DNS, connection refused/reset, socket hang up, closed websocket, …) never trigger a switch — a notify suggests re-sending instead. If a *different* model failed within the last 60 s, the failure is treated as shared infrastructure and no switch happens. A switch never targets the current model or one already visited this run. A successful response (<400) resets that model's count. On switch: `setModel`, optional `setThinkingLevel`, target's count reset; if the fallback has no auth, pi stays put with an error. The resume epoch resets when a new run starts outside an auto-resume (new prompt, `/retry`, queued steer).

**Caveats** — Auto-resume marker ("The previous attempt died mid-run…") is sent as a follow-up; after 2 resumes the run is abandoned with a warning. Writing a pair rewrites the whole settings.json (formatting normalized to 2-space indent). Auth/config errors (non-429 4xx) do not trigger fallback.

## model-router

Jev-scored per-task routing: classifies each new prompt and switches model or thinking tier before the first provider call.

**What it does** — For each new task it sends the prompt (plus recent history) to a small classifier, which answers new-task vs follow-up, execution vs deciding, and a compute tier (keep/fast/mid/deep). If it is confidently a new task and a tier clears the threshold, pi switches to that tier's model — or only changes the thinking level when the tier maps to the current base model. Follow-ups keep the current model to preserve prompt-cache coherence.

**Commands and tools**

| Command | What it does |
|---|---|
| `/route` (same as `/route status`) | Enabled state, prefer-roles, threshold, timeout, per-tier resolution, pin, breaker, last 8 routes, log and config paths |
| `/route on` / `/route off` | Enable/disable routing (persisted) |
| `/route prefer <on\|off>` | On: `/roles` settings win over explicit tier refs |
| `/route tier [tier] [model]` | Set a tier to a model ref or `@role`; `off`/`none` disables it. Omitted args open pickers (tier → off/configured roles/registry models, plus a thinking-level picker in TUI). |
| `/route clear [tier]` | Remove the explicit ref; tier falls back to its role default |
| `/route threshold [value]` | Number 0.5–0.95; picker offers 0.6/0.7/0.75/0.8/0.9 |

**Configuration** — `~/.pi/agent/settings.json` → `modelRouter`, plus env:

| Key / env var | Default | Effect |
|---|---|---|
| `enabled` | `true` | Only an explicit `false` disables routing |
| `threshold` | `0.75` | Minimum probability to act |
| `timeoutMs` | `1500` | Classifier request timeout |
| `preferRoles` | `false` | Role refs beat explicit tier refs |
| `fast` / `mid` / `deep` | unset → `@smol` / `@task` / `@slow` from `/roles`; `null` = off | Tier ref `provider/model:thinking` or `@role` |
| `MODEL_ROUTER` | unset | `0` disables routing entirely |
| `JEV_BASE_URL` | `https://openrouter.ai/api` | Classifier endpoint |
| `JEV_MODEL` | `jev-latest` | Classifier model |
| `JEV_API_KEY` / `OPENROUTER_API_KEY` | unset → `openrouter.key` in `~/.pi/agent/auth.json` | Classifier auth |

Telemetry state: `~/.pi/agent/jev-decisions/model-router.jsonl` (decision + outcome records) and per-session `model-route` audit entries. With no `/roles` roles configured and no explicit tiers set, routing stays inert.

**How it works** — Routing fires after prompt submission but before the first provider call, so the routed model serves the whole task. Prompts shorter than 12 chars and slash-commands are skipped. The classifier payload — prompt (first 4000 chars), up to 3 previous user prompts (200 chars each), project directory name, current model — is scrubbed of common secret patterns (PEM blocks, `sk-`, GitHub, AWS, JWT tokens). With no session history the new-task probability is 1; otherwise `new_task=yes` must clear the threshold. The execution answer is recorded for telemetry but does not gate behavior. A manual model pick or cycle pins the current choice for the rest of that task; auto-routing resumes at the next task boundary. Three consecutive classifier failures trip a breaker that pauses routing for 10 minutes. Outcomes are logged back to the JSONL: a `bash` tool run matching a test runner (`pnpm`/`npm`/`yarn`/`bun`/`npx` test scripts, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `make test`) records `tests_passed`/`tests_failed`; manual model changes record `model_override`; prompts matching the correction heuristic record `user_corrected` — matched to the route within a 10-turn window.

**Caveats** — No auth for a routed model → stays on the current model with a warning. Unresolved tier refs (role unset, model not in registry) are warned once per ref and skip routing. Settings edits apply to the next prompt — no `/reload` needed. Depends on `model-fallback.ts` (imports its picker and thinking levels), so both files must be present.
## plugins

Browse and install skills from local Claude Code plugin marketplaces with `/plugins`.

**What it does** — Opens an interactive menu (Browse & install / Installed / Marketplaces) with searchable pickers, or manages marketplaces and plugins from the command line. Installed plugins load in place via `resources_discover` — a `git pull` of the marketplace updates its skills without reinstalling.

**Commands and tools**

| Command | What it does |
|---|---|
| `/plugins` | Interactive menu; non-TUI sessions print usage |
| `/plugins list` | Installed plugins with `[✓]`/`[✗]` state |
| `/plugins list all` / `list available` | Browse catalog (TUI picker; text catalog with 60-char descriptions otherwise) |
| `/plugins install\|uninstall\|enable\|disable <name>` | Mutate installed plugins |
| `/plugins marketplace` / `marketplace add <path>` / `marketplace remove <name-or-path>` | Manage marketplaces (`<path>` = repo root or direct `…/marketplace.json`) |

Tab completion offers catalog names for install and installed names for the rest; after every mutation a `/reload` is offered (TUI only).

**Configuration** — Catalog at `<marketplace-root>/.claude-plugin/marketplace.json`:

```json
{
  "name": "my-marketplace",
  "plugins": [
    { "name": "my-skill-pack", "description": "…", "source": "./skills-pack" }
  ]
}
```

Plugin fields: `name` (required), `description`, `author` (string or `{name}`), `category`, `source` (relative to the marketplace root or absolute; `git:`/`github:`/`https?:` sources are listed but not installable). A plugin ships `skills/` (recursive `SKILL.md`) or a root `SKILL.md`; `agents/`, `commands/`, and `.mcp.json` are detected for display only ("not supported yet").

State: `~/.pi/agent/plugins.json` — `{version: 1, marketplaces: [{name, path}], installed: {<name>: {marketplace, path, enabled, installedAt}}}`, re-read on every command and discovery.

| Env var | Default | Effect |
|---|---|---|
| `PI_PLUGIN_MARKETPLACE` | unset | Seeds the first marketplace only while `plugins.json` is missing/unreadable and `<path>/.claude-plugin/marketplace.json` exists; ignored once state is saved |

**Caveats** — Remote marketplace sources (`git:`/`github:`/`https:`) show in listings but cannot be installed. The picker matches by substring, not fuzzy search.

## summarize

`/summarize` renders a scrollable, full-terminal summary overlay of the conversation.

**What it does** — Flattens the conversation (user/assistant text plus `Tool <name> was called with args <json>` lines) and asks a model to produce a goals/decisions/progress/open-questions/next-steps summary, shown in a scrollable overlay (mouse wheel + keyboard). `/summarize view` reopens the last summary without a model call.

**Commands and tools**

| Command | What it does |
|---|---|
| `/summarize [model]` | Generate and open. The optional arg is a role alias (default `@smol`) or a `provider/model[:thinking]` ref; a concurrent generation is rejected |
| `/summarize view` (`show`, `last`) | Reopen the cached summary; warns "No summary yet" if none |

**Configuration** — No settings of its own. The model resolves through `utils/model-role.ts`: aliases `@smol`/`@fast`, `@slow`/`@reasoning`, `@plan`, `@task`, `@designer`; settings keys `smolModel`/`fastModel`/`slowModel`/`reasoningModel`/`planModel`/`taskModel`/`designerModel`/`modelRoles.*`; env overrides `PI_SMOL_MODEL` … `PI_MODEL`; default thinking effort `high`, overridable with a `:thinking` suffix.

**How it works** — Overlay keys: `↑/↓`/`k/j` line, Space, pageUp/pageDown, `home`/`g`, `end`/`G`, Esc close, mouse wheel; non-TUI contexts skip the overlay. The generation call runs in a fresh session (`uuidv7`, `cacheRetention: "none"`) so it never pollutes the current session; gated on a registry model and configured auth. An empty conversation is a no-op.

**Caveats** — The last summary is cached in memory only and is lost on restart or `/reload`.

## handoff

`/handoff <goal>` distills the current conversation into a fresh, focused session.

**What it does** — Serializes the current branch into one user message (`## Conversation History` / `## User's Goal for New Thread`), asks the currently selected model — with a fixed system prompt — to draft a self-contained handoff prompt, lets you edit the draft, then replaces the current session with a new one whose editor is pre-filled. You submit the prompt when ready.

**Commands and tools**

| Command | What it does |
|---|---|
| `/handoff <goal>` | Transfer context to a new focused session. TUI-only; requires a selected model, a non-empty goal, and a non-empty conversation |

**How it works** — Message entries pass through as-is; a compaction entry contributes its summary plus entries from `firstKeptEntryId` onward; other entry types are dropped. The draft generation runs in a fresh session (`uuidv7`, `cacheRetention: "none"`); the draft is edited via the UI editor, then `ctx.newSession({ parentSession, withSession })` replaces the session and records the old session file as parent.

**Caveats** — Only the distilled prompt transfers: verbatim history and tool outputs are lost, and pre-compaction content survives only via the summary.

## decisions-report

`/decisions-report` joins every decision log to its outcomes and flags what to prune or reword.

**What it does** — Auto-discovers every `*.jsonl` under `~/.pi/agent/jev-decisions/`, joins each system's decision records to their outcome records, and writes a markdown report with per-system tables (decisions / outcomes / joined / verdicts / stale / untyped) plus action flags.

**Commands and tools**

| Command | What it does |
|---|---|
| `/decisions-report [days]` | Analysis window, default 7 (clamped 1–365); writes the report and notifies with its path |

**Configuration** — Reads the record contract from `utils/jev-outcomes.ts`: `decision` (carries `id`), `outcome` (resolves a decision via `ref`, carries a domain `outcome` and the universal `verdict`: good/bad/mixed/unknown), and `event`; reserved keys `kind`, `system`, `id`, `ref`, `outcome`, `verdict`, `ts`. A decision with no outcome after 24 h counts as stale; `joined` = outcomes minus orphans. Known logs: `ttsr-jev.jsonl`, `model-router.jsonl`, `jev-curator.jsonl`, `jev-memory.jsonl` — any new `*.jsonl` in the directory is picked up automatically.

**How it works** — The report lands at `~/.pi/agent/jev-decisions/reports/decisions-<date>.md` (UTC date, overwritten same day). Flags: TTSR rules with ≥20 evaluations and zero delivered fires as prune candidates (plus adverse wording when ≥3 resolved and ≥50% adverse); router routes followed by `tests_failed`; curator extracts emitted >3 days that were never recalled. Legacy (pre-telemetry) rows are reported separately from telemetry-era counts.

**Caveats** — Outcome records only exist for decisions made after the telemetry rollout, so early history shows as legacy-only. The automated loop over these flags lives in [`decision-tuner`](decision-tuner/README.md).
## todo

Session-scoped todo list exposed to the model as a `todo` tool and to the user as a `/todos` overlay.

**What it does** — Registers a `todo` tool the model uses to `list`, `add`, `toggle`, and `clear` todos, plus a `/todos` command that opens an interactive overlay showing the list with a done/total count. State is not stored in external files: each tool result embeds the full todo snapshot, so state is reconstructed by replaying the session. Branching to an earlier point in history therefore restores the todo state as of that point.

**Commands and tools**

| Command / tool | What it does |
|---|---|
| `todo` (tool) | `list`; `add` (needs `text`); `toggle` (needs `id`); `clear` |
| `/todos` | Show all todos on the current branch in an overlay (Escape or Ctrl+C closes) |

**How it works** — On `session_start` and `session_tree`, the extension scans the current branch's entries for `todo` tool results in order and adopts the `todos`/`nextId` snapshot from the last one. IDs are sequential starting at 1; `clear` resets the counter. Tool results render as compact summaries — the collapsed list shows at most 5 items, expanding shows all.

**Caveats** — `/todos` requires interactive (TUI) mode; elsewhere it notifies and does nothing. `add` without `text` and `toggle` with an unknown id return error results. Only the current branch's entries are replayed, so state is branch-scoped.

## stats

`/stats` launches the omp-stats web dashboard (cost, tokens, cache) against this machine's pi session logs.

**What it does** — `/stats [port]` starts the `@oh-my-pi/omp-stats` dashboard as a detached background server and opens it in the browser. If something already answers on the target port's `/api/stats`, it just opens the browser. Otherwise it spawns the server, waits in the background for it to come up, then opens the browser.

**Commands and tools**

| Command | What it does |
|---|---|
| `/stats [port]` | Start (or reuse) the dashboard on `port` and open it in a browser |

**Configuration**

| Env var | Default | Effect |
|---|---|---|
| `PI_STATS_HOST` | `127.0.0.1` | Host the dashboard binds to and is reached at (local-only by default) |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Agent directory; also passed through to the server process |
| `BUN_BIN` | unset | Explicit bun binary path (first fallback candidate) |

The port comes from the command argument (1–65535, otherwise default `3847`). Server stdout/stderr is appended to `~/.pi/agent/utils/omp-stats/server.log`.

**How it works** — One-time setup: the published `@oh-my-pi/omp-stats` package must be installed under `~/.pi/agent/utils/omp-stats/` (e.g. `bun add @oh-my-pi/omp-stats`); the extension does not install it. Bun is required: the extension probes `bun --version` and falls back to `BUN_BIN`, `~/.bun/bin/bun`, `/opt/homebrew/bin/bun`, `/usr/local/bin/bun` (first that exists), then plain `bun` — covering environments whose `PATH` lacks `~/.bun/bin`. It then spawns `bun run <agentDir>/utils/omp-stats/node_modules/@oh-my-pi/omp-stats/src/index.ts -p <port> --host <host>` detached and polls the API once per second for up to 120 s before opening the browser (`open` / `cmd /c start` / `xdg-open` per platform).

**Caveats** — The command returns immediately; startup is awaited in the background ("first sync can take a minute"). If the server never comes up within 120 s, the error points at `server.log`. An invalid or missing port argument silently falls back to 3847. A dashboard already running on the chosen port is reused, not restarted.

## custom-footer

Two-line TUI status bar — directory, git branch, token/cost totals, context usage, and model — enabled by default.

**What it does** — Replaces the default footer. Line 1 shows the current directory's basename and git branch. Line 2 shows session input/output token totals, context-window usage as a percentage of the model's max (warning color at ≥60%, error at ≥85%), running cost, and the model id with thinking level. `/footer` toggles it off (restoring the default footer) and back on.

**Commands and tools**

| Command | What it does |
|---|---|
| `/footer` | Toggle the custom footer; off restores the default footer |

**How it works** — Totals are recomputed on every render by summing `usage.input`, `usage.output`, and `usage.cost.total` over all assistant messages on the current branch. The footer re-renders on git branch changes via `footerData.onBranchChange` (unsubscribed on dispose). It is reinstalled on every `session_start` (new, resume, fork, reload) while enabled.

**Caveats** — The on/off toggle is in-memory: it survives session switches but resets to enabled on extension reload or restart. Never installed in non-TUI sessions. Context shows 0% when the model has no known context window; the branch shows `-` when git info is unavailable.

## confirm-destructive

Confirms session switches and forks so unfinished conversations aren't discarded.

**What it does** — Hooks `session_before_switch` and `session_before_fork`. Switching to another session prompts for confirmation when the session contains at least one user message; forking always prompts with an explicit yes/no dialog. Declining cancels the action.

**How it works** — Returns `{ cancel: true }` from the `before_*` events to abort. A `session_before_switch` with reason `new` (starting a fresh session) is never blocked, and both hooks no-op without a UI. The switch prompt warns "You have messages in the current session. Switch anyway?"; the fork prompt shows the first 8 characters of the fork entry id.

**Caveats** — Only switch and fork are guarded: the file's header comment also mentions `clear`, but no such handler exists in the code. In non-interactive sessions there is no UI, so the hooks silently do nothing (no confirmation, no block). The "unsaved work" check is any user message in the session — not just messages since the last assistant response, despite the in-file comment.

## dirty-repo-guard

Blocks session switches and forks while the git working tree has uncommitted changes.

**What it does** — Before a session switch or fork, runs `git status --porcelain` and, if the tree is dirty, asks "You have N uncommitted file(s). \<action\> anyway?" with options to proceed or stay and commit first. Anything other than "Yes, proceed anyway" cancels the action with a "Commit your changes first" warning. Applies to both switch reasons ("new session", "switch session") and forks.

**How it works** — The changed-file count is the number of non-empty `--porcelain` lines (untracked files included). A non-zero git exit (not a git repo) or a clean tree allows the action without prompting. In non-interactive mode there is no prompt: a dirty tree blocks by default.

**Caveats** — In non-interactive sessions a dirty tree always blocks; there is no override. Relies on `git` being on `PATH` — a failing git command is treated as "not a repo" and the action is silently allowed.

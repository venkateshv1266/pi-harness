# my-pi-setup

My [pi coding agent](https://github.com/earendil-works/pi-coding-agent) setup —
the extensions in `extensions/`, themes in `themes/`, a pack of generic TTSR
rules in `rules/`, nine subagent definitions in `agents/`, and skills in
`skills/`. Clone this repo
and run `./install.sh` to get the same setup.

## Prerequisites

- **Node.js >= 22.15.0** (pi uses `zlib.createZstdDecompress`, which older
  Node versions lack — pi will crash on startup below this version)
- **pi** installed globally: `npm i -g @earendil-works/pi-coding-agent`
- `rsync` (present on macOS; on Linux install it via your package manager)

## Setup

```bash
git clone https://github.com/venkateshv1266/my-pi-setup.git
cd my-pi-setup
./install.sh
```

Then restart pi (or run `/reload` in an open session). That's it — pi
auto-discovers the installed extensions and themes in `~/.pi/agent/`.

To uninstall an extension, delete its file (or directory) from
`~/.pi/agent/extensions/` and `/reload`.

## Optional: YubiKey alerts for Git in cmux

If Git uses a YubiKey for SSH authentication or signing, install the optional
cmux alert wrappers:

```bash
./scripts/install-yubikey-notifications.sh
```

This installs wrappers and the selected alert sound under `~/.pi/agent/`, then
configures Git's global `core.sshCommand` and `gpg.program` settings:

- SSH-backed `git pull`, `fetch`, `push`, and similar operations alert before
  SSH authentication starts. SSH cannot expose in advance whether the agent
  will require a hardware touch, so this may alert when an existing session
  does not need one.
- GPG signing operations alert when Git actually invokes GPG. Verification
  operations remain silent.

The default sound is `~/.pi/agent/sounds/yubikey-alert-2-beep.wav`. Set
`PI_YUBIKEY_NOTIFICATION_SOUND` before launching Git or pi to use another
`.wav`/`.aiff` file. The installer preserves an existing custom Git setting
instead of overwriting it.

## Updating an existing setup

Already installed? Pull and re-run the installer:

```bash
cd my-pi-setup
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

## Themes

Custom Pi themes are stored in `themes/` and installed to
`~/.pi/agent/themes/` by `./install.sh`.

| Theme | Description |
|---|---|
| **onedark-obsidian** | One Dark-inspired dark theme with a softened steel-blue accent (`#789bbd`). |
| **quiet-night** | Warm, low-glare dark theme with muted accents for long sessions. |
| **low-lumen** | Deep dark theme with low-saturation colors, warm text, and high readability contrast. |

Select a theme from `/settings`, or use one for a single run:

```bash
pi --use-theme onedark-obsidian
pi --use-theme quiet-night
pi --use-theme low-lumen
```

## Extensions

### Single-file extensions (`~/.pi/agent/extensions/*.ts`)

| Extension | What it does |
|---|---|
| **web-search.ts** | Gives the LLM `web_search` + `web_fetch` tools. DuckDuckGo/Jina by default (no key needed); optionally set `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY` for better search. |
| **rewind.ts** | `/rewind` — Claude-Code-style checkpoints & rewind. Tracks every file the agent edits and snapshots state at each user prompt. |
| **handoff.ts** | `/handoff <task>` — instead of a lossy compact, extracts what matters and spawns a fresh focused session with a generated prompt. |
| **todo.ts** | `todo` tool + `/todos` command — todo state persisted in session entries, not files. |
| **summarize.ts** | `/summarize` — full-terminal scrollable summary overlay (mouse wheel + keyboard); model selected via role alias (`@smol` by default, any alias accepted as the command arg); `/summarize view` reopens the last summary from cache without re-running the model. |
| **claude-compat.ts** | Makes pi discover Claude Code resources (`.claude/` contexts, skills, hooks) by walking cwd → root. |
| **custom-footer.ts** | Two-line status footer: cwd, git branch, tokens in/out, context %, cost, model. Toggle with `/footer`. |
| **openrouter-guardrail-header.ts** | Sticky top header showing daily/monthly OpenRouter usage and configured caps. Reads the current session key via `GET /api/v1/key`; no MCP or Management API key is required. |
| **model-roles.ts** | `/roles` — interactive TUI to assign the subagent model roles (`smolModel`, `slowModel`, `planModel`, `taskModel`, `designerModel`) in settings.json: role picker with one-line purpose descriptions → searchable model picker → thinking level. See [Model roles](#model-roles) below. |
| **model-fallback.ts** | Auto-failover when a model is rate-limited (429) or errors out — switches to a configured fallback model (with its own thinking level) and the in-flight run continues on it. Covers the main session **and** subagents, since subagents are spawned `pi` processes that load global extensions. See [Model fallback](#model-fallback) below. |
| **model-router.ts** | Route-ahead model selection: at each task boundary, Jev (System One decision model) classifies the prompt — new task? compute tier (keep/fast/deep)? — and switches models *before* the first token is spent. Confidence-gated, honors manual model choices, fails open. See [Model routing](#model-routing-route-ahead) below. |
| **confirm-destructive.ts** | Asks for confirmation before destructive session actions (`/clear`, switch, branch). |
| **dirty-repo-guard.ts** | Blocks session-clearing actions while the repo has uncommitted changes. |
| **repo-agents-guard.ts** | Blocks agent tool calls targeting a repository until its nearest `AGENTS.md` is successfully read with `read`; covers path tools, shell working directories/paths, and subagent launch paths. |
| **plugins.ts** | `/plugins` — browse & install skills from Claude Code plugin marketplaces (local `.claude-plugin/marketplace.json` catalogs). Interactive searchable picker + detail views, or CLI: `/plugins install\|uninstall\|enable\|disable\|list <name>`, `/plugins marketplace add <path>`. Installed plugins load in place via `resources_discover` — `git pull` of the marketplace updates skills. State: `~/.pi/agent/plugins.json` (local, not synced); seed marketplaces there or via `PI_PLUGIN_MARKETPLACE`. |
| **cmux-session.ts** | Bridges pi into [cmux](https://github.com/earendil-works/cmux) (session lifecycle, telemetry, notifications). **Managed by cmux** — `cmux hooks pi install` writes/overwrites this file. Skip it if you don't use cmux. |
| **stats.ts** | `/stats [port]` — opens a browser-based usage dashboard for pi session cost, token, and cache statistics. |

### Repository instruction guard

`repo-agents-guard.ts` finds the nearest `AGENTS.md` for each agent tool target. It treats `AGENTS.md` files already preloaded by Pi into the current system context as satisfied, so a sibling repository can reuse an already-loaded parent file; a closer `AGENTS.md` still requires its own read. Otherwise, it allows the `read` call for the applicable file, then records the repository as cleared only after the read succeeds. Other path tools, shell calls, and subagent launches are blocked until then. Shell detection covers the current working directory, absolute and `~` paths, `cd`, and `git -C`/work-tree arguments. It does not intercept user `!`/`!!` shell commands or paths hidden inside shell variables.

### Usage statistics

The `/stats` command launches the `@oh-my-pi/omp-stats` dashboard with Bun.
The dashboard is installed under `~/.pi/agent/utils/omp-stats/` and reads the
session logs from the same pi agent directory.

After running `./install.sh`, install the dashboard dependency once:

```bash
cd ~/.pi/agent/utils/omp-stats
bun install
```

Then reload pi and run:

```text
/stats
```

Pass a port to use something other than the default `3847`, for example
`/stats 4000`. Set `PI_STATS_HOST` to change the bind host. The command opens
the dashboard in the system browser and writes startup errors to
`~/.pi/agent/utils/omp-stats/server.log`.

### Subdirectory extensions (own `package.json`, `npm install` runs in `install.sh`)

| Extension | What it does |
|---|---|
| **mcp-bridge/** | Adds MCP server support to pi: lazy-connects servers from `~/.pi/agent/mcp-servers.json`, registers their tools as `mcp__<server>__<tool>`, does OAuth 2.0 PKCE login for remote servers (Slack, Linear, …), strips sensitive env vars from child processes, and truncates oversized tool results. Config lives in `~/.pi/agent/mcp-servers.json` (see below). |
| **subagent/** | The `subagent` tool — delegate tasks to isolated `pi --mode json` child processes. Parallel task batches, sequential chains with a `{previous}` placeholder, per-agent tool allowlists, model-role aliases (`@smol`, `@slow`, …). Agent definitions ship in `agents/` below. |
| **persistent-subagent/** | Named, steering-able, resumable subagents. `subagent_spawn` (single or `tasks` batch) runs children as long-lived `pi --mode rpc` processes with per-child persistent sessions and **blocks until they settle, returning results in the same call** (`wait: false` returns handles for mid-flight steering). `subagent_send` steers a running child or starts a follow-up turn; `subagent_wait` collects results — waiting on an aborted child auto-resumes it; `subagent_list` shows the roster. Children are scoped to the root session (no cross-session leakage), survive restarts via on-disk session files, idle-unload after 30 min and transparently resume. Same agent definitions as `subagent` (from `agents/`). |
| **ttsr/** | TTSR (Time-Traveling Stream Rules) engine — rules sit dormant with **zero token cost** until the model's live output matches a regex or [ast-grep](https://ast-grep.github.io/) pattern, then abort+remind or block/prepend. Manage with `/ttsr`; rules are `.md` files in `.pi/rules/` (project) or `~/.pi/agent/rules/` (user). See `extensions/ttsr/README.md`. |
| **refine/** | Evidence-gated self-refinement — `/refine` reviews a session trajectory and promotes recurring lessons into TTSR rules or notes; `refine_propose` lets the agent submit a draft mid-session (approval + rollback history). Plus a **background self-improvement loop**: pre-gated every `REFINE_AUTO_TURNS` turns (default 10 — fires only on user-correction regex hits or 2+ repeated identical tool errors), the planner proposes, Jev adjudicates (weakest-link score over evidence / trigger-precision / novelty), notes auto-apply, and rules land **staged** in `~/.pi/agent/refine/rules-staging/` (dormant by construction) for one-glance arming via `/refine-review` (arm / keep / `discard`). Dedup is name + content-hash + Jev redundancy vs existing rule bodies; rules are born with optional `verify:` Jev gating; every decision audits to `~/.pi/agent/refine/auto-refine.jsonl` with per-session attribution. `REFINE_AUTO=0` / `REFINE_JEV=0` kill switches, `REFINE_AUTO_RULE_THRESHOLD` (0.8) / `REFINE_AUTO_NOTE_THRESHOLD` (0.6), `REFINE_AUTO_HEADLESS=1` for non-TUI sessions; Jev unavailable degrades to manual-only — nothing auto-writes ungated. |
| **jev-memory/** | Persistent memory + session search with a Jev System-One decision layer — admission gate on every save (blocked low-value writes return their reason), review pre-gate (skips the periodic LLM review on quiet turns), correction adjudication behind the regex pre-filter, search rerank over BM25, and scheduled typed (retire-only) consolidation. Every decision degrades to plain hermes behavior when Jev is unavailable. Data lives in `~/.pi/agent/jev-memory/` (auto-migrates from a legacy `pi-hermes-memory` store on first start); `JEVM_JEV=0` kill switch; decisions audit to `~/.pi/agent/refine/jev-memory.jsonl`. See `extensions/jev-memory/README.md`. |
| **setup/** | `/setup` — full-screen setup window: every setting from pi core and the installed extensions (models, roles, router, fallbacks, guardrails, appearance, core behavior, packages/plugins) plus a cheat sheet of every loaded slash command, TTSR rules, and MCP servers — with a detail pane explaining what each setting does and when changes apply. Extensible: any extension can contribute a section via a `setup.ts` file (see [Setup window](#setup-window) below). |

## Subagent definitions (`agents/`)

Six agents, used with the `subagent` tool above. Full file-format docs in
`agents/README.md`.

| Agent | Role | Tools |
|---|---|---|
| **explorer** | Fast read-only codebase recon — "where is X?" lookups, returns a compressed map for handoff (`@smol`) | read, grep, find, ls, bash |
| **research** | Open-ended investigation across files/logs/docs, returns a structured briefing with citations (`@smol`) | read-only + web_search, web_fetch |
| **writer** | Code-typing executor for fully-decided specs — implements, doesn't design (`@smol`) | read, bash, edit, write, grep, find, ls |
| **verifier** | Quality-gate pass — grades a writer's diff against the frozen spec and the lint/typecheck/test harness (`@slow`, xhigh thinking) | read-only |
| **reviewer** | Backend review orchestrator — dispatches parallel lens sub-agents + a validator pass, synthesizes prioritized findings (`@slow`) | read-only + subagent |
| **task** | General-purpose worker, can fan out to nested subagents (`@task`) | full set + subagent |
| **security-auditor** | Dedicated security lens for review fan-outs — threat-models new entry points (authn/authz bypasses, IDOR, injection, secrets, PII). Spawned by `reviewer` on non-trivial diffs; usable standalone (`@slow`) | read, bash, grep, find, ls |
| **concurrency-auditor** | Dedicated concurrency & state lens — transaction/isolation gaps, idempotency violations, races, lock ordering, outbox/dual-write, saga rollback. Spawned by `reviewer` on diffs touching state, queues, or money paths (`@slow`) | read, bash, grep, find, ls |
| **review-validator** | Fact-checker for review findings — independently verifies each finding against the cited code, classifies as CONFIRMED / DOWNGRADE / REFUTED / UNVERIFIABLE; never generates new findings (`@slow`, xhigh thinking) | read, bash, grep, find, ls |

`install.sh` auto-configures the role aliases (add-only — it never
overwrites keys you've already set): `@smol` → OpenAI GPT-5.6 Luna,
`@slow` → GLM-5.3, `@plan` → GPT-5.6 Terra, `@task` → GLM-5.3 Flash, all
routed via OpenRouter (needs an OpenRouter key configured in pi). It also
seeds the [model-router](#model-routing-route-ahead) `modelRouter` block
(fast/deep tiers + threshold) the same add-only way, so route-ahead works
out of the box on a fresh install. Thinking
levels are pinned per-agent in the frontmatter (e.g. verifier runs `xhigh`).
Override anytime via `smolModel` / `slowModel` / `planModel` / `taskModel` in
`~/.pi/agent/settings.json` or `PI_SMOL_MODEL` / `PI_SLOW_MODEL` env vars;
fully unset, agents inherit your session model. The `writer` → `verifier`
pair is the cascade pattern: a cheap model types, a strong model grades.
Project-local agents can override these via `.pi/agents/<name>.md`.

### OpenRouter guardrail header

The installer adds this block to `~/.pi/agent/settings.json` without overwriting an existing value:

```json
"openrouterGuardrails": {
  "monthlyLimit": 500,
  "dailyLimit": 75
}
```

The header combines OpenRouter credit usage and BYOK usage for the active key,
refreshes every five minutes, and displays the configured monthly (`M`) and daily
(`D`) caps. Update the two limits in `settings.json` if the dashboard budgets
change, then run `/reload`.

### Model fallback

**model-fallback.ts** watches every provider response and switches to a fallback
model when the current one fails for real — HTTP 429 (rate limit), 5xx, or
stream-level errors (timeouts, mid-body disconnects). User aborts (Esc) never
trigger a switch, and each failure is attributed to the model that produced it.
It covers the main session and subagents (subagents are spawned `pi` processes
that load global extensions).

**Setup** — pairs live in `~/.pi/agent/settings.json` under a `modelFallback`
map, using the same `provider/model:thinking` syntax as the model roles:

```jsonc
"modelFallback": {
  "openrouter/z-ai/glm-5.3": "openrouter/openai/gpt-5.6-terra:high",
  "openrouter/openai/gpt-5.6-luna:xhigh": "openrouter/z-ai/glm-5.3:max"
}
```

- Key = primary model: full `provider/modelId`, bare `modelId`, or a
distinctive substring of the model id
- Value = fallback; a `:thinking` suffix (`high`, `xhigh`, `max`, …)
auto-applies that thinking level on switch
- Optional `"failThreshold": N` tolerates N−1 transient failures before
switching (default `1` = switch on first failure)
- Chains work: a fallback can have its own fallback (cycles are blocked)

**Manage with `/fallback`:**

| Command | What it does |
|---|---|
| `/fallback` | Show configured pairs, threshold, and live failure counters |
| `/fallback add` | Interactive: searchable picker for primary → fallback → thinking level, saved to settings.json |
| `/fallback add <primary> <fallback> [thinking]` | One-liner, e.g. `/fallback add glm-5.3 openrouter/openai/gpt-5.6-terra high` |
| `/fallback remove [primary]` | Drop a pair (picker if no arg) |

Config is re-read on every failure, so edits apply immediately — no reload
needed. When a run dies after retries are exhausted, the failed prompt is
automatically re-sent on the fallback so the turn resumes where it left off.

### Model routing (route-ahead)

**model-router.ts** complements model-fallback: instead of reacting to
failures, it picks the right starting model *before* the task begins. On every
prompt that starts a new task, it sends the prompt (plus the last few user
prompts as continuity evidence) to Jev — TypeSafe's System One decision model,
served via OpenRouter at ~100–600 ms and ~$0.00003/call — with two calibrated
questions: is this a new task, and which compute tier fits (keep / fast /
mid / deep)? It switches the model only when both answers clear the confidence
threshold.

Design properties:

- **Task-boundary routing only.** Follow-up prompts never re-route, so the
  prompt cache stays warm within a task (switching models mid-task would
  invalidate it). The first prompt of a session is structurally a new task.
- **Calibrated gate.** Both questions must clear `threshold` (default 0.75);
  anything less is a silent no-op. Criteria are asymmetric: when in doubt,
  deep over fast.
- **Manual choice wins.** A model picked via `/model` or Ctrl+P is honored for
  the current task; auto-routing resumes at the next task boundary.
- **Fails open.** Jev unreachable → no-op, with a circuit breaker that pauses
  routing for 10 minutes after 3 consecutive failures.
- **Layers with model-fallback:** the router picks the starting model; the
  fallback repairs failures. Neither depends on the other.

**Setup** — tiers live in `~/.pi/agent/settings.json` using the same
`provider/model:thinking` syntax as fallback pairs:

```jsonc
"modelRouter": {
  "enabled": true,
  "threshold": 0.75,
  "timeoutMs": 1500,
  "fast": "openrouter/z-ai/glm-5.3-flash:medium",
  "mid": "openrouter/z-ai/glm-5.3-flash:high",
  "deep": "openrouter/z-ai/glm-5.3-flash:max"
}
```

Tiers map to work shapes: `fast` — mechanical edits and lookups; `mid` —
bounded judgment (review triage, research synthesis, local debugging); `deep` —
hard reasoning (incident triage, architecture, concurrency/retry contracts,
long-horizon implementations with multiple failure paths). All three tiers
share one base model, so every route is a thinking-level change: it never
switches to a more expensive model (a measured 2.3× billing premium with no
pass-rate gain) and never invalidates the prompt cache — the extension detects
same-model routes and only adjusts thinking.

Requires an OpenRouter key (`~/.pi/agent/auth.json` → `openrouter.key`, or
`OPENROUTER_API_KEY`). Endpoint/model are overridable via `JEV_BASE_URL` and
`JEV_MODEL`; `MODEL_ROUTER=0` disables the Jev call entirely. Every decision
—including no-ops, with reasons and probabilities—is appended to
`~/.pi/agent/refine/model-router.jsonl` for auditing hit rate and calibration.

**Manage with `/route`:**

| Command | What it does |
|---|---|
| `/route` | Status: config, pin state, circuit breaker, last 8 decisions |
| `/route on` / `/route off` | Toggle routing in settings.json (applies immediately, no reload) |
| `/route tier` | Interactive (same searchable picker TUI as `/roles`): pick tier → model → thinking level, saved to settings.json |
| `/route tier <fast\|mid\|deep> [model:thinking]` | One-liner, e.g. `/route tier deep openrouter/openai/gpt-5.6-luna:xhigh` |
| `/route clear [fast\|mid\|deep]` | Unset a tier (router stops acting on it) |
| `/route threshold [0.6\|0.7\|0.75\|0.8\|0.9]` | Minimum calibrated p for both questions before the router acts (default 0.75) |

### Model roles

**model-roles.ts** provides `/roles` for assigning the model roles that the
subagent engine resolves via `@smol` / `@slow` / `@plan` / `@task` /
`@designer` aliases. Keys live at the top level of
`~/.pi/agent/settings.json` using the same `provider/model:thinking` syntax
as fallback pairs:

```jsonc
"smolModel": "openrouter/openai/gpt-5.6-luna:xhigh",
"slowModel": "openrouter/z-ai/glm-5.3:max",
"planModel": "openrouter/z-ai/glm-5.3:max",
"taskModel": "openrouter/z-ai/glm-5.3-flash",
"designerModel": "google/gemini-3.7-flash"
```

| Command | What it does |
|---|---|
| `/roles` | Interactive: role picker (shows each alias's purpose and current model) → searchable model picker → thinking level |
| `/roles <role> <model:thinking>` | One-liner, e.g. `/roles smolModel openai/gpt-5.6-luna:xhigh` |
| `/roles clear [role]` | Remove a role assignment (falls back to its alias chain) |

`PI_SMOL_MODEL` / `PI_SLOW_MODEL` / etc. env vars take precedence over these
settings, and an unset role falls back through its chain to `defaultModel`
(see the subagent section above). Restart pi or `/reload` after changing.

`PI_SMOL_MODEL` / `PI_SLOW_MODEL` / etc. env vars take precedence over these
settings, and an unset role falls back through its chain to `defaultModel`
(see the subagent section above). Restart pi or `/reload` after changing.

### Setup window

**setup/** provides `/setup [section]` — a full-screen, two-pane window that
covers every setting in one place so you never have to remember which command
tweaks what:

```
╭ pi setup ─ Models ────────────────────────────── ? help · esc close ╕
│ [Models] · Roles · Router · Fallbacks · Guardrails · … │
├──────────────────────────────────┬─────────────────────────────────┤
│ → Default model        glm-5.3-… │ Default model                   │
│   Default thinking     high     │ current: openrouter/…           │
│   + Add override                │ Model used when a session …     │
│                                 │ ● applies: new sessions         │
╘═╧═══════════════════════════════╧═══════════════════════════════╛
```

- **Left pane** lists settings for the active section with current values;
  **right pane** explains the highlighted setting: what it is, when a change
  takes effect (immediately / next prompt / next start), which extension owns
  it, and its allowed values.
- **Editors are inline** — no nested dialogs: `←/→` cycles enums and toggles,
  `enter` opens a type-to-filter model picker (with a thinking-level suffix
  step), numbers/text get an inline input, `⌫` removes an entry (fallback
  pair, thinking override, package), `+ Add …` rows add new ones.
- **Sections**: Models, Roles, Router, Fallbacks, Guardrails, Appearance,
  Core, Packages, Commands (every loaded slash command with its description —
  built via `pi.getCommands()`), Rules (TTSR), MCP. `/setup router` deep-links
  to a section; `/` filters across all sections; `?` shows key help.
- Changes are written with the same read-merge-write pattern the individual
  commands use, so concurrent writers (router, roles, fallback) never clobber
  each other. Where the API allows, changes also apply to the live session
  (`pi.setModel`, `pi.setThinkingLevel`).

**Contributing a section:** any extension can plug into the window without
touching it. Ship `foo.setup.ts` next to `foo.ts` (or `<dir>/setup.ts` for
directory extensions) exporting a default function that returns a
`SetupSection` — see `extensions/setup/types.ts` for the small typed surface
(`SetupItem` kinds: enum, model, model-pair, number, text, toggle, action,
info). Failed contributors show up as a "Broken" section instead of breaking
the window.

## TTSR rules (`rules/`)

17 generic rules for the TTSR engine above. They sit dormant with **zero token
cost** until the model's output matches a trigger, then abort+remind or
block/prepend. Delete any you disagree with before installing — `install.sh`
copies them all into `~/.pi/agent/rules/` without deleting yours.

**Git discipline**

| Rule | Fires when | Effect |
|---|---|---|
| `no-force-without-lease` | `git push --force` without `--with-lease` | blocks |
| `amend-ci-fixes` | a standalone `git commit` for a lint/type-only fixup | blocks (amend instead) |

**Code quality (write/edit scope)**

| Rule | Fires when |
|---|---|
| `no-ts-any` / `no-ts-ignore` | `: any`, `as any`, `@ts-ignore`, blanket `eslint-disable` |
| `no-empty-catch` | empty `catch {}` |
| `no-console-log-in-prod-code` | `console.log` written into non-script source |
| `no-localhost-in-prod-code` | `localhost`/`127.0.0.1` URLs in prod-path code |
| `no-hardcoded-api-keys` / `no-placeholder-api-key` | literal keys, or placeholder keys that should've been real config |
| `no-temp-fixes` | "for now" / "quick fix" / `// HACK` — in prose or code |

**Process discipline**

| Rule | Fires when | Effect |
|---|---|---|
| `verify-before-done` | "I'm done / the task is complete" in prose | abort + remind to run lint/tests first |
| `no-prod-migrations-local` | a prod-mode DB migration run locally | blocks |
| `search-before-creating-utility` | writing into a shared-utils dir without grepping for an existing helper | reminder |
| `tests-validate-behavior-not-implementation` | snapshot tests / mock-only tests | reminder |
| `delegate-read-only-exploration` | announcing a broad multi-pronged repo survey inline | abort + remind to use a subagent |
| `no-console-log-prose` | "let me just log this to see…" | abort + suggest a debugger/proper test |

## Skills (`skills/`)

| Skill | What it does |
|---|---|
| **add-rule/** | Full procedure for authoring a new TTSR rule: failure analysis, bucket decision tree, quality gates, trigger crafting (regex / ast-grep / globs), the rule-file template, and a validator script (`node skills/add-rule/scripts/validate-rule.js <rule.md> --sample "..."`) that must print `OK — rule is valid.` before a rule ships. |
| **add-agent/** | Procedure for creating a new pi-native subagent (`~/.pi/agent/agents/` or `.pi/agents/`): scope + naming rules, a task-profile → model-role table (`@smol`/`@slow`/`@plan`/`@task`/`@designer` with matching thinking + tool allowlists), description and system-prompt authoring guidance, a copy-paste template, and RFC 2119 tool-allowlist rules (tool names MUST be discovered from the live toolset — session tools, extension tools, `mcp__<server>__<tool>` — never assumed). |
| **code-review/** | Reviews a PR, branch, or working diff through the read-only `reviewer` agent, including applicable lens fan-out, validator verification, severity ordering, and the required consolidated review format. |
| **add-mcp-server/** | How to add an MCP server to pi via `mcp-bridge` — local `stdio` launchers AND remote `http`/`sse` endpoints (OAuth 2.0 PKCE browser flow, static Bearer headers, or public unauthenticated), the config-file shape, the lazy-connect model, the env denylist security model, and verification steps. |

### Adding an HTTP-type MCP server (quick version)

Remote servers need no local process — just a `url` in
`~/.pi/agent/mcp-servers.json`. Full details in `skills/add-mcp-server/SKILL.md`.

OAuth 2.0 PKCE (e.g. Slack — the bridge opens a browser on first connect and
caches tokens in `~/.pi/agent/mcp-oauth.json`, mode 0600):

```json
"slack": {
  "type": "http",
  "url": "https://mcp.slack.com/mcp",
  "oauth": { "clientId": "<your-slack-app-client-id>", "callbackPort": 3118 }
}
```

Static API key / Bearer token:

```json
"my-remote-service": {
  "type": "http",
  "url": "https://mcp.example.com/mcp",
  "headers": { "Authorization": "Bearer <TOKEN>" }
}
```

Then `/reload` + `/mcp <name>` to connect, and the server's tools appear as
`mcp__<name>__<tool>`.

## Not included (on purpose)

- **`~/.pi/agent/mcp-servers.json`** — your MCP server config. It names your
  servers, endpoints, and env wiring; it is *your* data, not setup boilerplate.
  mcp-bridge will simply find no servers until you write one. Shape:
  ```json
  {
    "mcpServers": {
      "my-server": {
        "command": "npx",
        "args": ["-y", "some-mcp-server"],
        "env": { "API_KEY": "..." }
      }
    }
  }
  ```
  Remote servers needing OAuth just need a `url` + optional `oauth` block; the
  bridge handles the browser PKCE flow and stores tokens in
  `~/.pi/agent/mcp-oauth.json` (mode 0600). See "Adding an HTTP-type MCP
  server" above and `skills/add-mcp-server/SKILL.md`.
- **Most TTSR rule content** — the rules here are the generic, shareable
  subset. Rules referencing my employer's infra, internal docs, or personal
  context files stay local in `~/.pi/agent/rules/`. Author your own; the
  `add-rule` skill walks you through it.
- **Project-local agents** (`.pi/agents/` in work repos) — those encode
  team/project-specific workflows; the six generic user-scope agents ship in
  `agents/`.
- **`auth.json`, `settings.json`, prompts, skills** — account/session state and
  personal tooling, not shareable setup.

## Optional bits to know

- **mcp-bridge auth hooks**: for servers whose name starts with `grafana-` or
  `redash-`, the bridge runs a pre-tool auth-check script, expecting it under
  `~/mcp-servers/` (override the directory with the `MCP_SERVERS_ROOT` env
  var). If you don't configure such servers, this never fires — harmless. See
  `AUTH_HOOKS` in `mcp-bridge/index.ts` to wire your own.
- **mcp-bridge Slack OAuth**: set your own app's client ID via
  `oauth.clientId` in `mcp-servers.json`; there is no built-in fallback.
- **web-search keys**: fully optional; without keys it falls back to free
  DuckDuckGo scraping + Jina Reader.

## Maintenance (repo owner)

After tweaking things live in `~/.pi/agent/`, pull them back into the repo,
review the README, then commit and push. See `AGENTS.md` for the complete
workflow:

```bash
./sync.sh
git status --short
git diff -- README.md
# Update README.md if it does not document the change.
git add README.md
# Stage only the other relevant files for this change.
git diff --cached --check
git commit -m "type(scope): describe the change"
git push origin "$(git branch --show-current)"
```

`sync.sh` mirrors the whole `extensions/` dir, refreshes the allowlisted
`themes/` and rules in the repo (their file lists are the allowlists —
private/work rules stay local), refreshes the shipped agent definitions, and
refreshes both skills.
`node_modules/`, lock files, and transient dotfiles are excluded on both
`install.sh` and `sync.sh`.

Note to self: keep this repo free of machine/employer-specific details —
server names, endpoints, internal doc names, and personal paths belong in
local config (`mcp-servers.json`, rules, agents), not in extension code.

# my-pi-setup

My [pi coding agent](https://github.com/earendil-works/pi-coding-agent) setup —
the extensions in `extensions/`, a pack of generic TTSR rules in `rules/`, and
an `add-rule` skill in `skills/` for authoring more. Clone this repo and run
`./install.sh` to get the same setup.

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
auto-discovers everything in `~/.pi/agent/extensions/`.

To uninstall an extension, delete its file (or directory) from
`~/.pi/agent/extensions/` and `/reload`.

## Extensions

### Single-file extensions (`~/.pi/agent/extensions/*.ts`)

| Extension | What it does |
|---|---|
| **web-search.ts** | Gives the LLM `web_search` + `web_fetch` tools. DuckDuckGo/Jina by default (no key needed); optionally set `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY` for better search. |
| **rewind.ts** | `/rewind` — Claude-Code-style checkpoints & rewind. Tracks every file the agent edits and snapshots state at each user prompt. |
| **handoff.ts** | `/handoff <task>` — instead of a lossy compact, extracts what matters and spawns a fresh focused session with a generated prompt. |
| **todo.ts** | `todo` tool + `/todos` command — todo state persisted in session entries, not files. |
| **summarize.ts** | `/summarize` — renders a session/conversation summary in the TUI. |
| **claude-compat.ts** | Makes pi discover Claude Code resources (`.claude/` contexts, skills, hooks) by walking cwd → root. |
| **custom-footer.ts** | Two-line status footer: cwd, git branch, tokens in/out, context %, cost, model. Toggle with `/footer`. |
| **model-status.ts** | Shows model changes in the status bar when switching via `/model` or Ctrl+P. |
| **confirm-destructive.ts** | Asks for confirmation before destructive session actions (`/clear`, switch, branch). |
| **permission-gate.ts** | Asks for confirmation before dangerous bash commands (`rm -rf`, `sudo`, `chmod 777`, …). |
| **dirty-repo-guard.ts** | Blocks session-clearing actions while the repo has uncommitted changes. |
| **cmux-session.ts** | Bridges pi into [cmux](https://github.com/earendil-works/cmux) (session lifecycle, telemetry, notifications). **Managed by cmux** — `cmux hooks pi install` writes/overwrites this file. Skip it if you don't use cmux. |

### Subdirectory extensions (own `package.json`, `npm install` runs in `install.sh`)

| Extension | What it does |
|---|---|
| **mcp-bridge/** | Adds MCP server support to pi: lazy-connects servers from `~/.pi/agent/mcp-servers.json`, registers their tools as `mcp__<server>__<tool>`, does OAuth 2.0 PKCE login for remote servers (Slack, Linear, …), strips sensitive env vars from child processes, and truncates oversized tool results. Config lives in `~/.pi/agent/mcp-servers.json` (see below). |
| **subagent/** | The `subagent` tool — delegate tasks to isolated `pi --mode json` child processes. Parallel task batches, sequential chains with a `{previous}` placeholder, per-agent tool allowlists, model-role aliases (`@smol`, `@slow`, …). Agents are defined as `.md` files in `~/.pi/agent/agents/`. |
| **ttsr/** | TTSR (Time-Traveling Stream Rules) engine — rules sit dormant with **zero token cost** until the model's live output matches a regex or [ast-grep](https://ast-grep.github.io/) pattern, then abort+remind or block/prepend. Manage with `/ttsr`; rules are `.md` files in `.pi/rules/` (project) or `~/.pi/agent/rules/` (user). See `extensions/ttsr/README.md`. |

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
- **Subagent definitions** (`~/.pi/agent/agents/*.md`) — same deal: the tool is
  here, the agents are yours.
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

After tweaking things live in `~/.pi/agent/`, pull them back into the repo and
push:

```bash
./sync.sh
git add -A && git commit -m "update extensions" && git push
```

`sync.sh` mirrors the whole `extensions/` dir, refreshes every rule listed in
`rules/` (the file list there is the allowlist — private/work rules stay
local), and refreshes both skills. `node_modules/`, lock files, and transient
dotfiles are excluded on both `install.sh` and `sync.sh`.

Note to self: keep this repo free of machine/employer-specific details —
server names, endpoints, internal doc names, and personal paths belong in
local config (`mcp-servers.json`, rules, agents), not in extension code.

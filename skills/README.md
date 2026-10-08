# Skills (`skills/`)

> The pi skills shipped by this repo — procedural playbooks the agent loads when the current task matches a skill's description.

## What skills are and how pi finds them

A skill is a directory containing a `SKILL.md`: YAML frontmatter (`name`, `description`) followed by the procedure body the agent reads and follows. The `description` is the routing surface — every shipped skill phrases it as what the skill does plus concrete trigger phrases ("Use when …").

Discovery, per this repo's own docs:

- **User scope** — `install.sh` copies `skills/` into `~/.pi/agent/skills/` (see [Installation](#installation)).
- **Claude compatibility** — the `claude-compat` extension makes pi discover Claude Code resources — including skills — by walking the cwd toward the filesystem root looking for `.claude/` trees.
- **Marketplaces** — the `plugins` extension (`/plugins`) installs skills from Claude Code plugin marketplaces; installed plugins load in place via `resources_discover` (state: `~/.pi/agent/plugins.json`, not synced).

A project-scope directory for skills is not documented in this repo's docs (project scope is documented for *agents*, `.pi/agents/`, not for skills).

## The skills

| Skill | Ships | What it does | Use when |
|---|---|---|---|
| `add-agent/` | `SKILL.md` | Creates a new pi-native subagent definition — an `.md` file in `~/.pi/agent/agents/` (user scope) or `.pi/agents/` (project scope) — with valid frontmatter and a task-appropriate model role, thinking level, and tool allowlist. | Asked to add, create, or define a new agent, subagent, or specialist. |
| `add-mcp-server/` | `SKILL.md` | Adds an MCP server to pi by editing `~/.pi/agent/mcp.json` — local `stdio` or remote `http` endpoints, OAuth sign-in, exposure settings, cookie-gate auth-hook prefixes, verification. | Asked to add/configure/register a new MCP server in pi. |
| `add-rule/` | `SKILL.md`, `scripts/validate-rule.js` | Authors a TTSR rule end to end: failure analysis, bucket decision tree, quality gates, trigger crafting, verify-gate adjudication, rule template, validation, rules-engine reload. | "Add a rule for X", "make a rule that the agent shouldn't do Y", "whenever I do Z, remind the agent to W". |
| `code-review/` | `SKILL.md` | Reviews a PR, branch, or working diff by spawning one read-only `reviewer` subagent (persistent, resumable on failure; Jev-based triage of the changed files inside the reviewer) and relaying its consolidated review verbatim. | Asked to review a PR or diff. |
| `orchestrate/` | `SKILL.md` | Orchestrates multi-step implementation via cascade routing: plans in the main session with `explorer` agents, persistent `writer` subagents (`@smol`) implement parallel frozen specs under `.pi/tasks/orchestrate-<topic>/`, persistent `verifier` subagents (`@slow`, xhigh) grade in steerable fix-loops (max 3), and a final integration verifier checks the whole diff. Jev (`ask_jev`) decides triage, BLOCKED routing, FAIL root-cause, and stalemate calls. | Multi-step features, ticket-driven bug fixes, or any plan-then-execute-then-verify work too complex for a direct edit. |

### add-agent

- Scope and naming: lowercase `a-z 0-9 -`, ≤64 chars; never collide with existing files or the shipped set (`explorer`, `research`, `writer`, `verifier`, `reviewer`, `task`); never overwrite without explicit confirmation.
- A task-profile table maps workloads to `@smol`/`@slow`/`@plan`/`@task`/`@designer` roles with matching thinking levels and tool allowlists. Roles resolve via `~/.pi/agent/settings.json`; if a role isn't configured, omit `model` and let the agent inherit the session model.
- RFC 2119 tool-allowlist rules: tool names MUST be discovered from the live toolset (session tools, extension-registered tools, `mcp__<server>__<tool>`) — never invented; read-only agents MUST NOT be granted `write`/`edit`; the allowlist SHOULD be the minimal sufficient set.
- Agents are discovered at session start: after writing the file, `/reload` and run a one-line test spawn to verify it boots.

### add-mcp-server

- No code change for most servers: pi's built-in MCP support reads `~/.pi/agent/mcp.json` at session start and connects each server (config edits need `/reload`).
- Covers the config shape for `stdio` and `http` types (legacy SSE is rejected); OAuth sign-in (`pi mcp login`, tokens cached in `~/.pi/agent/mcp-auth.json`, auto-refresh); `${VAR}`/`!command` secret interpolation; exposure settings (`direct` for skills that call `mcp__<server>__<tool>` directly); and the cookie-gate rule (servers named `grafana-*`/`redash-*` get a pre-call cookie check).
- Verify with `pi mcp list`, then `/reload` and `/mcp` in-session; tools register as `mcp__<server>__<tool>`.
- Pre-call cookie-SSO hooks: the `mcp-cookie-gate` extension, `../extensions/README.md#mcp-cookie-gate`.

### add-rule

- The bucket decision tree is the core: a regex/ast-grep trigger on the model's own output stream is the only case that justifies a rule file (TTSR); always-relevant invariants go to `AGENTS.md`/`CLAUDE.md` (the validator rejects them); rulebook is a last resort only.
- Five quality gates must all pass — prevents a real failure, reusable, non-obvious, actionable, worth the cost. Otherwise no rule is produced, and reporting which gate failed is the correct outcome.
- Trigger crafting: regexes anchored on specific identifiers, narrow over broad, never matching user input; ast-grep `astCondition` for structural code patterns.
- A Jev adjudication (`utils/jev-ask.mjs`) decides whether the rule needs an opt-in `verify:` gate. A malformed `verify:` is silently dropped by the engine, which is why validation is blocking: the rule must print `OK — rule is valid.` before it ships.
- Pairs with the TTSR engine: `../extensions/ttsr/README.md`.

### code-review

- The only skill whose frontmatter also carries `version`, `created`, and `updated` fields.
- Procedure: resolve the target (PR number/URL, branch, or the staged/unstaged working diff), spawn the `reviewer` as a **persistent** subagent (`delegate` single form, `mode: "persistent"`, named handle `reviewer`, `cwd` set to the repo, tools matching the reviewer's frontmatter: `read, bash, grep, find, ls, subagent, ask_jev_files, ask_jev_file_bool, ask_jev_file_score, pick_first_file, triage_log` — a stale override strips the Jev tools and silently disables triage), collect via `subagent_wait`, then relay the review verbatim — no re-summarizing, re-ranking, or added findings.
- Failure and retry contract: failures resume the retained `reviewer` session (`subagent_wait` auto-resumes an aborted run; `subagent_send` retries only a failed nested lens/validator in-session). Re-running the full review flow via a fresh spawn is the forbidden outcome — a fresh spawn is a last resort after 2 failed resume/steer attempts, and never a duplicate while a handle is live. Jev being unavailable (ask-jev tool errors) is not a failure — the reviewer degrades to heuristic routing per its own instructions and notes it in the opener.
- Fixes go to a writer/task agent, never the reviewer (read-only by design). Not for stack-specific review workflows.

### orchestrate

- All spawn doors are `delegate`; writer/verifier children are **persistent** with named handles (`orch-<topic>-t<n>-writer|verifier`) and fix iterations steer the same child via `subagent_send` — a fresh spawn happens only after a spec rewrite (`-r2` handles).
- Parallelization is planned, not incidental: the plan's `## Parallelization` section defines waves (≤8), and parallel specs own **disjoint file sets including test files** — shared-file ambiguity is a proven writer-race failure mode.
- Jev decision points are fixed: `ask_jev` triage (SIMPLE/MODERATE/COMPLEX), BLOCKED routing, FAIL root-cause (writer-fix vs spec-fix), and the 3-iteration stalemate call. Consequential calls still go to the user.
- Artifacts live in `.pi/tasks/orchestrate-<topic>/` (`input.md`, `plan.md`, `specs/T<n>.md`); resume reads the plan's `<!-- approved: yes -->` marker and `- [x]` checkboxes plus `subagent_list()`.
- Employer/PR glue is deliberately generic: the push/PR skill (e.g. `push-changes`) is read if configured, otherwise the repo's own contribution rules. Not for single-file edits, doc-only changes, or pure investigation.

## Shipped files

```
skills/
├── add-agent/SKILL.md
├── add-mcp-server/SKILL.md
├── add-rule/SKILL.md
├── add-rule/scripts/validate-rule.js
├── code-review/SKILL.md
└── orchestrate/SKILL.md
```

`scripts/validate-rule.js` runs under plain `node` (imports only `node:fs`/`node:path`) and validates a rule file before it is saved:

```
node scripts/validate-rule.js <rule.md> [--sample "text the model would emit"]
```

Checks: frontmatter parses with required fields; bucket policy enforcement (TTSR valid; always-apply → error; rulebook → error if it names a specific command/tool, warn otherwise); every `condition` regex compiles; with `--sample`, reports which conditions match and warns if none do; `astCondition` metavariable sanity; kebab-case name; scope values (`text`/`thinking`/`tool`); non-empty body. Exits non-zero on hard errors, zero with warnings, and prints `OK — rule is valid.` when clean.

## Installation

`install.sh` (step 5) creates `~/.pi/agent/skills/` and rsyncs this repo's `skills/` into it, excluding `node_modules`. The copy uses no `--delete`, so re-running never removes locally added files.

`sync.sh` mirrors live edits back into the repo; its skill step is a hardcoded file list covering `add-rule` (including the validator script), `add-agent`, `add-mcp-server`, `code-review`, and `orchestrate`. A new skill won't mirror back until its copy lines are added.

## Adding a new skill

1. Create `skills/<name>/SKILL.md` with frontmatter `name` and `description` (what it does + concrete trigger phrases — the description is what pi routes on), then the body. Follow the shape the shipped skills use: When to Use → Procedure → Pitfalls → Verification. `code-review/SKILL.md` shows the optional `version`/`created`/`updated` fields.
2. Put supporting scripts under `skills/<name>/scripts/` (see `add-rule/scripts/validate-rule.js`).
3. Run `./install.sh` to copy it into `~/.pi/agent/skills/`, then `/reload` in pi.
4. Add the file's copy lines to `sync.sh` so live edits mirror back, and add a row to the skills table in the root `README.md`.

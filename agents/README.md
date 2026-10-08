# Agents

Subagent definitions for the `subagent` extension. Each agent is a single
markdown file named `<name>.md`.

## Layout

```
~/.pi/agent/agents/
├── explorer.md             # fast read-only codebase recon, returns a compressed map (@smol)
├── research.md             # thorough investigation, returns a structured briefing (@smol)
├── writer.md               # code execution layer (@smol)
├── verifier.md             # quality gate verification (@slow)
├── reviewer.md             # backend code review orchestrator (@slow) — Jev-triages the diff, fans out to lens agents below
├── security-auditor.md     # dedicated security lens for reviewer fan-outs (@slow, high)
├── concurrency-auditor.md  # dedicated concurrency/state lens for reviewer fan-outs (@slow, high)
├── review-validator.md     # fact-checker for review findings — CONFIRM/DOWNGRADE/REFUTE (@slow, xhigh)
└── task.md                 # flexible multi-step worker with subagent tool (@task)
```

The three dedicated lens/validator agents are read-only (no `subagent` tool)
and are spawned by `reviewer` as depth-2 leaves; they also work standalone for
a single-lens pass on a diff.

## Jev in the agent stack

Every agent ships the full ask-jev toolset (`ask_jev`, `ask_jev_file_bool`,
`ask_jev_file_choice`, `ask_jev_file_score`, `ask_jev_files`, `pick_first_file`,
`triage_log` — see
[`../extensions/ask-jev/README.md`](../extensions/ask-jev/README.md)) so any
spawned child can buy cheap file judgments before spending context on reads. In
the review stack they act as a routing layer between diff gathering and the
expensive lens/validator passes:

- `reviewer` runs one `ask_jev_files` triage over the changed files — entry
  points, state writes, authz surface, irreversible external effects, per-file
  risk score — and uses the risk map to pick lenses, build each lens's
  deep-read priority list, name hot spots in the opener, and order the
  validator's findings list. Failing CI logs go through `triage_log` first.
- `security-auditor` and `concurrency-auditor` may run one targeting call to
  rank which changed files (and one-hop callers) deserve their deep reads
  first.
- `review-validator` may ask one-hop behavioral questions (e.g. "does the
  caller validate this before passing it in?") to decide how much surrounding
  code to read before ruling; pure existence checks stay grep-based.

Outside review, `explorer`, `research`, `writer`, `verifier`, and `task` use
them the same way: rank where to start in an unfamiliar tree, check an
assumption about a file before opening it, and triage large logs or command
output before pulling it into context.

The invariant that makes this safe (from a 59-verdict A/B test of Jev as a
sole verifier): **Jev answers only add scrutiny.** They order reads and
trigger lenses; they never skip a lens, never produce a verdict, and never
back a finding. Every finding and every verdict must cite a `file:line` the
agent actually read. A low-confidence or failed Jev answer defaults to the
more careful path; on ask-jev tool errors the reviewer degrades to heuristic
routing and says so in the opener.

## Fan-out failure handling

Lens failures follow a strict retry contract: only the failed or missing lenses
are re-spawned (same mandate), a leaf that fails twice is run by the reviewer
itself, and a failed validator is retried alone with the same findings list.
Completed lens results are never re-run; a deliberate second pass (e.g. over a
force-pushed head) starts fresh by design.

Project-local agents live in `.pi/agents/<name>.md` and override same-named
user agents when the tool is invoked with `agentScope: "both"` (or `"project"`).
Default scope is `"user"`.

## Agent file format

```markdown
---
name: my-agent
description: What this agent does and when to use it. Be specific.
tools: read, grep, find, ls, bash
model: "@smol"
thinking: medium
spawns: ["explorer", "research"]
output:
  properties:
    summary:
      type: string
---

System prompt for the agent goes here. The body (after the closing `---`)
becomes the spawned subprocess's appended system prompt.
```

### Frontmatter

| field | required | notes |
|---|---|---|
| `name` | yes | lowercase a-z 0-9 hyphens, max 64 chars |
| `description` | yes | what the agent does + when to use it, max 1024 chars |
| `tools` | no | comma-separated string or YAML list of tool names to allowlist. Can be overridden per-invocation. |
| `model` | no | Model role (`@smol`, `@slow`, `@plan`, `@task`, `@designer`) configured via `~/.pi/agent/settings.json`, or a direct `provider/model-id`. |
| `thinking` | no | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `auto` |
| `spawns` | no | Whitelist of child subagents allowed to be spawned (e.g. `["explorer", "research"]` or `"*"`). |
| `output` | no | JSON/JTD schema defining required structured output. Automatically injected into prompt and validated. |
| `timeoutMs` | no | Optional wall-clock limit in milliseconds or duration string (e.g. `120000`, `"2m"`). Omitted or `0` = infinite. |

## How it runs

The `subagent` tool spawns a separate `pi` subprocess per invocation with an
**isolated context window**. It passes:

- `--model <model>` (resolved from roles via `~/.pi/agent/settings.json`) and `--thinking <level>`
- `--tools <tools>` from frontmatter or call overrides
- `--append-system-prompt <tmpfile>` containing the AGENT.md body + schema instructions
- the task text as the prompt

The child's final assistant text is returned to the orchestrator. Output,
tool calls, usage, structured JSON data, and per-task results are preserved in the tool result
details (expand with Ctrl+O in the TUI).

# How the pieces fit together

pi loads six kinds of resources from `~/.pi/agent/`. This repo ships all six plus a shared `utils/`
directory they import.

```
pi
├── extensions/   TypeScript modules that add tools, commands, and lifecycle hooks
├── rules/        TTSR stream rules: prompts injected when a trigger matches model output
├── agents/       Subagent definitions (name, model role, tools, instructions)
├── skills/       Reusable procedures loaded on demand (SKILL.md)
├── themes/       UI themes
└── utils/        Shared helpers imported by extensions
```

## Extensions

An extension is a module pi loads at startup. It can register tools (`ask_jev`, `delegate`, `todo`),
slash commands (`/setup`, `/ttsr`, `/stats`), or hooks on the turn lifecycle (prompt construction,
tool results, turn end). Directory extensions own a `README.md`; single-file extensions have a
sibling `.md`.

The dependency direction is one-way: extensions import `utils/`, never the other way around.

## Rules (TTSR)

TTSR stands for Time-Traveling Stream Rules. A rule is a markdown file with frontmatter that decides
**when** to fire and what to inject:

```markdown
---
name: no-console-log
trigger: /\bconsole\.log\(/
---
Do not ship console.log in production code.
```

The engine watches the model output stream and the tool-call stream. When a trigger matches, the
rule body is injected as a reminder, and the model continues with it in context. Rules are cheap
when idle: a trigger that never matches costs nothing. `rules/` ships the generic subset; rules that
name internal services stay local.

## Agents and delegation

An agent file describes a subagent: which model role it uses, which tools it may call, and what it is
for. `extensions/delegate` is the single spawn door. It classifies each delegation and routes it to:

- the **one-shot engine** (`extensions/subagent`) — blocking child, exits after returning its result;
- the **persistent engine** (`extensions/persistent-subagent`) — retained session, steerable and
  resumable after it finishes.

Model roles (`@smol`, `@slow`, `@plan`, `@task`) are aliases resolved by `extensions/model-roles`.
They keep agent definitions independent of specific model IDs.

## Skills

A skill is a procedure the model can load when a task matches its description. Unlike a rule, it is
not injected automatically; the model reads `SKILL.md` on demand. `skills/add-rule` and
`skills/add-agent` are meta-skills: they describe how to author the other resources.

## The Jev layer

Jev is a small classifier model used for judgment calls that do not need the main model: ranking log
lines, triaging test output, reviewing a diff, deciding whether a delegation is revisitable.
`utils/jev-client.ts` is the shared client; the `jev` tier contains everything built on it.

Without `JEV_API_KEY`, those extensions are inert. They do not break the rest of the harness — the
`core` tier never calls Jev.

## Observability

`extensions/observatory` reads pi's local session and decision logs and serves a dashboard. It is
read-only over `~/.pi/agent`, so it can only show data your machine already produced.

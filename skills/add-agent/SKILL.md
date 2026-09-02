---
name: add-agent
description: Create a new pi-native subagent definition — an .md file in ~/.pi/agent/agents/ (user scope) or .pi/agents/ (project scope) with valid frontmatter and a task-appropriate model role (@smol, @slow, @plan, @task, @designer). Analyzes the agent's intended task to pick model, thinking level, and tool allowlist. Use when asked to add, create, or define a new agent, subagent, or specialist — not for marketplace plugin agents.
---

# Add a pi agent

## When to Use

The user wants a new pi subagent — a reusable specialist the orchestrator can spawn via the `subagent` tool. Not for Claude-plugin agents (that's the `/plugins` extension).

## Procedure

1. **Scope** — user-global `~/.pi/agent/agents/<name>.md` (default) vs project `.pi/agents/<name>.md` (repo-specific, needs `agentScope: "both"`). Ask only if genuinely ambiguous; repo-specific specialists go project-local.
2. **Name** — lowercase `a-z 0-9 -`, ≤64 chars. `ls` the target dir first; never collide with existing files or the shipped set (`explorer`, `research`, `writer`, `verifier`, `reviewer`, `task`). Never overwrite an existing agent without explicit confirmation.
3. **Task analysis** — classify the agent's job against the model-role table below. Prefer the cheapest role that does the job reliably; pin `thinking: high`/`xhigh` only for genuine reasoning gates (cost scales with it).
4. **Description** — one paragraph: what the agent does + when to use it, with concrete trigger phrases ("use for X", "when the user asks Y"). ≤1024 chars. This is what the orchestrator routes on — vague descriptions produce never-invoked agents.
5. **Body** — the agent's system prompt. The spawned child sees ONLY this body plus the task text, so it must be self-contained: role, procedure, constraints, and the expected output format (end with what to return, e.g. "Return your findings as a structured summary.").
6. **Optional fields** — `spawns` (child-agent whitelist, or `"*"`), `output` (JTD schema for structured output), `timeoutMs` (bounded tasks).
7. **Write the file**, then verify (below). Tell the user to `/reload` to make it invocable in the current session (agents are discovered at session start).

## Model-role selection

Roles resolve via `~/.pi/agent/settings.json` (`smolModel` / `slowModel` / `planModel` / `taskModel` / `designerModel`). Check the key exists before pinning; if the role isn't configured, omit `model` entirely and let the agent inherit the session model.

| Task profile | model | thinking | tools |
|---|---|---|---|
| Fast read-only recon — locate definitions, call sites, file structure ("where is X?") | `@smol` | `low` | `read, grep, find, ls` |
| Code execution from a frozen, fully-decided spec — typing, scaffolding, fix-application | `@smol` | `medium` | `read, bash, edit, write, grep, find, ls` |
| Reasoning gate — verification, code review, deep root-cause analysis; read-mostly | `@slow` | `xhigh` | `read, bash, grep, find, ls` |
| Planning / spec authoring / architecture decisions | `@plan` | `high` | `read, grep, find, ls` |
| Flexible multi-step worker that may fan out to children | `@task` | `medium` | `read, bash, edit, write, grep, find, ls, subagent` + `spawns: "*"` |
| Design/UI-adjacent general work | `@designer` | `medium` | per task |
| Ambiguous or mixed workload | *(omit — inherit session default)* | — | minimal sufficient set |

Tool rules: read-only agents never get `write`/`edit`; add `bash` only when the task runs commands; a missing tool silently caps the agent, an extra one expands its privilege — pick the minimal sufficient set.

## Template

```markdown
---
name: <name>
description: <what it does + when to use it, with trigger phrases>
tools: <comma-separated allowlist>
model: "@<role>"
thinking: <level>
---

<system prompt: role, procedure, constraints, output format.
End with what the agent must return.>
```

## Pitfalls

- Don't reuse shipped agent names — the first-loaded file wins and routing gets confusing.
- Don't pin a model role that isn't in `settings.json` — the spawn fails or silently inherits.
- A `tools` allowlist that omits a needed tool fails mid-task with permission errors, not at spawn time.
- The body is the whole system prompt — references to "the conversation above" or orchestrator context don't exist for the child.

## Verification

- Frontmatter parses and has `name` + `description`; name matches `^[a-z0-9-]{1,64}$`.
- `ls` the target dir shows exactly the new file.
- After `/reload` (or next session), the agent appears in the `subagent` tool's available set — do a one-line test spawn to confirm it boots and returns.

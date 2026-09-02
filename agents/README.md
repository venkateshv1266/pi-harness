# Agents

Subagent definitions for the `subagent` extension. Each agent is a single
markdown file named `<name>.md`.

## Layout

```
~/.pi/agent/agents/
├── explorer.md    # fast read-only codebase recon, returns a compressed map (@smol)
├── research.md    # thorough investigation, returns a structured briefing (@smol)
├── writer.md      # code execution layer (@smol)
├── verifier.md    # quality gate verification (@slow)
├── reviewer.md    # backend code review orchestrator (@slow)
└── task.md        # flexible multi-step worker with subagent tool (@task)
```

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

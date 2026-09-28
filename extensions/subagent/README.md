# subagent

> The one-shot subagent engine — spawns an isolated `pi --mode json` child
> process per delegated task and returns the child's output when it exits.

## What it does

Registers the `subagent` tool, which runs tasks on specialized agents defined
as markdown files (see Configuration). Each invocation spawns an isolated
`pi --mode json -p --no-session` child, blocks until the child exits, and
returns its final output. Three call shapes are supported — a single task, a
parallel batch (max 8, rendered as one grouped widget), and a sequential
chain — selected with exactly one of `agent`+`task`, `tasks`, or `chain`.

This is the one-shot engine behind [delegate](../delegate/README.md): raw
`subagent` calls are hidden in root sessions in favor of `delegate`, which
routes between this engine and the persistent engine
([persistent-subagent](../persistent-subagent/README.md)). Call `subagent`
directly only when one-shot semantics are wanted deliberately — the child
exits after the call and cannot be revisited.

## Commands and tools

| Command / tool | What it does |
|---|---|
| `subagent` | Run one, a parallel batch (max 8), or a chain of agents; blocks until all children exit. |

## Configuration

### Agent definitions

Flat markdown files. Only `.md` files (or symlinks) are loaded; files missing
`name` or `description` frontmatter are skipped.

- `~/.pi/agent/agents/<name>.md` — user scope, always loaded.
- `.pi/agents/<name>.md` and `.claude/agents/<name>.md` (Claude Code
  compatibility) — project scope, found by walking up from the cwd; loaded
  only when `agentScope` is `"project"` or `"both"`. With `"both"`, project
  definitions win name collisions.

| Frontmatter key | Required | Effect |
|---|---|---|
| `name` | yes | Agent identifier used as the `agent` parameter. |
| `description` | yes | What the agent does and when to use it; embedded in the tool-description roster. |
| `tools` | no | Tool allowlist for the child: comma-separated string or YAML list. Overridable per call. |
| `model` | no | Provider model ID or role alias (`@smol`, `@slow`, `@plan`, `@task`, `@designer`). |
| `thinking` (alias `thinkingLevel`) | no | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`. |
| `spawns` | no | List of allowed downstream agent names or `*`; parsed but not enforced by this engine. |
| `output` | no | JSON schema/JTD; appended to the agent's system prompt, and the final response is parsed against it. |
| `timeoutMs` (alias `timeout`) | no | Wall-clock limit (`300000`, `"5m"`, `"60s"`); omit or `0` = no limit. |

### Model role aliases

Role aliases are resolved (via `utils/model-role.ts`) from env and
`~/.pi/agent/settings.json`, first match wins; unresolved roles fall back to
`PI_MODEL`, then the `defaultModel` setting. A `model` value without `@` is
passed through as a literal model ID.

| Alias | Resolution order |
|---|---|
| `@smol` / `@fast` | `PI_SMOL_MODEL` → `PI_FAST_MODEL` → `smolModel` / `fastModel` / `modelRoles.smol` |
| `@slow` / `@reasoning` | `PI_SLOW_MODEL` → `PI_REASONING_MODEL` → `slowModel` / `reasoningModel` / `modelRoles.slow` |
| `@plan` | `PI_PLAN_MODEL` → `PI_SLOW_MODEL` → `planModel` / `slowModel` / `modelRoles.plan` |
| `@task` | `PI_TASK_MODEL` → `taskModel` / `modelRoles.task` |
| `@designer` | `PI_DESIGNER_MODEL` → `designerModel` / `modelRoles.designer` |
| any other `@role` | `PI_MODEL` → `defaultModel` |

### Environment

The extension reads no settings keys directly. Children inherit the parent
environment plus `PI_SUBAGENT_CHILD=1` and `CMUX_PI_HOOKS_DISABLED=1`
(internal markers, not user configuration). `PI_SUBAGENT_CHILD` is what keeps
the raw spawn tools available inside children so nested fan-out works;
`DELEGATE_RAW_TOOLS=1` in a root session disables the hiding of `subagent` /
`subagent_spawn` entirely (both implemented by
[delegate](../delegate/README.md)).

## How it works

**Child invocation.** `getPiInvocation` decides how to spawn: if the running
entry point is a real `.js`/`.mjs`/`.cjs` file (and not a bundled virtual
path), it re-execs that file with the current node/bun binary; if the runtime
is `node`/`bun`, it falls back to `pi` from `PATH`; otherwise it spawns
`process.execPath` with the args. The child runs with `--model`, `--thinking`,
and `--tools` (comma-joined allowlist) as configured. The agent's system
prompt is written to a temp file (mode `0o600`, deleted after the run) and
passed via `--append-system-prompt`; the task is sent as the final
`Task: <task>` argument. `cwd` defaults to the session cwd.

**Mode dispatch.** Exactly one shape per call — mixing them (or providing
none) returns an error listing the available agents. With `agentScope:
"project"` or `"both"`, project-local agents trigger an interactive
confirmation before running (`confirmProjectAgents`, default `true`).

- **Parallel** — up to 8 tasks launched concurrently, streamed as one grouped
  widget (`Parallel batch: X/N done`) and summarized as
  `Parallel: S/N succeeded` with per-task `### [agent] completed|failed`
  sections. Duplicate agent names get an index suffix (`agent-2`).
- **Chain** — steps run sequentially; every `{previous}` occurrence in a step
  task is replaced with the prior step's final output (truncated to 50 KB).
  The chain stops at the first failed step (`Chain stopped at step N (agent):
  …`); otherwise the last step's output is the call result.
- **Single** — returns the child's final assistant message.

A result is failed when the exit code is non-zero, the stop reason is `error`
or `aborted`, or the run timed out; failures surface as tool errors carrying
the child's error message or stderr.

**Timeouts and aborts.** The watchdog is disabled by default (`timeoutMs: 0`).
On expiry the child gets `SIGTERM`, then `SIGKILL` after 3 s. An abort signal
kills the child the same way (5 s before `SIGKILL`).

**Streaming and accounting.** The child's JSON event stream is parsed to
collect messages, cumulative usage (input/output, cache read/write, cost,
context tokens, turns), and stop reasons. A model reported by the child
overrides the requested one, since the model router may reroute after spawn.
`subagent` calls made by children are captured and rendered as nested rows in
the parent's widget.

**Structured output.** With an `output` schema, the final text is parsed
(whole-text JSON → fenced `json` block → first `{` to last `}`); the parsed
value lands in `structuredData`, a failure in `schemaError`.

**Per-task output cap.** Outputs interpolated into chain `{previous}` and
embedded in parallel summaries are truncated to 50 KB with an omission
notice; single-mode results are returned untruncated.

**TUI.** `render.ts` (with the vendored `tui.ts`, `symbols.ts`, and
`render-utils.ts` primitives) renders the call and results as a rounded,
state-colored framed block with tree rows — per-agent status (`○` pending,
`◐` running, `✔` completed, `✘` failed, `▪` aborted), task previews, usage
and cost — drawn flush via `renderShell: "self"` so the block supplies its
own border.

## Caveats

- Exactly one call shape per call; `tasks` and `chain` must be real JSON
  arrays of objects, never stringified.
- More than 8 `tasks` is rejected with an error (the persistent route in
  `delegate` silently keeps the first 8 instead).
- A structured-output extraction failure (`schemaError`) is reported but does
  not by itself fail the task.
- Agents are re-discovered on every call, but the roster embedded in the tool
  description is computed once when the extension loads.
- The per-call `tools` override only takes effect when non-empty; an empty
  array is rejected by the schema (`minItems: 1`).
- The project-agent confirmation is skipped in non-interactive sessions
  (`hasUI` false), where project agents run without prompting.

# delegate

> The unified entry point for spawning subagents — one tool that routes
> automatically between the one-shot engine (blocking, child exits after
> returning its result) and the persistent engine (retained, steerable,
> resumable sessions).

## What it does

Registers the `delegate` tool, which is the only spawn door the model sees in a
root session. Each call is routed to one of two engines:

- **One-shot** (`extensions/subagent/index.ts`): spawns an isolated
  `pi --mode json -p --no-session` child per task; the call blocks until the
  child exits with its result.
- **Persistent** (`extensions/persistent-subagent/index.ts`): spawns
  `pi --mode rpc` children with sessions retained for the lifetime of the root
  session; results can be collected or the children steered after the spawn
  call returns (via `subagent_send` / `subagent_wait` / `subagent_list`).

With `mode: "auto"` (the default) a Jev classifier decides the route by
whether the delegated work will plausibly be revisited — writer/verifier fix
loops, iteration, mid-flight steering, or tasks whose context must survive for
follow-up — versus self-contained single-consumption work. Every decision is
appended to `~/.pi/agent/jev-decisions/subagent-router.jsonl` for auditing.

## Commands and tools

| Command / tool | What it does |
|---|---|
| `delegate` | Spawn one, a parallel batch (max 8), or a sequential chain of subagents; routes between engines. |
| `subagent` / `subagent_spawn` | The raw engine tools. Hidden from the model in root sessions (see How it works); children keep them for nested fan-out. |

## Call shapes

Exactly one shape per call — `agent`+`task`, `tasks`, or `chain`. Mixing them
(or providing none) returns an error listing the available agents.

| Shape | Form | Engine |
|---|---|---|
| Single | `{ agent, task, name?, cwd?, tools?, model?, timeoutMs?, wait? }` | Either |
| Parallel | `{ tasks: [{ agent, task, name?, cwd?, tools?, model?, timeoutMs?, wait? }, ...] }` — max 8; always use this instead of multiple separate calls for concurrent work | Either |
| Chain | `{ chain: [{ agent, task }, { agent, task: "... {previous}" }, ...] }` — `{previous}` is replaced with the prior step's output | One-shot only |

Batch limit: more than 8 `tasks` is rejected with an error by the one-shot
engine; the persistent route silently keeps only the first 8.

## Parameters

| Param | Default | Effect |
|---|---|---|
| `mode` | `"auto"` | `"oneshot"` forces the blocking engine; `"persistent"` forces a retained child (single or batch only — `chain` + `"persistent"` is an error). |
| `agent` / `task` | — | Single-form target and prompt. |
| `tasks` | — | Array of task objects for a parallel batch. Must be a real array of objects. |
| `chain` | — | Array of steps for a sequential pipeline. Always one-shot. |
| `name` | auto-generated | Persistent handle name (top level and per `tasks` item). Pattern: `[a-zA-Z0-9][a-zA-Z0-9_-]*`; sanitized from the agent name and de-duplicated with a `-N` suffix when omitted. |
| `tools` | agent frontmatter | Non-empty allowlist of tool names for this invocation, overriding the agent definition's `tools` frontmatter. Omit to use the declared tools. Acceptable at the top level and per `tasks`/`chain` item. An empty array is rejected by the schema (`minItems: 1`). |
| `model` | agent frontmatter | Model ID or role alias (`@smol`, `@slow`, `@task`, `@plan`). |
| `agentScope` | `"user"` | `"project"` or `"both"` also load project-local agents from `.pi/agents/` (and `.claude/agents/` for compatibility) walking up from the cwd. |
| `confirmProjectAgents` | `true` | Prompt before running project-local agents (one-shot engine, interactive sessions only). |
| `cwd` | session cwd | Working directory for the child process (top level for single form; per item for `tasks`/`chain`). |
| `timeoutMs` | `0` (no limit) | Wall-clock limit for one-shot children (agent frontmatter `timeoutMs` also applies). Not used by the persistent engine. |
| `wait` | `true` | Persistent engine only: block until children settle and return results in the same call. `false` returns handles immediately for mid-flight steering — collect later with `subagent_wait`. Chain steps have no `wait`. |

## How it works

Routing (`decideRoute`), in order:

1. Explicit `mode: "oneshot"` / `"persistent"` wins.
2. `chain` shape always routes one-shot.
3. `DELEGATE_JEV=0` routes one-shot and marks the decision degraded.
4. Otherwise one Jev classifier call (task previews truncated to 800 chars,
   bounded by `DELEGATE_CLASSIFY_TIMEOUT_MS`): probability ≥
   `DELEGATE_PERSIST_THRESHOLD` routes persistent, otherwise one-shot. If the
   classifier is unavailable or returns no probability, the call degrades to
   one-shot.

The classifier question mirrors the persistent-subagent TTSR rule's verify
question so both layers agree on what "will be revisited" means.

Raw spawn tools (`subagent`, `subagent_spawn`) are removed from the active
tool set on `session_start` and `before_agent_start` unless the process is
itself a child (`PI_SUBAGENT_CHILD=1`, set by both engines) or
`DELEGATE_RAW_TOOLS=1` disables hiding. The steering tools (`subagent_send`,
`subagent_wait`, `subagent_list`) are never hidden.

Persistent children are spawned with `PI_SUBAGENT_CHILD=1` and retained
sessions scoped to the root session. Waiting on an aborted child via
`subagent_wait` auto-resumes it; wait timeouts on `subagent_send` /
`subagent_wait` default to 10 minutes.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `DELEGATE_PERSIST_THRESHOLD` | `0.7` | Classifier probability at or above which `auto` routes persistent. Clamped to [0, 1]. |
| `DELEGATE_CLASSIFY_TIMEOUT_MS` | `2500` | Budget for the routing classifier call (minimum 500). |
| `DELEGATE_JEV` | unset | `0` disables the classifier; all `auto` calls route one-shot and are logged as degraded. |
| `DELEGATE_RAW_TOOLS` | unset | `1` disables hiding of `subagent` / `subagent_spawn` in root sessions. |
| `PI_SUBAGENT_CHILD` | unset | Set to `1` by both engines in child processes; children keep the raw spawn tools for nested fan-out. |

## Caveats

- Exactly one call shape per call; `tasks` and `chain` must be real JSON
  arrays of objects, never stringified.
- Chains cannot be persistent; `mode: "persistent"` with `chain` errors.
- The routing decision log (`~/.pi/agent/jev-decisions/subagent-router.jsonl`)
  records route id, session, requested vs. decided mode, reason, probability,
  confidence, threshold, latency, degraded flag, shape, agents, task count,
  and a 140-char preview of the first task.
- When routed persistent without an explicit `name`, handles are allocated
  against live children in the session scope; collisions get a `-N` suffix.
- The one-shot engine rejects batches larger than 8; the persistent route
  truncates to the first 8 without an error.

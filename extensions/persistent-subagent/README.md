# Persistent subagents

Named, steering-able, resumable child sessions — the persistent engine behind
the `delegate` spawn door.

## What it does

Registers four tools — `subagent_spawn`, `subagent_send`, `subagent_wait`,
`subagent_list` — for child agents that outlive a single tool call. Where the
one-shot `subagent` tool ([../subagent/README.md](../subagent/README.md))
spawns `pi --mode json -p --no-session` and blocks until exit, children here
run as long-lived `pi --mode rpc` processes with a dedicated `--session-dir`
per name. They can be steered mid-flight, given follow-up turns in their
retained sessions, and their sessions survive parent restarts and idle
unload.
[delegate](../delegate/README.md) routes spawns to this engine automatically;
call `subagent_spawn` directly only when persistent semantics are wanted
deliberately.

## Commands and tools

| Tool | What it does |
|---|---|
| `subagent_spawn` | Spawn named children — a single `agent`+`task`+`name` or a concurrent `tasks` batch — and block until they settle, returning all results in the same call. `wait:false` returns handles (a spawn receipt) immediately for mid-flight steering. |
| `subagent_send` | Message a named child: steer it between tool calls mid-run, queue a follow-up, or start a new turn when idle. An unloaded child is transparently resumed from disk with full context. `wait:true` blocks for the final output. |
| `subagent_wait` | Block until a named child settles and return its final assistant output. Auto-resumes an aborted child; an idle child returns its last settled output; a dead process's last output is read from its session file on disk. |
| `subagent_list` | Roster of the current root session's children: name, agent, status (running/idle/stopped), idle age, model, cost. |

### `subagent_spawn`

Exactly one form per call — a `tasks` batch or a single `agent`+`task`+`name`.
Batch entries accept the same optional `cwd`, `tools`, `model`, `wait` fields
as the single form.

| Param | Default | Effect |
|---|---|---|
| `name` | required | Persistent handle. Pattern `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}`. |
| `tools` | agent frontmatter | Tool allowlist override for this invocation. |
| `model` | agent frontmatter | Model ID or role alias (`@smol`, `@slow`, `@task`, `@plan`). |
| `wait` | `true` | Block until every waited child settles and return outputs inline; `false` returns the receipt at once. |
| `agentScope` | `"user"` | Which agent directories resolve names: `user`, `project`, or `both`. |

Validation is all-or-nothing: an invalid name, an already-live name, or an
unknown agent aborts the whole call before anything spawns. If a child fails
to admit its task (no RPC ack within 15 s), the entire batch is killed. With
`wait:true` the call streams `N/M done` progress and returns each child's
output under a `## name` heading, splitting a 40,000-char budget evenly
across the waited children; a truncated child stays unmarked so
`subagent_wait` still delivers its full text. Parent abort (Esc) stops the children's current runs gracefully —
sessions are retained and waiting again resumes them.

### `subagent_send`

| Param | Default | Effect |
|---|---|---|
| `name`, `message` | required | Target handle and the message. |
| `behavior` | `"auto"` | `auto` steers if the child is mid-run, else starts a new turn. `steer` delivers between tool calls of the current run; `followUp` queues until it finishes; `prompt` forces a new turn. |
| `wait` | `false` | `true` blocks until the child settles and returns its final output. |
| `timeoutMs` | `600000` | Wait timeout; `0` waits forever. |
| `cwd` | parent cwd | Used when resuming a stopped child. |

If the name is not live, the registry is consulted; an unknown name errors
with the known names. Resume respawns the child with `--continue` on its
session dir, the model from the registry entry, and the agent definition
re-resolved with scope `both` (a missing definition falls back to a stub so
the session still resumes). Never use this merely to retrieve a finished
child's output — `subagent_wait` reads the already-settled result for free,
while `subagent_send` costs a new agent turn.

### `subagent_wait`

| Param | Default | Effect |
|---|---|---|
| `name` | required | Target handle. |
| `timeoutMs` | `600000` | `0` waits forever; on timeout the child keeps running. |

A child aborted before producing any output is auto-resumed with a
continuation prompt ("You were interrupted mid-task. Continue from exactly
where you left off and complete the task.") and the call blocks until it
finishes. Full output is delivered at most once per run; repeat requests for
the same run get a one-line pointer instead. If the process is gone, the last
assistant message is read from the newest `.jsonl` file in the child's session
dir; if none exists, the result points at `subagent_send` to resume.

## Configuration

No settings keys and no user-facing env vars — all thresholds are hardcoded
constants in `index.ts`:

| Constant | Value |
|---|---|
| Idle unload | 30 min (reaper checks every 60 s) |
| Default wait timeout | 10 min (`0` = forever) |
| RPC command ack timeout | 15 s |
| Max batch size | 8 |
| Batch result budget | 40,000 chars, split evenly |
| stderr tail kept per child | 4,000 chars |
| SIGKILL after SIGTERM | 3 s |

Children inherit the parent environment plus `CMUX_PI_HOOKS_DISABLED=1` and
`PI_SUBAGENT_CHILD=1` (internal; not user configuration).

State lives under `~/.pi/agent/subagents/`, scoped per root session:

```
~/.pi/agent/subagents/<scope-hash>/
  registry.json        # name, agent, sessionDir, spawnedAt, lastActiveAt, model, modelRole
  sessions/<name>/     # the child's pi session JSONL files, plus .system-prompt.md
```

`<scope-hash>` is the first 16 hex chars of the SHA-256 of the root session
key: `file:<session-file-path>`, or `id:<session-id>` when no session file
exists. `registry.json` is written atomically (temp file + rename).
`.system-prompt.md` (mode 0600) is written on fresh spawn only and passed via
`--append-system-prompt`, with the agent's output-schema prompt appended when
one is defined.

## How it works

**Blocking vs handles.** By default `subagent_spawn` keeps the tool call open
until every waited child settles — the turn cannot end before results exist.
Children run concurrently; live partial frames show the whole batch with
per-row spinners. `wait:false` returns a spawn receipt (name, agent, one-line
brief, session dir, pid) immediately; the hint line on the receipt points at
`subagent_wait` for collection and `subagent_send` for steering.

**Child process.** Each child is spawned as
`pi --mode rpc --session-dir <dir> --name <name> [--continue] [--model M] [--thinking T] [--tools a,b]`.
`--thinking` and the system-prompt file are only applied on a fresh spawn; a
resumed child already carries them in its session. The child's reported model
wins over the configured one, since the router may reroute after spawn.

**Idle unload and resume.** A background reaper SIGTERMs non-streaming
children whose `lastActiveAt` (set at spawn, updated when a run settles) is
older than 30 minutes, escalating to SIGKILL after 3 s. The next
`subagent_send` transparently respawns the child from disk with `--continue`
— full retained context, no re-read from scratch.

**Root-session scoping.** The registry and live children are keyed by the root
session's scope hash. Different root sessions get different directories and
cannot see or message each other's children.

**Parent lifecycle.** Interactive sessions and `--mode rpc` parents keep their
children until `session_shutdown` (graceful SIGTERM → SIGKILL) or the idle
reap. Print-like parents (`-p` / `--print`) run once and exit, so their
children are killed at `agent_settled`; the on-disk sessions stay resumable. A
`process.on("exit")` hook SIGTERMs any remaining live children as a backstop.

**Module state.** Lifecycle state (live children, reaper timer) is a
`Symbol.for` process-global singleton: the extension loader evaluates modules
without a module cache, so the double import via delegate would otherwise
create a second, invisible state.

**Shared code.** Agent discovery, TUI rendering, and the `pi` invocation
helper are reused from [../subagent/README.md](../subagent/README.md). This
module exports `executePersistentSpawn`, `isNameLive`, and `resolveScopeKey`
for the delegate router ([../delegate/README.md](../delegate/README.md)),
which is the unified spawn entry point routing between the one-shot and
persistent engines.

## Caveats

- Names are scoped to the root session and cannot be reused while a child of
  that name is live.
- A resumed child whose agent definition no longer exists still runs, but with
  an empty system prompt.
- `subagent_send` on a settled child starts a new agent turn (billable); use
  `subagent_wait` for free retrieval of an already-settled output.
- Full output is delivered once per run; re-requesting it returns only a
  pointer with the output's length.
- A child that crashes mid-run fails its waiters with the retained stderr tail
  in the error message.
- A timed-out wait leaves the child running; wait again or steer it instead.
- The idle reaper only unloads non-streaming children — a child hung mid-run
  is never auto-killed.

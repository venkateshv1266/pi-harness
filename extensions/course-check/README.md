# course-check

> Periodic Jev supervision — every N turn ends, hand Jev the session goal plus a digest of recent activity and ask: is the agent on a path that plausibly reaches the goal? Off-track verdicts inject a visible course-correction message telling the agent to rethink its approach.

## What it does

Every `intervalTurns` completed turns (default 10), the extension builds a one-line-per-message digest of recent activity and sends it to Jev (System One) alongside the session goal — the curator's goal pin or GoalSpec, falling back to the user's first prompt — with two questions:

1. **course** — `on_track` / `off_track` / `goal_unclear` / `goal_moved` / `goal_met` / `blocked`: is the trajectory plausibly reaching the goal? Judged on direction, not effort: a productive dead end that was abandoned is on track; repeated failing approaches, scope drift, tangents, or work past completion are not. `goal_moved` fires when the user's own recent messages redefine the objective, leaving the goal state stale — not agent drift.
2. **failure** — the dominant failure mode (`scope_drift` / `rabbit_hole` / `tangents` / `wrong_solution` / `goal_met_overrun`), used to word the nudge.

Nudge verdicts (`off_track`, `goal_unclear`, `goal_moved`, `goal_met`) with probability ≥ `threshold` inject a visible `custom_message` that tells the agent to rethink: restate what the goal requires, name where the current work diverged, pick the next action closest to the goal. `goal_unclear` nudges instruct the agent to sharpen the goal state via `pin_goal`/`amend_goalspec` or ask the user instead of guessing; `goal_moved` nudges tell the agent the user redefined the objective and to re-pin the goal state via `pin_goal`/`amend_goalspec` rather than steering back toward the old objective; `goal_met` nudges tell it to verify and report instead of continuing. A second consecutive off-track verdict escalates to a mandatory 3-line reassessment. `on_track` and `blocked` verdicts stay silent — a blocked agent is not a deviating one.

At most one nudge is ever live in context: each new nudge retires the previous via a `context_edit`, and a recovering trajectory retires the stale one, so old "off-track" text never lingers and never accumulates.

## Commands and tools

| Command / tool | What it does |
|---|---|
| `/course-check` | Status: enabled, interval, threshold, timeout, last check, consecutive nudges, breaker state. |
| `/course-check on\|off` | Toggle via `settings.json` `courseCheck.enabled`; applies from the next check. |
| `/course-check now` | Arm a one-shot check at the next turn end, regardless of interval. |

## Configuration

Persisted to `settings.json` `courseCheck` (see `/setup` → Course check); env vars override for one-off runs, `COURSE_CHECK=0` is a hard kill switch.

| Key | Env var | Default | Effect |
|---|---|---|---|
| `enabled` | `COURSE_CHECK` | `true` | Master switch; `0` kills, `1` forces on. |
| `intervalTurns` | `COURSE_CHECK_INTERVAL` | `10` | Check at every Nth completed turn end (clamped 1–100). |
| `threshold` | `COURSE_CHECK_THRESHOLD` | `0.7` | Minimum probability for a nudge verdict to fire (clamped 0.5–0.95). |
| `timeoutMs` | `COURSE_CHECK_TIMEOUT_MS` | `6000` | Jev call timeout inside the turn boundary (clamped 1–30 s). |
| `digestEntries` | `COURSE_CHECK_DIGEST_ENTRIES` | `60` | Max digest lines handed to Jev. |
| `digestCapChars` | `COURSE_CHECK_CAP` | `6000` | Max digest chars, kept from the tail. |

## How it works

Hooks `turn_end` (async). Skips print mode — `pi -p` prints only the last session message, so an appended nudge would displace the output; subagent children run in print mode and are therefore never supervised, only the main session is. Aborted/error turns are skipped. The handler composes boundary drafts: `{ entries: [...event.entries, ...drafts] }`.

Goal source, in order: latest `jev-curator-goal` pin → `jev-curator-goalspec` (objective + success criteria + plan) → first user prompt. Reads session entries, never the curator extension, so it works with the curator disabled.

Digest: user messages (200 chars), assistant text (400) plus `call: tool(input)` lines, tool results (120, `ok`/`err`). The check's own nudges are excluded, so Jev never judges its own messages as agent activity. Secrets are scrubbed before the call (same patterns as model-router).

Safety: a Jev failure never breaks the turn; 3 consecutive failures open a 30-minute breaker so turn boundaries stop stalling on a dead endpoint. All failures log events.

Telemetry (shared contract, `~/.pi/agent/jev-decisions/course-check.jsonl`, auto-discovered by `/decisions-report`):

- Nudge → `decision` (`turn`, `verdict`, `p`, `why`, `consecutive`, `session`); the next check resolves it — `recovered` (good) / `still_off_track` (bad) / `blocked` (unknown), with a `userSteered` flag when the user sent a correction in between.
- Non-nudging checks → `event` records; Jev failures → `jev_unreachable` / `breaker_open` events.

Pure logic lives in `state.ts` and is unit-tested without a live session: `node --test extensions/course-check/state.test.ts`.

## Caveats

- The check stalls the turn boundary for up to `timeoutMs` every N turns; keep `intervalTurns` reasonable in long sessions.
- Interval checks fire on turn-index multiples; a rewound-and-replayed turn is not re-checked (same index, same turn).
- `consecutive nudges` escalation and pending-outcome state are in-memory; they reset on restart or rewind.
- Without any goal material (no pin, no GoalSpec, no user prompt) the check no-ops silently.

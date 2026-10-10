# recite

> Tail recitation — after every completed turn, re-emit a compact session-state block at the tail of model context so the current goal, plan, and todo list always sit at the most-attended position.

## What it does

After each turn, `recite` appends a deterministic block starting with `SESSION STATE (reference only — continue the task; do not restate this block)` as a hidden custom message: objective, goal refinements, plan, open questions, todo list, success criteria, and constraints. The previous copy is omitted from model context via a context edit, so exactly one block is ever live. State is read from session entries — the curator's GoalSpec and `todo` tool results — so the reciter runs independently of other extensions: with the curator disabled (`JEVCURATOR=0`), the objective falls back to the first user request and the todo list still recites.

## Commands and tools

| Command / tool | What it does |
|---|---|
| `/recite` | Show recitation status (enabled, char budget, size of the last live block) and a preview of the next block, or `next block: none (no goal or todo state yet)`. |

## Configuration

No `settings.json` keys. State lives entirely in session entries; nothing is written outside the session file.

| Env var | Default | Effect |
|---|---|---|
| `RECITE` | unset (enabled) | Set to `0` to disable the recitation; `/recite` then reports that it is disabled. |
| `RECITE_CHARS` | `1200` | Char budget for the block (~300 tokens). Values outside `400`–`8000` (or non-numeric) fall back to `1200`. |

## How it works

Hooks `turn_end`. The handler skips when `RECITE=0`, when the turn outcome is not `completed`, and in print mode — `pi -p` prints only the last session message, so an appended recitation would displace the assistant reply and `pi -p` would output nothing.

All state readers are pure functions over the session branch (`ctx.sessionManager.getBranch()`):

- Latest `custom` entry of type `jev-curator-goalspec`, flushed by the curator (`../jev-context-curator/`), supplies the objective, refinements, criteria, constraints, plan, and open questions. Malformed entries are ignored.
- Latest `toolResult` of the `todo` tool supplies the live todo list.
- With no GoalSpec on the branch, the objective falls back to the first non-empty user message — a stable anchor that cannot drift as the conversation moves.

Sections are composed in a fixed priority order, whole items first, until the char budget is spent — a long constraints list can never crowd out the objective. A section that does not fit is dropped; capped lists get a `(+N more)` marker when the marker itself fits.

| Section | Source | Cap |
|---|---|---|
| `OBJECTIVE` | GoalSpec `userObjective` (the distilled digest when the curator distills the seed), else first user message | 1 item, 320 chars |
| `GOAL` | last 2 objective refinements | 200 chars/item |
| `PLAN` | first 6 plan steps (`p1.`, `p2.`, …) | 140 chars/item |
| `OPEN` | first 4 open questions (`q1.`, …) | 140 chars/item |
| `TODO` | `n/m done` + up to 6 pending items (`#<id>`, text clipped to 100 chars) | 120 chars/item |
| `CRITERIA` | first 4 success criteria (`c1.`, …) | 140 chars/item |
| `CONSTRAINTS` | first 4 constraints (`k1.`, …) | 140 chars/item |

When nothing fits, no block is emitted at all.

One copy live: on each emission, if a previous recitation exists on the branch, a `context_edit` draft replaces it with `null` (omitted from model context) before the fresh `custom_message` (`customType: "recite"`, `display: false`) is appended. Re-emitting every turn is what keeps the block at the tail.

Composition with other `turn_end` extensions: the handler returns `{ entries: [...event.entries, ...drafts] }`, preserving boundary drafts returned by earlier handlers — boundary entries compose by replacement. The curator is the GoalSpec producer and also emits boundary drafts on `turn_end`.

Composition is pure and unit-tested without a live session: `node --test extensions/recite/compose.test.ts`.

## Caveats

- `RECITE_CHARS` outside `400`–`8000` is silently ignored; the default `1200` applies.
- Print mode never emits the block — deliberate, to keep `pi -p` output intact.
- With no objective or todo state on the branch, the reciter no-ops; no empty block is written.
- The GoalSpec entry shape is a persisted contract with the curator; recite reads entries, not the extension, so it never needs the curator loaded.
- If the session branch cannot be read, the hook no-ops and `/recite` reports `Session branch unreadable.`

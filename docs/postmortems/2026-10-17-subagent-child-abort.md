# Postmortem: TTSR rules aborted spawned subagents mid-task — stuck with no work

- **Date:** 2026-10-17
- **Scope:** `extensions/ttsr` (engine + context registry), `extensions/subagent`, `~/.pi/contexts/registry.yaml` (live-only config, not synced)
- **Status:** all fixes applied and verified; see [Verification](#verification).

## Preface

TTSR is a stream-rule engine: rules sit dormant until the model's live output
matches a regex, then abort+remind (text/thinking scope) or block+prepend
(tool scope). Subagent children (`pi --mode json -p` one-shot, `pi --mode rpc`
persistent) are full pi processes, so they load every extension — including
TTSR — with the same rule set as the root session.

The problem this note solves: a delegation could spawn, then die with zero
work done, surfacing to the parent as `Subagent was aborted` — twice in a row
in the reporting session (2026-10-16, defi-service session `01a14693`). The
parent re-read the pushed context doc and re-delegated, losing the work again.

## TL;DR

- **Children self-aborted on root-coaching rules:** the text/thinking rule
  `delegate-read-only-exploration` (`interrupt: true`, no Jev verify) matches
  an explorer child's literal job announcement ("I'll explore the repo…"). The
  engine had no child awareness, so it aborted the child's run mid-task; a
  one-shot child exits with nothing. **Fixed** by skipping text/thinking
  enforcement when `PI_SUBAGENT_CHILD=1`. Tool-scope rules still apply in
  children — a blocked call carries its reason and the child can adapt, unlike
  an aborted run.
- **A post-hoc context push caused re-delegation churn:** the registry entry
  `subagent-patterns` (gate: none) fired a non-blocking push on every
  session's first `delegate` call — attached to the *finished* delegation's
  result — so the parent read the doc and re-did the delegation. **Fixed** by
  making the entry delegate-seeding-only: entries with `subagents: true` and
  no `triggers:` now synthesize only the pre-spawn `ctxdelegate-` gate (which
  Jev had correctly suppressed in all 30 historical adjudications).
- **Abort errors were opaque:** the one-shot engine threw a hardcoded
  `Subagent was aborted`, discarding the watchdog's timeout reason.
  **Fixed** by throwing `currentResult.abortReason`.
- **Minor:** removed dead `toolBufs` stream buffering (written, never read)
  and fixed latent strict-mode type errors that surfaced when the touched
  files were first typechecked.

## Body

### 1. Children self-aborted on root-session coaching rules

Evidence timeline (session `01a14693`, all times UTC):

- 21:19:54 — root thinking matches `delegate-read-only-exploration`
  ("The rule says: read-only repo exploration belongs in a subagent"),
  aborts the inline survey, calls `delegate` (explorer, one-shot). Correct
  root-session behavior.
- 21:25:20 — delegate result: the `ctx-subagent-patterns` reminder plus
  exactly `Subagent was aborted`. Zero child output.
- 21:25:33 / 21:25:46 — parent reads `~/.pi/contexts/subagent-patterns.md`
  (following the reminder).
- 21:26:32 — parent re-delegates.
- 21:27:31 — result: `Subagent was aborted` again.
- 21:27:41 — root: "The delegate was aborted again with no visible reason";
  user: "looks like it stuck again?"

Mechanism: both spawn engines (`extensions/subagent/index.ts`,
`extensions/persistent-subagent/index.ts`) already set `PI_SUBAGENT_CHILD=1`
in the child env — `extensions/delegate/index.ts` consults it to keep raw
spawn tools unhidden in children — but the TTSR engine never did. Inside the
child, the first thinking delta ("I'll explore the repo…") matched the rule,
`ctx.abort()` ended the child's only run, and the abort+follow-up delivery
(`deliverAfterAbort`) has nothing to deliver to in print mode. The engine
threw `Subagent was aborted`; the parent saw an opaque failure with no work.

**Fix** (`extensions/ttsr/index.ts`): the `message_update` handler returns
early when `PI_SUBAGENT_CHILD=1`. Both abort paths (immediate and
Jev-verified-batch) live behind that handler, so children can never be
mid-run aborted by a rule. Tool-scope handling is unchanged.

### 2. Post-hoc context push made parents re-do finished delegations

The registry entry `subagent-patterns` triggered on `^(delegate|subagent_spawn)$`
with `gate: mode: none`, so a non-blocking push ("Read subagent-patterns.md
before proceeding") attached to the delegate tool *result* — after the
delegation had already run. Parents dutifully read the doc and then re-did
the just-finished delegation. The pre-spawn variant (`ctxdelegate-`, Jev
gate ≥ 0.85, `onFail: suppress`) is the right mechanism and had suppressed
all 30 adjudications (probs 0.22–0.39 — the delegated tasks were
self-contained lookups that did not need the doc).

**Fix** (`extensions/ttsr/registry.ts`): `synthesizeRules` now accepts
delegate-seeding-only entries — `subagents: true` with no `triggers:`
synthesizes only the `ctxdelegate-` spawn gate, no inline push rule. The
live `~/.pi/contexts/registry.yaml` entry for `subagent-patterns` dropped
its `triggers:` block (that file is personal config and is not synced).

### 3. Opaque abort errors

`extensions/subagent/index.ts` ended execution with
`throw new Error("Subagent was aborted")` while `currentResult.abortReason`
held the actual cause (e.g. `Subagent timed out after Nms` from the
watchdog). The thrown message is what the parent model sees.

**Fix:** `throw new Error(currentResult.abortReason ?? "Subagent was aborted")`.

### 4. Dead code and latent strict-mode type errors

`toolBufs` buffered `toolcall_delta` events but was never read — removed.
The first strict typecheck of the touched files surfaced two latent errors at
the nested-results stash (`msg.details` is a `JsonValue` union; property
access on it fails strict mode) — fixed with a typed local + cast.

## Verification

- `extensions/ttsr/index.test.ts` (new): a fake-pi harness reproduces the
  incident mechanism deterministically. Root mode aborts on a thinking match
  (the engine's intended root behavior); child mode does not; tool-scope
  blocking holds in both modes. Before the guard it failed with
  `child: thinking match must not abort the run (got 1)`; it passes after.
- `extensions/ttsr/registry.test.ts`: extended with a delegate-seeding-only
  fixture entry (no `ctx-` push rule; `ctxdelegate-` gate survives) and a
  no-triggers/no-subagents entry (synthesizes nothing). 6 rules / 7 entries.
- Strict typecheck (scratch tsconfig per the verify-pi-extension-edits
  skill, paths mapped to the global pi install) exits 0 across all touched
  files.
- Both suites green live and in the repo mirror after `./sync.sh`
  (`npm install` + `npm test` in `extensions/ttsr`).

## Open questions

- Persistent (`--mode rpc`) children could in principle benefit from *some*
  text-scope reminders delivered as non-blocking follow-ups; the guard skips
  text/thinking entirely for uniformity. Revisit only if a concrete need
  appears.

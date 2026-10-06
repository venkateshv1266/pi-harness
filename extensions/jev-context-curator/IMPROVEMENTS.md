# Jev Context Curator — Improvement Plan

Working record of the curator improvement program: what was measured, what is
being built, and how each change is proven. Companion to
[`README.md`](README.md) (operating manual) and
[`jev-curator-v3-architecture.md`](jev-curator-v3-architecture.md) (session
flow). Status legend: **BUILT** — implemented in this change set; *PLANNED* —
designed, next change sets.

## Why these improvements — Jev's identity

Jev is a cheap System One attention router: ~0.5s and ~$0.00002 per call,
calibrated probabilities, many structured questions per request, fail-open.
It narrows haystacks; it does not conclude — frontier models own conclusions.
Five design corollaries follow, and the curator's gaps are exactly where it
violates them:

| Corollary | Gap found |
|---|---|
| Attention is **dynamic** — verdicts re-route when the goal moves | `shadowJudged` is permanent per context lifetime; a spec change invalidates nothing |
| Coverage should be **exhaustive** — cheap calls justify indexing everything | `curator_find` searches only condensed sources; caps and retained sources are invisible to semantic search |
| Jev **prepares**, frontier **concludes** | the verifier sees one holistic question it answers poorly; 77% of proposals get vetoed with concrete-loss reasons — proposal quality, not the gate, is the bottleneck |
| Cheap ≠ **free** — wall-clock matters at a boundary pi awaits | 2 parallel Jev HTTP calls per candidate; failed calls burn full timeouts; scoring only runs at the boundary |
| Every logged outcome is **calibration data** | recall regret, veto reasons, and approval rates are logged but never read back |

## Measured baseline (from `~/.pi/agent/jev-decisions/jev-curator*.jsonl`)

- **Emission is a quality lever, not a cost lever.** Each mid-session
  `context_edit` re-bills the post-edit prefix (13–24k tokens ≈ $0.055/emit);
  a controlled benchmark showed a cost wash at session scale. Optimize
  emission for quality and cache timing, never for raw char savings.
- **The verifier veto is information.** 77% of non-active proposals are
  vetoed; 76% of veto reasons cite concrete loss (dropped names, ids, facts).
  The proposal builder, not the gate, is the quality bottleneck.
- **Boundary latency is real.** Turn-end gaps of 6–18s: per-candidate Jev
  calls with 8s timeouts, line scoring at 25s, one frontier call per verifier
  batch (70% of batches contain a single candidate), and degraded Jev calls
  pay the full timeout with no verdict.
- **Jev cannot approve a *holistic* verify question.** A/B (59 paired
  verdicts): 78% agreement with the frontier, but Jev approved only 3 frontier
  vetoes (all low-confidence, indistinguishable from genuine holds) and
  over-retained 10/10 frontier approvals. As a drop-in replacement for the
  frontier question, Jev fails. **That is a protocol failure, not a capability
  verdict** — see Tier 2a.

---

## Tier 1 — Close the real gaps ¹ **BUILT**

### 1a. Overflow queue (was: silent drop)
Candidates beyond `SHADOW_MAX_PER_TURN` were marked `shadowJudged` at
collection and logged `skipped-over-limit` — never classified again until
compaction. Big turns systematically lost their largest results. **Fix:** a
bounded FIFO overflow queue (cap `JEVCURATOR_OVERFLOW_CAP`, default 50);
each boundary classifies this turn's candidates first, then drains the queue
into remaining capacity.

### 1b. Re-classification on GoalSpec version bumps (dynamic attention)
`set_plan`, resolved questions, and new criteria change the relevance oracle,
but every prior verdict stayed frozen. **Fix:** each registry entry records
the `specVersion` it was judged against; at every boundary, retained sources
judged against an older spec are re-judged (bounded:
`JEVCURATOR_RECLASS_PER_TURN`, default 5, oldest first). Curation becomes a
loop keyed to the live goal instead of a one-shot compression. Already
condensed sources are *not* re-judged (one-way edits stay; recall covers
restoration).

### 1c. Merged Jev calls + degraded-call circuit breaker
`shadowClassify` fired two parallel HTTP calls (role samples; shape+links) —
merged into one multi-question request (the native systemone shape). A
circuit breaker (`JEVCURATOR_JEV_BREAKER`, default 2 consecutive failures)
stops paying serial timeouts once Jev is down: the rest of the boundary fails
open immediately, one `jev-breaker-open` line is logged, and the breaker
resets to probe once at the next boundary.

## Tier 2 — Proposal quality and the verification protocol ² **BUILT**

### 2a. Jev fact-decomposed verification (repair-first)
The old A/B gave Jev the frontier's holistic question — the one thing System
One models are worst at. The new protocol uses Jev the way it is strong: many
narrow, calibrated, evidence-in-context questions.

1. **Coverage check.** For each proposal, the line scorer already knows every
   goal-relevant raw line (score ≥ 0.5) and which survived into the extract.
   One Jev call asks per dropped line: *"is this line's goal-relevant
   information preserved in the replacement shown?"* (noul, 1=preserved,
   0=lost).
2. **Repair before verdict.** Lines scoring < `JEVCURATOR_COV_MIN` (0.5) are
   added back as deterministic lines and the extract re-rendered within
   `JEVCURATOR_REPAIR_SLACK`× budget (1.5). A repaired extract that fits is
   approved with method `…+repair` — the veto becomes a fix.
3. **Verdict.** No loss lines → `useExtract`. Cards: role-gated
   (`irrelevant`→`indexOnly`; `background` needs p ≥
   `JEVCURATOR_CARD_BG_PROB`, 0.8). Scoring-degraded or head-tail-fallback
   proposals are **not** Jev-approvable — they escalate or retain.
4. **Escalation (`JEVCURATOR_VERIFIER=hybrid`, default).** Repair failures
   and degraded checks escalate to the frontier verifier *for that item
   only* — one frontier call per boundary at most. `frontier` restores the
   old behavior; `jev` runs Jev-only (fail-safe: uncertain → retainFull).
5. **Continuous A/B, not belief.** `JEVCURATOR_VERIFIER_SHADOW_PCT` (0.15)
   of Jev-**approved** decisions are also sent to the frontier in the same
   call and logged as `verifier-ab` lines — agreement is measured every
   session, not assumed from one 59-sample test. Recall-regret telemetry
   (Tier 5a, partially built) is the ground-truth backstop.

### 2b. Supersession detection
Stale same-path reads — the biggest bloat source per the V2 analysis — were
each re-judged in isolation and usually kept. **Fix:** new reads register
their path; a retained older read of the same path is re-judged with an
explicit hint ("a newer read of this file is in context at turn N"). Bounded:
`JEVCURATOR_SUPERSEDE_MAX` (5) per turn.

### 2c. Per-method stats + regret calibration
`/curator` now shows per-proposal-method approved/proposed (where do
proposals fail?), verifier mode, and repair/escalation tallies. Every
`jev_recall` of a condensed source increments a session regret counter, and
the verifier's state carries a conservatism note when regret is non-zero —
the first closed feedback loop in the system.

## Tier 3 — Recovery coverage (the no-opaque-loss contract, completed) ³ **BUILT**

### 3a. Source registry: index everything
Previously only condensed sources (the ledger) were searchable; capped and
retained-full sources had no semantic handle. **Fix:** a registry of *every*
classified source (role, type, links, verdict, path, spec version) plus every
cap-at-rest event, persisted as a `jev-curator-registry` custom entry
(union-hydrated, in-memory cap `JEVCURATOR_REGISTRY_CAP`, 150).

### 3b. `curator_find` over the whole registry
Search now ranks ledger extracts (recoverable, extract shown) *and* registry
cards for retained/capped sources (labeled "in context in full" / "capped —
page the raw"). Lexical prefilter → Jev rerank, lexical fail-open.

### 3c. Compaction carries the full source index
The quality-mode compaction prompt gains a `## SOURCE INDEX` section:
one-line cards for every registry entry not in the evidence ledger, so
post-compaction turns still know what exists and how to page it back.

### 3d. Recall ergonomics + right-sizing
- `jev_recall` gains `lines` paging (`"120-180"`, `"42"`, `"12,40-44"`) — the
  coordinate system extracts already cite.
- A full-raw recall of a >25k source re-injects bulk that was exempt from
  curation forever; recall results are now eligible for **cap-at-rest only**
  (head+tail with a paging hint). Role-based curation still never touches
  them — the measured no-churn property is preserved.

## Tier 4 — Emission economics *PLANNED*

- **Concentrate cache resets:** hold verifier-approved edits and emit at
  natural invalidation points (compaction, model switch) or above a combined
  savings floor — the proven V2 batch lesson applied to V3.
- **Coordinate with `cache_warming_decision`:** after an emit, warm the *new*
  prefix at idle so the next user turn pays cache-read, not full input.

## Tier 5 — Measurement and the oracle itself *PLANNED* (5a partially built)

- **5a. Regret loop (partial):** recall-of-condensed-source counting and the
  verifier conservatism note are built; per-method regret-rate dashboards and
  gate auto-tuning are next.
- **5b. Offline extract eval:** replay logged decisions, `jev_score` each
  extract against its raw for fact preservation, track per-method drift —
  the continuous version of the one-off benchmark, on real sessions.
- **5c. GoalSpec hygiene:** periodic cheap Jev audit of the spec (satisfied
  criteria, stale plan steps, drift), proposing amendments to the model —
  never auto-writing.

## Learned negatives — do not re-litigate

1. **Jev cannot answer the frontier's holistic verify question** — proven.
   The new protocol changes the question class, and stays measured via
   shadow A/B; if `verifier-ab` agreement on *approvals* regresses, flip
   `JEVCURATOR_VERIFIER` back to `frontier` and the loss-prevention gate is
   exactly as before.
2. **Emission does not pay for itself in tokens** — proven. Emit for quality
   and at cache-smart moments only.
3. **Naive re-curation of recall results breaks the no-churn property** —
   measured good behavior must be preserved (cap-at-rest only, bounded).

## New configuration

| Knob | Default | Effect |
|---|---|---|
| `JEVCURATOR_VERIFIER` | `hybrid` | `hybrid` = Jev protocol + frontier escalation on uncertainty; `jev` = Jev-only (uncertain → retainFull); `frontier` = pre-change behavior. `/setup`-persisted. |
| `JEVCURATOR_COV_MIN` | `0.5` | Coverage score below this = lost line (repair or escalate) |
| `JEVCURATOR_CARD_BG_PROB` | `0.8` | Role-probability gate for Jev-approving background cards |
| `JEVCURATOR_VERIFY_MAX_LINES` | `30` | Dropped relevant lines checked per source |
| `JEVCURATOR_REPAIR_SLACK` | `1.5` | Repair re-render budget multiplier |
| `JEVCURATOR_VERIFIER_SHADOW_PCT` | `0.15` | Jev-approved decisions also frontier-checked (logged only, ≤2/boundary) |
| `JEVCURATOR_JEV_BREAKER` | `2` | Consecutive Jev failures before the boundary stops calling Jev |
| `JEVCURATOR_RECLASS_PER_TURN` | `5` | Retained sources re-judged per spec bump |
| `JEVCURATOR_SUPERSEDE_MAX` | `5` | Stale same-path reads re-judged per turn |
| `JEVCURATOR_OVERFLOW_CAP` | `50` | Overflow queue bound |
| `JEVCURATOR_REGISTRY_CAP` | `150` | Source-registry in-memory bound |

## How the loop closes

Every decision already lands in `jev-curator.jsonl`. The new telemetry makes
the system self-measuring: `jev-verify` lines carry per-line coverage,
`…+repair` methods carry what was added back, `verifier-ab` lines carry
frontier agreement on Jev approvals, and recalls of condensed sources carry
regret. The acceptance question for this change set is not "does it save
tokens" (Tier 4 will handle timing) but: **does verifier approval rate rise
without a regret or agreement regression** — and every number needed to
answer it is now logged per session.

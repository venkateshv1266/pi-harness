# Jev Context Curator V3 — Goal-Quality-First Context Management

## Redefined objective

> Maximize the probability that the frontier model completes the user's
> **current overall goal** correctly. Cost, cache efficiency, and latency are
> secondary. Context should contain the evidence needed to satisfy the goal,
> not merely fewer tokens.

This explicitly rejects V2's implicit optimization target: reducing billed
context tokens. The ct01/ct02 benchmarks showed why: on GLM/OpenRouter,
cache-read is cheap and `context_edit` can re-bill an expensive suffix. A
cheaper transcript was not necessarily a better transcript.

The V3 curator is therefore a **goal-specific evidence manager**, not a token
trimmer.

---

## What the benchmarks proved — and did not prove

| Proven | Not proven |
|---|---|
| V2 is safe on the tested tasks: no verified correctness loss, raw history/recall work, cap-at-rest works. | V2 improves task quality. All benchmark arms passed; token and wall differences were mostly model-path variance + cache economics. |
| Middle-band output exists: 106–111k chars/run stayed in `keep` because it was plausibly useful. | A head/tail excerpt is sufficient evidence for every such result. |
| Raw log/query bulk can dominate a session. | Cost saving is the right reason to remove it. |

The central V3 question is not “can this be removed?” It is:

> **Which exact facts, code, constraints, failures, and decisions from this
> source could still change whether the current goal is completed correctly?**

---

## Non-negotiable quality contract

1. **The user goal is authoritative.** Derived understanding may refine it but
   must never silently replace it.
2. **No opaque loss.** Every non-full replacement has a source id, evidence
   rationale, and raw recovery path.
3. **Uncertainty preserves evidence.** False removal is worse than bloat. If
   either evaluator is unsure, retain the full result.
4. **Relevant means actionable.** Keep information that can affect an
   acceptance criterion, constraint, pending decision, active edit, test,
   hypothesis, or open question — not information that merely shares keywords.
5. **Raw history remains the source of truth.** Model-visible context is a
   working set; raw session entries are never deleted.

This cannot promise literal “100%” correctness — no lossy selection system can
— but it makes the failure mode explicit, conservative, auditable, and
reversible.

---

# V3 architecture

## 1. Replace the one-line goal with a canonical `GoalSpec`

Current `pin_goal` is a useful seed but not enough to judge relevance. V3
stores a versioned, structured session intent:

```ts
interface GoalSpec {
  userObjective: string;       // immutable unless user changes it
  successCriteria: string[];   // tests, report facts, behavior, acceptance
  constraints: string[];       // no hardcode, prod read-only, scope limits
  currentPlan: string[];       // next active steps/hypotheses
  knownFacts: EvidenceRef[];   // confirmed facts with source ids
  openQuestions: string[];     // questions still blocking completion
  version: number;
}
```

### Writers

- **User / `/goal`**: sets or corrects `userObjective` directly.
- **Frontier goal updater**: after a user prompt or material discovery (ticket,
  spec, incident source), updates *derived* fields only: criteria, constraints,
  plan, facts, questions.
- **Main model `pin_goal`**: proposes a refinement; the updater preserves the
  original objective and records it as a derived update.

The updater uses a frontier model — same quality tier as the main task model,
not Jev. Cost is accepted because goal quality is the primary requirement.

The result is visible via `/goal`; users can inspect the complete `GoalSpec`,
not only a sentence.

## 2. Classify evidence by its goal role, not by a generic keep/stub score

Jev remains the fast System One classifier, but its output becomes typed:

```ts
kind:
  | "active"       // directly needed for current plan / active edit / test
  | "evidence"     // contains specific facts needed for a criterion/question
  | "background"   // useful provenance, no immediate action
  | "irrelevant";  // cannot affect GoalSpec under high confidence

relevantSpans: LineRange[];   // for logs/text, or symbol/range candidates
linksTo: string[];            // GoalSpec criterion / fact / open question ids
confidence: number;
reason: string;
```

This changes the action vocabulary:

| Jev role | Model-visible representation | Raw retained? |
|---|---|---|
| `active` | Full verbatim output | Yes |
| `evidence` | Goal-relevant extract with citations | Yes |
| `background` | Source-card / evidence index entry | Yes |
| `irrelevant` | Omitted from working context, source-card remains | Yes |

`irrelevant` requires extremely high confidence (e.g. ≥0.95). Every other
class keeps either full evidence or a cited extract.

## 3. Type-aware evidence extraction — no generic head/tail as the primary path

A generic head/tail excerpt is a fallback only. Quality extraction depends on
what the source is:

### Logs / Loki query results

Use Jev line scoring/map-reduce (the existing `jev_triage_log` pattern):

- top goal-relevant lines
- neighboring stack/context lines
- exact timestamps, requestIds, error signatures, counts
- original line numbers / source query

The result becomes an evidence block such as:

```text
Source: Loki query #17 (service, fixed window)
Supports: open-question/rate-limit-root-cause
Key evidence:
  L128: 429 rateLimitProcessor ... requestId=...
  L194: same signature, username=...
  L252: prior-window count=...
Raw: curator_find / jev_recall source-17
```

### Code reads

Keep symbols and line ranges tied to the current plan, active edit, test
failure, or constraint — not arbitrary first/last lines:

```text
Source: lib/dedupe.ts
Supports: criterion/held-out-dataset-correctness
Evidence: dedupeKey (L8–10) uses depositId without epoch
Raw: read source at offsets / curator_find source-04
```

### Search / grep / directory listings

Keep query, matched paths, count, and the specific matches used by the plan.
Do not retain every non-match or unrelated path.

### Tickets / specs / docs

Extract acceptance criteria, constraints, API contracts, and explicit
non-goals into `GoalSpec`; retain citation/source links.

## 4. Frontier quality gate before every destructive replacement

Jev proposes a class/extract. A **frontier verifier** then approves any
full→non-full transition in one batched call at `turn_end`.

It sees:

```text
GoalSpec
current plan + open questions
candidate source metadata
Jev classification + proposed extract
raw candidate excerpt/spans
```

It returns only:

```ts
"retainFull" | "useExtract" | "indexOnly"
```

Verifier instruction:

> Would replacing this full source plausibly remove information needed to
> satisfy a success criterion, constraint, active plan step, or open question?
> If uncertain, retain full. Verify the proposed extract contains every
> goal-relevant claim from the candidate.

This is intentionally expensive. Jev does broad cheap classification; the
frontier model is the quality gate. Batching makes one verifier request cover
all candidates from a turn.

## 5. Evidence ledger and semantic retrieval, not entry-id recall alone

Current `jev_recall(entry_id)` assumes the main model already knows which
omitted source it needs. V3 adds:

```text
curator_find(query, limit?)
```

It searches the source/evidence ledger, asks Jev to rerank candidates against
the current GoalSpec and query, then returns:

- matching source cards
- relevant extracts
- raw source ids / offsets for paging

Example:

```text
curator_find("where did we establish rateLimitProcessor is the source of 429s")
```

This gives the model a recovery path even when it does not remember an entry
id or know that a source was condensed.

`jev_recall` remains the exact raw/paged recovery tool.

## 6. Context lifecycle

```text
Tool result arrives
  ↓
Cap-at-rest if extremely large (raw preserved; free before first exposure)
  ↓
Jev classifies role + candidate evidence spans against GoalSpec
  ↓
Frontier batch verifier approves retainFull / useExtract / indexOnly
  ↓
Append ContextEditEntry + EvidenceLedgerEntry at turn boundary
  ↓
On GoalSpec change: re-rank background evidence against the new plan
  ↓
On compaction: feed GoalSpec + evidence ledger into compaction instructions
```

The curator should not optimize for prefix-cache cost in this mode. It batches
edits only for operational sanity; quality governs the decision.

---

# Quality-oriented defaults

```text
mode: quality
cap-at-rest: 15–25k chars (experiment; raw always recoverable)
Jev irrelevant threshold: ≥0.95 + high confidence
Jev evidence extraction threshold: ≥0.70
frontier verifier: required for every full→non-full transition
uncertain decision: retainFull
context pressure: increases urgency, never lowers the quality gate
```

The existing cache-cost data is still recorded, but it is telemetry — not a
reason to retain known-irrelevant material.

---

# Why this differs from V2/V3-economy

| Topic | V2 / economy approach | V3 quality approach |
|---|---|---|
| Objective | Fewer billed tokens | Better goal completion evidence |
| Primary actor | Jev alone | Jev proposes; frontier verifier approves |
| Middle output | Generic head/tail | Type-aware, goal-cited extraction |
| Uncertainty | Threshold/cost tradeoff | Retain full |
| Recovery | Entry-id recall | Semantic `curator_find` + paged recall |
| Goal | One sentence | Versioned GoalSpec with criteria/constraints/questions |
| Compaction | Separate pi feature | Consumes GoalSpec + evidence ledger |

---

# Correct benchmark for V3

Do **not** judge V3 by cost or wall time first. Judge it by goal-evidence
quality.

## Benchmark design

1. A task with early, middle, and late evidence — code, long logs, ticket/spec.
2. Plant multiple critical facts in different source positions.
3. Add goal drift midway (user adds a constraint or ticket acceptance criterion).
4. Force a late decision that requires *all* critical facts.
5. Verify:
   - final implementation/report correctness
   - each critical fact cited or used correctly
   - goal changes reflected in GoalSpec
   - no irrelevant bulk survives unless verifier justified it
   - `curator_find` recovers a condensed source when asked

Metrics:

```text
primary: task correctness / evidence-recall / constraint compliance
secondary: false-removal count / recovery success / goal-spec correctness
tertiary: cost / tokens / latency
```

---

# Delivery phases

## Phase 1 — shadow quality mode

Build GoalSpec, ledger, Jev classification, and frontier verification, but do
not issue context edits. Log “would retain/extract/index” decisions and have a
human inspect 20–30 examples.

**Exit criterion:** zero unacceptable would-remove decisions in review.

## Phase 2 — evidence mode for logs and lists

Activate only log line extraction and listing/search source cards. Add
`curator_find`; retain full code/doc reads.

**Exit criterion:** evidence-recall benchmark passes; recovery tool used
correctly.

## Phase 3 — code/doc extraction + compaction integration

Activate frontier-approved code-symbol/doc-criterion extracts. Make pi
compaction consume GoalSpec + ledger.

**Exit criterion:** quality benchmark beats or matches uncurated arm on every
held-out task before broad activation.

---

# Decision

Keep the current curator as a tested cap/recall foundation. Do not keep tuning
it as a micro-dollar optimizer. Build V3 as the quality-first system above, in
shadow mode first.

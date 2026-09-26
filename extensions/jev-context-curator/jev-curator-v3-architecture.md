# Jev Context Curator — Architecture & Session Flow (V3)

How the curator behaves inside a pi session — the mode ladder, the per-turn
pipeline, the context view over time, GoalSpec, recovery, and compaction.
Implementation: `index.ts` next to this file.

## 1. The modes (one env var selects everything)

```
JEVCURATOR_MODE unset (default)  → quality — the full V3 system (see below)
JEVCURATOR=0                     → curator fully inert (kill switch, any mode)
JEVCURATOR_MODE=v2              → pre-V3 economics layer alone (benchmark arm)
JEVCURATOR_MODE=shadow-quality  → V3 classifies/proposes/verifies and LOGS only
JEVCURATOR_MODE=evidence         → V3 EMITS for log|listing on top of the V2 floor
JEVCURATOR_MODE=quality         → full V3 (the default): emission for
                                   log|listing|code|doc, compaction carries
                                   GoalSpec+ledger, V2 recency judge RETIRED
```

In `quality` (the default) the frontier verifier owns every full→non-full
transition; the V2 recency-based stub/truncate judge is disabled entirely —
cap-at-rest and `jev_recall` remain the V2 foundation underneath.

## 2. One turn in a session (the main diagram)

```
 USER PROMPT
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ MODEL WORKS: reasoning + tool calls                                     │
│  • tool_call event → curator records "name(input)" fingerprint          │
│  • model sees full, untouched tool results during the turn              │
└─────────────────────────────────────────────────────────────────────────┘
     │  (after every model response — turn boundary)
     ▼
 TURN_END  ── the curator's only actionable boundary ──────────────────────
     │
     ├─ ❶ FLUSH deferred state (invisible to the model, custom entries)
     │      pin_goal → "jev-curator-goal"; amend_goalspec → GoalSpec (v+1)
     │
     ├─ ❷ COLLECT candidates: this turn's tool results
     │      skip: <1500 chars · errors · edit/write/todo/jev_recall/mcp__jev*
     │
     ├─ ❸ CAP-AT-REST (V2, always on): >25k chars → head 15k + tail 5k
     │      runs BEFORE first model exposure next turn → never billed in full,
     │      no prefix-cache reset is ever paid for it; raw kept for recall
     │
     ├─ ❹ V2 due-judge (v2/evidence arms only; RETIRED in quality mode):
     │      results aged ≥3 turns: Jev keep/stub/truncate, held in a batch
     │      until the saved-mass floor / context pressure / age
     │      → generic head/tail edits (the "economist" path)
     │
     └─ ❺ V3 goal-quality pipeline (shadow-quality and up):
            ┌──────────────────────────────────────────────────────────┐
            │ JEV (fast classifier, enriched state = GoalSpec summary  │
            │ + tool input + recent activity + output excerpt):        │
            │   role: active | evidence | background | irrelevant      │
            │   sourceType: log | code | listing | doc | other          │
            │   links: which GoalSpec item this supports                │
            │   (irrelevant needs p≥0.95 + conf≥0.65, else → background)│
            └──────────────┬───────────────────────────────────────────┘
                           ▼
            ┌──────────────────────────────────────────────────────────┐
            │ TYPE-AWARE EXTRACT PROPOSAL (only for non-active roles)  │
            │  log    → Jev line-scoring (jev_triage_log pattern):     │
            │           top-k scored lines + ±1 neighbors + ERROR &    │
            │           summary lines kept deterministically, L# nums  │
            │  code   → scored lines merged into ranges (L8-L18, L63)  │
            │  doc    → same range extraction                          │
            │  listing→ query + plan-relevant matched paths            │
            │  background/irrelevant → compact source card             │
            │  budget: 30% of source (2.5k–12k), drop-worst-scored-fit │
            └──────────────┬───────────────────────────────────────────┘
                           ▼
            ┌──────────────────────────────────────────────────────────┐
            │ FRONTIER VERIFIER (batched per turn_end, session model):│
            │  sees GoalSpec + role/links + proposed extract + FULL raw│
            │  returns retainFull | useExtract | indexOnly            │
            │  rule: "if uncertain, retainFull" · any failure → retain │
            └──────────────┬───────────────────────────────────────────┘
                           ▼
            LOG every decision → jev-curator-v3-shadow.jsonl
                           ▼
            ┌──────────────────────────────────────────────────────────┐
            │ EMIT (evidence/quality modes only, scoped source types) │
            │  verifier-approved useExtract/indexOnly → context_edit:  │
            │    [Source: …; Supports: criterion-2; key lines L#…;     │
            │     raw via jev_recall "entryId"]                         │
            │  + EvidenceLedger entry (searchable index)               │
            │  guards: skip if V2 already edited it this turn;          │
            │          skip if the replacement isn't ≥20% smaller      │
            └──────────────────────────────────────────────────────────┘
```

## 3. What the model's context looks like over time

```
 turn 0   [user msg][result A: 14k log][result B: 5k ticket]
 turn 1   [A→ 3.2k extract ✓][B full — extract≈source, kept]
          model: "needs a fact A lost" → jev_recall "A" offset/limit → raw back,
          never re-curated (recall results are exempt)
 turn N   … extract A still there, cited, with its recall handle …
```

Every replacement is **advisory, not destructive**: raw session history is
never deleted; the edit only changes what the model *sees*.

## 4. GoalSpec — the session's structured intent

```
 seeds from first user prompt ──▶ userObjective (immutable — only /goal set can change it)
 pin_goal          ──▶ objectiveRefinements (never replaces the objective)
 amend_goalspec   ──▶ successCriteria / constraints / currentPlan / knownFacts / openQuestions
 /goal            ──▶ displays the whole spec; with args: user replaces the objective

 persisted: "jev-curator-goalspec" custom entries (latest wins on resume)
 used by:   Jev classification state · verifier prompt · curator_find rerank ·
            compaction summary (must survive verbatim)
```

## 5. Recovery paths (the "no opaque loss" contract)

```
 jev_recall(entry_id, offset?, limit?)   exact paged raw recovery of any source
                                         (cap'd, stubbed, truncated, or V3-extracted)
 curator_find("where did we see X")      semantic search over the evidence ledger:
                                         Jev reranks sources against the GoalSpec,
                                         returns cards + extract heads + raw ids
 jev_recall (no args)                    lists both V2-curated and V3-extracted sources
```

## 6. Compaction (quality mode)

```
 context approaches the window limit
        │
        ▼
 session_before_compact
        │  frontier model summarizes the conversation AND must carry:
        │   ① SESSION GOAL (GoalSpec) — complete, verbatim
        │   ② EVIDENCE LEDGER — every condensed source + jev_recall id
        │   ③ task-state summary (decisions, code, blockers, next steps)
        ▼
 compaction entry ──▶ model still knows: the goal, what exists, how to get any of it back
 (any failure → pi's default compaction runs unchanged)
```

## 7. The two pipelines side by side (why V3 exists)

```
                        V2 (the economist)            V3 (the evidence manager)
 decides                "will this be needed?"          "which exact facts serve the goal?"
 granularity            whole output                    line ranges / criteria / paths
 uncertainty            threshold gamble (p≥0.60/0.85)  retainFull, always safe
 goal awareness        one pinned sentence             full GoalSpec (criteria/constraints/…)
 approval               Jev alone                      Jev proposes → frontier verifier approves
 recovery               entry-id recall                recall + curator_find semantic search
 compaction             not involved                   carries GoalSpec + ledger
 cost target            minimize billed tokens          maximize goal completion probability
```

Both always run together: cap-at-rest and V2 remain the floor; V3 only ever
*replaces* content the frontier verifier confirmed lossless for the goal.

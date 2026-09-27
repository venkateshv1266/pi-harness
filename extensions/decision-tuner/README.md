# Decision telemetry + tuner

Closes the loop on the harness's own decisions. Every extension in the Jev
decision layer (TTSR rules, model-router, context curator, memory) already
logged *what it decided*; this system also records *what happened next*, joins
the two, and offers the safe cleanups as reviewable proposals.

Two surfaces:

- **`/decisions-report [days]`** — read-only audit. Joins every decision log to
  its outcome records and writes a markdown report.
- **`/decision-tuner`** — propose-first automation. Runs weekly, turns report
  findings into gated proposals, applies a prune only when you ask.

Both live in this directory; the shared machinery lives in `utils/`.

---

## Why this exists

A decision log without outcomes answers "what did we do", never "did it work".
Without that, tuning the harness is guesswork: rules that never fire stay
loaded, a router tier that keeps picking the wrong model is invisible, a
curator extract nobody ever reads looks the same as a valuable one, and the
deferred curator items (per-tool priors, dynamic extraction floor) have no data
source. The outcome records are that data source.

Telemetry begins with this feature's rollout. Decisions logged before it have
no outcome records; the analysis separates those **legacy** records from
**telemetry-era** ones so early rates aren't diluted.

## The files

| Path | Role |
|---|---|
| `utils/jev-outcomes.ts` | Write side: the telemetry contract (`logDecision` / `logOutcome` / `logEvent`), JSONL append, correction heuristic |
| `utils/decision-analysis.ts` | Read side: log discovery, envelope + legacy normalization, generic per-system stats, domain analyzers, `collectReport` |
| `extensions/decisions-report.ts` | `/decisions-report` command + markdown rendering |
| `extensions/decision-tuner/` | Weekly tuner, `/decision-tuner` command, `/setup` contributor (`setup.ts`) |
| `~/.pi/agent/jev-decisions/*.jsonl` | One decision log per system (auto-discovered) |
| `~/.pi/agent/jev-decisions/reports/` | Generated markdown reports |
| `~/.pi/agent/decision-tuner/` | Tuner state, proposals, run audit, config |

## The telemetry contract

Any extension logs to its own file under `~/.pi/agent/jev-decisions/` and
appears in the report and tuner automatically — no changes to either:

```ts
import { logDecision, logOutcome, logEvent } from "../utils/jev-outcomes.ts";

const id = logDecision("mysystem", "mysystem.jsonl", { action: "do-thing" });
logOutcome("mysystem", "mysystem.jsonl", id, "worked", { verdict: "good" });
logEvent("mysystem", "mysystem.jsonl", { note: "context, not a decision" });
```

- **`decision`** — something you decided, with an `id`.
- **`outcome`** — how it turned out, referencing the decision via `ref`.
  `outcome` is domain-specific (`retried`, `tests_failed`, `recalled`, …);
  `verdict` is the universal answer: `good` / `bad` / `mixed` / `unknown`.
- **`event`** — context that is not itself a decision.
- A decision with no outcome after 24h shows up as **stale** in the report —
  the signal that a system needs outcome instrumentation.
- Reserved keys (keep out of domain payloads): `kind`, `system`, `id`, `ref`,
  `outcome`, `verdict`, `ts`.

Legacy shapes written before the envelope (`record:"fire"`,
`record:"outcome"`, `decision:"recall"`, `decision:"emit-evidence"`, router
route rows) are normalized so old data still joins.

### What each shipped system records

| System | Decision | Outcomes |
|---|---|---|
| `ttsr` | each fire (rule, scope, session, turn, delivered, blocked) | `survived` (nothing adverse within 5 turns), `retried` (a blocked call re-issued unchanged with no user input), `repeated`, `user_corrected`, `unresolved` (session ended first) |
| `router` | each route (id, session, turn, tier, acted) | `model_override`, `user_corrected`, `tests_passed`, `tests_failed` (within 10 turns) |
| `curator` | each emitted extract (id = entry id) | `recalled` when `jev_recall` pages it back; `curator_find` is an event |
| `memory` | legacy audit rows only | admission / corrections / consolidation, surfaced as pipeline health |

---

## `/decisions-report [days]`

Default window 7 days. Scans every `*.jsonl` under `jev-decisions/`, joins
decisions to outcomes, writes
`~/.pi/agent/jev-decisions/reports/decisions-<date>.md`, and notifies a
compact summary.

| Section | Answers | Flags |
|---|---|---|
| **Systems** | which logs exist, join rates, good/bad verdicts, stale decisions, untyped rows | `N decisions >24h with no outcome`, orphan outcomes |
| **TTSR** | which rules intervene, and did it stick? | **prune** (≥20 evals, never delivered, no historical gate fire), **reword** (≥3 resolved, ≥50% adverse) |
| **Router** | where the router acted and what followed | acted routes followed by failing tests; outcome mix per era |
| **Curator** | emitted extracts vs later recall | `useExtract` without emission; emitted >3d never recalled |
| **Memory** | admission / correction / consolidation health | degraded consolidations |

The report changes nothing. It is the weekly review instrument and the data
source for tuning.

## `/decision-tuner`

### Weekly run

On session start, if the last run is older than `DECISION_TUNER_DAYS`
(default 7), the tuner re-runs the analysis, regenerates the report, and
**notifies only when there are proposals**. Otherwise it stays silent.

### What it proposes

| Proposal | Trigger (gates) | Action |
|---|---|---|
| **prune** | ≥20 evaluations, 0 delivered fires, 0 historical gate fires, not marked `safety: true`, not in `neverPrune` | **Applyable** — renames the rule file to `<name>.md.disabled` (reversible, never deletes); run `/ttsr-reload` to take effect |
| **reword** | ≥3 resolved outcomes, ≥50% adverse (`retried`/`repeated`/`user_corrected`) | **Advisory** — the rule fires but doesn't stick; evidence is shown, you edit the trigger/body |
| **config · router/tier-map** | acted routes followed by failing tests | **Advisory** — move the tier mapping or threshold in `settings.json` |
| **config · curator/extract-guard** | `useExtract` verdicts without an emission | **Advisory** — the emission guard runs after the verifier; fix is guard ordering, not a tuner action |
| **config · curator/extract-policy** | emitted extracts >3d never recalled | **Advisory** — tighten that source type's extract policy |

"Advisory" means the tuner diagnosed something but there is no safe mechanical
fix: applying would require judgment (rewriting a rule, moving a tier, changing
extract logic). Advisory proposals have no apply step — only `dismiss`.

### Commands

```
/decision-tuner            status: enabled, interval, last run, open proposal count, paths
/decision-tuner run        run now (analysis + proposals + regenerate report)
/decision-tuner list       open proposals with ids and evidence
/decision-tuner apply <id> apply a prune (advisory ids report why nothing happens)
/decision-tuner dismiss <id> hide a proposal for 30 days
```

### Proposal lifecycle

- **open** → **applied** (prune: file renamed) or **dismissed** (30-day cooldown).
- Same `kind + system + target` is not re-proposed while open/applied, and not
  within 30 days of a dismissal.
- Every run and decision is audited to `decision-tuner/tuner.jsonl`.

### Configuration

| Knob | Effect |
|---|---|
| `DECISION_TUNER=0` | disable the tuner entirely |
| `DECISION_TUNER_DAYS=N` | auto-run interval (default 7) |
| `decision-tuner/config.json` → `neverPrune: ["rule-name"]` | never propose pruning these rules |
| rule frontmatter `safety: true` | exempt that rule from prune proposals |

## `/setup → Decisions`

The same state without remembering commands: run the report, see the tuner's
last run, and apply/dismiss proposals from the setup window. Each action row
re-reads its own state on render and confirms in place — `✓ regenerated
<time>`, `✓ ran <time> · N open`, `✓ disabled`, `✓ dismissed` — so the result
is visible even though the window's status-line flash shares space with the
key hint.

## Reading the flags (weekly ritual)

1. Open the report (or wait for the tuner's notification).
2. Respect sample sizes: don't touch a rule with <5 resolved fires or a tier
   with <10 acted routes.
3. Act on at most one or two items so the next report can attribute the change.
4. Prunes → `apply` + `/ttsr-reload`. Rewords → edit the rule with the
   evidence. Router/curator configs → your judgment.
5. Compare the next report.

## Limits

- Outcome signals are **heuristics**, not ground truth: a `retried` may be a
  genuine ignore or a coincidence; a user correction after a fire may be
  unrelated. Rates over enough samples wash out individual mislabels.
- Safety guardrails are exempt by construction and should stay human-gated
  even when adverse rates look high — interruptions are the feature.
- No golden-trajectory eval set (R10) yet, so router/curator config changes
  cannot be *verified* as improvements; that is why nothing beyond a reversible
  prune auto-applies.
- Telemetry starts at rollout; pre-rollout decisions are counted separately as
  legacy records.

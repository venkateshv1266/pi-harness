# jev-context-curator

System One attention routing for pi: a cheap Jev classifier decides which past tool outputs still earn a place in model context, and the frontier model only ever sees a curated transcript. Design rationale and session-flow diagrams: [`jev-curator-v3-architecture.md`](jev-curator-v3-architecture.md); the V4 improvement program (Jev fact-decomposed verification, dynamic reclassification, source registry) is documented in [`IMPROVEMENTS.md`](IMPROVEMENTS.md).

## What it does

Every turn boundary, the curator examines the session's tool outputs and replaces those no longer needed with compact stand-ins, so context spend tracks the session goal instead of growing monotonically. Three mechanisms, ordered by economics:

1. **cap-at-rest** — outputs over 25k chars are replaced with a one-line notice at the turn boundary, before the next model turn is billed for the full bulk.
2. **V2 judge** (v2/evidence modes) — results a few turns old are judged keep/stub/truncate by Jev; verdicts are batched so a context edit only fires when the combined savings clear the batch floor (an edit resets the provider prefix cache; small edits lose more to the reset than they save).
3. **V3 goal-quality pipeline** (all modes except `v2`) — Jev classifies each output's role for the session goal (active / evidence / background / irrelevant), proposes a type-aware extract (scored log lines, code ranges, listing matches), and the verifier — the Jev fact-decomposed protocol with repair-first, escalating to the frontier only when uncertain — approves the replacement only if it preserves every goal-relevant fact.

All edits are advisory `context_edit` entries — raw session history is never deleted, and every replaced output stays recoverable verbatim via `jev_recall`. The mode ladder:

| `JEVCURATOR_MODE` | Behavior |
|---|---|
| unset / `quality` (default) | Full V3: the verifier owns every full→non-full transition (Jev fact-decomposed protocol + frontier escalation), emission covers log/listing/code/doc, and compaction is replaced by a frontier summary that carries the GoalSpec + evidence ledger + source index verbatim. The V2 recency judge is retired. |
| `evidence` | V3 emits only for log/listing sources, on top of the still-running V2 floor. |
| `shadow-quality` | V3 classifies/proposes/verifies and logs only — no context edits of its own; V2 keeps running unmodified (comparison arm). |
| `v2` | Pre-V3 economics layer alone: cap-at-rest + recency judge. |

Kill switch: `JEVCURATOR=0` makes the curator fully inert; `/curator off` disables at runtime.

## Commands and tools

| Command / tool | What it does |
|---|---|
| `/goal` | No args: show the session goal — the full GoalSpec (version, objective, criteria, constraints, plan, facts, open questions) in V3 modes; the pinned goal sentence in `v2`. With args: replace the objective — the user is the only writer allowed to do this. |
| `/curator` | Show stats (mode, verifier protocol, caps/truncs/stubs, ~chars saved, pending/held, goal status, and in V3 the shadow role/verdict tallies plus repaired/escalated/ab-checked/regret, per-method approval rates, and registry/overflow sizes). `off`/`on` toggles the curator. |
| `pin_goal` | Model-side refinement of the pinned goal (≤400 chars, self-contained). Flushed to session state at the next turn boundary; in V3 it becomes an objective *refinement*, never a replacement. |
| `amend_goalspec` | Record a discovery into the GoalSpec: `add_success_criteria`, `add_constraints`, `set_plan`/`add_plan_steps`, `add_facts` (with `source_ids`), `add_open_questions`, `resolve_open_questions` (1-based index or exact text). Version bumps at the next turn boundary. All modes except `v2`. |
| `jev_recall` | Exact paged raw recovery. No args: lists all curated outputs and evidence-extracted sources. With `entry_id` (from any replacement notice): returns the raw verbatim; `offset`/`limit` page by chars, `lines "120-180"` pages in the coordinate system extracts cite. A full-raw recall of a >25k source returns head+tail with a paging hint (explicit paging is never capped). Recall results are exempt from role curation (no churn loop) but cap-at-rest still applies; recalls of condensed sources feed the verifier's conservatism note. Results render collapsed to a 10-visual-line preview with pi's standard expand hint (`ctrl+o`) — counted in wrapped lines, so a recalled minified one-liner cannot fill the transcript. |
| `curator_find` | Semantic search over the whole source registry: condensed ledger sources (extract heads shown) plus capped and retained-full sources (cards labeled with their context state). Jev reranks against the GoalSpec (lexical overlap as fail-open fallback); returns source cards, extract heads, and the raw entry ids to page with `jev_recall`. `limit` defaults to 5 (clamped 1–20). Evidence/quality modes only. |

## Configuration

`/setup` → **Jev curator** exposes five knobs — `JEVCURATOR`, `JEVCURATOR_MODE`, `JEVCURATOR_VERIFIER`, `JEVCURATOR_VERIFIER_MODEL`, and `JEVCURATOR_DISTILL_MODEL` — persisted to `settings.json` under `jevCurator`; every other knob below is set through the environment, then code defaults. `JEVCURATOR=0` in the environment still forces the curator off regardless. Settings are read when the extension loads (`/reload` or a new session) except the verifier and distill models, which are re-resolved on every call so `/setup` edits to them apply immediately.

| Env var | Default | Effect |
|---|---|---|
| `JEVCURATOR` | on | Set to `0` to disable entirely (any mode). |
| `JEVCURATOR_MODE` | `quality` | `v2` / `shadow-quality` / `evidence` / `quality`; unrecognized values fall back to `quality`. |
| `JEVCURATOR_MIN_CHARS` | `1500` | Tool outputs below this are never candidates. |
| `JEVCURATOR_INGEST_CAP` | `25000` | Cap-at-rest threshold (chars). |
| `JEVCURATOR_CAP_HEAD` / `JEVCURATOR_CAP_TAIL` | `15000` / `5000` | Head/tail figures quoted in the cap-at-rest notice. |
| `JEVCURATOR_RECENCY_TURNS` | `3` | Age (turns) before a V2 verdict is due. |
| `JEVCURATOR_STUB_PROB` | `0.85` | V2 stub probability gate. |
| `JEVCURATOR_TRUNC_PROB` | `0.60` | V2 truncate probability gate. |
| `JEVCURATOR_MIN_CONF` | `0.65` | Confidence gate for any V2 verdict (also gates `irrelevant` classification). |
| `JEVCURATOR_SAMPLES` | `3` | Parallel Jev samples per verdict; median taken. |
| `JEVCURATOR_MIN_BATCH_SAVED` | `3000` | Combined saved chars before a held V2 batch emits. |
| `JEVCURATOR_MAX_HOLD_TURNS` | `10` | Batch age-out — emits regardless of floor. |
| `JEVCURATOR_MAX_STUBS` | `150` | Stops new V2 verdicts once this many curated records exist. |
| `JEVCURATOR_CONTEXT_FLOOR_PCT` | `70` | Context usage that lowers the truncate gate to 0.5. |
| `JEVCURATOR_CRITICAL_PCT` | `85` | Context usage that lowers stub to 0.7, truncate to 0.5, and drops the batch floor to 0 (selective truncation beats a lossy full compaction). |
| `JEVCURATOR_SOFT_FLOOR_PCT` | `50` | Context usage that starts proactive pruning: truncate gate drops to 0.5, the batch floor drops to a third of `MIN_BATCH_SAVED`, and shadow/reclassification budgets double so queued extracts and the overflow backlog drain faster. |
| `JEVCURATOR_AUTO_COMPACT_PCT` | `90` | Context usage that auto-triggers compaction at a turn boundary (`0` disables). Quality mode still swaps in the frontier GoalSpec summary. |
| `JEVCURATOR_AUTO_COMPACT_RISE_TURNS` | `3` | Slope trigger: compaction also fires when usage rises ≥0.5 pts/turn for this many consecutive turns while at or above `CRITICAL_PCT` (pruning cannot keep pace). A failed compaction cools down before retrying. |
| `JEVCURATOR_TRUNC_HEAD` / `JEVCURATOR_TRUNC_TAIL` | `600` / `600` | Head/tail sizes used in the batch saved-mass estimate for truncate verdicts. |
| `JEVCURATOR_JEV_TIMEOUT_MS` | `2500` | V2 judge Jev timeout. |
| `JEVCURATOR_SHADOW_JEV_TIMEOUT_MS` | `8000` | V3 role classification and `curator_find` rerank timeout. |
| `JEVCURATOR_SCORE_JEV_TIMEOUT_MS` | `25000` | V3 line-scoring timeout. |
| `JEVCURATOR_SHADOW_MAX_PER_TURN` | `10` | Max V3 candidates classified per turn boundary. |
| `JEVCURATOR_VERIFIER_MODEL` | session model | Frontier verifier/compaction model as `provider/model[:thinking]` (e.g. `openrouter/z-ai/glm-5.3:max`); the thinking level is mapped through the model's supported levels; defaults to the session's current model. |
| `JEVCURATOR_DISTILL_MODEL` | `@smol` role | Small model that rewrites the verbatim first prompt into the recited objective (≤320 chars, self-contained) at the first GoalSpec flush; the full text is kept verbatim in `objectiveSource`. Fire-and-forget, fail-open. Accepts `provider/model:thinking` or `@role`; unset role disables distillation. |
| `JEVCURATOR_VERIFIER` | `hybrid` | Verifier protocol: `hybrid` = Jev fact-decomposed verification (per-line coverage, repair-first) with frontier escalation on uncertainty; `jev` = Jev-only (uncertain → retainFull, no frontier calls); `frontier` = the holistic frontier gate only (pre-V4 behavior). `/setup`-persisted. |
| `JEVCURATOR_COV_MIN` | `0.5` | Coverage score below which a dropped goal-relevant line counts as lost (repair or escalate). |
| `JEVCURATOR_CARD_BG_PROB` | `0.8` | Role-probability gate for Jev-approving background source cards. |
| `JEVCURATOR_VERIFY_MAX_LINES` | `30` | Dropped goal-relevant lines coverage-checked per source. |
| `JEVCURATOR_REPAIR_SLACK` | `1.5` | Repair re-render budget multiplier over the extract budget. |
| `JEVCURATOR_VERIFIER_SHADOW_PCT` | `0.15` | Fraction of Jev-approved decisions also frontier-checked (≤2 per boundary), logged as `verifier-ab` — measurement only, never overrides. |
| `JEVCURATOR_JEV_BREAKER` | `2` | Consecutive Jev failures before the rest of the boundary stops calling Jev (fail-open); one fresh probe per turn. |
| `JEVCURATOR_RECLASS_PER_TURN` | `5` | Retained sources re-judged per turn after a GoalSpec version bump. |
| `JEVCURATOR_SUPERSEDE_MAX` | `5` | Same-path older reads re-judged per turn when a newer read arrives. |
| `JEVCURATOR_OVERFLOW_CAP` | `50` | Overflow queue bound for candidates beyond the per-turn classification budget. |
| `JEVCURATOR_REGISTRY_CAP` | `150` | Source-registry in-memory bound. |
| `JEVCURATOR_VERIFIER_TIMEOUT_MS` | `90000` | Verifier request timeout. |
| `JEVCURATOR_VERIFY_RAW_CAP` | `60000` | The verifier sees the complete raw below this size, an excerpt above it. |
| `JEV_BASE_URL` | OpenRouter API base | Shared Jev client endpoint (see [jev-memory](../jev-memory/README.md)). |
| `JEV_MODEL` | `jev-latest` | Shared Jev classifier model. |
| `JEV_API_KEY` → `OPENROUTER_API_KEY` → `auth.json` | unset | Key chain for Jev calls; falls back to the OpenRouter key in `~/.pi/agent/auth.json`. No key → every verdict degrades to keep (fail-open). |

Session state (custom entries, all append-only): `jev-curator-goal` (goal pins; latest wins), `jev-curator-goalspec` (full spec; v1 is the seed, written at the session's first boundary even with no amendment, later versions bump per amendment; latest wins on resume), `jev-curator-ledger` (emitted evidence items, union-hydrated), `jev-curator-registry` (every classified or capped source, union-hydrated, in-memory cap `REGISTRY_CAP`), `jev-curator-stubs` (V2 batch emission audit).

Audit logs in `~/.pi/agent/jev-decisions/`: `jev-curator-v2.jsonl` (V2 verdicts, batch hold/emit, and post-emit cache-cost probes) and `jev-curator.jsonl` (V3 shadow verdicts, `jev-verify` coverage decisions, verifier batches and `verifier-ab` frontier-agreement samples, breaker/overflow events, emissions and skips, GoalSpec amendments, compaction, `curator_find` queries, recall outcomes).

## How it works

`turn_end` is the curator's only actionable boundary. Candidates are that turn's tool results — non-error, ≥ `MIN_CHARS`, excluding `edit`/`write`/`todo`/`jev_recall` and Jev's own outputs (`mcp__jev*`, `ask_jev*`, `triage_log`, `pick_first_file` — the curator would churn them) (superseded reads are the biggest bloat, but writes are never pruned, and recall results are exempt or the curator would re-curate what the model just asked back). Each verdict is the median of `JEVCURATOR_SAMPLES` parallel Jev samples over an enriched state: pinned goal (plus GoalSpec summary in V3), tool input fingerprint, recent-activity fingerprint, and an output excerpt. Secrets (PEM keys, `sk-` tokens, GitHub/AWS/JWT token shapes) are scrubbed before any Jev call. Any Jev failure degrades to keep — uncertainty preserves evidence.

**V2 path** (v2/evidence): due results are judged stub/truncate/keep; a stub needs `p ≥ STUB_PROB` and truncate `p ≥ TRUNC_PROB`, both with confidence ≥ `MIN_CONF`. Approved replacements are one-line notices (verdict, probability, recall hint), held in a batch until the combined savings clear the floor, context pressure lowers the gates, or the batch ages out. Emitting resets the provider prefix cache, so the next turn's usage is logged as a cost probe.

**V3 path** (shadow-quality and up): Jev assigns a role against the GoalSpec — `irrelevant` requires p ≥ 0.95 plus the confidence gate, otherwise it demotes to `background` — plus a source type and a link to the GoalSpec item the output supports. Non-active roles get a type-aware extract proposal sized at ~30% of the source (clamped 2.5k–12k): logs are line-scored (top-k above 0.5, ±1 neighbor lines, ERROR/FATAL/PANIC and summary/total lines kept deterministically), code/doc reads become scored line ranges, listings keep query + matched paths, and background/irrelevant becomes a compact source card. Candidates beyond the per-turn classification budget queue as overflow and drain at later boundaries — nothing is silently dropped. The verifier then owns the full→non-full transition (`JEVCURATOR_VERIFIER`): by default the Jev fact-decomposed protocol checks, per dropped goal-relevant line, whether its information survives in the replacement (logged as `jev-verify`); lost lines are repaired back in within `REPAIR_SLACK`× budget, and only unrepairable, degraded, or head-tail-fallback cases escalate to the frontier model (GoalSpec + proposal + raw up to `VERIFY_RAW_CAP`). A sample of Jev approvals is also frontier-checked (`VERIFIER_SHADOW_PCT`, logged as `verifier-ab`, measurement only). When uncertain it retains full, and any verifier failure or omitted candidate also retains full. In evidence/quality modes, approved `useExtract`/`indexOnly` replacements are emitted as `context_edit` entries — but only if the replacement is at least 20% smaller (min 500 chars) and V2 hasn't already edited the same entry this turn; a V3 edit supersedes V2's pending plans for that source. Every classified or capped source lands in the source registry; when the GoalSpec advances or a newer read of the same path arrives, retained sources are re-judged against the live goal (`RECLASS_PER_TURN` / `SUPERSEDE_MAX` bounds). Every decision is logged to `jev-curator.jsonl` for human review.

**Recovery contract:** nothing is deleted. Every condensed or capped source keeps its entry id as the `jev_recall` handle, and every classified or capped source is indexed in the source registry where `curator_find` can find it. If a fact the model remembers seeing is no longer visible in full, `curator_find` locates the source and `jev_recall` pages the raw back (by chars or lines).

**Compaction** (quality mode only): when context nears the window limit, the frontier model generates the compaction summary instead of pi's default, and the prompt *requires* the complete GoalSpec verbatim, the full evidence ledger with entry ids, and a task-state summary — so goal state and recall handles survive every compaction. Any failure falls back to pi's default compaction unchanged.

**Auto-trigger:** at ≥ `AUTO_COMPACT_PCT` usage, or when usage keeps climbing while in the critical tier (the ladder in `tiering.ts`: soft ≥50% prunes early, floor ≥70% lowers the truncate gate, critical ≥85% zeroes the batch floor), the extension triggers compaction itself at the turn boundary. An in-flight flag blocks stacked triggers, failures start a cooldown, and success resets the usage history the slope detector reads.

**GoalSpec lifecycle:** seeded from the user's first prompt verbatim; the seed is persisted as the session's first `jev-curator-goalspec` entry (v1) at the first turn boundary, so every session carries a goal record from turn 1 even if nothing is ever amended. At the first flush the seed is distilled fire-and-forget by a small model (`JEVCURATOR_DISTILL_MODEL`, default the `@smol` role): `userObjective` is rewritten into a self-contained objective ≤320 chars (recite's OBJECTIVE cap — a long verbatim prompt loses its operative tail to the clip) and the full text is kept verbatim in `objectiveSource`; the digest flushes as the next version bump, and any failure leaves the verbatim in place. `pin_goal` adds refinements, `amend_goalspec` adds criteria/constraints/plan/facts/questions, and only `/goal` with args replaces the objective (user-authored objectives are never re-distilled). The curator is inert until a goal exists.

**Session isolation:** pi caches an extension module per cwd, so the module outlives a session; a `session_start` handler resets every session-scoped store (goal, GoalSpec, ledger, registry, batches, counters, auto-compact history), so each session seeds and judges against its own goal instead of inheriting the previous session's.

## Caveats

- Most settings are read at extension load — changing them via `/setup` or the environment needs `/reload` (or a new session); use `/curator off` for a runtime toggle. The verifier model is the exception: it is re-resolved on every call and applies immediately.
- Without a Jev API key every verdict silently degrades to keep/active; curation still applies cap-at-rest, but nothing else fires. When Jev fails mid-boundary a breaker (`JEVCURATOR_JEV_BREAKER`) stops the serial timeouts — the rest of the boundary fails open, with one fresh probe next turn. Check `/curator` for tallies.
- V2 stub/truncate replacements carry the notice text only, not an actual excerpt — the notice quotes the cap/head/tail figures and the recall path, and the raw stays intact in session history.
- In `quality` mode the V2 judge is retired: nothing is condensed without verifier approval (the Jev protocol, escalating to the frontier when uncertain), so savings come only from cap-at-rest and approved extracts.
- The in-memory raw store caps at 300 entries; older entry ids fall back to reading the session file on recall, so recall remains correct but may be slower in very long sessions.
- A failed or unreadable session, a lost audit log, or an unreachable Jev endpoint never blocks the host flow — every such path fails open.

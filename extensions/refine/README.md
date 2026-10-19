# refine

> Self-improvement loop for the harness itself: analyze a session trajectory, propose the
> smallest harness edit that would measurably improve future sessions, score it with Jev, and
> stage it for one-glance human approval. Since wave 1 the proposal vocabulary is the harness
> surface, not just TTSR rules: **rule, note, memory, context, agent, skill, settings**; wave 2
> adds **extension** — a new pi tool bundle that must pass a compile + fake-pi smoke + safety
> gate and arm atomically with the trigger that makes agents use it.

## What it does

- **`/refine [focus]`** — on-demand, user-gated analysis of the current session trajectory.
- **Background auto loop** — every `REFINE_AUTO_TURNS` turns, when a user correction or a
  repeated tool error was seen, runs the same analysis without being asked.
- Every proposal is Jev-scored and staged inert under
  `~/.pi/agent/jev-decisions/refine/staging/<kind>/<name>/`; a human arms it in
  `/refine-review`. Nothing is auto-armed, and Jev unavailability disables the loop rather than
  degrading to ungated writes.

## The harness surface

| Kind | Bundle | Arms into | Gate |
|---|---|---|---|
| `rule` | `<name>.md` with TTSR frontmatter (`condition` or `astCondition`) | `~/.pi/agent/rules/` | evidence / trigger / novelty floors |
| `note` | `<name>.md` | `refine/notes/` (passive record) | evidence / novelty; weakest-link ≥ threshold |
| `memory` | `entry.md` (`target: memory\|user\|failure`, optional `category`, ≤1200 chars) | appended to `~/.pi/agent/jev-memory/{MEMORY,USER,failures}.md` | evidence / durability / novelty |
| `context` | `<name>.md` + `entry.yaml` (registry fragment) | `~/.pi/agent/contexts/<name>.md` + `contexts/entries/<name>.yaml` | evidence / trigger precision / novelty |
| `agent` | `<name>.md` with `name`, `description`, optional `tools`/`model`/`thinking` | `~/.pi/agent/agents/` | evidence / role fit / novelty |
| `skill` | `SKILL.md` with `name`, `description` | `~/.pi/agent/skills/<name>/SKILL.md` | evidence / reusability / novelty |
| `settings` | `patch.json` (allowlisted primitive patch) | merged into `~/.pi/agent/settings.json` | evidence / precision / novelty (0.7 floors) |
| `extension` | `index.ts` + `README.md` + `pairing.md` (TTSR rule) or `pairing.md` + `pairing.yaml` (context entry), plus `expectation: tool:<name>` / `command:<name>` | `~/.pi/agent/extensions/<name>/{index.ts,README.md}` **and** the pairing target under `rules/` or `contexts/`, atomically | compile + fake-pi smoke + safety scan; telemetry suppression hard-rejects |

`utils/harness-surface.ts` is the single registry for this table: kind specs, per-kind
validators, per-part floors, bundle hashing and the armed-harness digest.

## Commands and tools

| Command / tool | What it does |
|---|---|
| `/refine [focus]` | Analyzes the full session trajectory (user/assistant text plus assistant tool calls). Sends it to the session model at high reasoning effort with the kind menu, recent memory lessons, and existing coverage. Each returned proposal is shown in an interactive overlay — Enter applies, Esc skips. Optional arg becomes a `focus` hint recorded in history. |
| `/refine-history` | Lists applied refinements; selecting one (after confirmation) restores or removes every file that arm touched (from its pre-arm backup) and marks the entry rolled back. |
| `/refine-review [discard]` | Reviews staged edits in a persistent two-panel reader: a capped list panel on top (one row per staged item with kind, tier and score) and the selected item's evidence, gate scores, arm targets and every file in the bundle in the large panel below — one overlay for the whole session, so navigating never flickers. Controls: ↑/↓ select, PgUp/PgDn or space scroll the bundle a page, j/k a line, Home/End or g/G jump, mouse wheel scrolls; Enter arms the selected item, `d d` rejects it (two-step confirm — the staged bundle is deleted and its bundle hash is recorded in `rejected.jsonl` so the auto loop will not re-stage identical content), and Esc closes the review leaving unreviewed items staged (viewed-but-undecided items are audited as kept-staged). Before the staged list opens, any open 14-day silent-extension prune proposal from the tuner is offered for confirmation (apply renames the extension directory to `.disabled`, reversibly). With the `discard` argument, a selected item is rejected directly through a confirmation, without the overlay. |
| `/refine-probe` | Measures every staged rule/context entry against the probe corpus on demand, writes the results into their manifests and logs one probe decision. Prints one line per item plus the corpus-wide hit rate and false-positive count. |
| `refine_propose` | Agent-callable tool to queue a proposal draft. Parameters: `kind` (all proposable kinds), `name` (kebab-case slug), `title`, `evidence`, `files` (relative path → content), and `expectation` for extensions. The user must approve the overlay — in a non-TUI session the tool skips with a warning. |

## Probes (stage 1)

A Jev trigger score is a paper judgement. A probe is a measurement: `probe.ts` parses a staged
rule's frontmatter (`condition` / `astCondition` / `scope` / `globs`) and runs ttsr's own matcher
(`../ttsr/matcher.ts`) over `probe-corpus/corpus.json` — 15 scrubbed fixtures with planted traps
(force-push, `console.log`, empty catch, `: any`, hardcoded keys, raw log dumps) and a real
secrets-scrubbed correction excerpt.

Two measurement paths keep the result honest for rules the corpus has never seen:

- **explicit** — fixtures name a rule in `expect` / `mustNot`; the probe reports hits, misses and
  false positives directly (this is how the seeded generic rules are scored).
- **paired topics** — each topic has a positive and a negative fixture, and a rule is only scored
  on a topic its own name or trigger text claims (`topicMembers`). A staged rule that fires on the
  positive but also on the negative earns a false positive; one the corpus cannot speak to is
  reported **unmeasured**, never given a fabricated rate.

Results land in `manifest.probe.rules` (per staged item; context bundles are probed through their
synthesized triggers) and in the probe decision stream. AST-only rules record `astSkipped` when the
native matcher is unavailable instead of failing silently.

Cadence: a rule/context item is probed the moment it is staged, the first turn of each UTC day runs
a sweep over everything still staged (date-guarded by `probe/last-sweep.json`, best-effort so it can
never break a turn), and `/refine-probe` runs it on demand. The review overlay shows the measurement
under the Jev tier — both are kept, never silently overridden: the tier is the paper judgement, the
probe line is what the trigger actually did, and a false positive is flagged in red.

## Lessons library

Every outcome window feeds a deterministic experience pass. It distils **at most one** lesson, and
only when the record shows a concrete contrast: a rule/extension rolled back after arming, an
extension blocked by the validation gate, a probe that measured false positives, or a rule the tuner
pruned. A window with no contrast produces **NO_ENTRY** — no file, no placeholder. That is the
feature, not a failure.

Lessons are grouped by proposal class so the planner recalls the relevant class instead of one flat
blob:

```
~/.pi/agent/harness-library/<domain>/INDEX.md
~/.pi/agent/harness-library/<domain>/entries/<slug>.md
```

Domains: `rule-triggers`, `extension-adoption`, `settings-tiers`, `context-precision`, `general`.
Entries carry `cue` (the shape of the situation), `lesson` (the operation, naming kind + target),
`evidence` (audit/history ids), `confidence`, `created`, and the harness digest at adoption.
Cue-similarity dedupe stops the same lesson from accumulating in different words.

`recallLessons` ranks entries by cue similarity to the current trajectory, then recency, and the
rendered section is character-bounded (4k by default) before it enters `buildProposalPrompt`
alongside the hermes memory lessons. Lesson ids that informed a proposal are recorded on its staged
manifest (`recalled`) and carried into `history.jsonl` on arm, so the daily snapshot can show the
lesson → proposal → arm → outcome lineage. The pass runs after arm and rollback, and nightly with
the probe sweep; a tuner extension prune distils an `extension-adoption` lesson, a pruned rule an
`rule-triggers` one.

**Not built (stage 2, stretch):** the headless `pi -p` replay rig over sandboxed repo snapshots
WITH base-vs-candidate blind contrast through Jev and KEEP_BASE semantics. Stage 1 (this probe
engine) measures a trigger against a fixture corpus; stage 2 would measure the whole candidate
harness against a replayed session. It is deliberately out of scope for this build.

## Extension adoption gate

A proposed extension is inert until it passes `extensions/refine/extension-gate.ts`:

1. **Compile** — the staged `index.ts` is typechecked in a scratch project against pi's real
   declarations (the `verify-pi-extension-edits` mechanism). Only first-party errors are
   reported; missing compile infrastructure fails closed.
2. **Fake-pi smoke** — the source loads against a fake `ExtensionAPI`, registers its tools /
   commands / boundary handlers, and every registered handler is fired with a synthetic event.
   A module that throws, registers nothing, or crashes a handler fails.
3. **Safety scan** — flags `child_process`, network egress, writes outside `~/.pi/agent/`, and
   **hard-rejects** any reference to `jev-decisions/`, observatory adapters, or reassignment
   of the outcomes loggers (anti-cheat: the loop may never blind its own instruments).

The gate runs when an auto-proposed extension is staged (result recorded in
`manifest.probe.gate`) and again on arm. Arming writes the source + README + pairing artifact
as one transaction: if any target is taken or a write fails, nothing is armed. The review
overlay shows each check and its result; a failed gate cannot be armed.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `REFINE_AUTO` | enabled | Set to `0` to disable the background auto-refine loop. |
| `REFINE_JEV` | unset | Set to `0` to kill Jev adjudication; the auto loop then disables itself for the session (no planner call, nothing written). |
| `REFINE_AUTO_TURNS` | `10` | Minimum turns between auto-refine scans (clamped to ≥ 1). |
| `REFINE_AUTO_HEADLESS` | unset | Set to `1` to let the auto loop run in non-TUI sessions; default is TUI-only. |
| `REFINE_AUTO_RULE_EVIDENCE_FLOOR` | `0.6` | Minimum Jev evidence part to stage a rule as ready. |
| `REFINE_AUTO_RULE_NOVELTY_FLOOR` | `0.6` | Minimum Jev novelty part to stage a rule as ready. |
| `REFINE_AUTO_RULE_TRIGGER_FLOOR` | `0.5` | Minimum Jev trigger part to stage a rule as ready. |
| `REFINE_AUTO_<KIND>_<PART>_FLOOR` | kind defaults | Per-kind floor override, e.g. `REFINE_AUTO_MEMORY_TRIGGER_FLOOR=0.6` (parts: `EVIDENCE`, `TRIGGER`, `NOVELTY`). |
| `REFINE_AUTO_NEAR_MISS_FLOOR` | `0.4` | Minimum of (evidence, novelty) to stage a floor-failing item as near-miss instead of suppressing. |
| `REFINE_AUTO_NOTE_THRESHOLD` | `0.6` | Minimum weakest-link Jev score to auto-apply a note (notes are passive; behavioural kinds always stage). |
| `JEV_BASE_URL` | OpenRouter API base | Jev endpoint base (see `../jev-memory/README.md`). |
| `JEV_MODEL` | `jev-latest` | Jev model id. |
| `JEV_TIMEOUT_MS` | `2000` | Jev request timeout; a timeout or error is treated as degraded, not as a pass. |
| `JEV_API_KEY` / `OPENROUTER_API_KEY` | unset | Jev auth; falls back to the `openrouter` key in `~/.pi/agent/auth.json`. |

## State

- `~/.pi/agent/jev-decisions/refine/staging/<kind>/<name>/` — inert staged bundle:
  `manifest.json` (kind, name, title, evidence, score, parts, session, stagedAt, trigger,
  tier, files, optional expectation, `probe.gate` for extensions and `probe.rules` for
  rule/context probes) plus the proposed files
  under `files/`. The pre-wave-1
  `rules-staging/<name>.md` layout is migrated once at extension start.
- `~/.pi/agent/jev-decisions/refine/notes/` — applied notes (passive markdown).
- `~/.pi/agent/jev-decisions/refine/backups/<timestamp>-<kind>-<name>/` — pre-arm copies of
  every file an arm touched; rollback restores them.
- `~/.pi/agent/jev-decisions/refine/rejected.jsonl` — bundle hashes of rejected items, merged
  into the auto loop's dedupe so identical proposals are not re-staged.
- `~/.pi/agent/jev-decisions/refine/history.jsonl` — every apply/arm: id, timestamp, kind,
  name, primary path, `armed` targets with backup paths, evidence, source (`manual`/`auto`),
  optional `focus`, optional extension `expectation`, the armed-harness digest, and
  `rolledBack` after a rollback.
- `~/.pi/agent/jev-decisions/refine/auto-refine.jsonl` — audit log of every auto-loop
  decision: stage (`plan`/`jev`/`apply`/`review`), decision
  (`skipped`/`degraded`/`no-proposals`/`suppressed`/`staged`/`applied`/`duplicate`/`kept-staged`/`armed`/`discarded`/`error`),
  score and parts, tier, kind, latency, trigger, and error text. `apply` lines for rules/contexts
  also carry the measured `probe` verdict (hits, misses, false positives, pass rate).
- `~/.pi/agent/harness-library/<domain>/{INDEX.md,entries/<slug>.md}` — lessons distilled by the
  experience pass, grouped by proposal class; recalled into the planner prompt and linked from
  staged/armed history via `recalled`.
- `~/.pi/agent/jev-decisions/lessons.jsonl` — one record per experience pass
  (`written` / `no-entry` / `duplicate`), so a quiet day is visible as a deliberate no-op.
- `~/.pi/agent/jev-decisions/refine/probe/last-sweep.json` — date guard for the daily probe sweep.
- `~/.pi/agent/jev-decisions/probe.jsonl` — probe decision stream (one record per stage-write
  probe, sweep or `/refine-probe` run) with per-rule verdicts; the Improvements snapshot aggregates
  its rule hit rate.
- Live homes: `rules/` (ttsr), `agents/`, `skills/`, `contexts/` (+ `contexts/entries/*.yaml`
  fragments), `jev-memory/`, and `settings.json`. Refine only writes there after human arming
  or an explicit `/refine`/`refine_propose` approval.

## How it works

**Proposal planning.** Both `/refine` and the auto loop build a trajectory from the session
branch — user and assistant text plus assistant tool calls — capped at the last 60,000
characters (the auto loop further trims to its window's last 30,000). The planner looks only
for four signals: an explicit user correction, the same failure occurring 2+ times, a
non-obvious workaround, and a recurring multi-step workflow. It is told to propose at most 3
edits (the loop's cap) and to return an empty list otherwise, and to choose the smallest kind
that carries the edit. Every proposal carries a `dimension` — **INV** (how the agent works:
procedure, tool use, sequencing) or **DOM** (what a practitioner knows: verified workspace
facts, conventions, infrastructure quirks) — so the two axes stay separate instead of
overlapping. Memory lessons are read from `~/.pi/agent/pi-hermes-memory/failures.md` so the
planner can promote recurring lessons into rules instead of re-proposing them. Existing
rule/note/context/agent/skill names and 300-character body previews are passed as coverage.

**Auto-refine triggers.** On every turn end the loop counts user messages matching a
correction regex ("don't", "stop doing", "not what I asked", "revert", "redo", …) and records
tool-error signatures (`toolName` + first 120 chars of the result) from failed tool calls.
Every `REFINE_AUTO_TURNS` turns, if at least one correction occurred or any tool-error
signature was seen twice, it runs a scan over the entries since the last scan. One scan runs
at a time.

**Jev adjudication.** Parsed proposals are deduped by (kind, name) against armed coverage and
staging and by normalized title across kinds, then aggregated by dimension — INV, DOM, then
unclassified, round-robin — so one axis cannot crowd the other out of the 3-proposal cap.
Survivors are bundle-hash deduped against every armed rule/note, every staged
bundle, and `rejected.jsonl`. Survivors are sent to Jev in one batched call — proposals, a
12,000-character trajectory tail, and existing bodies — after scrubbing secrets (private-key
blocks, `sk-` tokens, GitHub/AWS tokens, JWTs). Every proposal gets the same two questions
(`evidence`, `redundant`) plus one kind-specific question carried in the `trigger` part:
stream-trigger precision for rules, durability for memory, retrieval-trigger precision for
context, role/tool fit for agents, reusability for skills, and narrowness/reversibility for
settings. `min(evidence, trigger, 1 − redundant)` is recorded as the weakest-link score;
missing or malformed answers suppress the proposal rather than pass it.

**Apply.** Notes scoring ≥ `REFINE_AUTO_NOTE_THRESHOLD` are written directly (passive markdown
with no stream effect). Every behavioural kind (`rule`, `memory`, `context`, `agent`, `skill`,
`settings`) is **staged, never auto-armed**, in one of two tiers: `ready` when its parts clear
the per-part floors, or `near-miss` when it fails a floor but `min(evidence, novelty) ≥
REFINE_AUTO_NEAR_MISS_FLOOR`. Below both bands it is suppressed. `/refine-review` arms a
staged bundle through the kind's arm action, writing a pre-arm backup first; the history entry
records every target so `/refine-history` can restore them.

**Arm actions.** Rules copy to `rules/` (then `/ttsr-reload`). Memory entries append a
`§`-delimited line with `created`/`last` metadata to the target memory file. Context entries
write the doc plus a registry fragment that ttsr loads from `contexts/entries/` and turns into
a synthesized rule. Agents copy to `agents/`; skills copy to `skills/<name>/SKILL.md`.
Settings patches merge into `settings.json` after the allowlisted-primitive validation, with a
backup; they apply from the next session.

## Safety model

- **Manual paths are human-gated.** `/refine` and `refine_propose` write only after an explicit
  Enter in the review overlay; in non-TUI sessions they no-op with a warning rather than write
  blind.
- **The auto loop cannot write without Jev.** If `REFINE_JEV=0`, no key is configured, or the
  call fails or times out, the planner is not even invoked; the loop disables itself for the
  session with a one-time warning.
- **Behavioural edits are never auto-armed.** They sit in `staging/` until `/refine-review`
  arms them; rules and contexts additionally need `/ttsr-reload` to take effect.
- **Nothing overwrites.** Arming skips when any target file already exists; memory entries are
  deduped by body text; settings patches that change nothing are refused.
- **The instruments are out of bounds.** Every bundle passes `utils/anti-cheat.ts` before staging:
  instructions or code that remove, redirect, overwrite, suppress or fabricate `jev-decisions/`
  records, observatory adapters, or the outcomes loggers are rejected (extensions keep the
  stricter gate rule — any reference to the telemetry store is refused). A legitimate mention of
  the decision logs remains legal.
- **Rollback is real.** Every arm writes pre-arm backups; `/refine-history` restores or removes
  the recorded targets instead of blindly deleting a path.
- **Everything is auditable.** Every auto decision — including suppressions, degradations, and
  errors — is appended to `auto-refine.jsonl`; armed edits are in `history.jsonl` with the
  harness digest at arming time. Audit writes are wrapped so a logging failure can never break
  the loop.

## Caveats

- The auto loop only runs when the session model is configured and authenticated; otherwise the
  skip is recorded in the audit log.
- Trajectory windows only cover entries since the previous scan; the auto loop never re-reads
  older history.
- Rollback restores from the backup; if a target was edited after arming, that edit is lost —
  the confirmation names the files involved.
- Staged items left unreviewed stay in `staging/` indefinitely; there is no expiry.
- `extension` proposals are rejected until wave 2 lands the compile + fake-pi smoke + safety
  gate.
- The correction regex is fixed in code; all thresholds and floors above are tunable via
  environment.

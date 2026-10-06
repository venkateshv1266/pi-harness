# refine

Session-trajectory refinement: proposes TTSR rules and memory notes from observed failures and user corrections, with manual approval and staged, audited auto-apply.

## What it does

Refine watches the current session (user corrections, repeated tool errors) and turns recurring failures into the smallest possible harness edit: a stream-triggered TTSR rule or a passive memory note. Three surfaces:

- `/refine` — on-demand, user-gated analysis of the session trajectory.
- `refine_propose` — a tool the agent calls to queue a draft; the user approves it in an overlay before anything is written.
- A background auto-refine loop that runs every N turns when a correction or repeated tool-failure signal is present, adjudicates each proposal through Jev, auto-applies notes, and stages rules for human review.

Nothing in the auto loop writes ungated: rules are never armed automatically, every decision is appended to an audit log, and Jev unavailability disables the loop entirely rather than degrading to ungated writes.

## Commands and tools

| Command / tool | What it does |
|---|---|
| `/refine [focus]` | Analyzes the full session trajectory (user/assistant text plus assistant tool calls). Sends it to the session model at high reasoning effort with the rule-file format, recent memory lessons, and existing coverage. Each returned proposal is shown in an interactive overlay — Enter applies, Esc skips. Optional arg becomes a `focus` hint recorded in history. |
| `/refine-history` | Lists applied refinements; selecting one (after confirmation) deletes its file and marks the entry rolled back. |
| `/refine-review [discard]` | Reviews rules staged by the auto loop. Each staged rule is shown in the same overlay (near-miss drafts are labeled): Enter arms it (moves it into the live rules directory), Esc keeps it staged. With the `discard` argument, a selected staged rule and its metadata are deleted instead. |
| `refine_propose` | Agent-callable tool to queue a proposal draft. Parameters: `kind` (`rule` \| `note`), `name` (kebab-case slug), `title`, `evidence`, `content`. Rule content must be a complete TTSR rule file including frontmatter with a `condition` or `astCondition`; note content is plain markdown. The user must approve the overlay — in a non-TUI session the tool skips with a warning. |

Manual applies land rules in `~/.pi/agent/rules/<name>.md` and notes in `~/.pi/agent/jev-decisions/refine/notes/<name>.md`. An existing file is never overwritten — a duplicate name is skipped with a warning.

## Configuration

All environment variables, with defaults read from code:

| Env var | Default | Effect |
|---|---|---|
| `REFINE_AUTO` | enabled | Set to `0` to disable the background auto-refine loop. |
| `REFINE_JEV` | unset | Set to `0` to kill Jev adjudication; the auto loop then disables itself for the session (no planner call, nothing written). |
| `REFINE_AUTO_TURNS` | `10` | Minimum turns between auto-refine scans (clamped to ≥ 1). |
| `REFINE_AUTO_HEADLESS` | unset | Set to `1` to let the auto loop run in non-TUI sessions; default is TUI-only. |
| `REFINE_AUTO_RULE_EVIDENCE_FLOOR` | `0.6` | Minimum Jev evidence part to stage a rule as ready (clamped to 0–1). |
| `REFINE_AUTO_RULE_NOVELTY_FLOOR` | `0.6` | Minimum Jev novelty part to stage a rule as ready (clamped to 0–1). |
| `REFINE_AUTO_RULE_TRIGGER_FLOOR` | `0.5` | Minimum Jev trigger part to stage a rule as ready (clamped to 0–1). |
| `REFINE_AUTO_NEAR_MISS_FLOOR` | `0.4` | Minimum of (evidence, novelty) to stage a floor-failing rule as near-miss instead of suppressing (clamped to 0–1). |
| `REFINE_AUTO_NOTE_THRESHOLD` | `0.6` | Minimum weakest-link Jev score to auto-apply a note (clamped to 0–1). |
| `JEV_BASE_URL` | OpenRouter API base | Jev endpoint base (see `../jev-memory/README.md`). |
| `JEV_MODEL` | `jev-latest` | Jev model id. |
| `JEV_TIMEOUT_MS` | `2000` | Jev request timeout; a timeout or error is treated as degraded, not as a pass. |
| `JEV_API_KEY` / `OPENROUTER_API_KEY` | unset | Jev auth; falls back to the `openrouter` key in `~/.pi/agent/auth.json`. |

## State

- `~/.pi/agent/jev-decisions/refine/notes/` — applied notes (passive markdown).
- `~/.pi/agent/jev-decisions/refine/rules-staging/` — auto-proposed rules awaiting review: `<name>.md` plus `<name>.meta.json` (title, evidence, score, score parts, session id, staged timestamp, trigger, tier).
- `~/.pi/agent/jev-decisions/refine/history.jsonl` — every apply/arm: id, timestamp, kind, name, path, evidence, source (`manual`/`auto`), optional `focus`, and `rolledBack` after a rollback.
- `~/.pi/agent/jev-decisions/refine/auto-refine.jsonl` — audit log of every auto-loop decision: stage (`plan`/`jev`/`apply`/`review`), decision (`skipped`/`degraded`/`no-proposals`/`suppressed`/`staged`/`applied`/`duplicate`/`kept-staged`/`armed`/`discarded`/`error`), score and parts, tier for staged/reviewed rules, latency, trigger, and error text.
- Live rules live in `~/.pi/agent/rules/` (owned by [ttsr](../ttsr/README.md)); refine only adds files there via manual approval or an armed staged rule.

## How it works

**Proposal planning.** Both `/refine` and the auto loop build a trajectory from the session branch — user and assistant text plus assistant tool calls — capped at the last 60,000 characters (the auto loop further trims to its window's last 30,000). The planner prompt looks only for four signals: an explicit user correction, the same failure occurring 2+ times, a non-obvious workaround, and a recurring multi-step workflow. It is told to propose at most 2 edits and to return an empty list otherwise. Memory lessons are read from `~/.pi/agent/pi-hermes-memory/failures.md` (`§`-separated, 12 most recent by `last=` date, 8,000-character cap) so the planner can promote recurring lessons into rules instead of re-proposing them. Existing rule and note names — and, for the auto loop, their 300-character body previews — are passed in as coverage to avoid duplicates. The planner is told to propose rules only from failures recurring 2+ times (preferring `astCondition` over text regex) and treats existing notes as promotion candidates: a recorded lesson violated again in the trajectory may be proposed as its rule version.

**Auto-refine triggers.** On every turn end the loop counts user messages matching a correction regex ("don't", "stop doing", "not what I asked", "revert", "redo", …) and records tool-error signatures (`toolName` + first 120 chars of the result) from failed tool calls. Every `REFINE_AUTO_TURNS` turns, if at least one correction occurred or any tool-error signature was seen twice, it runs a scan over the entries since the last scan. Without a signal it does nothing. One scan runs at a time.

**Jev adjudication.** Parsed proposals are deduped by name against existing coverage, capped at 3, then content-hash deduped (SHA-256 of whitespace-collapsed, lowercased content) against every file in the rules, notes, and staging directories. Survivors are sent to Jev in one batched call — proposals, a 12,000-character trajectory tail, and existing bodies — after scrubbing secrets (private-key blocks, `sk-` tokens, GitHub/AWS tokens, JWTs). Each proposal is scored on three questions and `min(evidence, trigger, 1 − redundant)` is recorded as its weakest-link score. `evidence` asks whether the quoted trajectory genuinely shows a correction, demanded rework, or a repeated failure; `trigger` (rules only — notes score 1) asks whether the proposed regex/AST condition would fire precisely; `redundant` asks whether existing rules or notes already cover the content. Missing or malformed answers suppress the proposal rather than pass it. The recorded score is calibration data, not the rule gate: two weeks of audit data (29/29 auto rule proposals suppressed, trigger part never above 0.79) showed a 0.8 weakest-link bar is unreachable for behavioral rules, so rules gate on per-part floors with a near-miss band (see Apply).

**Apply.** A note scoring ≥ `REFINE_AUTO_NOTE_THRESHOLD` is written directly (notes are passive markdown with no stream effect). A rule is **staged, never auto-armed**, in one of two tiers: `ready` when its parts clear the per-part floors (`evidence ≥ REFINE_AUTO_RULE_EVIDENCE_FLOOR`, `novelty ≥ REFINE_AUTO_RULE_NOVELTY_FLOOR`, `trigger ≥ REFINE_AUTO_RULE_TRIGGER_FLOOR`), or `near-miss` when it fails a floor but `min(evidence, novelty) ≥ REFINE_AUTO_NEAR_MISS_FLOOR` — real signal worth a human look, typically with a trigger the user can sharpen before arming. Below both bands it is suppressed. Either tier lands in `rules-staging/` with its metadata (including the tier) and stays inert because it is outside the live rules directory. The user arms drafts via `/refine-review` (near-miss drafts are labeled in the overlay), which moves the file into `~/.pi/agent/rules/`, logs it in history with source `auto`, and prompts for `/ttsr-reload`. Arming skips — and audits — a rule whose live filename already exists; staging skips a name already staged.

## Safety model

- **Manual paths are human-gated.** `/refine` and `refine_propose` write only after an explicit Enter in the review overlay; in non-TUI sessions they no-op with a warning rather than write blind.
- **The auto loop cannot write without Jev.** If `REFINE_JEV=0`, no key is configured, or the call fails or times out, the planner is not even invoked; the loop disables itself for the session with a one-time warning.
- **Rules are never auto-armed.** Auto-accepted rules are dormant in `rules-staging/` until `/refine-review` moves them into the live rules directory; a second command (`/ttsr-reload`) is needed before they take effect.
- **Nothing overwrites.** Applies and arming both skip if the target file already exists; duplicate content is dropped by hash before the Jev call.
- **Everything is auditable.** Every auto decision — including suppressions, degradations, and errors — is appended to `auto-refine.jsonl`; applied and armed edits are in `history.jsonl` and reversible via `/refine-history`. Audit writes are wrapped so a logging failure can never break the loop mid-write.

## Caveats

- The auto loop only runs when the session model is configured and authenticated; otherwise the skip is recorded in the audit log.
- Trajectory windows only cover entries since the previous scan; the auto loop never re-reads older history.
- `/refine-history` rollback deletes the file even if it was moved or edited out-of-band (it warns if the file is already gone) and marks the entry rolled back; it does not restore prior content.
- Staged rules left unreviewed stay in `rules-staging/` indefinitely; there is no expiry.
- The correction regex is fixed in code; all thresholds and floors above are tunable via environment.

---
name: "code-review"
description: "Review a PR, branch, or the current working diff by spawning the reviewer subagent (which runs a Jev-based triage of the changed files, then lens fan-out plus validator pass on @slow). Use when asked to review a PR or diff."
version: 3
created: "2026-09-03"
updated: "2026-10-06"
---
## When to Use
Use when the user asks to review a PR (by number or URL), a branch, or the current diff/changes in a repo. Do not use for stack-specific review workflows or for reviewing specific files the user wants discussed interactively without the full review treatment.

## Procedure
1. Determine the target: a PR number/URL, a branch name, or the current working diff (staged/unstaged changes).
2. Determine the repo directory: the current working directory unless the PR belongs to another repo under the workspace.
3. Check `subagent_list` for a live or retained handle named `reviewer`. If one exists for this target, do NOT spawn a duplicate — steer that session (`subagent_send`) or collect it (`subagent_wait`).
4. If no handle exists, spawn the reviewer as a PERSISTENT subagent: one `delegate` call, single form, with `mode: "persistent"`, `name: "reviewer"`, agent `reviewer` (user scope), `cwd` set to the repo directory, tools `['read','bash','grep','find','ls','subagent','ask_jev_files','ask_jev_file_bool','ask_jev_file_score','pick_first_file','triage_log']` — this list must match the reviewer's frontmatter; a stale override strips the Jev tools and silently disables triage. NEVER spawn the reviewer without `mode: "persistent"` — a one-shot child exits on failure, and the reflexive retry (a fresh spawn) re-runs the entire review flow from scratch.
5. Task prompt must be self-contained, e.g.: "Review <PR #123 / branch X / the current staged+unstaged diff> in this repo. To get the diff run `gh pr diff <num> --patch` (PR), `git diff <base>...<branch>` (branch), or `git diff HEAD` + `git diff --staged` (working tree). Follow your own review method: gather the diff, triage the changed files with your Jev routing step (degrade to heuristics if ask-jev tools error), decide single-pass versus fan-out, run the validator pass if you fan out, and emit your consolidated review in your mandated output format. Return the full review as your final output."
6. Collect the result from the `reviewer` handle with `subagent_wait`. (A delegate call with default `wait: true` already blocks until the child settles; call `subagent_wait` when you spawned with `wait: false`, or after steering/resuming the child.)
7. Relay the reviewer's consolidated review to the user verbatim — do not re-summarize, re-rank, or add your own findings on top.
8. If the user then asks to fix findings, hand the confirmed findings list to a writer/task agent; do not let the reviewer edit files (it is read-only by design).

## Failure and retry contract
On any failure, resume the existing `reviewer` session — re-running the full review flow (re-gathering the diff, re-running every lens, re-validating) is the explicitly forbidden outcome. The retry path is `subagent_wait`/`subagent_send` on the retained handle, never a second `delegate` spawn.
- **Reviewer aborted mid-run (no final output)**: call `subagent_wait` on the handle — it auto-resumes the aborted child from where it stopped. Do not invoke `delegate` again.
- **A nested lens or validator agent failed, and the reviewer settled with a partial result**: `subagent_send` a follow-up on the same retained session, e.g. "The <lens/validator> run failed — re-spawn only that agent, merge its output with the findings you already have, and emit the consolidated review. Do not re-gather the diff or re-run completed lenses."
- **Handle missing ("no saved session")**: often a transient session-flush race — wait briefly and retry the same call before treating the session as lost.
- **Jev unavailable during the review (ask-jev tool errors)**: not a failure — the reviewer degrades to heuristic routing per its own instructions and notes it in the opener. Collect normally; do not respawn.
- **Fallback threshold**: after 2 failed resume/steer attempts for the same failure, spawn a fresh reviewer as a last resort, and tell the user the previous attempt could not be resumed.
- **Overlapping invocations**: if the user asks to review the same target again while a `reviewer` handle is live, steer the existing session; never run two reviewers on one target.

## Pitfalls
- Do not use this for stack-specific review workflows; use the repository's stack-review workflow when one is available.
- Do not ask the reviewer to edit files. Use a writer/task agent for confirmed fixes.
- Do not spawn the reviewer one-shot (omitting `mode: "persistent"`). One-shot children exit on abort, so the only available retry is a fresh spawn that silently re-runs the whole review flow — the exact anti-pattern this skill forbids.

## Verification
1. The reviewer subagent returns a review containing an opener, findings ordered by severity with path:line citations, What's good, Test coverage, and a Review Summary table with a verdict.
2. If handed a PR number, the review's opener correctly describes that PR's changes (not another PR or stale diff).
3. The reviewer was spawned with `mode: "persistent"` and name `reviewer`, the review was collected via `subagent_wait` on that handle, and no second reviewer was spawned for the same target — including when a run aborted mid-flight.
4. The review completed even if ask-jev tools errored mid-run — degradation to heuristic routing is handled inside the reviewer and is not a failure condition.

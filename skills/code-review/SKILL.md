---
name: "code-review"
description: "Review a PR, branch, or the current working diff by spawning the reviewer subagent (which runs its own lens fan-out plus validator pass on @slow). Use when asked to review a PR or diff."
version: 1
created: "2026-09-03"
updated: "2026-09-09"
---
## When to Use
Use when the user asks to review a PR (by number or URL), a branch, or the current diff/changes in a repo. Do not use for stack-specific review workflows or for reviewing specific files the user wants discussed interactively without the full review treatment.

## Procedure
1. Determine the target: a PR number/URL, a branch name, or the current working diff (staged/unstaged changes).
2. Determine the repo directory: the current working directory unless the PR belongs to another repo under the workspace.
3. Spawn ONE subagent call in single mode: agent `reviewer` (user scope), with `cwd` set to the repo directory and tools `['read','bash','grep','find','ls','subagent']`.
4. Task prompt must be self-contained, e.g.: "Review <PR #123 / branch X / the current staged+unstaged diff> in this repo. To get the diff run `gh pr diff <num> --patch` (PR), `git diff <base>...<branch>` (branch), or `git diff HEAD` + `git diff --staged` (working tree). Follow your own review method: gather the diff, decide single-pass versus fan-out, run the validator pass if you fan out, and emit your consolidated review in your mandated output format. Return the full review as your final output."
5. Relay the reviewer's consolidated review to the user verbatim — do not re-summarize, re-rank, or add your own findings on top.
6. If the user then asks to fix findings, hand the confirmed findings list to a writer/task agent; do not let the reviewer edit files (it is read-only by design).

## Pitfalls
- Do not use this for stack-specific review workflows; use the repository's stack-review workflow when one is available.
- Do not ask the reviewer to edit files. Use a writer/task agent for confirmed fixes.

## Verification
1. The reviewer subagent returns a review containing an opener, findings ordered by severity with path:line citations, What's good, Test coverage, and a Review Summary table with a verdict.
2. If handed a PR number, the review's opener correctly describes that PR's changes (not another PR or stale diff).

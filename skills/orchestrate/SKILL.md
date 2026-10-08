---
name: orchestrate
description: Orchestrates a full implementation via cascade routing — plan in the main session (high-end model), then persistent writer agents (@smol role) type code in parallel per frozen specs, and persistent verifier agents (@slow role at xhigh reasoning) grade in steerable fix-loops until clean. Every routing/classification decision goes through Jev. Accepts free-text tasks or Linear ticket IDs. Produces an iterated plan + specs under .pi/tasks/ for user approval before any code is written. Use for multi-step features, bug fixes from tickets, or any task where plan-then-execute-then-verify is worth the overhead.
argument-hint: "<Linear ticket ID, e.g. ENG-123> | <free-text task description>"
---

# Orchestrate — Cascade Routing for Implementation Tasks

This skill implements the **planner → writer (cheap) → verifier (xhigh reasoning) → steerable fix-loop** pattern (cascade routing). The orchestrator (you, the main session) plans on the session's high-end model; `writer` agents on the `@smol` role execute in parallel where the token volume is; `verifier` agents on the `@slow` role at xhigh reasoning grade and drive the fix-loop until clean. Writer and verifier children are spawned as **persistent subagents** so fix iterations steer the same child instead of paying a full respawn + context re-read every round. Every routing/classification decision goes through **Jev**.

The shipped artifact is gated to xhigh-reasoning quality *at the verifier*. Planning runs on whatever strong model the session already has — no model switching. Writer/verifier pin their roles in their own frontmatter, so the cascade economics hold regardless of session model. To change the economics, edit `~/.pi/agent/agents/writer.md` / `verifier.md`, not this skill.

Usage: `/orchestrate <Linear ticket ID>` or `/orchestrate <free-text task>`

---

## The agents you orchestrate

Agent definitions live in `~/.pi/agent/agents/` — verify with `ls` before spawning (never hardcode names beyond this table). Model roles and tool allowlists are pinned in each agent's frontmatter, so **do NOT pass `model` or `tools` in the delegate call** — omit both and let the frontmatter win.

| Agent | Model role | Role in cascade | Spawn mode |
|-------|-----------|-----------------|------------|
| `writer` | `@smol` | Types code per a frozen spec. Runs the harness itself. No architecture decisions. Returns `BLOCKED: <one-line ambiguity>` when the spec is ambiguous. | persistent, named |
| `verifier` | `@slow` | Grades the writer's diff against spec + harness. Read-only. Returns findings with severity (`BLOCKER`/`MAJOR`/`MINOR`/`NIT`) and `file:line` + `FIX:` instructions. | persistent, named |
| `explorer` | `@smol` | Maps the codebase surface during planning. Read-only, returns a compressed map. | auto (one-shot) |

You (the orchestrator) never edit code yourself — you plan, decompose, spawn, steer, and route.

## Persistent subagent contract (writer / verifier)

`delegate` is the only spawn door. Writer and verifier children MUST be spawned **persistent** (`mode: "persistent"`) with explicit `name` handles. Forcing persistent here is deliberate: the fix-loop is the definition of revisitable work, and a fresh child per iteration re-pays full context read + harness rediscovery every round.

- **Spawn (wave batch, ONE call, ≤8 children):**

  ```
  delegate {
    mode: "persistent",
    tasks: [
      { agent: "writer", cwd: <repo root>, name: "orch-<topic>-t1-writer",
        task: "Implement spec at .pi/tasks/orchestrate-<topic>/specs/T1.md. Read it fully first. Run the acceptance harness. Return the writer summary format exactly. Return your findings as a structured summary." },
      { agent: "writer", cwd: <repo root>, name: "orch-<topic>-t2-writer",
        task: "Implement spec at .pi/tasks/orchestrate-<topic>/specs/T2.md. … Return your findings as a structured summary." }
    ]
  }
  ```

- **Collect:** the batch blocks until every child settles (`wait: true` default). For any child you spawned with `wait: false`, collect with `subagent_wait({ name })` — never use `subagent_send` merely to retrieve a finished child's output.
- **Fix-loop = steer, don't respawn:**

  ```
  subagent_send {
    name: "orch-<topic>-t1-writer", wait: true, timeoutMs: 1800000,
    message: "The verifier found these issues — fix them, do not redesign:\n<findings verbatim>\nRe-run the acceptance harness. Return the writer summary format exactly."
  }
  ```

  The child retains its full prior context (its own diff, its own harness runs). If it was unloaded/idle it is transparently resumed from disk with that context. On timeout the child keeps running — re-`subagent_wait`, do not respawn.
- **Verifier re-grade = steer the same verifier child:** it remembers its own prior findings, so the re-grade is delta-focused:

  ```
  subagent_send { name: "orch-<topic>-t1-verifier", wait: true, timeoutMs: 1800000,
    message: "Re-verify the updated diff against spec specs/T1.md. Prior findings: <yours, verbatim>. Return the verifier report format exactly." }
  ```

- **Discovery/resume:** `subagent_list()` lists `orch-*` handles with live status (running/idle/stopped). Steer idle children; stopped/unloaded children resume from disk on next send/wait.
- **Sole exception — spec rewrite:** if the verifier proves the *spec* itself was wrong, fix the spec and spawn a **fresh** writer child (new handle, e.g. `…-t1-writer-r2`). The old child's context is poisoned by the spec it executed. Pure writer-error loops keep the same child.
- **Handle naming:** `orch-<topic>-t<n>-writer|verifier` (pattern `[a-zA-Z0-9][a-zA-Z0-9_-]*`).
- **Prompt hygiene:** every subagent prompt ends with `Return your findings as a structured summary.`

## Jev decision points

The orchestrator routes every classification/routing judgment through Jev instead of burning main-session reasoning or guessing. Jev narrows the call; you still surface consequential decisions to the user. Fixed points:

| Phase | Decision | Jev call |
|-------|----------|----------|
| 0b | Triage: SIMPLE / MODERATE / COMPLEX | `ask_jev` — score, 3 levels; state = task text + repo surface |
| 2c | Writer `BLOCKED`: spec bug / code issue / needs-user | `ask_jev` — choice |
| 3→4 | A FAIL's root cause: writer-fix vs spec-fix | `ask_jev` — choice; state = verifier findings |
| 4 | After 3 fix iterations: accept minors vs surface stalemate | `ask_jev` — choice; state = remaining findings |

Shape (triage example):

```
ask_jev({
  state: "<task title + rendered description>",
  paths: [<top relevant files>],
  command: "git ls-files | head -50",
  questions_json: {
    triage: {
      type: "score",
      instructions: "How complex is implementing this task end-to-end?",
      criteria: [
        "SIMPLE — approach fully decided by the task; mechanical edits; low blast radius; the harness fails loudly if wrong",
        "MODERATE — some real change but low risk or already-decided design; no silent-green failure modes",
        "COMPLEX — open design decisions the task doesn't pin, non-obvious edge cases, a test plan you must design, money/security blast radius or silent-green failure modes, long-horizon multi-step work"
      ]
    }
  }
})
```

Never decide triage by counting files or lines — surface substance only (the criteria above encode it). For point judgments about specific files during planning, prefer `ask_jev_file_bool` / `ask_jev_file_choice` / `ask_jev_file_score` over reading the file into context.

---

## Phase 0 — Intake & Triage

### 0a. Resolve the task source

**If the argument is a Linear ticket ID** (matches `[A-Z]+-[0-9]+`, e.g. `ENG-123`):
1. Use the `linear` MCP server to fetch the issue: title, description (render the ProseMirror `bodyData` to text), labels, and linked sub-issues/blockers.
2. Capture the rendered description as the task input.

**Free text** → use it directly. **No argument** → prompt the user for the task (one sentence is fine to start; Phase 1 expands it).

### 0b. Complexity triage via Jev (MUST)

Run the `ask_jev` triage above, then present to the user:

> Triage (Jev): `<SIMPLE|MODERATE|COMPLEX>` (confidence <n>) — <one-line substantive reason>. `<recommendation>`. Proceed?

Wait for the user's call.

- **SIMPLE** (or **MODERATE→direct**): exit this skill, do the work in the main session (still follow the repo's own conventions; hand the final commit to its push/PR skill if one exists).
- **MODERATE→orchestrate** only when the failure mode is silent-green (vacuous/wrong assertions a green harness won't surface) or the path is money-movement/security where an independent re-read is worth the cost.
- **COMPLEX** → continue to 0c.

This gate keeps the cascade reserved for work that actually benefits from it.

### 0c. Working context + artifacts

- **MUST sync the base branch before planning** so the plan and writer diffs target current code:

  ```bash
  BASE=$(git rev-parse --verify develop >/dev/null 2>&1 && echo develop || \
         (git rev-parse --verify main >/dev/null 2>&1 && echo main || echo master))
  git fetch origin "$BASE"
  git checkout "$BASE" && git pull --ff-only origin "$BASE"
  ```

  If the working tree has local changes that conflict with the pull, STOP and surface them — do not stash-and-yank unrelated work. If already on a feature branch with uncommitted work the user wants to keep, ask before switching.
- **Artifact directory** (repo-local, git-ignored): `.pi/tasks/orchestrate-<topic>/` — topic = ~2 kebab-case words (e.g. `fix-broadcast`). Write the raw task input to `input.md`. The plan goes to `plan.md`, frozen specs to `specs/T<n>.md`. Never write to repo-root `tasks/`.
- Branch creation waits for Phase 2.

---

## Phase 1 — Plan (main session, iterate with user until approved)

Planning happens here in the main session on the session's high-end model, with the user in the loop. **MUST NOT skip to code.** A bad plan wastes every downstream writer/verifier iteration.

### 1a. Discover the relevant code

Spawn read-only `explorer` agents (auto routing — self-contained one-shots):

```
delegate {
  tasks: [
    { agent: "explorer", cwd: <repo>,
      task: "Locate every file, symbol, and call site relevant to: <task>.
             Return the compressed map (path:line per hit, call graph, type shapes).
             Do not propose fixes. Return your findings as a structured summary." }
  ]
}
```

For larger tasks, fan out 2–4 explorers in one parallel batch, each scoped to a subsystem.

### 1b. Draft the plan

Write `.pi/tasks/orchestrate-<topic>/plan.md`:

```markdown
# Plan — <task title>

Source: <Linear ticket ID or "free-text task">
Date: <ISO>

## Problem
<2–4 sentences. What's wrong / what's needed.>

## Approach
<The chosen design. Why this over alternatives. 1–2 paragraphs.>

## Affected files
- `path/to/file.ts` — <what changes here>

## Implementation tasks (independent where possible)
- [ ] T1: <one-line description> — files: <list> — depends-on: none
- [ ] T2: <one-line description> — files: <list> — depends-on: T1

## Parallelization (MUST)
- Wave 1: T1, T3        ← parallel writers, disjoint files
- Wave 2: T2 (after T1), T4 (after T3)
- Wave 3: T5 (after T2, T4)
Rules: ≤8 tasks per wave; parallel tasks in the same wave MUST own disjoint
file sets — any shared file (INCLUDING test files) forces sequencing into
a later wave.

## Test plan
- <what tests to add/update, what existing tests cover this, how to run them>

## Risks / open questions
- <Q1: ...>

## Out of scope
- <explicitly not doing X>
```

The task list (`T1`, `T2`, …) and the wave table are what Phase 2 executes on. **The Parallelization section is mandatory** — ambiguous shared-file ownership across parallel writers is a proven failure mode: on a real cascade run, a writer told to create "ONE test file" in a shared tests dir deleted a sibling writer's test file mid-flight. Parallel tasks get named, individually-owned files or they get sequenced.

### 1c. Present to user and iterate

> Plan drafted at `.pi/tasks/orchestrate-<topic>/plan.md`. Please review — I'll iterate until you approve, then spawn persistent writers wave by wave.

**MUST wait for user feedback.** Apply edits to `plan.md` directly (plan/spec edits are your only allowed file edits). Re-present after each revision. On explicit approval ("looks good", "go", "approved"), append `<!-- approved: yes -->` to `plan.md` (the resume signal). Do not proceed to Phase 2 before approval.

If the user raises a design question you can't answer from the explorer maps, spawn another `explorer` or `research` agent, then update the plan.

---

## Phase 2 — Execute (parallel persistent writers)

### 2a. Branch + frozen specs

**MUST read the environment's push/PR convention skill first if one is configured** (e.g. `push-changes`) — it owns branch-naming and PR conventions; otherwise follow the repo's own contribution rules. Then:

```bash
git checkout -b <TICKET>-<short-description>   # e.g. ENG-123-fix-intent-verification
```

Do NOT use an `orchestrate/` prefix — it doesn't match ticket-linking hook conventions and the ticket won't be linked.

For **each** task, write a **frozen spec** `.pi/tasks/orchestrate-<topic>/specs/T<n>.md`:

```markdown
# Spec — T<n>: <one-line title>

## Context
<1–2 sentences linking to the plan. The writer reads THIS, not the plan.>

## File ownership (MUST for parallel tasks)
This task may touch ONLY:
- `path/a.ts`
- `tests/a.spec.ts`   ← its own named test file
It MUST NOT create, edit, or delete any other file — including other tasks'
files and shared dirs' contents.

## Files to edit
- `path/a.ts` — <precise change>

## Exact requirements
1. <MUST do X>
2. <MUST NOT change Z>
3. <No dictated constants — if a value is derived, give the FORMULA and let
   the writer compute it; a dictated wrong constant makes the writer twist
   correct code to match and a green test assert the wrong value.>

## Acceptance harness
- `npm run lint` — MUST exit 0
- `npm run typecheck` — MUST exit 0
- `npm test -- <scoped path>` — MUST exit 0

## Out of scope
- <do not touch W>
```

The spec is the writer's contract and MUST be unambiguous — a writer returning `BLOCKED` is usually reacting to a spec bug. Specs for wave-mates must partition file ownership explicitly and totally (see the Parallelization rule above).

### 2b. Spawn wave 1 writers (persistent batch)

Spawn ONE delegate call per wave (≤8 children), exactly as in the Persistent subagent contract. Do not spawn writers for trivial single-line fixes you can do in one `edit` yourself — the cascade overhead isn't worth it; reserve the loop for tasks touching 2+ files or needing test changes.

### 2c. Collect summaries; route BLOCKED via Jev

Each writer returns a structured summary (`harness: GREEN|RED`, `blocked: yes|no`, files touched, commands + exit codes). Record them.

- `BLOCKED` → **Jev choice** (`ask_jev`): spec-bug → fix the spec and spawn a fresh writer; genuine code issue → route to the verifier anyway for targeted assessment; needs-user → stop and ask.
- `harness: RED` → not a failure — route to the verifier anyway.

---

## Phase 3 — Verify (persistent verifier wave)

After a writer wave settles, spawn the matching verifier wave in ONE persistent batch (named `orch-<topic>-t<n>-verifier`), passing each verifier its writer's summary:

```
delegate {
  mode: "persistent",
  tasks: [
    { agent: "verifier", cwd: <repo>, name: "orch-<topic>-t1-verifier",
      task: "Verify the diff against spec .pi/tasks/orchestrate-<topic>/specs/T1.md.
             Writer summary: <paste writer's summary>.
             Re-run the acceptance harness independently.
             Check spec coverage item-by-item. Return the verifier report format exactly.
             Return your findings as a structured summary." }
  ]
}
```

The verifier returns `VERDICT: PASS | FAIL | BLOCKED` plus severity-tagged findings.

- **PASS** → mark `- [x] T<n>` in `plan.md` (the resume signal). If this unblocks dependents, spawn the next wave's writers now.
- **FAIL** → **Jev root-cause choice** (`ask_jev` over the findings): writer-fix → Phase 4 with the same children; spec-fix → fix the spec and spawn a fresh writer (`-r2` handle). Real cascade runs showed several FAILs were spec ambiguity, not writer error — patch the spec bug FIRST when that's the root cause.
- **BLOCKED** → spec-level problem. Resolve it yourself (update the spec, answer the design question, or ask the user), then fresh writer.

---

## Phase 4 — Steerable fix-loop (writer ↔ verifier, same children, until clean)

For each `FAIL` finding set:

1. **MUST NOT filter or paraphrase findings.** The verifier wrote precise `file:line` + `FIX:` instructions; relaying them verbatim via `subagent_send` (shape in the Persistent subagent contract) preserves that precision.
2. The writer child applies fixes within its retained context and returns a new summary.
3. Steer the **same** verifier child for the re-grade.
4. **MUST cap the loop at 3 iterations per task.** Well-scoped tasks converge in 1–2 passes; a task needing 4+ usually has a spec problem. If still `FAIL` after 3 passes, run the **Jev stalemate choice** (`ask_jev` over the remaining findings): accept remaining `MINOR`/`NIT` (note them in the final summary) vs surface the stalemate to the user with the last verifier report and writer summary. Never silently ship a failing task.
5. If a fix-loop reveals a spec gap, treat it as the spec-rewrite exception: fix the spec, fresh writer child. Don't ad-hoc patch a frozen spec through a steered loop.

---

## Phase 5 — Finalize

Once every task is `PASS` (or accepted-with-minors):

1. **Run the full harness once more at the repo root** (lint + typecheck + full relevant test suite, not scoped). This catches cross-task integration breakage that per-task verification misses.
2. **Spawn one final integration verifier on the whole diff** (auto routing — self-contained):

   ```
   delegate {
     tasks: [
       { agent: "verifier", cwd: <repo>,
         task: "Final integration verification. Diff: git diff <base>...HEAD.
                Check that the combined diff implements the whole plan
                (.pi/tasks/orchestrate-<topic>/plan.md), no cross-task conflicts,
                full harness green. Return the verifier report format exactly.
                Return your findings as a structured summary." }
     ]
   }
   ```

3. If integration verify returns `PASS`: print the final summary (below), then ask the user whether to commit + push + open a draft PR. If yes, **MUST hand off to the environment's push/PR skill if configured** (e.g. `/push-changes`) — it owns staging, the Conventional Commit format with ticket footer, the signed push, and the draft PR. Do not reimplement those steps here.
4. If `FAIL`: route integration findings via `subagent_send` to the offending tasks' writer children (Phase 4 loop), then re-run this phase.

### Final summary (MUST print)

```
## Orchestrate complete — <task title>

Source: <Linear ticket ID or free-text>
Branch: <TICKET-short-description>   # per push/PR convention
Plan:   .pi/tasks/orchestrate-<topic>/plan.md

Tasks:
  T1: PASS (2 verifier iterations, steered) — files: a.ts, b.ts
  T2: PASS (1 verifier iteration, steered) — files: c.ts
  T3: PASS (accepted 1 minor) — files: d.ts

Integration verify: PASS
Full harness: GREEN

Files changed: <count>
Lines: +<N> / -<M>

Next: say "push" to commit + open a draft PR, or review the diff yourself.
```

---

## Orchestrator rules (non-negotiable)

1. **MUST plan before executing.** No code touches until `plan.md` carries `<!-- approved: yes -->`. The single biggest quality lever.
2. **MUST NOT edit code yourself during Phases 2–4.** You plan, decompose, spawn, steer, and route. (Plan/spec edits are the exception.)
3. **MUST pass verifier findings verbatim** into every `subagent_send`. No paraphrasing, no filtering.
4. **MUST run the verifier on every task.** Skipping it collapses the cascade to cheap-model quality.
5. **MUST spawn writer/verifier children persistent and steer them** through fix iterations. Respawn only for spec rewrites (`-r2` handles) or resume-after-loss.
6. **MUST cap the fix-loop at 3 iterations** and route the stalemate through Jev instead of grinding.
7. **MUST run a final integration verify** — per-task PASS does not guarantee combined PASS.
8. **MUST execute the plan's Parallelization section:** parallel waves of ≤8 persistent writers, disjoint file ownership per parallel task (including test files), dependent tasks sequenced behind their dependencies.
9. **MUST NOT commit or push during Phases 1–4.** All committing is owned by the push/PR skill in Phase 5. Track PASSed tasks by checking their boxes in `plan.md` (also the resume signal); keep changes uncommitted until final handoff.
10. **MUST route every decision-point through Jev** (triage, BLOCKED routing, FAIL root-cause, stalemate) and surface consequential calls to the user.
11. **MUST NOT pass `model` or `tools` in delegate calls** for these agents — their frontmatter pins the roles and allowlists.
12. Every subagent prompt ends with: `Return your findings as a structured summary.`

## Resume support

If the session is killed and `/orchestrate` is re-invoked, recover from the working tree and live children (no interim commits exist by design — don't look for `git log` checkpoints):

- `.pi/tasks/orchestrate-<topic>/plan.md` exists with `<!-- approved: yes -->` → skip to Phase 2. `- [x] T<n>` boxes are PASSed tasks (their uncommitted `git status` diff is landed work — leave it); `- [ ]` boxes still need their loop.
- `subagent_list()` → steer existing `orch-*` children (idle or resumed-from-disk) instead of respawning; spawn fresh only for tasks never started.
- Missing artifacts (no `plan.md` / no `input.md`) → start from Phase 0a.

Never redo a PASSed task.

## When NOT to use this skill

These are pre-invocation hints — if unsure, invoke anyway and the Phase 0b Jev triage will route:

- Single-file, <20-line change with an obvious edit → do it directly; cascade overhead isn't worth it.
- Pure investigation / "where is X?" → `explorer` directly.
- Doc-only changes → the writer/verifier loop adds nothing over a direct edit.
- Anything needing tight user back-and-forth mid-edit → subagents have no user channel; do it in the main session.

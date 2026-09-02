---
name: add-rule
description: Evaluates a requested coding rule, decides whether it belongs as a TTSR stream rule (the only bucket that justifies a rule file) or should be skipped/put in CLAUDE.md, crafts a valid trigger, validates it, writes the rule file, and reloads the rules engine. Use when the user says "add a rule for X", "make a rule that the agent shouldn't do Y", "whenever I do Z, remind the agent to W", or similar.
---

# add-rule

You are adding a rule to the pi TTSR rules engine (the
`~/.pi/agent/extensions/ttsr/` extension). Follow this end to end. Do not skip
steps. Do not write the rule file until step 5.

## Step 1 — Understand the failure

Restate, in one sentence, the **mistake the model would make** that the rule is
meant to prevent. If the user's request is aspirational ("the agent should
always be careful with X") rather than about a **specific, recognizable slip-up**,
say so — the rules system is for TTSR only; the guidance belongs in CLAUDE.md.

Identify concretely:
- What does the model **emit** (prose, thinking, or tool arguments) when it slips?
- What is the **specific signal** that the slip is happening?
- What should the model **do instead**?

If you cannot state the signal in one sentence, the rule is not ready. Ask the
user one focused question, then proceed.

## Step 2 — Pick the bucket (decision tree)

**The rules system only earns its keep with TTSR.** TTSR rules cost zero tokens
until they fire; every other bucket is a perpetual tax with no dormant advantage.
Run the candidate through this tree in order. Stop at the first match.

1. **Can you write a regex (or ast-grep pattern) that matches the model's own
   output stream *when it is about to repeat the mistake*?** This is the
   **only bucket that justifies a rule file.**
   - Regex on prose/thinking → **TTSR** with `scope: [text]` or `[thinking]`.
   - Regex on a bash command's arguments → **TTSR** with `scope: [tool]`.
   - Regex on a tool/MCP tool name → **TTSR** with `scope: [tool]`, `interrupt: false`
     (the reminder is prepended to the tool result, non-blocking).
   - Regex on a file path being edited → **TTSR** with `scope: [tool]`, `globs`,
     `interrupt: false` (fires when the model edits a file in a watched dir).
   - ast-grep structural pattern on code being written by `edit`/`write` → **TTSR**
     with `scope: [tool]` + `astCondition`.
   - "Read doc X before doing Y" → **TTSR tool-scope non-interrupting**, where the
     condition matches the command/tool that precedes the need to read.

2. **Is there genuinely NO detectable single trigger?** (e.g. multi-step symptom
   investigation like "stuck queue workers" — not one command, a workflow). →
   **rulebook**, but only as a last resort. The validator will warn that this
   belongs in CLAUDE.md's context tree, and it's right — the rulebook bucket
   offers no advantage over a tree row in CLAUDE.md. Use it only if the guidance
   is too long for a tree row AND has no trigger. Otherwise, put it in CLAUDE.md.

3. **Is the request a short, always-relevant invariant?** → **Do not make a
   rule.** Put it in `AGENTS.md` / `CLAUDE.md`. Always-apply is perpetual token
   tax with zero TTSR advantage — it's the opposite of what the rules system is
   for. The validator will reject it.

4. **None of the above?** → **Do not add a rule.** Tell the user why and where
   the guidance actually belongs (a code comment, `AGENTS.md`, a doc file, or
   nowhere). Producing no rule is the correct outcome when the bar isn't met.

## Step 3 — Quality gates (all five must pass, or skip)

Before drafting, check every gate. State each as a yes/no.

1. **Prevents a real failure?** Would this rule have avoided a compilation
   error, test failure, dead-end approach, or user correction that actually
   happens?
2. **Reusable?** Could the same slip recur in future sessions? One-off typos
   and environment-specific issues do not qualify.
3. **Non-obvious?** Would the model avoid this from general knowledge alone?
   Standard library APIs, basic syntax, well-documented behavior don't need
   rules.
4. **Actionable?** Does the rule tell the model exactly what to do
   differently, not just what went wrong?
5. **Worth the cost?** Every rule adds to future sessions. A failure that
   wastes 2 minutes and is unlikely to recur doesn't justify a rule that costs
   tokens indefinitely.

If any gate fails, **do not add the rule**. Report which gate failed and why.
Do not lower the bar to justify a marginal rule.

## Step 4 — Craft the trigger

### For regex (`condition`)

- **Anchor on specific identifiers** — function names, import paths, API calls,
  config keys, exact flags — not generic syntax.
- **Narrow over broad.** A trigger that misses sometimes is better than one
  that fires on unrelated output.
- **Escape regex special characters** properly in the YAML string.
- Ask yourself: *"Would this regex fire during a different, legitimate task in
  this project?"* If yes, narrow it (add an identifier, anchor, or word
  boundary).
- For bash-tool rules, match the command shape, e.g.
  `git commit -m` (without `--amend`) rather than just `commit`.
- Multiple patterns are OR'd. Use a list: `condition: ["pat1", "pat2"]`.

**Anti-patterns (reject these):**
- `import .* from` — matches every import
- `function` — matches any function definition
- `TODO` — matches any comment
- Triggers that would match *user* input (user input is not the model's stream)

### For ast-grep (`astCondition`)

- Only evaluated on `scope: [tool]`, against the text introduced by `write`
  (full `content`) or `edit` (`newText`). Language is inferred from the file
  extension: `.ts/.tsx/.js/.jsx/.css/.html`.
- Write the pattern as code with metavariables: `console.log($$$)`,
  `if ($X) clearTimeout($X)`.
- A **repeated** metavariable (`$X ... $X`) requires both occurrences to bind
  equal — use this to enforce "same variable" constraints.
- A **multi** metavariable (`$$$ARGS`) matches zero-or-more.
- For languages not in the default set (Python, Rust, Go, …), tell the user
  they need to `npm install @ast-grep/lang-<x>` and register it in the
  extension's `EXT_TO_LANG` map first.

### Scope, interrupt, repeat defaults

- `scope`: include only what the signal lives in. `text` for prose, `thinking`
  for reasoning blocks, `tool` for bash/write/edit args. Don't add scopes you
  don't need.
- `interrupt`: default `true` for text/thinking (abort + remind), `false` for
  tool (prepend reminder to the tool result). Override to `true` on a tool rule
  when the action is destructive enough to block (e.g. a prod migration
  command, a force-push without `--with-lease`).
- `repeat: once` for most rules. Use `after-gap:3` only if the same slip
  genuinely recurs within a session and one shot isn't enough.
- `globs`: optional path gate for tool-scope rules, e.g.
  `["**/*.ts", "**/*.js"]`. Use when the pattern is language/file specific.

## Step 5 — Write the rule file

### Placement

- **User-scope** (applies to all projects): `~/.pi/agent/rules/<name>.md`
- **Project-scope** (this repo only, requires trust): `<cwd>/.pi/rules/<name>.md`
  (or `.omp/rules/` for omp portability).

Default to **project-scope** unless the rule is a personal/workflow convention
that applies everywhere. Ask the user if unclear; don't assume.

### Filename

`<name>.md` where `<name>` is kebab-case, matches the `name:` frontmatter, and
describes the mistake ("no-temp-fixes", "amend-lint-fixes",
"no-guarded-cleartimeout") — not the virtue ("good-comments").

### File template — TTSR (regex)

```
---
name: <kebab-name>
condition: ["<regex>"]
scope: [text, tool]
interrupt: true
repeat: once
---

# <Brief problem statement>

<2-3 sentences: what goes wrong, why, and what to do instead. No preamble, no
"best practices", no "note that". Specific enough that a future session can
follow it without context.>
```

### File template — TTSR (ast-grep)

```
---
name: <kebab-name>
astCondition: ["<pattern>"]
scope: [tool]
interrupt: true
repeat: once
globs: ["**/*.ts", "**/*.js"]
---

# <Brief problem statement>

<What goes wrong, why, what to do instead.>
```

### File template — rulebook (last resort; prefer CLAUDE.md)

```
---
name: <kebab-name>
description: "One sentence: when this applies"
globs: ["**/some-dir/**"]
---

# <Topic>

<Guidance. Can be longer than a TTSR body, but still specific.>
```

### File template — always-apply (DO NOT USE)

Do not create always-apply rules. Put short invariants in `AGENTS.md` / `CLAUDE.md`
instead. The validator rejects always-apply rules. Always-apply is perpetual
token tax with zero TTSR advantage — it's the opposite of what the rules system
is for.

### Rule body guidelines

- 2-3 sentences for TTSR. Prefer "use X instead" over full code examples.
- Name the correct approach over showing syntax — the model knows the language.
- No preamble, no generic advice, no "best practices", no "note that".
- Every token in a rule is a token paid each time the rule is loaded. Be terse.

## Step 6 — Validate

Run the validator from the skill directory:

```bash
node scripts/validate-rule.js <path-to-new-rule.md> --sample "<text the model would emit when slipping>"
```

For a TTSR regex rule, **always** pass `--sample` with a realistic snippet of
the bad output and confirm it prints `MATCH`. If it prints `no-match` or
`COMPILE ERROR`, fix the regex and re-run until `OK — rule is valid.`

For an ast-grep rule, the validator checks metavariable sanity and bucket
policy; also write the bad snippet to a temp file and confirm the pattern
matches via `node -e "const {parse,Lang}=require('@ast-grep/napi'); const r=parse(Lang.TypeScript, require('fs').readFileSync('<tmp>','utf8')).root(); console.log(r.find('<pattern>')?'MATCH':'no')"` before proceeding.

The validator enforces the bucket policy: it will ERROR on always-apply rules
and on rulebook entries that name a specific command, and WARN on rulebook
entries with no trigger (they belong in CLAUDE.md). Do not proceed until the
validator exits 0.

## Step 7 — Reload and confirm

Reload the rules engine without restarting pi:

```
/ttsr-reload
```

Then list to confirm the new rule is armed:

```
/ttsr
```

Tell the user the rule is live, its bucket, its trigger, and whether it will
abort+remind (text/thinking) or block (tool). Show the one-line status from
`/ttsr`.

## Step 8 — Propose CLAUDE.md / AGENTS.md trim (when relevant)

If the new TTSR rule replaces prose that currently lives in `CLAUDE.md` or
`AGENTS.md`, tell the user exactly which lines can now be removed (the always-on
prose is now redundant with the dormant TTSR rule that costs zero until it
fires). Offer to make the edit. Do not edit `CLAUDE.md` / `AGENTS.md` without
confirmation.

## Anti-patterns — do NOT

- Do not add a rule for one-off issues that won't recur (a typo, a misconfigured
  local env).
- Do not add a rule for a bug that has been fixed (the rule goes stale
  immediately).
- Do not add a rule for something that belongs in a code comment on one
  specific line in one specific file.
- Do not use `alwaysApply: true` — it is perpetual token tax with zero TTSR
  advantage. Put short invariants in `AGENTS.md` / `CLAUDE.md` instead. The
  validator rejects always-apply rules.
- Do not use the rulebook bucket when a trigger exists. If the guidance says
  "before X" or names a command/tool, make it TTSR tool-scope non-interrupting.
  The validator errors on rulebook entries that name specific commands.
- Do not write a broad trigger "to catch more cases". Broad triggers fire on
  unrelated output and erode trust in the system.
- Do not skip the validator. A regex that doesn't compile or doesn't match the
  sample is a rule that does nothing.
- Do not create the rule file in both user and project scope with the same name
  — first-wins discovery will shadow one. Pick a scope.

## Reference

- Engine + buckets: `~/.pi/agent/extensions/ttsr/README.md`
- Existing rules: `~/.pi/agent/rules/` and `<cwd>/.pi/rules/`
- Validator: `scripts/validate-rule.js` in this skill directory

# TTSR rules for pi

A pi extension that brings omp's TTSR (Time-Traveling Stream Rules) to stock
`@earendil-works/pi-coding-agent`, with ast-grep structural matching.

## The bucket: TTSR

**TTSR is the only bucket that justifies a rule file.** Rules sit dormant until
the model's live output stream matches a regex or ast-grep pattern; then they
abort+remind (text/thinking) or block/prepend (tool). **Zero tokens until a
match fires.**

Other buckets exist in the engine for legacy compatibility but are rejected by
the validator:
- **always-apply** (`alwaysApply: true`) — perpetual token tax, zero TTSR
  advantage. Put short invariants in `AGENTS.md` / `CLAUDE.md`. The validator
  errors on it.
- **rulebook** (`description`, no condition) — a passive one-line description in
  every system prompt, body on demand. The validator errors if it names a
  specific command (convert to TTSR tool-scope non-interrupting instead) and
  warns otherwise (it belongs in CLAUDE.md's context tree — no advantage over
  it). The only legit use is guidance with NO single-command trigger (e.g.
  multi-step symptom investigation) that's too long for a CLAUDE.md tree row.

## Install

Already at `~/.pi/agent/extensions/ttsr/` (auto-discovered). Restart pi or `/reload`.
Native deps (`@ast-grep/napi`, `typebox`) are in `package.json`; run `npm install`
in this directory once if `node_modules` is missing.

Verify:
```
/ttsr
```

## Rules

Drop `.md` files in any of (first-wins by `name`):

- `.pi/rules/` and `.omp/rules/` (project, requires trust)
- `~/.pi/agent/rules/` and `~/.omp/agent/rules/` (user)

### Frontmatter

```yaml
---
name: my-rule                              # required, kebab-case
condition: ["regex1", "regex2"]            # TTSR regex, OR'd
astCondition: ["if ($X) clearTimeout($X)"] # TTSR ast-grep, OR'd (tool scope only)
scope: [text, thinking, tool]              # default: all three
globs: ["src/**/*.ts"]                     # optional path gate (tool scope only)
interrupt: true                            # default: true for text/thinking, false for tool
repeat: once                               # "once" | "after-gap:3"
flags: i                                   # optional regex flags (e.g. i for case-insensitive)
---
Rule body — the reminder injected on match.
```

Legacy aliases: `ttsrTrigger`/`ttsr_trigger` → `condition`; `ast_condition` → `astCondition`.

## TTSR trigger patterns

| Signal lives in | Scope | Interrupt | Example |
|-----------------|-------|-----------|---------|
| prose / thinking | `text` / `thinking` | `true` (abort + remind) | "I'm done" → verify-before-done |
| bash command args | `tool` | `true` blocks, `false` prepends reminder to tool result | `git push --force` without `--with-lease` |
| MCP tool name | `tool` | usually `false` | `grafana` → "read the observability runbook first" |
| file path being edited | `tool` + `globs` | usually `false` | edits in `**/migrations/**` → "read the migration guide first" |
| code structure (write/edit content) | `tool` + `astCondition` | usually `true` | `if ($X) clearTimeout($X)` |

## ast-grep structural matching

`astCondition` patterns are matched with `@ast-grep/napi` against the text being
introduced by `write`/`edit` tool calls (the new content, not the full file
snapshot). Language is inferred from the file extension:

- `.ts` `.mts` `.cts` → TypeScript
- `.tsx` → Tsx
- `.js` `.mjs` `.cjs` `.jsx` → JavaScript
- `.css` → Css, `.html` `.htm` → Html

Repeated metavariables (`$X ... $X`) must bind equal — same semantic as omp.
Multi-metavariables (`$$$ARGS`) match zero-or-more. If the native module fails to
load, the extension degrades to regex-only and warns on session start.

For other languages (Python, Rust, Go, …) install the matching `@ast-grep/lang-*`
package and register it — see the `langFromPath` map in `index.ts`.

## Commands

- `/ttsr` — list all rules with armed/fired status and AST on/off
- `/rules` — alias for `/ttsr`
- `/ttsr-reload` — reload rules from disk without restarting
- `/omfg <complaint>` — draft a TTSR rule: prompts for a regex trigger + name,
  writes `.pi/rules/<name>.md`, then `/ttsr-reload`

## Tools

- `read_rule` — callable by the LLM; loads a rulebook rule's full body by name.
  Only useful for the rare rulebook entry that passed the validator.

## Persistence

Fired TTSR rules are recorded as `ttsr-injection` custom entries in the session
and restored on resume, so `repeat: once` suppression survives compaction and
reload.

## Honest limitations vs omp's native TTSR

1. **No mid-stream retry-from-same-point.** pi's public extension API has no
   `agent.continue()` or in-place message slicing. After aborting a text/thinking
   match, the reminder is queued as a follow-up user message (fresh turn); the
   aborted partial stays in context (`contextMode: keep` is the only mode).
   omp can discard the partial and retry mid-stream.
2. **AST matching covers introduced text only** (the `newText` of an edit, or the
   full `content` of a write), not the full reconstructed file snapshot omp uses.
3. **Tool-scope "interrupt" blocks the call** rather than aborting mid-stream;
   the reminder is delivered as the block reason (the tool result the model sees).
   This is the reliable pi-native equivalent and course-corrects on the same turn.

These are inherent to building on pi's public event API rather than inside the
agent engine. For the full feature set, run omp.

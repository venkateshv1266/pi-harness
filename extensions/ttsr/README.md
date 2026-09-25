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
verify: {"type":"noul","instructions":"...","threshold":0.8}  # optional Jev intent gate
---
Rule body — the reminder injected on match.
```

Legacy aliases: `ttsrTrigger`/`ttsr_trigger` → `condition`; `ast_condition` → `astCondition`.

## Jev verification (second-stage arbiter)

Regex/AST matching stays the free pre-filter; a rule can additionally declare a
`verify:` question so that a match only acts once a fast structured-decision
model (TypeSafe Jev) confirms the *intent* behind the match. The call happens
only after the pre-filter fires, so the zero-cost-until-match property holds.

```yaml
verify: {"type":"noul","instructions":"Is this actually X?","threshold":0.8,"onFail":"degrade"}
```

- `type`: `noul` (yes/no 0–1) | `choice` (requires `criteria` object) | `score`
  (requires `criteria` array). Fires when calibrated probability ≥ `threshold`
  (default 0.8) and confidence ≥ `minConfidence` (default 0).
- `onFail` (Jev unreachable / malformed answer): `fire` = status-quo behavior
  (use for fail-closed gates), `degrade` (default) = interrupt rules remind
  without aborting and tool blocks become prepends, `suppress` = stay armed
  silently.
- A suppressed match does **not** consume the `repeat: once` budget — the rule
  stays armed. All adjudications are appended to
  `~/.pi/agent/jev-decisions/ttsr-jev.jsonl` for threshold tuning.
- Simultaneously-matched rules are batched into one call. Stream-scope matches
  verify asynchronously (the stream keeps flowing; abort fires on confirmation)
  and are re-checked if the buffer grows ≥2000 chars since the last check.
- Matched text is sent as a bounded window around the first match (tool inputs
  capped at 24k chars) after scrubbing obvious secret shapes.

### Config (env)

| Variable | Default | Purpose |
|---|---|---|
| `JEV_API_KEY` / `OPENROUTER_API_KEY` | key from `~/.pi/agent/auth.json` | System One API key |
| `JEV_BASE_URL` | `https://openrouter.ai/api` | base URL, `/v1/systemone` is appended |
| `JEV_MODEL` | `jev-latest` | System One model ID |
| `JEV_TIMEOUT_MS` | `2000` | on timeout the `onFail` policy applies |
| `TTSR_JEV` | unset | set `0` to disable verification globally |

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
   match, the extension waits for the aborted run to settle (capped at 15s) and
   re-prompts with the reminder as a fresh user turn; the aborted partial stays
   in context (`contextMode: keep` is the only mode). A follow-up queued while
   the run is still settling would be stranded — pi's loop exits early on
   `stopReason: "aborted"` without draining the follow-up queue — hence the
   settle-wait. omp can discard the partial and retry mid-stream.
2. **AST matching covers introduced text only** (the `newText` of an edit, or the
   full `content` of a write), not the full reconstructed file snapshot omp uses.
3. **Tool-scope "interrupt" blocks the call** rather than aborting mid-stream;
   the reminder is delivered as the block reason (the tool result the model sees).
   This is the reliable pi-native equivalent and course-corrects on the same turn.

These are inherent to building on pi's public event API rather than inside the
agent engine. For the full feature set, run omp.

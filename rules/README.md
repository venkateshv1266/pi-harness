# Rules

Generic, shareable [TTSR](../extensions/ttsr/README.md) (Time-Traveling Stream
Rules) for pi. Rules sit dormant with **zero token cost** until the model's
live output or a pending tool call matches a trigger; only then is the rule
body injected, and most rules interrupt the offending action so the model can
course-correct on the same turn.

`install.sh` copies every rule here into `~/.pi/agent/rules/` **without
`--delete`** — your own rules are never removed, and a same-named local rule
shadows the repo version (first-wins). Delete any rule you disagree with before
installing, or override it with a same-named file in `~/.pi/agent/rules/`
(or `.pi/rules/` per project). Run `/ttsr-reload` after changing rules.

## Git discipline

| Rule | Fires when | Effect |
|---|---|---|
| `amend-ci-fixes` | a `git commit -m` / `--message` / `-am` tool call | blocks; reminds to fold a trivial lint/format/type CI fixup into the previous commit with `--amend --no-edit` + force-with-lease |
| `no-force-without-lease` | a force flag on `git push` without `--with-lease` | blocks; reminds to use `--force-with-lease` |

## Secrets and safety

| Rule | Fires when | Effect |
|---|---|---|
| `no-hardcoded-api-keys` | a string-literal assignment of an API key or secret (case-insensitive) | blocks |
| `no-placeholder-api-key` | placeholder token/secret literals passed as real values | blocks |
| `no-prod-migrations-local` | a prod-mode migration command (`--mode=prod`, production `NODE_ENV`) | blocks; points at the ops job / CI pipeline |

## Code quality

| Rule | Fires when | Effect |
|---|---|---|
| `no-ts-any` | TypeScript `any` annotations or casts in TS/JS writes | blocks |
| `no-ts-ignore` | ts-ignore / ts-nocheck directives or blanket eslint disables | blocks |
| `no-empty-catch` | empty catch blocks (ast-grep) | blocks |
| `no-guarded-cleartimeout` | a clearTimeout guarded by its own timer variable (ast-grep) | blocks |
| `no-console-log-in-prod-code` | a `git commit` while changed code still contains `console.log` (Jev verify gate) | blocks; reminds to strip it or use the project logger |
| `no-localhost-in-prod-code` | hardcoded loopback URLs with a port | reminder (non-interrupting) |
| `no-temp-fixes` | hack/FIXME-temporary markers, "for now", or "quick fix" in prose or code | blocks |

## Workflow and process

| Rule | Fires when | Effect |
|---|---|---|
| `verify-before-done` | claiming "done" / "complete" / "finished" in prose | aborts the stream; reminds to run lint, typecheck, and the tests touching the change |
| `replan-after-repeated-test-failure` | admitting the same test/build/typecheck failure again, or about to repeat a fix cycle | aborts; Jev gate suppresses when a materially new cause is being tested |
| `no-console-log-prose` | announcing a throwaway debug logging call | aborts |
| `delegate-read-only-exploration` | announcing an inline broad repo survey | aborts; points at the `explorer` / `research` subagents |
| `search-before-creating-utility` | any write under `utils/`, `lib/`, `shared/`, `common/`, or `helpers/` | reminder to grep for an existing helper first |
| `tests-validate-behavior-not-implementation` | snapshots or heavy mocks in test files | reminder to assert against known-good values |
| `concurrency-retry-contract` | concurrency / idempotency / retry / in-flight semantics in text or thinking | aborts; Jev gate suppresses when the task is not changing concurrency semantics |
| `kubectl-logs-via-jev` | an unbounded `kubectl` log dump | blocks; suggests saving to a file and using the Jev log-triage MCP tool; the Jev gate degrades to a reminder when Jev is unreachable |
| `no-raw-log-dumps` | a raw log dump: `read`/`cat` of `.log`/`.out`/`.ndjson`/`.jsonl` files, `journalctl`/`dmesg`, `gh run --log` / `gh run watch` CI logs, or a `pi-mcp-spillover` file | blocks once; suggests `triage_log` (ask-jev) with the file path first; small bounded peeks are allowed through |
| `ask-jev-for-file-judgments` | a read issued to answer a yes/no / which-one / how-risky question about a file | blocks the read; routes to `ask_jev_file_bool` / `ask_jev_file_choice` / `ask_jev_file_score`, `ask_jev_files` + `pick_first_file`, or `triage_log`; the Jev gate suppresses edit-prep reads and stays silent on Jev outage |
| `no-respawn-after-failure` | re-spawn / re-run phrasing after a delegated subagent fails (`spawn a new <agent>`, re-run … from scratch) | aborts; reminds to resume the retained session (`subagent_wait` / `subagent_send`) — Jev gate suppresses doc/quote mentions, fires anyway on Jev outage |

`kubectl-logs-via-jev` assumes a `jev` MCP server exposing its log-triage tool.
Without it, ignore or override the rule — its advice cannot be followed.

## Frontmatter

```yaml
---
name: my-rule                              # required, kebab-case
condition: ["regex1", "regex2"]            # TTSR regexes, OR'd
astCondition: ["if ($X) clearTimeout($X)"] # ast-grep patterns, OR'd (tool scope only)
scope: [text, thinking, tool]              # default: all three
globs: ["src/**/*.ts"]                     # optional path gate (tool scope only)
interrupt: true                            # default: true for text/thinking, false for tool
repeat: once                               # "once" | "after-gap:3"
flags: i                                   # optional regex flags (e.g. i)
verify: {"type": "noul", "instructions": "…", "threshold": 0.8, "onFail": "suppress"}
safety: true                               # optional: exempt from /decision-tuner pruning
---
Rule body — the reminder injected on a match.
```

| Field | Meaning |
|---|---|
| `name` | Rule identity; first-wins when two files share a name |
| `condition` | Regexes matched against streamed text/thinking or the tool input (OR'd) |
| `astCondition` | [ast-grep](https://ast-grep.github.io/) patterns matched against the text an edit/write introduces (tool scope only) |
| `alwaysApply` | `true` injects the rule unconditionally (rare; no trigger needed) |
| `scope` | Which streams it watches: `text`, `thinking`, `tool` |
| `globs` | Path gate for tool-scope rules |
| `interrupt` | Interrupting text rules abort the stream; interrupting tool rules block the call and deliver the body as the block reason. Non-interrupting rules inject the reminder without stopping anything |
| `repeat` | `once` fires at most once per session; `after-gap:N` re-arms after N turns |
| `flags` | Regex flags, e.g. `i` for case-insensitive |
| `verify` | Optional Jev intent gate: only fire when a second model judges the match intentional. `onFail`: `suppress` (stay silent), `degrade` (default — remind without blocking), `fire` (fail closed) |
| `safety` | `true` exempts the rule from `/decision-tuner` prune proposals |

Legacy aliases: `ttsrTrigger` / `ttsr_trigger` → `condition`;
`ast_condition` → `astCondition`.

## Authoring

Use the [`add-rule`](../skills/add-rule/SKILL.md) skill: failure analysis,
bucket choice, trigger crafting, Jev gate decision, and the validator
(`node skills/add-rule/scripts/validate-rule.js rules/my-rule.md --sample "…"`).
A malformed `verify:` block is silently dropped by the engine, so validate
before shipping.

This README intentionally has no YAML frontmatter: the TTSR loader parses every
`.md` under a rules directory and skips files without a frontmatter block, so
this file is never treated as a rule.

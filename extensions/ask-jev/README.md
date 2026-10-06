# ask-jev

> Jev (System One) as agent tools: typed judgments about files and logs without reading them into context.

## What it does

Gives the model seven direct tools that answer pre-declared question shapes — noul (yes/no probability), choice (one of your options), score (position on your levels) — with confidences, in ~300ms for a fraction of a cent. Code gathers the state: it reads the files, expands the globs, and runs one read-only command, so a 50KB file is judged for $0.0002 without ever entering the model's context. This is the in-process replacement for the former `jev` MCP server (`jev_classify` / `jev_score` / `jev_triage_log`), whose generic tools forced the model to relay state through its own context.

The agent learns when to reach for these from a system-prompt nudge injected at `before_agent_start`, not from a hook that fires on its own.

## Commands and tools

| Tool | What it does |
|---|---|
| `ask_jev_file_bool(path, question, yes?, no?)` | Yes/no about one file. Returns `{ answer, noul, confidence }`. |
| `ask_jev_file_choice(path, question, options)` | Pick one of 2-255 options about one file. The pick is always one of your options. |
| `ask_jev_file_score(path, question, levels)` | Position on a scale you define (2-16 levels, lowest first); `normalized` maps it to 0-1. |
| `ask_jev_files(paths_or_globs, questions_json, recursive?)` | Same question block asked of every matched file, one Jev call per file in parallel. Caps at 255 files. |
| `pick_first_file(question, candidates)` | Second pass after `ask_jev_files`: which file to open first. Returns `path: null` when nothing fits. |
| `ask_jev(questions_json, state?, paths?, command?)` | Level 10: the model writes the question block itself over state it assembles — short text, up to 20 paths, one read-only command. |
| `triage_log(file|text, question, ...)` | Log prefilter: scores every line for relevance, returns top-k with ±2 context lines; ERROR/FATAL/traceback lines pass through deterministically. Optional failure-type classification. Port of the former MCP tool. |

## Configuration

No settings keys. Environment (all read by [`utils/jev-client.ts`](../../utils/README.md)):

| Env var | Default | Effect |
|---|---|---|
| `JEV_API_KEY` / `OPENROUTER_API_KEY` | unset → `~/.pi/agent/auth.json` `openrouter.key` | API key resolution chain. |
| `JEV_BASE_URL` | `https://openrouter.ai/api` | System One endpoint. |
| `JEV_MODEL` | `jev-latest` | Model id. |
| `JEV_TIMEOUT_MS` | `10000` | Per-call timeout (one retry on 429/5xx/network). |
| `JEV_CONCURRENCY` | `6` | Parallel Jev calls for `ask_jev_files` and `triage_log` chunks. |

State: every call appends an event to `~/.pi/agent/jev-decisions/ask-jev.jsonl` (system `ask-jev`), auto-discovered by `decisions-report` and `decision-tuner`. A run summary (calls + cost) is logged at `agent_end` and shown as a UI notification when calls were made.

## How it works

`before_agent_start` appends the usage nudge once (marker `ask-jev-nudge-v1`; `before_agent_start` replaces the whole prompt, so the marker check keeps re-runs idempotent). File reads enforce a 150k-char budget (100k in `ask_jev_files`), sniff binaries, and `ask_jev_files` silently drops `node_modules`/`.git`/build output, lockfiles, and binary/generated extensions (`filtered` count in the result). The `command` parameter only accepts the read-only prefixes shared with `jev-guard`'s fast path (`utils/jev-client.ts` `READONLY_BASH_PREFIXES`) — deliberately excluding `find` (`find . -delete`) and anything that executes project code. Secrets are scrubbed from every state centrally in the shared client.

## Caveats

- Jev unavailable (no key, timeout) makes the tools return errors — they are model-invoked, so the model sees the failure and falls back to `read`. There is no silent degradation.
- `ask_jev_files` costs one Jev call per file; a 255-file glob with 5 questions is still under a cent, but point it at directories rather than repo roots.
- Jev answers are snap judgments with confidences, not reasoning — treat a 0.55 like a coin flip and read the file when it matters.
- Jev narrows logs; it does not conclude. `triage_log` evidence still needs root-cause analysis by the model.
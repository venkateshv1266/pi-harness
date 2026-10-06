# jev-guard

> Invisible Jev guardrails: a confidence-gated bash command gate and a prompt-injection screen on tool results.

## What it does

The agent never knows this extension is here. Before a bash command runs, commands off the read-only fast path get one Jev call classifying their effect (readonly / reversible / irreversible) and destructive intent, both with confidence; clear destruction blocks, gray areas ask the user once, everything else passes silently. After `read`, `bash`, and `web_fetch` results, outputs are screened once for instructions aimed at an AI agent; flagged results get a warning banner prepended and the agent still sees the content, marked as untrusted data.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `JEV_GUARD` | unset | `0` disables both hooks for the session. |
| `JEV_GUARD_TIMEOUT_MS` | `4000` | Per-call Jev timeout for gate and screen (gates must not stall a turn). |

Plus the shared client env from [`utils/jev-client.ts`](../../utils/README.md) (`JEV_BASE_URL`, `JEV_MODEL`, key resolution). State: every Jev-judged decision appends to `~/.pi/agent/jev-decisions/jev-guard.jsonl` (system `jev-guard`); a run summary is logged at `agent_end`.

## How it works

`tool_call` on `bash`: the shared `READONLY_BASH_PREFIXES` list (git status/diff/log/show, ls, cat, rg, ...) passes with no Jev call. Anything else is classified once per command string (session cache, 500 entries) — repeat commands are free. Tier matrix:

- `readonly` with confidence ≥ 0.75 → allowed silently.
- destructive intent ≥ 0.7 and (`irreversible`, or destructive confidence ≥ 0.85) → **blocked**, with a reason that is final for the session.
- Gray zone (`irreversible` and confident and destructive ≥ 0.4, or either confidence < 0.5) → `ctx.ui.confirm` when a UI exists; headless (subagents, codemode) allows and logs `allowed-headless`, since pi's trust model still governs.
- Everything else (reversible, plain installs/builds/tests) → allowed silently.

`tool_result` on `read`/`bash`/`web_fetch`: texts over 1500 chars are probed once (first 6000 chars, sha256-deduped, 100 screens/session) with one noul question; a score ≥ 0.7 prepends a `<system-warning source="jev-guard">` banner and passes `structuredContent` through untouched.

Both hooks fail **open**: a Jev outage or any internal handler error logs a `degraded` event and lets the call through — pi reports a thrown `tool_call` handler error by blocking the tool, so every path catches and degrades instead. The cache and verdicts reset with the session.

## Caveats

- First sight of an unrecognized command adds one ~300ms-4s Jev call to the turn; the fast path and cache keep repeat traffic at zero.
- Deliberately does not fight pi's own trust model — it adds semantic judgment on top, it does not replace allowlists.
- Blocks are per command string and final for the session; the block reason tells the agent to ask the user rather than work around.
- Only the first 6000 chars of a result are screened; an injection buried deeper than that in a huge file passes unscreened.
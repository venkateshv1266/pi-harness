# Utils

Shared helpers used by the extensions and skills. `install.sh` copies this
directory to `~/.pi/agent/utils/`, so extensions import these files by
relative path from the live tree.

## jev-outcomes.ts

The decision-log contract every decision-making extension writes to. Three
record kinds, one JSONL file per system under `~/.pi/agent/jev-decisions/`:

```ts
import { logDecision, logOutcome, logEvent } from "../utils/jev-outcomes.ts";

const id = logDecision("mysystem", "mysystem.jsonl", { action: "do-thing" });
logOutcome("mysystem", "mysystem.jsonl", id, "worked", { verdict: "good" });
```

- `decision` — what was decided, with an `id`
- `outcome` — resolves a decision via `ref`; carries a domain `outcome` string
  and the universal `verdict`: `good` / `bad` / `mixed` / `unknown`
- `event` — context that is not a decision

Reserved keys: `kind`, `system`, `id`, `ref`, `outcome`, `verdict`, `ts`.
A decision with no outcome after 24 h shows up as stale in the report.
Consumers: model-router, ttsr, jev-context-curator, delegate, and any new
system — `extensions/decisions-report.ts` auto-discovers every log file.

## decision-analysis.ts

The join/stale analysis behind the report: pairs outcomes to decisions by
`ref` → `id` per system, computes joined/verdict/stale/untyped counts, and
derives the prune/flag candidates. Consumed by `extensions/decisions-report.ts`
and, through it, by [`decision-tuner`](../extensions/decision-tuner/README.md).

## jev-ask.mjs

CLI helper that asks System One (Jev) a structured question and prints the
calibrated probability:

```sh
node jev-ask.mjs --noul "<question>" [--state "<context>"] [--state-file <path>]
                 [--threshold 0.6] [--timeout 8000] [--json]
```

Also accepts a full request JSON via `--request <file>` or stdin. Auth resolves
`JEV_API_KEY` → `OPENROUTER_API_KEY` → `openrouter.key` in
`~/.pi/agent/auth.json`; `JEV_BASE_URL` and `JEV_MODEL` override the endpoint.
Prompts are scrubbed of common secret patterns before sending. Used by the
[add-rule](../skills/add-rule/SKILL.md) skill to decide whether a new rule
needs an opt-in `verify:` gate; generic enough for any one-off adjudication.

## jev-client.ts

Shared System One (Jev) client imported by the `ask-jev` and `jev-guard`
extensions: one `jevCall(state, questions, opts?)` POST to
`{JEV_BASE_URL}/v1/systemone` with typed `noul` / `choice` / `score` questions,
secret scrubbing on every state, one retry on 429/5xx/network, a bounded
parallel `mapPool`, and typed answer accessors. Auth resolves `JEV_API_KEY` →
`OPENROUTER_API_KEY` → `openrouter.key` in `~/.pi/agent/auth.json`; `JEV_MODEL`
(default `jev-latest`), `JEV_TIMEOUT_MS` (default 10000), `JEV_CONCURRENCY`
(default 6) override behavior. Also exports `READONLY_BASH_PREFIXES` /
`isReadonlyCommand()` — the read-only command allowlist shared by `ask_jev`'s
`command` parameter and `jev-guard`'s fast path.

## model-role.ts

Model-role resolution shared by the subagent engines, `summarize`, and the
router: `@smol` / `@fast` / `@slow` / `@reasoning` / `@plan` / `@task` /
`@designer` aliases resolve through env overrides (`PI_SMOL_MODEL`, …), the
`/roles` settings keys (`smolModel`, …), nested `modelRoles.*`, then
`PI_MODEL` / `defaultModel`. The full precedence chains are documented in the
[`model-roles` section](../extensions/README.md#model-roles) of the extensions
README.

## omp-stats/

The usage-dashboard package (`@oh-my-pi/omp-stats`, version-pinned) that
`/stats` launches with Bun. One-time setup after installing:
`cd ~/.pi/agent/utils/omp-stats && bun install`. Reads pi session logs from
the agent directory; startup errors land in `omp-stats/server.log`. See the
[`stats` section](../extensions/README.md#stats) of the extensions README.

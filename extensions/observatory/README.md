# Observatory

A local web dashboard for the pi harness itself: model routing, every jev
decision and its effectiveness, the context curator's per-session work, full
session traces, installed extensions, and token/cost statistics — all read-only
from logs pi already writes.

Nothing leaves the machine. The server binds to loopback, reads only
`~/.pi/agent/` data, and stores its index at `~/.pi/agent/observatory/observatory.db`.

## Quickstart

```
/observatory          # start on port 4747 (default) and open the browser
/observatory 4800     # start on a custom port
/observatory status   # is it running?
/observatory stop     # stop it
```

First start indexes every session file (large histories take a few seconds);
after that, ingests are incremental and the file watcher streams changes to the
UI live. Config lives at `~/.pi/agent/observatory/config.json` (`port`, `host`,
`openBrowser`); `OBSERVATORY_PORT` / `OBSERVATORY_HOST` override it.

Server logs: `~/.pi/agent/observatory/server.log`.

## Pages

| Page | Answers |
|---|---|
| **Overview** | Where tokens and money went, split model work vs harness overhead; curator/router/rules/guard leverage; watchlist of warnings. The per-day chart is bars broken out **per model** (top 5 + other, with harness overhead as its own segment), switchable between **cost, tokens and requests**, the choice persisted |
| **Impact** | What the harness earned or cost, plus decision support: **Findings** (rule-based diagnostics ordered sharpest first — each states the rule that fired with its threshold, the evidence folded behind a disclosure, size of the prize, the lever that changes it, and links to the rows behind it; `new` and `recurring` are flagged and colour-coded), **Harness benefit** (each mechanism's measured cost versus an explicit counterfactual: rules injected vs resident, context curator condensed vs the flow it avoids on the calls that follow, always-on prompt, goal loop, judgment tools, memory), **Quality signals** (colour-coded), **per-system Effectiveness** (verdict mixes per subsystem · TTSR rule outcomes with precision), **Levers** (which knob to turn, and where it lives) a **model scope picker** that filters the whole view to one model you actually ran (kept in the URL), with unattributable metrics clearly marked global, and **Trends** — four comparisons against the identical previous window: cost per call, cache rate, context condensed per call and course-check off-track rate (rates as percentage-point deltas). A **Digest** button exports the window as markdown. Every metric carries a **?** drawer: what it means, how it is computed, the raw log behind it, and what to do |
| **Improvements** | The single monitoring surface for the self-improvement loop, scoped to the selected window (24h / 7d / 30d / all): an **attention row** (review queue with ready/near-miss counts, probe issues and gate failures, open rule/extension prunes in-window with older-open noted, last snapshot), **today vs yesterday** KPIs (armed, staged, rule-probe hit rate, rule survival, lessons added/recalled, extension adoption), **day-over-day** for any two days, the **day strip**, the **review queue** (staged edits sorted false-positive/near-miss first, with Jev parts, probe line, gate, age and View/Meta drill-through), and the **improvement ledger**. **Loop decisions** (per-run conclusions plus ready/near-miss/below gate bands) and **tuning proposals** (open, applied and dismissed proposals in one status-filtered list) sit side by side as regular cards. Read-only: actions stay in `/refine-review`, `/refine-probe` and `/decision-tuner`. |
| **Models** | One hero card — per-day bars by model (cost, tokens or requests) over a stats strip (cost, calls, cache savings, tokens) — then the unit-economics breakdown table and thinking-level mix |
| **Router** | Every tier decision (keep/mid/deep/fast) with probability, confidence, acted flag, latency and outcomes, with verdicts grouped by tier (good / bad / the model being overridden / unclassified) beside the number still unjudged, so a small sample reads as small — and no cost figure: the router logs a decision, not a price (`cost_usd` is null on every record) |
| **Ask Jev** | Every ask-jev call by tool over time — the 2026-10-10 reform reshaped the surface around inputs too big to read — with the full registered tool surface (active / idle / never-called / retired, parsed live from the extension so it stays exact), per-tool stats, the review_diff verdict mix, the retired read-gate rule's never-fired history (all-time), and drill-through recent calls |
| **Jev Ledger** | One filterable table over all decision logs (curator, TTSR, guard, memory, router, course-check, refine, tuner, ask-jev, subagent router); decision volume per system is one coloured line per subsystem, click one to isolate it (the axis rescales to that system)|
| **Curator** | All sessions in range: candidates, emits and retained share, tokens condensed, frontier escalations, repairs, verifier agreement and verifier cost per emit, with the range candidate flow (source → role → verifier verdict) and role/verdict mixes |
| **Sessions** | All sessions sortable by cost/tokens/recency **and by harness impact** (condensed tokens — counted once per trim, with the token flow they avoid on the calls that follow and what that flow is worth at cache-read rates, cache saved, problems); a **GoalSpec** section (the current objective, refinements, success criteria, constraints, plan, known facts and open questions, plus the evolution from the seeded v1 — each snapshot timed, with what it added; sessions that ran the curator before seeds were persisted show a clearly-labelled **reconstructed** seed rebuilt from the first prompt), a **Session impact** section (benefit, quality meters, improvement hints, biggest context items), harness events filterable by system, and a side-by-side **compare** against another session |
| **Extensions** | Every installed extension with activity, cost, adapter coverage, and a **silent 7d+** flag; adapter log paths are shown resolved (`~/.pi/agent/jev-decisions/…`) with the declared name in a tooltip, since a bare relative name is indistinguishable from a moved file |
| **First Context** | The fixed overhead every new session starts with: the first model call's billed prompt split by character share into system-prompt sections and declared tool schemas, a per-session trend, and a table of recent sessions. Click a row for the section-by-section and tool-by-tool breakdown. Use it to watch context creep — a new MCP server or a fatter skill description shows up here before it shows up in a bill |
| **Health** | Warnings/errors per subsystem and recent issues, with raw-record drilldown |

Every headline number drills through to the raw log record it came from.
Values the logs do not contain are shown as `—`, never estimated silently.
Every view fits the viewport: column widths follow content, cell text wraps rather
than clipping, and no page scrolls sideways.

## Data sources

| Source | Used for |
|---|---|
| `~/.pi/agent/sessions/**/*.jsonl` | model calls (usage, cost, thinking level), messages, context edits, curator ledgers, model switches |
| `~/.pi/agent/jev-decisions/*.jsonl` | decision streams for every subsystem (see `server/adapters/decisions.ts`) |
| `~/.pi/agent/jev-decisions/refine/`, `decision-tuner/` | refinement and tuning passes |
| `~/.pi/agent/jev-decisions/probe.jsonl` | rule-probe decision stream (stage-write, nightly sweep, `/refine-probe`) feeding the Improvements rule-probe rate |
| `~/.pi/agent/harness-library/`, `~/.pi/agent/jev-decisions/lessons.jsonl` | lessons added/recalled counts and the experience-pass no-op/write ledger |
| `~/.pi/agent/observatory/snapshots/YYYY-MM-DD.json` | materialized daily improvement snapshots (recomputable from the logs above plus session tool calls) |
| `~/.pi/agent/models-store.json` | per-model prices for cache-savings estimates |
| `~/.pi/agent/extensions/*` | extension inventory and adapter coverage |

## Architecture

```
pi logs on disk ──► adapters (server/adapters/*) ──► SQLite (bun:sqlite)
                        │                              │
        file watcher ───┘                              ▼
        /api/emit (optional live bridge)        HTTP + SSE API
                                                       │
                                     web/ (no build step, plain ES modules)
```

- **One event envelope** for everything: `{ ts, origin, system, kind, severity,
  session_id, turn, cost_usd, latency_ms, ref, title, summary, data }`.
- **Adapters** normalize each subsystem's log into that envelope and declare
  their panels (`/api/manifest`). Unknown fields ride along in `data`, so log
  schema drift degrades to a generic row instead of an error.
- **Sessions** additionally land in typed tables (`model_calls`, `messages`,
  `sessions`) with rollups recomputed from the typed rows, so rescanning is
  idempotent.
- **Daily snapshots** are materialized views: `server/snapshots.ts` computes one
  JSON per day from refine's audit/history, TTSR outcomes, tuner proposals and
  session tool calls. The server writes today's on start; refine writes it at the
  first turn of a session when the file is missing. Raw JSONL remains the source
  of truth, so any snapshot is recomputable.
- **Live updates** come from recursive `fs.watch` on the data dirs; the UI
  refreshes over SSE. `POST /api/emit` accepts pushed events for subsystems
  that want zero-latency streaming.

## Extending it for a new harness extension

1. Find the log your subsystem writes (typically `~/.pi/agent/jev-decisions/<name>.jsonl`).
2. Add an adapter in `server/adapters/decisions.ts` (or a new file in
   `server/adapters/` default-exporting `Adapter[]` — it is auto-discovered):

```ts
jsonlAdapter({
  id: "my-subsystem",
  title: "My Subsystem",
  description: "What it decides.",
  file: "my-subsystem.jsonl",
  map: (o) => draftFrom(o, { kind: String(o.decision ?? "event"), severity: "info" }),
  panels: [{ id: "mine", title: "Decisions", kind: "table", query: "ledger" }],
})
```

3. Restart the server (`/observatory stop` then `/observatory`). The adapter
   appears in the Jev Ledger filters, the Extensions page, and `/api/manifest`
   with no UI changes.

For subsystems that want push-based streaming instead of file tailing, POST the
same envelope shape to `http://<host>:<port>/api/emit`:

```json
{ "events": [{ "id": "uuid", "system": "my-subsystem", "kind": "decision", "title": "…", "summary": "…", "sessionId": "…", "turn": 4 }] }
```

## Privacy & safety

- Binds to `127.0.0.1` by default. Do not bind a public interface: transcript
  previews are part of the UI.
- Read-only over session and decision logs; the only writes are the SQLite index
  and `config.json` under `~/.pi/agent/observatory/`.
- No outbound network calls; the UI ships its own CSS/JS with no CDN assets.
  catalogue and flags the prices as stale.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Port already in use | `/observatory 4800` (or edit `config.json`) |
| Dashboard does not start | Read `~/.pi/agent/observatory/server.log` |
| Stale numbers | Press **Sync** in the header, or `POST /api/sync?force=1` |
| Browser shows no data after an upgrade | Stop, delete `~/.pi/agent/observatory/observatory.db`, start again (full rescan) |

## Development

```bash
cd ~/pi-harness/extensions/observatory
bun server/main.ts        # run the server directly (port 4747)
```

The UI under `web/` is plain ES modules — edit and reload, no build step.
Server-side schema lives in `server/db.ts`; queries in `server/queries.ts`.

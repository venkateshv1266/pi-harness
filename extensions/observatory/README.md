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
| **Impact** | What the harness earned or cost, plus decision support: **Findings** (rule-based diagnostics ordered sharpest first — each states the rule that fired with its threshold, the evidence folded behind a disclosure, size of the prize, the lever that changes it, and links to the rows behind it; `new` and `recurring` are flagged and colour-coded), **Harness benefit** (each mechanism's measured cost versus an explicit counterfactual: rules injected vs resident, context curator condensed vs the flow it avoids on the calls that follow, always-on prompt, guard, goal loop, judgment tools, memory), **Quality signals** (colour-coded), **Levers** (which knob to turn, and where it lives) a **model scope picker** that filters the whole view to one model you actually ran (kept in the URL), with unattributable metrics clearly marked global, and **Trends** — this window against the identical previous one, ratio-normalised per call (rates report percentage-point deltas with their sample sizes) with per-day series. A **Digest** button exports the window as markdown. Every metric carries a **?** drawer: what it means, how it is computed, the raw log behind it, and what to do |
| **Models** | Cost and tokens per model, cache rate and estimated cache savings, thinking-level mix; per-day bars by model, switchable between cost, tokens and requests |
| **Router** | Every tier decision (keep/mid/deep/fast) with probability, confidence, acted flag, latency and outcomes, with verdicts grouped by tier (good / bad / the model being overridden / unclassified) beside the number still unjudged, so a small sample reads as small — and no cost figure: the router logs a decision, not a price (`cost_usd` is null on every record) |
| **Jev Ledger** | One filterable table over all decision logs (curator, TTSR, guard, memory, router, course-check, refine, tuner, ask-jev, subagent router) + per-system effectiveness tabs; decision volume per system is one coloured line per subsystem, click one to isolate it (the axis rescales to that system)|
| **Curator** | Per-session candidate flow (source → role → verifier verdict), ledger items, context edits, and the session's GoalSpec record — the seeded v1 plus every amendment with its timing, distilled objectives marked against their verbatim seed; the session list marks each spec's state (`GoalSpec vN seeded`, `(pre-seed)`, `reconstructed`) |
| **Sessions** | All sessions sortable by cost/tokens/recency **and by harness impact** (condensed tokens — counted once per trim, with the token flow they avoid on the calls that follow and what that flow is worth at cache-read rates, cache saved, problems); per-session timeline lanes (messages, harness events, goalspec updates, model calls), a **GoalSpec** section (the current objective, refinements, success criteria, constraints, plan, known facts and open questions, plus the evolution from the seeded v1 — each snapshot timed, with what it added; sessions that ran the curator before seeds were persisted show a clearly-labelled **reconstructed** seed rebuilt from the first prompt), a **Session impact** section (benefit, quality meters, improvement hints, biggest context items), a **Course check** card (Jev supervision nudges and their outcomes) with the GoalSpec card marking distilled objectives, and a side-by-side **compare** against another session |
| **Refine** | The self-improvement loop: runs audited, decisions and stages, **rules and notes segregated by kind** — rules carry their lifecycle (proposed → staged → armed, or rolled back), notes are records — with every artifact openable in full, rules **staged for arming** with their tier (`ready` / `near-miss`) and part scores, and **gate calibration**: the band each rule proposal lands in and how close its evidence/novelty/trigger scores come to the floors |
| **Tuner** | Weekly tuning passes and their **proposals** — prune or config, with the evidence behind each, its review status, and a link to the file it concerns: config proposals record no file, so they open the proposal log, and an applied prune opens its renamed `.disabled` copy rather than a path that no longer exists |
| **Extensions** | Every installed extension with activity, cost, adapter coverage, and a **silent 7d+** flag; adapter log paths are shown resolved (`~/.pi/agent/jev-decisions/…`) with the declared name in a tooltip, since a bare relative name is indistinguishable from a moved file |
| **Health** | Warnings/errors per subsystem and recent issues, with raw-record drilldown |
| **Live** | Streaming feed of harness events as they are written |

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

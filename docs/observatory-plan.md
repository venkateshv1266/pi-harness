# Pi Harness Observatory — Plan

Status: **Shipped (v0.1).** P0 + P1 and most of P2 are implemented in
[`extensions/observatory/`](../extensions/observatory/README.md): bun+SQLite server,
auto-discovered adapters for all decision-log families, session parsing with
ledger enrichment, live SSE, and the full page set (Overview, Models, Router,
Jev Ledger, Curator, Sessions + detail, Extensions, Health, Live). Not yet
built: the optional pi-side live bridge (`observatory-bridge.ts`) — file
watching already streams updates; saved views/exports; re-pointing
`decisions-report.ts` at the same aggregation code. See §6 for phase detail.
Goal: a local, read-only webapp that visualizes everything the pi harness does —
models, routing, every Jev decision and its effectiveness, the context curator's
per-session work, each session end-to-end, every installed extension, and all
token/request/cost statistics — and absorbs future harness features by adding
one adapter file, never UI code.

---

## 1. Research findings

### 1.1 Prior art online

| Project | What it does | What we borrow |
|---|---|---|
| [token-dashboard](https://github.com/nateherkai/token-dashboard) | Local Python+SQLite+ECharts dashboard over Claude Code JSONL transcripts: per-prompt cost, tool/file heatmaps, cache analytics, rule-based tips, 7 tabs, SSE live refresh | Project structure (scan → SQLite → JSON API → web UI), tips engine idea, "explain the numbers" panel, dedupe-by-message-id discipline for streamed rewrites |
| [Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) | Real-time Express+React+SQLite+WebSocket monitor: sessions, tool usage, subagent orchestration, cost | WebSocket/SSE live board, subagent attribution view, Kanban-like activity framing |
| Langfuse / Arize Phoenix / OpenLLMetry | LLM observability: traces, spans, token/cost analytics, evals, prompt management | The **trace drilldown idiom** (session → turn → request span → tool spans, waterfall + detail drawer) and the idea of a normalized span/event envelope |
| Grafana + OpenTelemetry GenAI conventions | Dashboards over OTel GenAI semantic conventions | A path to optionally export the same events as OTel spans later, without changing the store |

None of them knows anything about *harness governance*: decision logs, rule
firing, context curation, guards, memory consolidation. That gap is this app.

### 1.2 Prior art on this machine (checked before planning)

| Thing | Status | Verdict |
|---|---|---|
| `@oh-my-pi/omp-stats` 18.1.10 (launched by `extensions/stats.ts`, port 3847) | Already covers **session/model/provider/tool/cost/error/trace** layer over session JSONL, with its own SQLite + React/Chart.js UI (11 routes) | **Do not duplicate, do not fork** (third-party package, own release cadence). The Observatory owns the *harness governance layer* and links out to `/stats` for pure model analytics. Session parsing logic is re-derived, not shared, but the same techniques are reused. |
| `extensions/decisions-report.ts` + `jev-decisions/reports/*.md` | Daily markdown rollup of decision logs from a TUI command | Its aggregation questions become the Observatory's initial metric recipes; the extension can later be re-pointed at the same adapter code. |
| `utils/decision-analysis.ts`, `utils/jev-outcomes.ts` | Shared analysis helpers over decision logs | Reuse candidates for adapter math where applicable (single source of truth for "what does `acted` mean"). |

### 1.3 What actually exists to observe (measured today)

| Source | Volume | Fields that matter |
|---|---|---|
| `~/.pi/agent/sessions/**/*.jsonl` | 839 files, 38 project dirs, 516 MB, v3 tree format | per-message `usage` (input/output/cacheRead/cacheWrite/reasoning/totalTokens + USD `cost` split), `provider`/`model`/`api`/`thinkingLevel`, tool calls, `model_change`/`thinking_level_change`, `context_edit` (467), `custom`/`custom_message` (615), timestamps (ISO + ms) |
| `jev-decisions/jev-curator.jsonl` | 8,017 | V3 role classification (role, roleProb, roleConf, links→GoalSpec), sourceType, extractMethod, verifier verdict (`retainFull`/`useExtract`/`indexOnly`), verifierModel incl. frontier escalation, `jev-verify` coverage, `verifier-ab` samples, breaker/overflow, emissions/skips, GoalSpec amendments, compaction, contextPct |
| `jev-decisions/ttsr-jev.jsonl` | 4,028 | rule, scope, `delivered`/blocked, mode, **outcome records** (survived, verdict good/bad, turnsAfter) |
| `jev-decisions/jev-memory.jsonl` | 2,402 | consolidation outcome (incl. `degraded`), pairs/retires/merges_deferred/sticky_blocked/shrink_bytes, latency |
| `jev-decisions/model-router.jsonl` | 1,074 | prompt excerpt, from→to, tier keep/deep, p, confidence, newTaskP, acted, reason, latencyMs, session/turn |
| `jev-decisions/jev-guard.jsonl` | 879 | hook, tool/command, verdict clean/flagged/blocked, effect/destructive scores, cost, cached, run counters (gated/allowed/confirmed/blocked/screened/flagged) |
| `jev-decisions/jev-curator-v2.jsonl` | 531 | V2 verdicts keep/stub/truncate, batch hold/emit, **post-emit cache-cost probes** |
| `jev-curator-v3-shadow.jsonl` / `course-check` / `subagent-router` / `ask-jev` | 63 / 140 / 47 / 36 | A/B comparison arm, goal-loop verdicts, delegate routing decisions, file-judgment latency+cost |
| `decision-tuner/`, `refine/`, `rewind/`, `jev-memory/` store, `models-store.json` (per-model prices/context), rules (incl. retired), skills, agents, contexts registry, `mcp.json`, `plugins.json` | — | extension state, proposals, memory entries, library inventory, price truth for cost math |

Every count above is a live measurement, and every log is append-only JSONL →
append-only scanning with byte-offset cursors is safe and cheap.

---

## 2. Product definition

**User**: one owner-operator (you). **Mode**: local-only, loopback, read-only
over pi data (the Observatory never writes into `sessions/` or `jev-decisions/`).
**Job to be done**: answer, without grepping logs —

1. Where did my tokens and money go, split into *model work* vs *harness overhead*?
2. Is the harness earning its cost? (routing, curation savings, rule catches, guard blocks)
3. What exactly did the curator do in this session, turn by turn, and did the verifier agree?
4. What did each extension actually do lately, and what did it cost?
5. What is happening *right now*?

**Non-goals**: cloud sync, multi-user, prompt content analytics beyond what pi
already stored locally, replacing `/stats` (omp-stats), training/finetuning,
any write path into harness state.

---

## 3. Architecture

### 3.1 Shape

```
 pi session (live)                    on disk (history)
   │ pi.on(...) hooks                    │ sessions/*.jsonl, jev-decisions/*.jsonl,
   ▼                                     │ store dirs, configs
 observatory-bridge.ts                  ▼
 (optional, no-op if server down)   ┌─────────────────────────────┐
   │ HTTP POST /api/emit            │ Ingest                      │
   └───────────────────────────────▶│  · adapter registry (auto)  │
                                    │  · file cursors + fs.watch  │
                                    │  · normalize → Event        │
                                    └────────────┬────────────────┘
                                                 ▼
                                    ┌─────────────────────────────┐
                                    │ SQLite (bun:sqlite)         │
                                    │  events, sessions, messages,│
                                    │  decisions, curator_actions,│
                                    │  model_calls, cursors, meta │
                                    └────────────┬────────────────┘
                                                 ▼
                                    ┌─────────────────────────────┐
                                    │ HTTP + SSE server           │
                                    │  /api/manifest (UI schema)  │
                                    │  /api/query/*  /api/stream  │
                                    └────────────┬────────────────┘
                                                 ▼
                                    React SPA — generic renderer
                                    registry + 3 bespoke hero views
                                    (Curator, Session trace, Live)
```

- **Runtime**: `bun` (already installed; matches the omp-stats precedent on this
  machine) for server + SQLite. The pi extension spawns it detached; the web
  bundle is prebuilt and committed, so no build step is needed to use it.
- **Port**: 4747 default (distinct from omp-stats 3847), configurable.
- **DB**: `~/.pi/agent/observatory/observatory.db` (not in the repo, never committed).
- Extension factory does **nothing** on load; the server starts on `/observatory`
  (or `session_start` when an explicit opt-in flag is set).

### 3.2 The extensibility core (the part the whole plan hinges on)

Two mechanisms, both data-driven. **Adding a new harness feature must never
require touching UI code.**

**(a) Adapters** — `extensions/observatory/adapters/*.ts`, auto-discovered by
directory scan:

```ts
export default defineAdapter({
  id: "jev-curator",
  title: "Context Curator",
  icon: "scissors",
  // where data comes from — file globs, config files, or live bridge events
  sources: [{ kind: "jsonl", path: "~/.pi/agent/jev-decisions/jev-curator.jsonl" }],
  // tolerant parser: unknown fields → raw passthrough, never throws
  parse(line, ctx): Event[] { /* normalize to Event envelope */ },
  // which pi session/turn this event belongs to (best-effort join)
  correlate(e, ctx): { sessionId?, turn? },
  // declarative page content; kinds are rendered by the generic registry
  panels: [
    { id: "curator-fates", title: "Candidate fates", kind: "sankey", query: "curator.fates" },
    { id: "curator-savings", title: "Chars saved", kind: "timeseries", query: "curator.savings" },
    { id: "curator-verdicts", title: "Verifier verdicts", kind: "table", query: "curator.verdicts",
      columns: [...], filters: ["role","sourceType","verifierVerdict","session"] },
  ],
  // named metric recipes for the effectiveness pages
  metrics: [{ id: "retain-rate", label: "Retain-full rate", compute: (q) => ... }],
});
```

**(b) Generic renderer registry** — the server serves `/api/manifest` (adapters +
panels + nav), and the SPA maps panel `kind` → component: `kpi`, `timeseries`,
`stacked-area`, `bar`, `table`, `sankey`, `waterfall`, `histogram`, `timeline`,
`transcript`, `log`, `card-grid`. New subsystem → new adapter → new page, no
React changes.

**(c) Live bridge** — `observatory-bridge.ts` subscribes to pi events
(`turn_end`, `tool_call`, `tool_result`, `provider_stream_event`, `context`,
custom harness events) and POSTs a small normalized envelope to the loopback
base URL from config (`observatory.port`, default 4747). If the server is down:
single failed connect, drop, zero session overhead. Real-time view consumes the same stream over SSE. File
tail remains the universal fallback so old extensions work without a bridge.

### 3.3 Event envelope (one shape for everything)

```jsonc
{ "ts": "...", "origin": "adapter:jev-curator | bridge:ttsr",
  "system": "curator", "kind": "verifier-verdict", "severity": "info",
  "sessionId": "01a1…", "turn": 9, "costUsd": 0.0004, "latencyMs": 485,
  "refs": { "entryId": "a4f89d9e", "rule": "search-before-utility" },
  "data": { /* adapter-normalized fields, raw passthrough kept */ } }
```

Schema version in `meta`; adapters declare `schemaVersion`. Unknown kinds still
store and render as generic rows — forward-compatible by default.

### 3.4 Ingestion rules (correctness matters here)

- Cursors per file in SQLite (`mtime`, `size`, `byteOffset`); append-only reads; rescan on truncation.
- Session streamed rewrites: dedupe assistant messages by message id, latest-wins.
- Cost math uses `models-store.json` prices; anything unpriced shows as `N/A`, never 0.
- Backfill: 839 sessions / 516 MB target ≤ 60 s first scan, incremental after.
- Never modify any source file; open read-only.

---

## 4. Visual design

Global chrome on every page: time-range control (1 h / 24 h / 7 d / 30 d / all),
scope filters (project, session, subsystem), dark/light, hash routes
(shareable, same idiom as omp-stats), export (CSV/JSON) per table, and a
"net cost" toggle that splits **model work** vs **harness overhead** everywhere.

### 4.1 Overview — "Where did it go, what did it buy?"

```
┌ Overview ─────────────────────────── range:[7d▾] scope:[all▾] ──┐
│ ┌Cost $42.10──┐┌Tokens 812M─┐┌Cache 87%──┐┌Sessions 139┐┌Harness $3.10 (7.4%)┐│
│ └ 14.2% day▲  ┘└ in/out▾   ┘└ saved $9.1┘└ 2,410 turns┘└ 17,2k decisions   ┘│
│                                                                 │
│  Cost/day ─ stacked: model work ▓▓▓ │ harness ▒▒                │
│  ▁▂▃▅▆▇█▇▆▅▃▂▁▂▃▅▇█▇▅▃▂▁▂▄▆█▇▆▅▃▂▁  (hover: per-subsystem split)│
│                                                                 │
│ ┌Harness leverage ───────────────────────────────────────────┐  │
│ │ curator saved 4.2M tok (~$2.10) · cache reset cost $0.31   │  │
│ │ routing kept 71% on cheap tier ($ · deep used 29%)        │  │
│ │ ttsr fired 412× · 87 outcomes · 91% good · 12 blocks      │  │
│ │ guard screened 879 · blocked 4 dangerous · cost $0.05     │  │
│ └────────────────────────────────────────────────────────────┘  │
│  Watchlist ▶ 14 memory consolidations degraded · breaker open 1 │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 Models & Router

- Model preference over time (stacked area), per-model table (tokens in/out/cache,
  cost, latency, error rate, cache-hit %), thinking-level mix.
- **Router page**: decision stream (from→to, tier, p, confidence, acted, reason,
  latency) with filters; tier-share donut; p/confidence histograms; "acted"
  timeline; cost of routing itself; per-model "kept vs bumped" matrix.
- Deep-link to `/stats` (omp-stats) for the pure-API view; this page leads with
  *decision* context that omp-stats cannot show.

### 4.3 Jev Ledger — every decision, one table, effectiveness per system

```
┌ Jev Ledger ─ system:[all▾] verdict:[all▾] search:[…] ────────────┐
│ ts▾        system    kind              sid      turn  lat   cost │
│ 11:58:48   curator   verifier-verdict  a4f8…    9     812ms $0.0004 │
│ 11:58:41   ttsr      outcome(good)     b2a7…    7      —     —   │
│ 11:58:34   ttsr      decision(deliver) 01a1…    7      —     —   │
│ 11:43:54   router    decision(keep)    01a1…    6     849ms $0.0001 │
│ ▸ row click → drawer: full payload + raw JSON + jump-to-session  │
│                                                                  │
│ Effectiveness tabs: [Router][TTSR][Guard][Memory][Course][Curator]│
└──────────────────────────────────────────────────────────────────┘
```

### 4.4 Context Curator (hero view #1)

```
┌ Curator · session 01a1110e · [turn ▾ 9/23] ──────────────────────┐
│ Context 5.6% ─ area chart w/ markers: ▲cap ●v2 verdict ◆v3 emit  │
│ ▁▂▂▃▄▅▅▆▇█  ×  (marker hover: entryId, chars saved, verdict)     │
│                                                                  │
│ Candidate flow (this session)   Sankey:                          │
│  source → role → verifier → fate                                 │
│   bash(2.2k) ─evidence─▶ retainFull ◀── reason: "458 chars omitted"│
│   read(31k) ─background─▶ useExtract ─▶ emitted (−28k)           │
│                                                                  │
│ ┌GoalSpec v1┐ objective · criteria · facts · open questions ▾    │
│ ┌Verifier ┐  jev+frontier(1) · agree w/ A/B 92% · repaired 3 lines│
│ ┌Registry ┐  418 sources · overflow 2 · breaker closed            │
└──────────────────────────────────────────────────────────────────┘
```

### 4.5 Session Explorer (hero view #2)

List (839 sessions, grouped by project; sortable by cost/tokens/turns/last-seen)
→ detail with **three lanes on one time axis**:

```
│ lane 1  user ▏ assistant ▏▏  assistant ▏ (tool wait) ▏▏            │
│ lane 2  harness ◆router(deep) ◆curator emit ◆ttsr fire ◆guard     │
│ lane 3  subagents [explorer ▓▓▓] [reviewer ▓▓▓▓▓▓]                │
│                                                                  │
│ turn strip: turn# | model | in/out | cacheR | $ | tools | curator│
│ ▸ click any turn → transcript excerpt + tool calls + context_edit │
└──────────────────────────────────────────────────────────────────┘
```

### 4.6 Extensions Registry

Card per installed extension, auto-built from its README + adapter + activity:
name, purpose (from README first line), **activity sparkline** (events/day from
whatever log it owns), cost contribution, last active, config summary,
**coverage badge** (`adapter ✓` / `file-log ✓` / `bridge ✓` / `unknown`).
"Catalogue" tab lists every `extensions/*` on disk so a newly installed
extension is visible even before an adapter exists — with a "add adapter"
checklist. This page is the living proof of extensibility.

### 4.7 Health, Libraries, Live

- **Health**: degraded/breaker/overflow events, guard blocks, session errors,
  consolidation streaks, stale cursors; each row links to raw evidence.
- **Libraries**: rules (fires, good/bad outcomes, retired), skills, agents,
  memory entries + consolidation history, contexts registry — inventory + effectiveness.
- **Live** (SSE): current session feed — decision ticker, curator actions,
  token/cost accruing in real time, subagent spans growing; works via bridge or
  file tail, whichever is present.

---

## 5. Effectiveness methodology (honest by construction)

| Subsystem | Metric | Basis |
|---|---|---|
| Curator | chars → tokens saved, $ saved net of cache-reset probes | v2 probe entries + edit sizes |
| Curator | verifier agreement (Jev vs frontier A/B), repair rate, regret | `verifier-ab`, `jev-verify`, regret fields |
| Router | kept-on-cheap %, acted %, cost delta keep-vs-deep, latency | router log |
| TTSR | delivered, suppressed, blocked; outcome good/bad/survived at N turns; per-rule precision | ttsr decision+outcome records |
| Guard | screens, flags, blocks, destructive-catch rate, cost-per-screen | guard run counters |
| Memory | consolidation success/degraded, shrink bytes, retires, sticky-blocked | consolidation entries |
| Course-check | verdict mix, turns-to-goal correlation | course-check entries |
| Extensions | events, cost, last-seen, failures | adapter rollups |

Principle: **if the log cannot support a claim, the UI shows `N/A` + the raw
rows**, never a fabricated score. Every headline number is click-through to the
exact log lines that produced it.

---

## 6. Build phases

| Phase | Deliverable | Est. |
|---|---|---|
| **P0 Skeleton** | server + SQLite + ingest for sessions & 4 core decision logs; Overview + Models/Router + Jev Ledger pages (generic renderers) | 2–3 d |
| **P1 Hero views** | Curator page (timeline, sankey, GoalSpec, verifier) + Session Explorer (3-lane trace, transcript) + file-tail live refresh | 3–4 d |
| **P2 Live & registry** | `observatory-bridge.ts` + SSE Live page + Extensions Registry with coverage badges | 2 d |
| **P3 Effectiveness** | metric recipes for all subsystems, A/B + savings accounting, Health page, library pages | 2–3 d |
| **P4 Polish** | saved views, exports, theming, docs, adapter-authoring guide, `decisions-report.ts` re-point | 1–2 d |

Definition of done for "extensible": after P2, adding observability for a **new**
harness extension is one adapter file + manifest entries; verified by building
one adapter for a feature that did not exist when the app was written.

---

## 7. Repo layout, commands, testing

```
extensions/observatory/
  index.ts                 # pi extension: /observatory [port] [open|stop|status]
  README.md
  server/                  # (no index.ts — keeps pi from treating it as an extension)
    main.ts  db.ts  ingest.ts  manifest.ts  query.ts
  adapters/                # the extensibility surface
    sessions.ts  jev-curator.ts  ttsr.ts  model-router.ts  jev-guard.ts
    jev-memory.ts  course-check.ts  subagent-router.ts  ask-jev.ts
    refine.ts  decision-tuner.ts  extensions-inventory.ts  libraries.ts
  bridge/observatory-bridge.ts   # optional live emitter (also installable standalone)
  web/                     # Vite + React + TS; dist/ committed, `bun run build`
  test/                    # fixture logs → golden events/dashboards
```

Commands: `/observatory` (start+open), `/observatory stop`, `/observatory status`,
`bun run sync` (force rescan). Tests: adapter fixtures (each log format gets a
trimmed real sample committed as fixture), cursor/dedupe unit tests, one
end-to-end smoke test (server boots, manifest valid, each panel query returns
shaped data). `sync.sh` already mirrors the whole `extensions/` tree — no change
needed; README + `docs/observatory.md` updated before any commit per repo rules.

---

## 8. Risks & open decisions

Risks: log schema drift (mitigated: tolerant parsers + raw passthrough +
fixture tests); 516 MB backfill (byte cursors, incremental after); streamed
session rewrites (message-id dedupe); port conflict (configurable, status
command); privacy (loopback-only default; prompt content stays local; repo
carries code only); duplicate-ish surface with omp-stats (explicit non-goal +
link-out).

Decisions needed before P0:

1. **Runtime**: bun for server+SQLite (recommended; matches omp-stats). *or* node + better-sqlite3.
2. **UI stack**: Vite+React+TS+Tailwind+Chart.js with committed prebuilt bundle (recommended; sibling look to omp-stats) — vs no-build vanilla.
3. **Live bridge default**: on when server up / off entirely / on with env opt-out (recommended: on-when-up, silent no-op otherwise).
4. **Scope of first release**: P0+P1 only (recommended first demo) vs push through P3.
5. **Name/command**: "Observatory" + `/observatory`, port 4747 — confirm.
6. **Session content**: show prompt/assistant text in transcript views (local-only) — default yes, with a global "redact content" toggle.

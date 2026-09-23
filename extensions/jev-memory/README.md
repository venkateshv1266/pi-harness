# jev-memory

Hybrid markdown + Jev System-One decision-layer memory for pi.  
Vendored from pi-hermes-memory@0.9.8 (MIT). See `tasks/todo-jev-memory.md` in my-pi-setup.

## Overview

The extension provides persistent Markdown memory, SQLite-backed memory and session search, correction and background review hooks, procedural skills, secret scanning, and memory consolidation. Command names and tool names remain compatible with the vendored extension.

The default storage directory is `~/.pi/agent/jev-memory/`. On first run, existing data in `~/.pi/agent/pi-hermes-memory/` is auto-migrated non-destructively, including `sessions.db`.

## Configuration

Create `~/.pi/agent/jev-memory-config.json` to override defaults. Supported environment/configuration values include:

- `PI_CODING_AGENT_DIR` — changes the Pi agent root.
- `PI_CODING_AGENT_SESSION_DIR` — overrides the directory used for session files.
- `PI_TIMING=1` — enables lifecycle timing diagnostics.
- `memoryMode`, `memoryPolicyStyle`, `memoryPolicyCustomText`
- `memoryCharLimit`, `userCharLimit`, `projectCharLimit`
- `memoryDir`, `projectsMemoryDir`, `sessionSearch`, `sessionRetentionDays`
- `reviewEnabled`, `reviewTransport`, `nudgeInterval`, `nudgeToolCalls`
- `correctionDetection`, `failureInjectionEnabled`, `standingInstructionsEnabled`
- `flushOnCompact`, `flushOnShutdown`, `flushMinTurns`, `flushRecentMessages`
- `llmModelOverride`, `llmThinkingOverride`, `childExtensionPaths`
- `memoryOverflowStrategy`, `autoConsolidate`, `consolidationTimeoutMs`, `overflowGraceMs`

The default `memoryDir` is `~/.pi/agent/jev-memory`.

## Store locations

- Global Markdown memory and `sessions.db`: `~/.pi/agent/jev-memory/` (auto-migrated from `pi-hermes-memory` on first run)
- Project memory: `~/.pi/agent/projects-memory/<project>/`
- Configuration: `~/.pi/agent/jev-memory-config.json`

## Commands

- `/memory-insights`
- `/memory-skills`
- `/memory-consolidate`
- `/memory-interview`
- `/memory-switch-project`
- `/memory-index-sessions`
- `/memory-sync-markdown`
- `/memory-preview-context`
- `/learn-memory-tool`

## Jev decision layer

Every memory-management decision degrades to pre-Jev (hermes) behavior whenever Jev is
unavailable — nothing is lost on outage, and an explicit save is never dropped because of a
Jev failure.

- **Admission gate** — every `memory_add` (and every review-suggested add) is scored by 5
  batched Jev questions (`should_store` / `future_utility` / `importance` / `novelty` /
  `redundancy`); exact duplicates block deterministically without a call; blocked saves
  return their reason to the agent. `replace`/`remove` are never gated.
- **Review pre-gate** — skips the periodic LLM review when nothing durable occurred.
- **Correction adjudication** — regex-detected corrections are adjudicated by Jev
  (is-correction + target hint) before saving.
- **Search rerank** — BM25 top-30 rescored (relevance / adds_detail / actionable_now),
  floor 0.35 (always keeps ≥3 results); Jev down → plain BM25 order.
- **Typed consolidation** — scheduled every `jev.consolidation.intervalWrites` successful
  adds (default 20) or via `/memory-consolidate`: batched
  `redundant`/`contradiction`/`obsolete` + `representation` per candidate pair, retire-only
  executor (no free-text rewriting), atomic-shrink checked, non-destructive snapshots.

Config (`~/.pi/agent/jev-memory-config.json`, `jev` section, all optional with these defaults):

| Field | Default |
|---|---|
| `admission: {enabled, threshold}` | `true`, `0.60` |
| `admissionWeights` (future_utility, importance, novelty, redundancy) | `[0.4, 0.3, 0.3, 0.2]` |
| `pregate: {enabled, threshold}` | `true`, `0.55` |
| `correction: {enabled}` | `true` |
| `rerank: {enabled, topK, floor}` | `true`, `30`, `0.35` |
| `consolidation: {enabled, intervalWrites, freestyleFallbackMaxChars}` | `true`, `20`, `50000` |
| `consolidation.stale: {enabled, ageDays, referencedDays, threshold}` | `true`, `30`, `30`, `0.85` — per-entry stale-retirement: entries older than `ageDays` AND not referenced within `referencedDays` are Jev-judged (batched Noul) and retired at ≥ threshold; 7-day recency stickiness always applies |
| `audit: {enabled}` | `true` — decisions append to `~/.pi/agent/refine/jev-memory.jsonl` |

Env vars: `JEVM_JEV=0` kill switch (all decisions → status quo), `JEVM_MOCK=1` deterministic
mock (no network, for tests), `JEVM_TIMEOUT_MS` (3000), `JEVM_MAX_RETRIES` (2),
`JEVM_CACHE_SIZE` (1024), `JEVM_AUDIT_PATH`, plus the shared client vars `JEV_BASE_URL`,
`JEV_MODEL` (`jev-latest`), and the key chain `JEVM_API_KEY` → `JEV_API_KEY` →
`OPENROUTER_API_KEY` → `auth.json`.

## Tools

`memory_add`, `memory_replace`, `memory_remove`, `memory_search`, `session_search`, and
`skill_manage`.

## License

MIT

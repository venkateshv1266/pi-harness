/**
 * SQLite schema. One generic `events` table carries every harness decision;
 * typed tables carry session/model detail. All writes are upserts keyed by a
 * stable fingerprint or message id so re-scans are idempotent.
 */
import { Database } from "bun:sqlite";
import { dbPath } from "./config";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS files (
  file TEXT PRIMARY KEY,
  size INTEGER,
  mtime REAL,
  scanned_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT UNIQUE,
  ts TEXT,
  ts_ms INTEGER,
  origin TEXT,
  system TEXT,
  kind TEXT,
  severity TEXT DEFAULT 'info',
  session_id TEXT,
  turn INTEGER,
  cost_usd REAL,
  latency_ms REAL,
  ref TEXT,
  title TEXT,
  summary TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_events_system ON events(system, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity, ts_ms DESC);

CREATE TABLE IF NOT EXISTS model_calls (
  msg_id TEXT PRIMARY KEY,
  session_id TEXT,
  project TEXT,
  ts_ms INTEGER,
  ts TEXT,
  model TEXT,
  provider TEXT,
  api TEXT,
  thinking_level TEXT,
  turn INTEGER,
  input INTEGER,
  output INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  reasoning INTEGER,
  total_tokens INTEGER,
  cost REAL,
  tool_count INTEGER DEFAULT 0,
  tools TEXT,
  stop_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_ts ON model_calls(ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_calls_session ON model_calls(session_id, ts_ms);

CREATE TABLE IF NOT EXISTS messages (
  msg_id TEXT PRIMARY KEY,
  session_id TEXT,
  project TEXT,
  ts_ms INTEGER,
  role TEXT,
  turn INTEGER,
  chars INTEGER,
  preview TEXT,
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts_ms);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project TEXT,
  path TEXT,
  cwd TEXT,
  parent_session TEXT,
  started_ts TEXT,
  last_ts TEXT,
  turns INTEGER DEFAULT 0,
  calls INTEGER DEFAULT 0,
  input INTEGER DEFAULT 0,
  output INTEGER DEFAULT 0,
  cache_read INTEGER DEFAULT 0,
  cache_write INTEGER DEFAULT 0,
  reasoning INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  errors INTEGER DEFAULT 0,
  models TEXT DEFAULT '[]',
  title TEXT,
  user_messages INTEGER DEFAULT 0,
  harness_events INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS prices (
  model TEXT PRIMARY KEY,
  input REAL,
  output REAL,
  cache_read REAL,
  cache_write REAL
);
`;

export function openDb(): Database {
	const db = new Database(dbPath(), { create: true });
	db.exec(SCHEMA);
	ensureColumn(db, "sessions", "system_chars", "INTEGER DEFAULT 0");
	return db;
}

/** Additive migrations: newer columns on tables that already exist in older DBs. */
function ensureColumn(db: Database, table: string, column: string, definition: string): void {
	const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
	if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function metaGet(db: Database, key: string): string | null {
	const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
	return row?.value ?? null;
}

export function metaSet(db: Database, key: string, value: string): void {
	db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ...[key, value]);
}

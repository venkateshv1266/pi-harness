/**
 * Ingest pipeline. Decision logs are append-only JSONL: a line is hashed into
 * a fingerprint and inserted once (INSERT OR IGNORE), so re-scans are
 * idempotent and cheap. Session files are re-parsed when size/mtime change and
 * upserted by message id; session rollups are recomputed from the typed tables.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { modelsStorePath, sessionsRoot } from "./config";
import { metaSet } from "./db";
import { log } from "./log";
import { loadAdapters, type Adapter } from "./adapters/registry";
import { adapterFilePath } from "./adapters/define";
import type { EventDraft, RawRecord } from "./adapters/define";
import { scanSessionFile } from "./adapters/sessions";

export interface IngestResult {
	decisionFiles: number;
	sessionFiles: number;
	events: number;
	calls: number;
	skipped: number;
	ms: number;
}

interface FileState {
	size: number;
	mtime: number;
}

function fingerprint(line: string): string {
	return Bun.hash(line).toString(16);
}

function systemFromKind(kind: string): string {
	const prefix = kind.split(".")[0];
	return prefix === "curator" || prefix === "model" || prefix === "harness" || prefix === "usage" ? prefix : "session";
}

function fileChanged(db: Database, file: string): boolean {
	const stat = statSync(file);
	const row = db.query<FileState, [string]>("SELECT size, mtime FROM files WHERE file = ?").get(file);
	return !row || row.size !== stat.size || Math.abs(row.mtime - stat.mtimeMs) > 0.5;
}

function markFile(db: Database, file: string): void {
	const stat = statSync(file);
	db.run(
		"INSERT INTO files (file, size, mtime, scanned_at) VALUES (?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, scanned_at = excluded.scanned_at",
		...[file, stat.size, stat.mtimeMs, Date.now()],
	);
}

export function ingestPrices(db: Database): number {
	const store = modelsStorePath();
	if (!existsSync(store)) return 0;
	type ModelEntry = { id?: string; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } };
	type Provider = { models?: ModelEntry[] };
	let parsed: Record<string, Provider> = {};
	try {
		parsed = JSON.parse(readFileSync(store, "utf8")) as Record<string, Provider>;
	} catch (err) {
		log.error(`cannot parse models-store.json: ${err instanceof Error ? err.message : String(err)}`);
		return 0;
	}
	const stmt = db.prepare(
		"INSERT INTO prices (model, input, output, cache_read, cache_write) VALUES (?, ?, ?, ?, ?) ON CONFLICT(model) DO UPDATE SET input = excluded.input, output = excluded.output, cache_read = excluded.cache_read, cache_write = excluded.cache_write",
	);
	let count = 0;
	db.transaction(() => {
		for (const provider of Object.values(parsed)) {
			for (const model of provider.models ?? []) {
				if (!model.id || !model.cost) continue;
				stmt.run(model.id, model.cost.input ?? null, model.cost.output ?? null, model.cost.cacheRead ?? null, model.cost.cacheWrite ?? null);
				count += 1;
			}
		}
	})();
	return count;
}

function ingestDecisionFile(db: Database, adapter: Adapter, force = false): { events: number; changed: boolean } {
	const file = adapterFilePath(adapter);
	if (!file || !existsSync(file)) return { events: 0, changed: false };
	if (!force && !fileChanged(db, file)) return { events: 0, changed: false };

	const raw = readFileSync(file, "utf8");
	// Upsert, not insert-or-ignore: a fingerprint identifies a log line, so a
	// parser improvement must be able to rewrite the row it produced.
	const insert = db.prepare(
		`INSERT INTO events (fingerprint, ts, ts_ms, origin, system, kind, severity, session_id, turn, cost_usd, latency_ms, ref, title, summary, data)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(fingerprint) DO UPDATE SET
		   ts = excluded.ts, ts_ms = excluded.ts_ms, kind = excluded.kind, severity = excluded.severity,
		   session_id = excluded.session_id, turn = excluded.turn, cost_usd = excluded.cost_usd,
		   latency_ms = excluded.latency_ms, ref = excluded.ref, title = excluded.title,
		   summary = excluded.summary, data = excluded.data`,
	);
	let inserted = 0;
	const rows = raw.split("\n");
	db.transaction(() => {
		rows.forEach((line, index) => {
			if (!line.trim()) return;
			let record: RawRecord;
			try {
				record = JSON.parse(line) as RawRecord;
			} catch {
				return;
			}
			let drafts: EventDraft[] = [];
			try {
				const mapped = adapter.map?.(record, index) ?? null;
				drafts = mapped ? (Array.isArray(mapped) ? mapped : [mapped]) : [];
			} catch (err) {
				log.error(`${adapter.id} map error on line ${index}: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			for (const draft of drafts) {
				const result = insert.run(
					fingerprint(`${adapter.id}|${line}`),
					draft.ts,
					draft.tsMs ?? null,
					`adapter:${adapter.id}`,
					adapter.id,
					draft.kind,
					draft.severity,
					draft.sessionId ?? null,
					draft.turn ?? null,
					draft.costUsd ?? null,
					draft.latencyMs ?? null,
					draft.ref ?? null,
					draft.title ?? null,
					draft.summary ?? null,
					JSON.stringify(draft.data),
				);
				if (Number(result.changes ?? 0) > 0) inserted += 1;
			}
		});
		markFile(db, file);
	})();
	return { events: inserted, changed: true };
}

function recomputeSession(db: Database, sessionId: string): void {
	const agg = db
		.query<
			{ calls: number; input: number; output: number; cache_read: number; cache_write: number; reasoning: number; total_tokens: number; cost: number; errors: number },
			[string]
		>(
			`SELECT COUNT(*) calls, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
			        COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write,
			        COALESCE(SUM(reasoning),0) reasoning, COALESCE(SUM(total_tokens),0) total_tokens,
			        COALESCE(SUM(cost),0) cost, COALESCE(SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END),0) errors
			 FROM model_calls WHERE session_id = ?`,
		)
		.get(sessionId);
	const span = db
		.query<{ a: number | null; b: number | null }, [string]>("SELECT MIN(ts_ms) a, MAX(ts_ms) b FROM messages WHERE session_id = ?")
		.get(sessionId);
	const users = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM messages WHERE session_id = ? AND role = 'user'").get(sessionId);
	const harness = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM events WHERE session_id = ?").get(sessionId);
	const models = db.query<{ model: string | null }, [string]>("SELECT DISTINCT model FROM model_calls WHERE session_id = ? AND model IS NOT NULL").all(sessionId);
	const title = db
		.query<{ preview: string | null }, [string]>("SELECT preview FROM messages WHERE session_id = ? AND role = 'user' ORDER BY ts_ms LIMIT 1")
		.get(sessionId);
	const meta = db.query<{ project: string; path: string; cwd: string | null; parent_session: string | null; started_ts: string | null }, [string]>(
		"SELECT project, path, cwd, parent_session, started_ts FROM sessions WHERE session_id = ?",
	).get(sessionId);

	db.run(
		`INSERT INTO sessions (session_id, project, path, cwd, parent_session, started_ts, last_ts, turns, calls, input, output, cache_read, cache_write, reasoning, total_tokens, cost, errors, models, title, user_messages, harness_events)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   project = excluded.project, last_ts = excluded.last_ts, turns = excluded.turns, calls = excluded.calls,
		   input = excluded.input, output = excluded.output, cache_read = excluded.cache_read, cache_write = excluded.cache_write,
		   reasoning = excluded.reasoning, total_tokens = excluded.total_tokens, cost = excluded.cost, errors = excluded.errors,
		   models = excluded.models, title = excluded.title, user_messages = excluded.user_messages, harness_events = excluded.harness_events`,
		...[
			sessionId,
			meta?.project ?? "unknown",
			meta?.path ?? "",
			meta?.cwd ?? null,
			meta?.parent_session ?? null,
			span?.a ? new Date(span.a).toISOString() : (meta?.started_ts ?? null),
			span?.b ? new Date(span.b).toISOString() : null,
			users?.n ?? 0,
			agg?.calls ?? 0,
			agg?.input ?? 0,
			agg?.output ?? 0,
			agg?.cache_read ?? 0,
			agg?.cache_write ?? 0,
			agg?.reasoning ?? 0,
			agg?.total_tokens ?? 0,
			agg?.cost ?? 0,
			agg?.errors ?? 0,
			JSON.stringify(models.map((m) => m.model).filter(Boolean)),
			title?.preview ?? null,
			users?.n ?? 0,
			harness?.n ?? 0,
		],
	);
}

function ingestSessionFile(db: Database, file: string): { events: number; calls: number } {
	const raw = readFileSync(file, "utf8");
	const scan = scanSessionFile(file, raw);
	let events = 0;
	const upsertCall = db.prepare(
		`INSERT INTO model_calls (msg_id, session_id, project, ts_ms, ts, model, provider, api, thinking_level, turn, input, output, cache_read, cache_write, reasoning, total_tokens, cost, tool_count, tools, stop_reason)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(msg_id) DO UPDATE SET turn = excluded.turn, cost = excluded.cost, input = excluded.input, output = excluded.output,
		   cache_read = excluded.cache_read, cache_write = excluded.cache_write, reasoning = excluded.reasoning, total_tokens = excluded.total_tokens,
		   tool_count = excluded.tool_count, tools = excluded.tools, stop_reason = excluded.stop_reason, thinking_level = excluded.thinking_level`,
	);
	const upsertMessage = db.prepare(
		`INSERT INTO messages (msg_id, session_id, project, ts_ms, role, turn, chars, preview, model)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(msg_id) DO UPDATE SET turn = excluded.turn, chars = excluded.chars, preview = excluded.preview, model = excluded.model`,
	);
	const insertEvent = db.prepare(
		`INSERT INTO events (fingerprint, ts, ts_ms, origin, system, kind, severity, session_id, turn, cost_usd, latency_ms, ref, title, summary, data)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(fingerprint) DO UPDATE SET
		   ts = excluded.ts, ts_ms = excluded.ts_ms, kind = excluded.kind, severity = excluded.severity,
		   session_id = excluded.session_id, turn = excluded.turn, cost_usd = excluded.cost_usd,
		   latency_ms = excluded.latency_ms, ref = excluded.ref, title = excluded.title,
		   summary = excluded.summary, data = excluded.data`,
	);
	db.transaction(() => {
		db.run(
			"INSERT INTO sessions (session_id, project, path, cwd, parent_session, started_ts, system_chars) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET project = excluded.project, path = excluded.path, cwd = excluded.cwd, parent_session = excluded.parent_session, system_chars = excluded.system_chars",
			...[scan.sessionId, scan.project, scan.path, scan.cwd ?? null, scan.parentSession ?? null, scan.startedTs ?? null, scan.systemChars],
		);
		for (const call of scan.calls) {
			upsertCall.run(
				call.msgId,
				call.sessionId,
				call.project,
				call.tsMs,
				call.ts,
				call.model ?? null,
				call.provider ?? null,
				call.api ?? null,
				call.thinkingLevel ?? null,
				call.turn,
				call.input,
				call.output,
				call.cacheRead,
				call.cacheWrite,
				call.reasoning,
				call.totalTokens,
				call.cost,
				call.toolCount,
				call.tools ?? null,
				call.stopReason ?? null,
			);
		}
		for (const message of scan.messages) {
			upsertMessage.run(message.msgId, message.sessionId, message.project, message.tsMs, message.role, message.turn, message.chars, message.preview, message.model ?? null);
		}
		for (const event of scan.events) {
			const result = insertEvent.run(
				event.fingerprint,
				event.ts,
				event.tsMs ?? null,
				"session",
				systemFromKind(event.kind),
				event.kind,
				event.severity,
				event.sessionId ?? null,
				event.turn ?? null,
				event.costUsd ?? null,
				event.latencyMs ?? null,
				event.ref ?? null,
				event.title ?? null,
				event.summary ?? null,
				JSON.stringify(event.data),
			);
			if (Number(result.changes ?? 0) > 0) events += 1;
		}
		markFile(db, file);
		recomputeSession(db, scan.sessionId);
	})();
	return { events, calls: scan.calls.length };
}

function sessionFiles(): string[] {
	const root = sessionsRoot();
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const dir of readdirSync(root)) {
		const projectDir = path.join(root, dir);
		try {
			if (!statSync(projectDir).isDirectory()) continue;
		} catch {
			continue;
		}
		for (const entry of readdirSync(projectDir)) {
			if (entry.endsWith(".jsonl")) files.push(path.join(projectDir, entry));
		}
	}
	return files;
}

export async function ingestAll(db: Database, opts: { force?: boolean } = {}): Promise<IngestResult> {
	const started = Date.now();
	const force = opts.force ?? false;
	ingestPrices(db);
	const adapters = await loadAdapters();
	let decisionFiles = 0;
	let sessionFilesScanned = 0;
	let events = 0;
	let calls = 0;
	let skipped = 0;

	for (const adapter of adapters) {
		const result = ingestDecisionFile(db, adapter, force);
		if (result.changed) decisionFiles += 1;
		events += result.events;
		if (!result.changed) skipped += 1;
	}

	for (const file of sessionFiles()) {
		if (!force && !fileChanged(db, file)) {
			skipped += 1;
			continue;
		}
		try {
			const result = ingestSessionFile(db, file);
			sessionFilesScanned += 1;
			events += result.events;
			calls += result.calls;
		} catch (err) {
			log.error(`session ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	metaSet(db, "last_ingest", String(Date.now()));
	metaSet(db, "last_ingest_ms", String(Date.now() - started));
	return { decisionFiles, sessionFiles: sessionFilesScanned, events, calls, skipped, ms: Date.now() - started };
}

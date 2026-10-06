/**
 * Observatory server. Serves the static UI, the JSON API and an SSE stream;
 * watches pi data dirs and re-ingests on change. Loopback-bound by default.
 */
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { agentDir, dbPath, decisionsDir, loadConfig, sessionsRoot, webDir } from "./config";
import { metaSet, openDb } from "./db";
import { loadAdapters } from "./adapters/registry";
import { ingestAll } from "./ingest";
import { log } from "./log";
import * as queries from "./queries";

const config = loadConfig();
const db = openDb();
const startedAt = Date.now();

log.info("initial ingest…");
const first = await ingestAll(db);
log.info(`ingest: ${first.events} events, ${first.calls} model calls, ${first.sessionFiles} sessions in ${first.ms}ms`);

// ------------------------------------------------------------------ live updates

const encoder = new TextEncoder();
const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function broadcast(payload: unknown): void {
	const frame = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
	for (const client of sseClients) {
		try {
			client.enqueue(frame);
		} catch (err) {
			// Closed clients reject enqueue; drop them from the fan-out.
			sseClients.delete(client);
			log.warn(`dropping SSE client: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

let ingestTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleIngest(): void {
	clearTimeout(ingestTimer);
	// Coalesce bursts (a turn writes several files) into one ingest pass.
	ingestTimer = setTimeout(async () => {
		try {
			const result = await ingestAll(db);
			if (result.events > 0 || result.calls > 0) {
				metaSet(db, "last_change", String(Date.now()));
				broadcast({ type: "ingest", at: Date.now(), ...result });
			}
		} catch (err) {
			log.error(`watcher ingest failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, 400);
}

for (const dir of [sessionsRoot(), decisionsDir(), path.join(decisionsDir(), "refine"), path.join(decisionsDir(), "decision-tuner")]) {
	if (!existsSync(dir)) continue;
	try {
		watch(dir, { recursive: true }, () => scheduleIngest());
	} catch (err) {
		// Some filesystems cannot watch recursively; polling via /api/sync still works.
		log.warn(`cannot watch ${dir}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// Safety net: catch anything the OS watch coalesced or dropped. Unchanged
// files are skipped by stat, so this pass is cheap.
setInterval(() => scheduleIngest(), 60_000);

setInterval(() => {
	const ping = encoder.encode(": ping\n\n");
	for (const client of sseClients) {
		try {
			client.enqueue(ping);
		} catch (err) {
			sseClients.delete(client);
			log.warn(`keepalive drop: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}, 25_000);

// ------------------------------------------------------------------ helpers

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
	".ico": "image/x-icon",
	".png": "image/png",
};

function rangeFrom(url: URL): queries.Range {
	const to = Number(url.searchParams.get("to")) || Date.now();
	const raw = url.searchParams.get("from");
	if (!raw || raw === "all") return { from: 0, to };
	const relative = /^(\d+)([hdw])$/.exec(raw);
	if (relative) {
		const value = Number(relative[1]);
		const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2] as "h" | "d" | "w"] ?? 86_400_000;
		return { from: to - value * unit, to };
	}
	const parsed = Number(raw);
	return { from: Number.isFinite(parsed) ? parsed : to - 7 * 86_400_000, to };
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function serveStatic(pathname: string): Response {
	const root = webDir();
	const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const target = path.resolve(root, rel);
	if (!target.startsWith(path.resolve(root))) return new Response("forbidden", { status: 403 });
	if (!existsSync(target) || !statSync(target).isFile()) {
		if (rel.includes(".")) return new Response("not found", { status: 404 });
		return new Response(readFileSync(path.join(root, "index.html"), "utf8"), { headers: { "content-type": MIME[".html"] ?? "text/html" } });
	}
	const ext = path.extname(target);
	// Local tool: never let the browser serve a stale stylesheet or module.
	const cacheable = ext === ".png" || ext === ".svg" || ext === ".ico";
	return new Response(readFileSync(target), {
		headers: {
			"content-type": MIME[ext] ?? "application/octet-stream",
			"cache-control": cacheable ? "max-age=3600" : "no-cache",
		},
	});
}

function insertBridgeEvent(event: Record<string, unknown>): number {
	const kind = typeof event.kind === "string" ? event.kind : "event";
	const system = typeof event.system === "string" ? event.system : "bridge";
	const ts = typeof event.ts === "string" ? event.ts : new Date().toISOString();
	const id = typeof event.id === "string" ? event.id : randomUUID();
	const result = db.run(
		"INSERT OR IGNORE INTO events (fingerprint, ts, ts_ms, origin, system, kind, severity, session_id, turn, cost_usd, latency_ms, ref, title, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		...[
			`bridge|${id}`,
			ts,
			Number.isFinite(Date.parse(ts)) ? Date.parse(ts) : Date.now(),
			"bridge",
			system,
			kind,
			typeof event.severity === "string" ? event.severity : "info",
			typeof event.sessionId === "string" ? event.sessionId : null,
			typeof event.turn === "number" ? event.turn : null,
			typeof event.costUsd === "number" ? event.costUsd : null,
			typeof event.latencyMs === "number" ? event.latencyMs : null,
			typeof event.ref === "string" ? event.ref : null,
			typeof event.title === "string" ? event.title : null,
			typeof event.summary === "string" ? event.summary : null,
			JSON.stringify(event.data ?? {}),
		],
	);
	return Number(result.changes ?? 0);
}

// ------------------------------------------------------------------ routes

const server = Bun.serve({
	hostname: config.host,
	port: config.port,
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const p = url.pathname;

		if (!p.startsWith("/api/")) return serveStatic(p);

		try {
			if (p === "/api/ping") return json({ ok: true, at: Date.now() });

			if (p === "/api/stream") {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "hello", at: Date.now() })}\n\n`));
						sseClients.add(controller);
						req.signal.addEventListener("abort", () => {
							sseClients.delete(controller);
							try {
								controller.close();
							} catch (err) {
								// Already closed by the runtime; nothing to do.
								log.warn(`SSE close: ${err instanceof Error ? err.message : String(err)}`);
							}
						});
					},
				});
				return new Response(stream, {
					headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
				});
			}

			if (p === "/api/sync" && req.method === "POST") {
				const force = url.searchParams.get("force") === "1";
				const result = await ingestAll(db, { force });
				broadcast({ type: "ingest", at: Date.now(), ...result });
				return json(result);
			}

			if (p === "/api/emit" && req.method === "POST") {
				const body = (await req.json().catch(() => null)) as { events?: Record<string, unknown>[] } | null;
				const events = body?.events ?? [];
				let inserted = 0;
				db.transaction(() => {
					for (const event of events) inserted += insertBridgeEvent(event);
				})();
				if (inserted > 0) broadcast({ type: "ingest", at: Date.now(), events: inserted, bridge: true });
				return json({ ok: true, inserted });
			}

			if (p === "/api/status") return json(await queries.status(db, { port: config.port, host: config.host, startedAt, dbPath: dbPath() }));
			if (p === "/api/overview") return json(queries.overview(db, rangeFrom(url)));
			if (p === "/api/impact") return json(queries.impact(db, rangeFrom(url), url.searchParams.get("model")));
			if (p === "/api/findings") return json(queries.findings(db, rangeFrom(url), await loadAdapters()));
			if (p === "/api/benefits") return json(queries.harnessBenefits(db, rangeFrom(url)));
			if (p === "/api/trends") return json(queries.trends(db, rangeFrom(url)));
			if (p === "/api/session/impact") {
				const sessionId = url.searchParams.get("id");
				if (!sessionId) return json({ error: "id parameter required" }, 400);
				return json(queries.sessionImpact(db, sessionId));
			}
			if (p === "/api/models") return json(queries.models(db, rangeFrom(url)));
			if (p === "/api/router") return json(queries.router(db, rangeFrom(url), Number(url.searchParams.get("limit")) || 300));
			if (p === "/api/ledger")
				return json(
					queries.ledger(db, {
						system: url.searchParams.get("system") ?? undefined,
						kind: url.searchParams.get("kind") ?? undefined,
						severity: url.searchParams.get("severity") ?? undefined,
						q: url.searchParams.get("q") ?? undefined,
						range: rangeFrom(url),
						limit: Math.min(500, Number(url.searchParams.get("limit")) || 200),
						offset: Number(url.searchParams.get("offset")) || 0,
					}),
				);
			if (p === "/api/ledger/stats") return json(queries.ledgerStats(db, rangeFrom(url)));
			if (p === "/api/digest") {
				const range = rangeFrom(url);
				return json(queries.digest(db, range, url.searchParams.get("label") ?? "selected range", await loadAdapters()));
			}
			if (p === "/api/curator/sessions") return json(queries.curatorSessions(db));
			if (p === "/api/curator/overview") return json(queries.curatorOverview(db, rangeFrom(url)));
			if (p === "/api/curator") {
				const session = url.searchParams.get("session");
				if (!session) return json({ error: "session parameter required" }, 400);
				return json(queries.curatorDetail(db, session));
			}
			if (p === "/api/sessions")
				return json(
					queries.sessionsList(db, {
						q: url.searchParams.get("q") ?? undefined,
						sort: url.searchParams.get("sort") ?? undefined,
						limit: Math.min(2000, Number(url.searchParams.get("limit")) || 400),
					}),
				);
			if (p === "/api/session") {
				const id = url.searchParams.get("id");
				if (!id) return json({ error: "id parameter required" }, 400);
				return json(queries.sessionDetail(db, id));
			}
			if (p === "/api/extensions") return json(await queries.extensionsInventory(db));
			if (p === "/api/refine") return json(queries.refineOverview(db, rangeFrom(url)));
			if (p === "/api/tuner") return json(queries.tunerOverview(db, rangeFrom(url)));
			if (p === "/api/file") {
				const requested = url.searchParams.get("path");
				if (!requested) return json({ error: "path parameter required" }, 400);
				const result = queries.readHarnessFile(requested);
				return "error" in result ? json(result, 404) : json(result);
			}
			if (p === "/api/health") return json(queries.health(db, rangeFrom(url)));
			if (p === "/api/live") return json(queries.live(db, Math.min(400, Number(url.searchParams.get("limit")) || 80)));
			if (p === "/api/event") {
				const id = Number(url.searchParams.get("id"));
				if (!id) return json({ error: "id parameter required" }, 400);
				return json(queries.eventDetail(db, id));
			}
			if (p === "/api/manifest") {
				const inventory = await queries.extensionsInventory(db);
				return json({ version: "0.1.0", generatedAt: Date.now(), adapters: inventory.adapters });
			}
			return json({ error: "not found" }, 404);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.error(`${p} failed: ${message}`);
			return json({ error: message }, 500);
		}
	},
});

log.info(`listening on http://${config.host}:${server.port} (db ${dbPath()})`);

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

function shutdown(): void {
	log.info("shutting down");
	try {
		db.close();
	} catch (err) {
		log.error(`db close: ${err instanceof Error ? err.message : String(err)}`);
	}
	server.stop(true);
	process.exit(0);
}

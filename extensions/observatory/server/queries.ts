/**
 * API query layer. Amounts are summed from typed tables (model calls) and the
 * generic events table (harness decisions). System-specific effectiveness math
 * runs in JS over a bounded row set so log schema drift never breaks a page.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { agentDir, extensionsDir, refineDir, rulesDir, tunerDir } from "./config";
import { resolveProposalFile } from "./proposal-file";
import { loadAdapters, type Adapter } from "./adapters/registry";
import { adapterFilePath } from "./adapters/define";
import { log } from "./log";

export interface Range {
	from: number;
	to: number;
}

interface EventRow {
	id: number;
	ts: string;
	ts_ms: number | null;
	origin: string;
	system: string;
	kind: string;
	severity: string;
	session_id: string | null;
	turn: number | null;
	cost_usd: number | null;
	latency_ms: number | null;
	ref: string | null;
	title: string | null;
	summary: string | null;
	data: string;
}

const dayExpr = "strftime('%Y-%m-%d', ts_ms / 1000, 'unixepoch', 'localtime')";

function pct(values: number[], p: number): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
	return sorted[idx] ?? null;
}

function tally(rows: Array<Record<string, string | number | null>>, key: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const row of rows) {
		const value = row[key];
		if (value === null || value === undefined) continue;
		const label = String(value);
		out[label] = (out[label] ?? 0) + 1;
	}
	return out;
}

function parseData(row: { data: string }): Record<string, unknown> {
	try {
		return JSON.parse(row.data) as Record<string, unknown>;
	} catch {
		// A malformed payload still renders as a generic row; keep the record.
		return {};
	}
}

// ------------------------------------------------------------------ prices

interface Price {
	model: string;
	input: number | null;
	output: number | null;
	cache_read: number | null;
	cache_write: number | null;
}

export function prices(db: Database): Price[] {
	return db.query<Price, []>("SELECT model, input, output, cache_read, cache_write FROM prices").all();
}

function priceFor(list: Price[], model: string): Price | null {
	const exact = list.find((p) => p.model === model);
	if (exact) return exact;
	const bare = model.replace(/^~/, "");
	return (
		list.find((p) => p.model.replace(/^~/, "") === bare) ??
		list.find((p) => bare.endsWith(p.model.replace(/^~/, "")) || p.model.replace(/^~/, "").endsWith(bare)) ??
		null
	);
}

// ------------------------------------------------------------------ overview

export function overview(db: Database, range: Range) {
	const totals = db
		.query<
			{
				calls: number;
				input: number;
				output: number;
				cache_read: number;
				cache_write: number;
				reasoning: number;
				total_tokens: number;
				cost: number;
				errors: number;
				sessions: number;
			},
			[number, number]
		>(
			`SELECT COUNT(*) calls, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
			        COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write,
			        COALESCE(SUM(reasoning),0) reasoning, COALESCE(SUM(total_tokens),0) total_tokens,
			        COALESCE(SUM(cost),0) cost,
			        COALESCE(SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END),0) errors,
			        COUNT(DISTINCT session_id) sessions
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ?`,
		)
		.get(range.from, range.to);

	const turns = db
		.query<{ n: number }, [number, number]>("SELECT COUNT(*) n FROM messages WHERE role = 'user' AND ts_ms BETWEEN ? AND ?")
		.get(range.from, range.to);

	const harness = db
		.query<{ n: number; cost: number }, [number, number]>("SELECT COUNT(*) n, COALESCE(SUM(cost_usd),0) cost FROM events WHERE ts_ms BETWEEN ? AND ?")
		.get(range.from, range.to);

	const modelDaily = db
		.query<{ day: string; cost: number; tokens: number; calls: number; cache_read: number }, [number, number]>(
			`SELECT ${dayExpr} day, COALESCE(SUM(cost),0) cost, COALESCE(SUM(total_tokens),0) tokens, COUNT(*) calls, COALESCE(SUM(cache_read),0) cache_read
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ? GROUP BY day ORDER BY day`,
		)
		.all(range.from, range.to);

	const harnessDaily = db
		.query<{ day: string; cost: number; events: number }, [number, number]>(
			`SELECT ${dayExpr} day, COALESCE(SUM(cost_usd),0) cost, COUNT(*) events
			 FROM events WHERE ts_ms BETWEEN ? AND ? GROUP BY day ORDER BY day`,
		)
		.all(range.from, range.to);

	const days = new Map<string, { date: string; costModel: number; costHarness: number; tokens: number; calls: number; events: number; cacheRead: number }>();
	for (const row of modelDaily) days.set(row.day, { date: row.day, costModel: row.cost, costHarness: 0, tokens: row.tokens, calls: row.calls, events: 0, cacheRead: row.cache_read });
	for (const row of harnessDaily) {
		const day = days.get(row.day) ?? { date: row.day, costModel: 0, costHarness: 0, tokens: 0, calls: 0, events: 0, cacheRead: 0 };
		day.costHarness = row.cost;
		day.events = row.events;
		days.set(row.day, day);
	}

	const topModels = db
		.query<{ model: string; cost: number; calls: number; tokens: number }, [number, number]>(
			`SELECT model, COALESCE(SUM(cost),0) cost, COUNT(*) calls, COALESCE(SUM(total_tokens),0) tokens
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ? AND model IS NOT NULL GROUP BY model ORDER BY cost DESC LIMIT 8`,
		)
		.all(range.from, range.to);

	// Per-model daily breakdown for the Overview chart: the same top-5 + other
	// grouping the Models tab uses, plus harness overhead where a subsystem logs
	// its own price. `cost` and `requests` carry the harness series; tokens do not,
	// because decision events log no tokens.
	const perModelDaily = db
		.query<{ day: string; model: string; cost: number; tokens: number; calls: number }, [number, number]>(
			`SELECT ${dayExpr} day, model, COALESCE(SUM(cost),0) cost, COALESCE(SUM(total_tokens),0) tokens, COUNT(*) calls
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ? AND model IS NOT NULL GROUP BY day, model`,
		)
		.all(range.from, range.to);
	const dailyLabels = [...days.keys()].sort();
	const dailyIndex = new Map(dailyLabels.map((day, i) => [day, i]));
	const topFive = topModels.slice(0, 5).map((m) => m.model);
	const modelMetricSeries = (pick: (row: (typeof perModelDaily)[number]) => number) => {
		const series = [...topFive, "other"].map((name) => ({ name, values: new Array(dailyLabels.length).fill(0) as number[] }));
		for (const row of perModelDaily) {
			const i = dailyIndex.get(row.day);
			if (i === undefined) continue;
			const target = series.find((s) => s.name === (topFive.includes(row.model) ? row.model : "other"));
			if (target) target.values[i] += pick(row);
		}
		return series;
	};
	const harnessDay = (name: string, pick: (day: { costHarness: number; events: number }) => number) => ({
		name,
		values: dailyLabels.map((day) => pick(days.get(day)!)),
	});
	const dailyMetrics = {
		cost: [...modelMetricSeries((r) => r.cost), harnessDay("harness", (d) => d.costHarness)],
		tokens: modelMetricSeries((r) => r.tokens),
		requests: [...modelMetricSeries((r) => r.calls), harnessDay("harness decisions", (d) => d.events)],
	};

	const toRows = db
		.query<EventRow, [number, number]>("SELECT * FROM events WHERE ts_ms BETWEEN ? AND ? AND severity IN ('warn','error') ORDER BY ts_ms DESC LIMIT 12")
		.all(range.from, range.to);

	const systems = db
		.query<{ system: string; n: number; cost: number }, [number, number]>(
			"SELECT system, COUNT(*) n, COALESCE(SUM(cost_usd),0) cost FROM events WHERE ts_ms BETWEEN ? AND ? GROUP BY system",
		)
		.all(range.from, range.to);
	const bySystem = Object.fromEntries(systems.map((s) => [s.system, { count: s.n, cost: s.cost }]));

	const curator = db
		.query<EventRow, [number, number]>("SELECT * FROM events WHERE system = 'curator' AND ts_ms BETWEEN ? AND ? LIMIT 20000")
		.all(range.from, range.to);
	let curatorCandidates = 0;
	let curatorEmits = 0;
	let curatorSavedChars = 0;
	let curatorRetain = 0;
	const curatorVerdicts: Record<string, number> = {};
	let contextPctSum = 0;
	let contextPctCount = 0;
	for (const row of curator) {
		const data = parseData(row);
		if (row.kind === "shadow") curatorCandidates += 1;
		const verdict = typeof data.verifierVerdict === "string" ? data.verifierVerdict : null;
		if (verdict) curatorVerdicts[verdict] = (curatorVerdicts[verdict] ?? 0) + 1;
		if (verdict === "retainFull") curatorRetain += 1;
		if (data.action === "emit" || row.kind === "emit-evidence") {
			curatorEmits += 1;
			if (typeof data.saved === "number") curatorSavedChars += data.saved;
		}
		if (typeof data.contextPct === "number") {
			contextPctSum += data.contextPct;
			contextPctCount += 1;
		}
	}

	const router = db
		.query<EventRow, [number, number]>("SELECT * FROM events WHERE system = 'router' AND ts_ms BETWEEN ? AND ? LIMIT 20000")
		.all(range.from, range.to);
	const routerTiers: Record<string, number> = {};
	let routerActed = 0;
	for (const row of router) {
		const data = parseData(row);
		const tier = typeof data.tier === "string" ? data.tier : "unknown";
		routerTiers[tier] = (routerTiers[tier] ?? 0) + 1;
		if (data.acted === true) routerActed += 1;
	}
	const routerTotal = router.length;

	const ttsr = db.query<EventRow, [number, number]>("SELECT * FROM events WHERE system = 'ttsr' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	const ttsrStats = { fired: 0, suppressed: 0, blocked: 0, good: 0, bad: 0 };
	for (const row of ttsr) {
		const data = parseData(row);
		if (data.decision === "fired") ttsrStats.fired += 1;
		if (data.decision === "suppressed") ttsrStats.suppressed += 1;
		if (data.blocked === true) ttsrStats.blocked += 1;
		if (data.verdict === "good") ttsrStats.good += 1;
		if (data.verdict === "bad") ttsrStats.bad += 1;
	}

	const guard = db.query<EventRow, [number, number]>("SELECT * FROM events WHERE system = 'guard' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	const guardVerdicts: Record<string, number> = {};
	for (const row of guard) {
		const data = parseData(row);
		const verdict = typeof data.verdict === "string" ? data.verdict : "unknown";
		guardVerdicts[verdict] = (guardVerdicts[verdict] ?? 0) + 1;
	}

	const memory = db.query<EventRow, [number, number]>("SELECT * FROM events WHERE system = 'memory' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	const memoryStats = { consolidations: 0, degraded: 0, admissions: 0 };
	for (const row of memory) {
		const data = parseData(row);
		if (data.decision === "consolidation") memoryStats.consolidations += 1;
		if (data.decision === "admission") memoryStats.admissions += 1;
		if (row.severity === "warn") memoryStats.degraded += 1;
	}

	return {
		range,
		totals: {
			cost: totals?.cost ?? 0,
			costModel: totals?.cost ?? 0,
			costHarness: harness?.cost ?? 0,
			calls: totals?.calls ?? 0,
			turns: turns?.n ?? 0,
			sessions: totals?.sessions ?? 0,
			input: totals?.input ?? 0,
			output: totals?.output ?? 0,
			cacheRead: totals?.cache_read ?? 0,
			cacheWrite: totals?.cache_write ?? 0,
			reasoning: totals?.reasoning ?? 0,
			totalTokens: totals?.total_tokens ?? 0,
			cacheRate: totals && totals.input + totals.cache_read > 0 ? totals.cache_read / (totals.input + totals.cache_read) : null,
			errors: totals?.errors ?? 0,
			events: harness?.n ?? 0,
		},
		daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
		dailyMetrics,
		topModels,
		bySystem,
		leverage: {
			curator: {
				candidates: curatorCandidates,
				emits: curatorEmits,
				savedChars: curatorSavedChars || null,
				retainFull: curatorRetain,
				verdicts: curatorVerdicts,
				avgContextPct: contextPctCount ? contextPctSum / contextPctCount : null,
			},
			router: { total: routerTotal, tiers: routerTiers, acted: routerActed, actedPct: routerTotal ? routerActed / routerTotal : null },
			ttsr: ttsrStats,
			guard: { total: guard.length, verdicts: guardVerdicts, cost: guard.reduce((a, r) => a + (r.cost_usd ?? 0), 0) },
			memory: memoryStats,
		},
		watchlist: toRows.map((row) => ({
			id: row.id,
			ts: row.ts,
			system: row.system,
			kind: row.kind,
			severity: row.severity,
			title: row.title,
			summary: row.summary,
			sessionId: row.session_id,
		})),
	};
}

// ------------------------------------------------------------------ impact

/**
 * What the harness saved or cost, per mechanism. Every number carries its
 * basis; anything the logs cannot support is returned as null / "count only"
 * rather than guessed.
 */
export function impact(db: Database, range: Range, model: string | null = null) {
	const priceList = prices(db);

	const modelRows = db
		.query<{ model: string; input: number; output: number; cache_read: number; calls: number }, number[]>(
			`SELECT model, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output, COALESCE(SUM(cache_read),0) cache_read, COUNT(*) calls
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ? AND model IS NOT NULL${model ? " AND model = ?" : ""} GROUP BY model`,
		)
		.all(...(model ? [range.from, range.to, model] : [range.from, range.to]));

	let pricedInputTokens = 0;
	let pricedInputCost = 0;
	let pricedCacheReadTokens = 0;
	let pricedCacheReadCost = 0;
	let totalInputTokens = 0;
	let cacheSavingsUsd = 0;
	let cacheReadTokens = 0;
	let pricedCalls = 0;
	let unpricedCalls = 0;
	for (const row of modelRows) {
		totalInputTokens += row.input;
		const price = priceFor(priceList, row.model);
		if (price?.input != null) {
			pricedInputTokens += row.input;
			pricedInputCost += (row.input * price.input) / 1_000_000;
			pricedCalls += row.calls;
		} else {
			unpricedCalls += row.calls;
		}
		if (price?.input != null && price.cache_read != null) {
			cacheSavingsUsd += (row.cache_read * (price.input - price.cache_read)) / 1_000_000;
			cacheReadTokens += row.cache_read;
			pricedCacheReadTokens += row.cache_read;
			pricedCacheReadCost += (row.cache_read * price.cache_read) / 1_000_000;
		}
	}
	// $ per token, blended across priced models — the rate used to price saved chars.
	const blendedInputRate = pricedInputTokens > 0 ? pricedInputCost / pricedInputTokens : null;
	const blendedCacheRate = pricedCacheReadTokens > 0 ? pricedCacheReadCost / pricedCacheReadTokens : blendedInputRate;
	const promptTokenTotal = totalInputTokens + cacheReadTokens;
	const cacheHitRate = promptTokenTotal > 0 ? cacheReadTokens / promptTokenTotal : 1;
	// Saved tokens would mostly have been re-sent from cache, so they are worth
	// the cache rate far more often than the full input rate. Pricing them at the
	// input rate would overstate the saving.
	const effectiveRate =
		blendedInputRate != null && blendedCacheRate != null ? cacheHitRate * blendedCacheRate + (1 - cacheHitRate) * blendedInputRate : blendedInputRate;

	// -------- curator condensation
	// Classification counts come from the decision log…
	const curatorRows = db
		.query<{ kind: string; data: string }, [number, number]>("SELECT kind, data FROM events WHERE system = 'curator' AND ts_ms BETWEEN ? AND ? LIMIT 40000")
		.all(range.from, range.to);
	let curatorCandidates = 0;
	let curatorRetain = 0;
	let verifierAbTotal = 0;
	let verifierAbAgree = 0;
	let verifierEscalations = 0;
	let repairsVerified = 0;
	let repairsRepaired = 0;
	let repairsLostLines = 0;
	let repairsDropped = 0;
	for (const row of curatorRows) {
		const data = parseData(row);
		if (row.kind === "shadow") curatorCandidates += 1;
		if (data.verifierVerdict === "retainFull") curatorRetain += 1;
		if (data.decision === "verifier-ab" && typeof data.agree === "boolean") {
			verifierAbTotal += 1;
			if (data.agree) verifierAbAgree += 1;
		}
		if (typeof data.verifierModel === "string" && data.verifierModel.includes("frontier")) verifierEscalations += 1;
		if (data.decision === "jev-verify") {
			repairsVerified += 1;
			if (data.repaired === true) repairsRepaired += 1;
			if (Array.isArray(data.lostLines)) repairsLostLines += data.lostLines.length;
			if (typeof data.droppedChecked === "number") repairsDropped += data.droppedChecked;
		}
	}

	// …savings come from session ledger items, which carry session + turn. A
	// condensed source stays condensed for every later turn in that session, so
	// the saving is carried: chars saved x remaining turns.
	const turnCounts = new Map<string, number>();
	for (const row of db.query<{ session_id: string; turns: number }, []>("SELECT session_id, turns FROM sessions").all()) turnCounts.set(row.session_id, row.turns);
	const ledgerRows = db
		.query<{ session_id: string; turn: number | null; data: string }, [number, number]>(
			"SELECT session_id, turn, data FROM events WHERE kind = 'curator.ledger' AND session_id IS NOT NULL AND ts_ms BETWEEN ? AND ? LIMIT 40000",
		)
		.all(range.from, range.to);
	// Attribute each condensed item to the model in use at that turn (curator
	// ledger items carry session + turn, not a model).
	const modelByTurn = new Map<string, string>();
	for (const row of db
		.query<{ session_id: string; turn: number; model: string }, [number, number]>(
			`SELECT session_id, turn, MIN(model) model FROM model_calls WHERE ts_ms BETWEEN ? AND ? AND model IS NOT NULL GROUP BY session_id, turn`,
		)
		.all(range.from, range.to)) {
		modelByTurn.set(`${row.session_id}|${row.turn}`, row.model);
	}
	const modelAt = (session: string, turn: number | null): string | null => {
		if (turn == null) return null;
		return modelByTurn.get(`${session}|${turn}`) ?? modelByTurn.get(`${session}|${turn + 1}`) ?? modelByTurn.get(`${session}|${turn - 1}`) ?? null;
	};
	let curatorItemsTotal = 0;
	let curatorItemsAttributed = 0;

	let curatorEmits = 0;
	let savedCharsOneTime = 0;
	let savedCharsCarried = 0;
	const savedBySource: Record<string, number> = {};
	for (const row of ledgerRows) {
		const data = parseData(row);
		const items = Array.isArray(data.items) ? data.items : [];
		for (const rawItem of items) {
			const item = (rawItem ?? {}) as Record<string, unknown>;
			const sourceChars = typeof item.chars === "number" ? item.chars : null;
			const extractChars = typeof item.extractChars === "number" ? item.extractChars : null;
			const verdict = typeof item.verdict === "string" ? item.verdict : null;
			if (sourceChars == null || extractChars == null || (verdict !== "useExtract" && verdict !== "indexOnly")) continue;
			const delta = Math.max(0, sourceChars - extractChars);
			if (delta === 0) continue;
			const turn = typeof item.turn === "number" ? item.turn : (row.turn ?? 0);
			const itemModel = modelAt(row.session_id, turn);
			curatorItemsTotal += 1;
			if (itemModel != null) curatorItemsAttributed += 1;
			if (model && itemModel !== model) continue;
			const remaining = Math.max(0, (turnCounts.get(row.session_id) ?? 0) - turn);
			curatorEmits += 1;
			savedCharsOneTime += delta;
			savedCharsCarried += delta * remaining;
			const sourceType = typeof item.sourceType === "string" ? item.sourceType : "other";
			savedBySource[sourceType] = (savedBySource[sourceType] ?? 0) + delta;
		}
	}
	// Fallback for logs written before ledger items carried extract sizes —
	// only valid for the unscoped view, where every item is in scope.
	if (!model && curatorEmits === 0) {
		for (const row of curatorRows) {
			const data = parseData(row);
			const verdict = typeof data.verifierVerdict === "string" ? data.verifierVerdict : null;
			const chars = typeof data.chars === "number" ? data.chars : null;
			const extract = typeof data.proposedExtract === "string" ? data.proposedExtract : null;
			if (chars != null && extract != null && (verdict === "useExtract" || verdict === "indexOnly")) {
				const delta = Math.max(0, chars - extract.length);
				curatorEmits += 1;
				savedCharsOneTime += delta;
				savedCharsCarried += delta;
			}
		}
	}
	const savedTokensOneTime = Math.round(savedCharsOneTime / 4);
	const savedTokensEst = Math.round(savedCharsCarried / 4);
	const savedUsdEst = effectiveRate != null ? savedTokensEst * effectiveRate : null;

	// -------- harness overhead that the logs actually price
	const overheadRows = db
		.query<{ system: string; decisions: number; cost: number }, [number, number]>(
			`SELECT system, COUNT(*) decisions, COALESCE(SUM(cost_usd),0) cost
			 FROM events WHERE ts_ms BETWEEN ? AND ? AND cost_usd IS NOT NULL GROUP BY system ORDER BY cost DESC`,
		)
		.all(range.from, range.to);
	const overheadCost = overheadRows.reduce((a, r) => a + r.cost, 0);
	const overheadDecisions = overheadRows.reduce((a, r) => a + r.decisions, 0);

	// -------- guard
	const guardRows = db.query<{ ts: string; data: string }, [number, number]>("SELECT ts, data FROM events WHERE system = 'guard' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	const destructive: Array<{ command: string; destructive: number; ts: string }> = [];
	let guardBlocked = 0;
	let guardFlagged = 0;
	for (const row of guardRows) {
		const data = parseData(row);
		const verdict = typeof data.verdict === "string" ? data.verdict : "";
		if (verdict === "blocked") guardBlocked += 1;
		if (verdict === "flagged") guardFlagged += 1;
		if ((verdict === "blocked" || verdict === "flagged") && typeof data.command === "string") {
			destructive.push({ command: data.command.slice(0, 180), destructive: typeof data.destructive === "number" ? data.destructive : 0, ts: row.ts });
		}
	}
	destructive.sort((a, b) => b.destructive - a.destructive);

	// -------- TTSR
	const ttsrRows = db.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE system = 'ttsr' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	const ttsr = { fired: 0, suppressed: 0, delivered: 0, blocked: 0, good: 0, bad: 0, unresolved: 0 };
	let userCorrections = 0;
	const ttsrRules: Record<string, { good: number; bad: number; fired: number }> = {};
	for (const row of ttsrRows) {
		const data = parseData(row);
		if (data.decision === "fired") ttsr.fired += 1;
		if (data.decision === "suppressed") ttsr.suppressed += 1;
		if (data.delivered === true) ttsr.delivered += 1;
		if (data.blocked === true) ttsr.blocked += 1;
		if (data.verdict === "good") ttsr.good += 1;
		if (data.verdict === "bad") ttsr.bad += 1;
		if (data.outcome === "unresolved") ttsr.unresolved += 1;
		if (data.outcome === "user_corrected") userCorrections += 1;
		const rule = typeof data.rule === "string" ? data.rule : null;
		if (rule) {
			const entry = (ttsrRules[rule] ??= { good: 0, bad: 0, fired: 0 });
			if (data.decision === "fired") entry.fired += 1;
			if (data.verdict === "good") entry.good += 1;
			if (data.verdict === "bad") entry.bad += 1;
		}
	}

	// -------- router escalations joined to the call they influenced
	const callByTurn = new Map<string, { input: number; output: number }>();
	for (const row of db
		.query<{ session_id: string | null; turn: number | null; input: number; output: number }, [number, number]>(
			"SELECT session_id, turn, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output FROM model_calls WHERE ts_ms BETWEEN ? AND ? GROUP BY session_id, turn",
		)
		.all(range.from, range.to)) {
		if (row.session_id != null && row.turn != null) callByTurn.set(`${row.session_id}|${row.turn}`, { input: row.input, output: row.output });
	}
	const routerRows = db
		.query<{ session_id: string | null; turn: number | null; data: string }, [number, number]>(
			"SELECT session_id, turn, data FROM events WHERE system = 'router' AND ts_ms BETWEEN ? AND ? LIMIT 20000",
		)
		.all(range.from, range.to);
	let escalations = 0;
	let escalationMatched = 0;
	let escalationUsd = 0;
	let escalationTokens = 0;
	const routerVerdicts = { good: 0, bad: 0 };
	for (const row of routerRows) {
		const data = parseData(row);
		if (data.outcome === "user_corrected") userCorrections += 1;
		if (data.verdict === "good") routerVerdicts.good += 1;
		if (data.verdict === "bad") routerVerdicts.bad += 1;
		if (data.acted !== true) continue;
		const from = typeof data.from === "string" ? data.from : null;
		const to = typeof data.to === "string" ? data.to : null;
		if (!from || !to || from === to) continue;
		if (model && from !== model && to !== model) continue;
		escalations += 1;
		const tokens =
			row.session_id != null && row.turn != null
				? (callByTurn.get(`${row.session_id}|${row.turn}`) ?? callByTurn.get(`${row.session_id}|${row.turn + 1}`) ?? callByTurn.get(`${row.session_id}|${row.turn - 1}`))
				: undefined;
		if (!tokens) continue;
		const fromPrice = priceFor(priceList, from);
		const toPrice = priceFor(priceList, to);
		if (fromPrice?.input == null || fromPrice.output == null || toPrice?.input == null || toPrice.output == null) continue;
		escalationMatched += 1;
		escalationTokens += tokens.input + tokens.output;
		escalationUsd += (tokens.input * (toPrice.input - fromPrice.input) + tokens.output * (toPrice.output - fromPrice.output)) / 1_000_000;
	}

	// -------- memory + course checks
	const memoryRows = db.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE system = 'memory' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	const memory = { admissions: 0, rejected: 0, consolidations: 0, shrinkBytes: 0, degraded: 0 };
	for (const row of memoryRows) {
		const data = parseData(row);
		if (data.decision === "admission") memory.admissions += 1;
		if (data.outcome === "block") memory.rejected += 1;
		if (data.decision === "consolidation") {
			memory.consolidations += 1;
			const scores = (data.scores ?? {}) as Record<string, unknown>;
			if (typeof scores.shrink_bytes === "number") memory.shrinkBytes += scores.shrink_bytes;
		}
		if (data.outcome === "degraded" || data.degraded === true) memory.degraded += 1;
	}
	const courseRows = db.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE system = 'course-check' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	const course: Record<string, number> = {};
	for (const row of courseRows) {
		const data = parseData(row);
		if (typeof data.verdict === "string") course[data.verdict] = (course[data.verdict] ?? 0) + 1;
	}

	// -------- quality signals (health of the harness's own judgments)
	const callStats = db
		.query<{ calls: number; errors: number }, number[]>(
			`SELECT COUNT(*) calls, COALESCE(SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END),0) errors
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ?${model ? " AND model = ?" : ""}`,
		)
		.get(...(model ? [range.from, range.to, model] : [range.from, range.to]));
	const goalTotal = course.on_track !== undefined || course.goal_met !== undefined || course.off_track !== undefined ? (course.on_track ?? 0) + (course.goal_met ?? 0) + (course.off_track ?? 0) : 0;
	const ruleJudged = ttsr.good + ttsr.bad;
	const quality = {
		verifierAgreement: verifierAbTotal ? verifierAbAgree / verifierAbTotal : null,
		verifierAbTotal,
		verifierAbAgree,
		verifierEscalations,
		repairs: {
			verified: repairsVerified,
			repaired: repairsRepaired,
			rate: repairsVerified ? repairsRepaired / repairsVerified : null,
			lostLines: repairsLostLines,
			droppedChecked: repairsDropped,
		},
		rulePrecision: { good: ttsr.good, bad: ttsr.bad, rate: ruleJudged ? ttsr.good / ruleJudged : null },
		guardClean: {
			screens: guardRows.length,
			blocked: guardBlocked,
			flagged: guardFlagged,
			rate: guardRows.length ? Math.max(0, (guardRows.length - guardBlocked - guardFlagged) / guardRows.length) : null,
		},
		goalHealth: { onTrack: course.on_track ?? 0, goalMet: course.goal_met ?? 0, offTrack: course.off_track ?? 0, total: goalTotal, rate: goalTotal ? ((course.on_track ?? 0) + (course.goal_met ?? 0)) / goalTotal : null },
		callErrors: { calls: callStats?.calls ?? 0, errors: callStats?.errors ?? 0, rate: callStats && callStats.calls > 0 ? callStats.errors / callStats.calls : null },
		routerVerdicts,
		userCorrections,
		memoryGate: { admissions: memory.admissions, rejected: memory.rejected, rate: memory.admissions ? memory.rejected / memory.admissions : null },
	};

	const totalChecked = pricedInputTokens + unpricedCalls;
	return {
		range,
		curator: {
			candidates: curatorCandidates,
			emits: curatorEmits,
			retainFull: curatorRetain,
			savedCharsOneTime,
			savedCharsCarried,
			savedTokensOneTime,
			savedTokensEst,
			savedUsdEst,
			savedBySource,
		},
		cache: { savingsUsd: cacheSavingsUsd, cacheReadTokens, pricedCalls, unpricedCalls },
		overhead: { cost: overheadCost, decisions: overheadDecisions, bySystem: overheadRows },
		guard: { screens: guardRows.length, blocked: guardBlocked, flagged: guardFlagged, destructive: destructive.slice(0, 6) },
		ttsr: { ...ttsr, topRules: Object.entries(ttsrRules).map(([rule, v]) => ({ rule, ...v })).sort((a, b) => b.fired - a.fired).slice(0, 12) },
		router: { total: routerRows.length, judged: routerVerdicts.good + routerVerdicts.bad, escalations, matched: escalationMatched, usd: escalationUsd, tokens: escalationTokens },
		memory,
		course,
		quality,
		scope: {
			model,
			curatorItemsTotal,
			curatorItemsAttributed,
			// Honest attribution: these are not attributable to a single model.
			global: ["overhead", "verifierAgreement", "rulePrecision", "routerVerdicts", "guard", "goalHealth", "memory", "cacheResets"],
		},
		rates: { blendedInputPerToken: blendedInputRate, blendedCachePerToken: blendedCacheRate, cacheHitRate, effectivePerToken: effectiveRate, pricedCoverage: totalInputTokens > 0 ? pricedInputTokens / totalInputTokens : null },
	};
}

/** Display form for a resolved log path: absolute, with the home dir shortened. */
function displayPath(file: string | null): string | null {
	if (file == null) return null;
	const home = homedir();
	return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

// ------------------------------------------------------------------ findings

export interface Finding {
	id: string;
	title: string;
	tone: "ok" | "warn" | "error" | "info";
	summary: string;
	/** The rule that fired, stated as a threshold, so the card explains itself. */
	trigger: string;
	evidence: string[];
	action: string;
	impact?: string;
	links?: Array<{ label: string; hash: string }>;
}

/**
 * Rule-based diagnostics: each finding states the evidence, the lever that
 * changes it, and (where computable) the size of the prize. Everything here is
 * derived from logged behaviour — no advice without data behind it.
 */
function computeFindings(db: Database, range: Range, adapters: Adapter[] = []): { findings: Finding[]; generatedAt: number } {
	const out: Finding[] = [];
	const compact = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
	const usd = (n: number): string => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
	const short = (value: string, max = 44): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

	// ---- session ledger items: sizes, verdicts, read targets
	interface LedgerItem {
		session: string;
		turn: number | null;
		tool: string;
		sourceType: string;
		verdict: string;
		chars: number;
		inputShape: string | null;
	}
	const items: LedgerItem[] = [];
	for (const row of db
		.query<{ session_id: string; turn: number | null; data: string }, [number, number]>(
			"SELECT session_id, turn, data FROM events WHERE kind = 'curator.ledger' AND session_id IS NOT NULL AND ts_ms BETWEEN ? AND ? LIMIT 40000",
		)
		.all(range.from, range.to)) {
		const data = parseData(row);
		const list = Array.isArray(data.items) ? data.items : [];
		for (const rawItem of list) {
			const item = (rawItem ?? {}) as Record<string, unknown>;
			items.push({
				session: row.session_id,
				turn: typeof item.turn === "number" ? item.turn : row.turn,
				tool: typeof item.tool === "string" ? item.tool : "?",
				sourceType: typeof item.sourceType === "string" ? item.sourceType : "?",
				verdict: typeof item.verdict === "string" ? item.verdict : "?",
				chars: typeof item.chars === "number" ? item.chars : 0,
				inputShape: typeof item.inputShape === "string" ? item.inputShape : null,
			});
		}
	}

	const CAP = 25_000;
	const oversized = items.filter((item) => item.chars >= CAP);
	const oversizedRetained = oversized.filter((item) => item.verdict === "retainFull");
	if (oversized.length >= 5) {
		out.push({
			id: "oversized-outputs",
			title: "Oversized tool outputs",
			tone: oversizedRetained.length >= 20 ? "warn" : "info",
			summary: `${oversized.length} tool results came in at ${compact(CAP)}+ chars (${compact(oversized.reduce((a, i) => a + i.chars, 0))} chars total); ${oversizedRetained.length} stayed in context in full.`,
			trigger: "fires when 5+ tool results reach 25k chars; escalates to a warning when 20+ of them stay in context in full",
			evidence: [...oversized]
				.sort((a, b) => b.chars - a.chars)
				.slice(0, 5)
				.map((item) => `${item.tool} · ${item.sourceType} · ${compact(item.chars)} chars · ${item.verdict}`),
			action: "Cap at the source — head/tail or filter the command itself — so the bulk never enters context. Cheapest win available.",
			impact: `~${compact(oversizedRetained.reduce((a, i) => a + i.chars, 0) / 4)} tokens carried per turn while retained`,
			links: [{ label: "Curator", hash: "#/curator" }],
		});
	}

	const readCounts = new Map<string, { path: string; session: string; count: number; chars: number }>();
	for (const item of items) {
		if (!item.inputShape) continue;
		const match = /"path"\s*:\s*"([^"]+)"/.exec(item.inputShape);
		if (!match) continue;
		const key = `${item.session}|${match[1]}`;
		const entry = readCounts.get(key) ?? { path: match[1], session: item.session, count: 0, chars: 0 };
		entry.count += 1;
		entry.chars += item.chars;
		readCounts.set(key, entry);
	}
	const repeats = [...readCounts.values()].filter((entry) => entry.count >= 3).sort((a, b) => b.count - a.count);
	if (repeats.length) {
		out.push({
			id: "repeated-reads",
			title: "Files re-read inside one session",
			tone: repeats.length > 10 ? "warn" : "info",
			summary: `${repeats.length} file/session pairs were read three or more times (worst: ${repeats[0].count}×).`,
			trigger: "fires when one file is read 3+ times inside a single session; escalates past 10 such file/session pairs",
			evidence: repeats.slice(0, 5).map((entry) => `${short(entry.path.split("/").slice(-2).join("/"))} · ${entry.count}× · ${compact(entry.chars)} chars`),
			action: "Ask for line ranges or reuse the condensed extract (jev_recall) instead of re-reading whole files; a repeated read is paid for again on every later turn.",
			links: [
				{ label: "Sessions", hash: "#/sessions" },
				{ label: "Curator", hash: "#/curator" },
			],
		});
	}

	// ---- prompt-cache hygiene
	const churn = db
		.query<{ session_id: string; calls: number; cache_read: number; input: number; cost: number }, [number, number]>(
			`SELECT session_id, COUNT(*) calls, COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(input),0) input, COALESCE(SUM(cost),0) cost
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ? GROUP BY session_id HAVING calls >= 10 ORDER BY cost DESC LIMIT 200`,
		)
		.all(range.from, range.to);
	const lowCache = churn.filter((row) => row.cache_read + row.input > 0 && row.cache_read / (row.cache_read + row.input) < 0.5);
	if (lowCache.length) {
		out.push({
			id: "low-cache-sessions",
			title: "Low prompt-cache reuse",
			tone: "warn",
			summary: `${lowCache.length} of ${churn.length} multi-call sessions reused under 50% of prompt tokens from cache — the rest was re-billed at full input rate.`,
			trigger: "fires when a session with 10+ calls reuses under 50% of its prompt tokens from cache",
			evidence: lowCache.slice(0, 5).map((row) => `${row.session_id.slice(0, 8)} · ${row.calls} calls · cache ${Math.round((row.cache_read / (row.cache_read + row.input)) * 100)}% · ${usd(row.cost)}`),
			action: "Keep the prefix stable: don't switch models mid-session, and let context edits batch up rather than firing small ones that reset the cache.",
			links: [{ label: "Sessions", hash: "#/sessions" }],
		});
	}

	const switches = db
		.query<{ session_id: string; n: number }, [number, number]>(
			"SELECT session_id, COUNT(*) n FROM events WHERE kind = 'model.switch' AND session_id IS NOT NULL AND ts_ms BETWEEN ? AND ? GROUP BY session_id HAVING n >= 2 ORDER BY n DESC LIMIT 20",
		)
		.all(range.from, range.to);
	if (switches.length) {
		out.push({
			id: "model-switches",
			title: "Mid-session model switches",
			tone: "info",
			summary: `${switches.length} sessions changed model mid-conversation (worst: ${switches[0].n} switches). Each switch re-bills the whole prefix uncached.`,
			trigger: "fires when a session records 2+ model switches",
			evidence: switches.slice(0, 5).map((row) => `${row.session_id.slice(0, 8)} · ${row.n} switches`),
			action: "Decide the model for the whole session up front, or let the router own it — manual switches are the most expensive kind of change.",
			links: [{ label: "Router", hash: "#/router" }],
		});
	}

	const think = db
		.query<{ n: number; cost: number; tokens: number }, [number, number]>(
			"SELECT COUNT(*) n, COALESCE(SUM(cost),0) cost, COALESCE(SUM(total_tokens),0) tokens FROM model_calls WHERE thinking_level IN ('high','xhigh','max') AND total_tokens < 20000 AND ts_ms BETWEEN ? AND ?",
		)
		.get(range.from, range.to);
	if (think && think.n >= 20) {
		out.push({
			id: "high-thinking-small-turns",
			title: "Deep thinking on small turns",
			tone: "info",
			summary: `${think.n} calls ran at high/xhigh/max thinking while using under 20k tokens (${usd(think.cost)}, ${compact(think.tokens)} tokens).`,
			trigger: "fires when 20+ calls ran at high/xhigh/max thinking on under 20k tokens",
			evidence: [`worst-case reasoning cost is paid even when the answer is short`, `these calls averaged ${compact(think.tokens / think.n)} tokens each`],
			action: "Reserve max thinking for hard problems; set a lower default and raise it per task (or let the router tier it).",
			links: [{ label: "Models", hash: "#/models" }],
		});
	}

	// ---- rules: dead, noisy, and wrong
	const ttsrRows = db.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE system = 'ttsr' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	const perRule = new Map<string, { fired: number; suppressed: number; good: number; bad: number }>();
	for (const row of ttsrRows) {
		const data = parseData(row);
		const rule = typeof data.rule === "string" ? data.rule : null;
		if (!rule) continue;
		const entry = perRule.get(rule) ?? { fired: 0, suppressed: 0, good: 0, bad: 0 };
		if (data.decision === "fired") entry.fired += 1;
		if (data.decision === "suppressed") entry.suppressed += 1;
		if (data.verdict === "good") entry.good += 1;
		if (data.verdict === "bad") entry.bad += 1;
		perRule.set(rule, entry);
	}

	let ruleFiles: string[] = [];
	try {
		if (existsSync(rulesDir())) ruleFiles = readdirSync(rulesDir()).filter((file) => file.endsWith(".md") && file !== "README.md").map((file) => file.replace(/\.md$/, ""));
	} catch (err) {
		log.warn(`cannot list rules: ${err instanceof Error ? err.message : String(err)}`);
	}
	const dead = ruleFiles.filter((name) => {
		const entry = perRule.get(name);
		return !entry || entry.fired + entry.suppressed === 0;
	});
	if (dead.length >= 3) {
		out.push({
			id: "dead-rules",
			title: "Rules that never fired",
			tone: "info",
			summary: `${dead.length} of ${ruleFiles.length} rules never fired or gate-checked in this range.`,
			trigger: "fires when 3+ rules neither fired nor gate-checked in the range",
			evidence: dead.slice(0, 6).map((name) => name),
			action: "Prune or retune them — every armed rule is a standing invitation for the model to spend attention on it.",
			links: [{ label: "Ledger", hash: "#/ledger?system=ttsr" }],
		});
	}
	const noisy = [...perRule.entries()].filter(([, value]) => value.suppressed >= 50 && value.good + value.bad === 0);
	if (noisy.length) {
		out.push({
			id: "noisy-rules",
			title: "Rules that gate-check constantly but never land",
			tone: "warn",
			summary: `${noisy.length} rules were checked 50+ times with no recorded outcome — gate cost without visible effect.`,
			trigger: "fires when a rule is gate-checked 50+ times with no recorded good/bad outcome",
			evidence: noisy.slice(0, 5).map(([rule, value]) => `${rule} · ${value.suppressed} suppressions · 0 outcomes`),
			action: "Tighten the trigger so the gate only runs when the rule can actually apply, or reword the rule so it produces an observable effect.",
			links: [{ label: "Ledger", hash: "#/ledger?system=ttsr" }],
		});
	}
	const badRules = [...perRule.entries()].filter(([, value]) => value.bad > 0).sort((a, b) => b[1].bad - a[1].bad);
	if (badRules.length) {
		out.push({
			id: "bad-rules",
			title: "Rules with bad outcomes",
			tone: "warn",
			summary: `${badRules.length} rules were judged to have made things worse at least once.`,
			trigger: "fires when a rule is judged to have made things worse at least once",
			evidence: badRules.slice(0, 5).map(([rule, value]) => `${rule} · ${value.good} good / ${value.bad} bad`),
			action: "Open the tagged cases and reword the rule's condition or its instruction — a bad outcome usually means the rule fired when it shouldn't have.",
			links: [{ label: "Ledger", hash: "#/ledger?system=ttsr" }],
		});
	}

	// ---- model reliability
	const errModels = db
		.query<{ model: string; calls: number; errors: number; cost: number }, [number, number]>(
			`SELECT model, COUNT(*) calls, COALESCE(SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END),0) errors, COALESCE(SUM(cost),0) cost
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ? AND model IS NOT NULL GROUP BY model HAVING errors > 0 ORDER BY errors DESC LIMIT 20`,
		)
		.all(range.from, range.to);
	const errRate = (row: { calls: number; errors: number }): number => (row.calls > 0 ? row.errors / row.calls : 0);
	const badModels = errModels.filter((row) => errRate(row) >= 0.02 && row.calls >= 20);
	if (badModels.length) {
		out.push({
			id: "error-models",
			title: "Models with an elevated error rate",
			tone: "warn",
			summary: `${badModels.length} models errored on 2%+ of calls (20+ calls).`,
			trigger: "fires when a model errors on 2%+ of its calls, over 20+ calls",
			evidence: badModels.slice(0, 5).map((row) => `${short(row.model.split("/").pop() ?? row.model)} · ${row.errors}/${row.calls} errors (${(errRate(row) * 100).toFixed(1)}%) · ${usd(row.cost)}`),
			action: "Check the provider or add a fallback for these; failures are billed work that produced nothing.",
			links: [{ label: "Models", hash: "#/models" }],
		});
	}

	// ---- goal loop
	const courseRows = db.query<{ session_id: string | null; data: string }, [number, number]>("SELECT session_id, data FROM events WHERE system = 'course-check' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	const offTrack = new Map<string, number>();
	for (const row of courseRows) {
		const data = parseData(row);
		if (data.verdict === "off_track" && row.session_id) offTrack.set(row.session_id, (offTrack.get(row.session_id) ?? 0) + 1);
	}
	if (offTrack.size) {
		out.push({
			id: "off-track-sessions",
			title: "Sessions judged off track",
			tone: "warn",
			summary: `${offTrack.size} sessions drifted from their goal at least once.`,
			trigger: "fires when course-check judges a session off track at least once",
			evidence: [...offTrack.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([session, count]) => `${session.slice(0, 8)} · ${count} off-track verdict${count > 1 ? "s" : ""}`),
			action: "Re-read the first prompt of each: off-track usually traces to an unclear goal or missing acceptance criteria — say what \"done\" looks like.",
			links: [{ label: "Sessions", hash: "#/sessions" }],
		});
	}

	// ---- memory worker health
	const memoryRows = db.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE system = 'memory' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	let degraded = 0;
	for (const row of memoryRows) {
		const data = parseData(row);
		if (data.outcome === "degraded" || data.degraded === true) degraded += 1;
	}
	if (degraded > 0) {
		out.push({
			id: "memory-degraded",
			title: "Memory consolidation ran degraded",
			tone: "error",
			summary: `${degraded} consolidation runs fell back instead of completing normally.`,
			trigger: "fires when a memory consolidation run falls back instead of completing",
			evidence: ["degraded runs still consume their window but do not merge or retire entries"],
			action: "Check the consolidation model availability/timeout (memory config) — a silent fallback means memory hygiene is paused.",
			links: [{ label: "Health", hash: "#/health" }],
		});
	}

	// ---- dashboard self-check: a log we expect but cannot read is a blind spot
	const unreadable = adapters.filter((adapter) => {
		const file = adapterFilePath(adapter);
		return file != null && !existsSync(file);
	});
	if (unreadable.length) {
		out.push({
			id: "adapter-logs-missing",
			title: "Adapter logs not found",
			tone: "error",
			summary: `${unreadable.length} adapter(s) point at a log file that does not exist — those subsystems are invisible in every view here.`,
			trigger: "fires when an adapter's log file is missing on disk",
			evidence: unreadable.slice(0, 6).map((adapter) => `${adapter.id} → ${adapter.file}`),
			action: "Fix the path in server/adapters/decisions.ts or move the log to where the adapter expects it. This is a blind spot in the dashboard itself, not a quiet subsystem.",
			links: [{ label: "Extensions", hash: "#/extensions" }],
		});
	}

	// ---- sharpest first: severity order, stable within a tone. The UI depends on
	// this order (Overview shows the first three), so it is part of the contract.
	const rank: Record<Finding["tone"], number> = { error: 0, warn: 1, info: 2, ok: 3 };
	out.sort((a, b) => rank[a.tone] - rank[b.tone]);
	return { findings: out, generatedAt: Date.now() };
}

/** Per-rule file sizes on disk — shared so every view counts the same rules. */
function ruleSizes(): Array<{ name: string; chars: number }> {
	try {
		const dir = rulesDir();
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((file) => file.endsWith(".md") && file !== "README.md")
			.map((file) => ({ name: file.replace(/\.md$/, ""), chars: statSync(path.join(dir, file)).size }));
	} catch (err) {
		log.warn(`cannot size rules: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}

/** Range-wide condensed chars (one-time and carried). Single source for every view that needs it. */
function condensedTotals(db: Database, from: number, to: number) {
	const turnCounts = new Map<string, number>();
	for (const row of db.query<{ session_id: string; turns: number }, []>("SELECT session_id, turns FROM sessions").all()) turnCounts.set(row.session_id, row.turns);
	let oneTimeChars = 0;
	let carriedChars = 0;
	let items = 0;
	for (const row of db
		.query<{ session_id: string; turn: number | null; data: string }, [number, number]>(
			"SELECT session_id, turn, data FROM events WHERE kind = 'curator.ledger' AND session_id IS NOT NULL AND ts_ms BETWEEN ? AND ? LIMIT 40000",
		)
		.all(from, to)) {
		const data = parseData(row);
		for (const rawItem of Array.isArray(data.items) ? data.items : []) {
			const item = (rawItem ?? {}) as Record<string, unknown>;
			const sourceChars = typeof item.chars === "number" ? item.chars : null;
			const extractChars = typeof item.extractChars === "number" ? item.extractChars : null;
			const verdict = typeof item.verdict === "string" ? item.verdict : null;
			if (sourceChars == null || extractChars == null || (verdict !== "useExtract" && verdict !== "indexOnly")) continue;
			const delta = Math.max(0, sourceChars - extractChars);
			if (delta === 0) continue;
			const turn = typeof item.turn === "number" ? item.turn : (row.turn ?? 0);
			oneTimeChars += delta;
			carriedChars += delta * Math.max(0, (turnCounts.get(row.session_id) ?? 0) - turn);
			items += 1;
		}
	}
	return { oneTimeChars, carriedChars, items };
}

// ------------------------------------------------------------------ benefits

/**
 * Cost-benefit ledger for the whole harness, not just the curator.
 *
 * Measured columns come from logs; "alternative" columns are explicit
 * counterfactuals with their formula stated (e.g. rules living in the always-on
 * prompt would be re-sent every call). Anything that cannot be priced is
 * reported as a count and marked as such.
 */
export function harnessBenefits(db: Database, range: Range) {
	const priceList = prices(db);

	const modelRows = db
		.query<{ model: string; input: number; cache_read: number }, [number, number]>(
			`SELECT model, COALESCE(SUM(input),0) input, COALESCE(SUM(cache_read),0) cache_read
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ? AND model IS NOT NULL GROUP BY model`,
		)
		.all(range.from, range.to);
	let pricedInputTokens = 0;
	let pricedInputCost = 0;
	let pricedCacheTokens = 0;
	let pricedCacheCost = 0;
	let inputTotal = 0;
	let cacheReadTotal = 0;
	for (const row of modelRows) {
		inputTotal += row.input;
		cacheReadTotal += row.cache_read;
		const price = priceFor(priceList, row.model);
		if (price?.input != null) {
			pricedInputTokens += row.input;
			pricedInputCost += (row.input * price.input) / 1_000_000;
		}
		if (price?.cache_read != null) {
			pricedCacheTokens += row.cache_read;
			pricedCacheCost += (row.cache_read * price.cache_read) / 1_000_000;
		}
	}
	const blendedInput = pricedInputTokens > 0 ? pricedInputCost / pricedInputTokens : null;
	const blendedCache = pricedCacheTokens > 0 ? pricedCacheCost / pricedCacheTokens : blendedInput;
	const promptTokens = inputTotal + cacheReadTotal;
	const cacheHitRate = promptTokens > 0 ? cacheReadTotal / promptTokens : 1;
	const effectiveRate = blendedInput != null && blendedCache != null ? cacheHitRate * blendedCache + (1 - cacheHitRate) * blendedInput : blendedInput;

	const callStats = db
		.query<{ calls: number; cost: number; tokens: number }, [number, number]>(
			"SELECT COUNT(*) calls, COALESCE(SUM(cost),0) cost, COALESCE(SUM(total_tokens),0) tokens FROM model_calls WHERE ts_ms BETWEEN ? AND ?",
		)
		.get(range.from, range.to);
	const calls = callStats?.calls ?? 0;
	const spend = callStats?.cost ?? 0;
	const avgCallCost = calls > 0 ? spend / calls : null;

	// ---- always-on prompt: what every call pays before any harness value is added
	const baselineRow = db
		.query<{ avg_chars: number; sessions: number }, []>("SELECT COALESCE(AVG(system_chars),0) avg_chars, COUNT(*) sessions FROM sessions WHERE system_chars > 0")
		.get();
	const baselineChars = Math.round(baselineRow?.avg_chars ?? 0);
	const baselineTokens = Math.round(baselineChars / 4);
	const baselineCost = effectiveRate != null ? baselineTokens * calls * effectiveRate : null;

	// ---- rules: injected on match vs permanently resident in the prompt
	const ruleFiles = ruleSizes();
	const ruleChars = ruleFiles.reduce((total, file) => total + file.chars, 0);
	const ruleTokens = Math.round(ruleChars / 4);
	const alwaysOnRulesCost = effectiveRate != null ? ruleTokens * calls * effectiveRate : null;
	const charsByRule = new Map(ruleFiles.map((file) => [file.name, file.chars]));

	const ttsrRows = db.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE system = 'ttsr' AND ts_ms BETWEEN ? AND ? LIMIT 40000").all(range.from, range.to);
	let fired = 0;
	let deliveries = 0;
	let deliveredChars = 0;
	for (const row of ttsrRows) {
		const data = parseData(row);
		if (data.decision === "fired") fired += 1;
		if (data.delivered === true) {
			deliveries += 1;
			if (typeof data.rule === "string") deliveredChars += charsByRule.get(data.rule) ?? 0;
		}
	}
	const injectedTokens = Math.round(deliveredChars / 4);
	const injectedCost = effectiveRate != null ? injectedTokens * effectiveRate : null;
	const rulesNet = alwaysOnRulesCost != null && injectedCost != null ? alwaysOnRulesCost - injectedCost : null;

	// ---- guard: safety value (counted, not priced)
	const guardRows = db.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE system = 'guard' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	let blocked = 0;
	let flagged = 0;
	for (const row of guardRows) {
		const data = parseData(row);
		if (data.verdict === "blocked") blocked += 1;
		if (data.verdict === "flagged") flagged += 1;
	}
	const guardCostRow = db
		.query<{ cost: number }, [number, number]>("SELECT COALESCE(SUM(cost_usd),0) cost FROM events WHERE system = 'guard' AND ts_ms BETWEEN ? AND ?")
		.get(range.from, range.to);
	const guardCost = guardCostRow?.cost ?? 0;

	// ---- goal loop: drift caught vs the rework it likely prevented
	const courseRows = db.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE system = 'course-check' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	let offTrack = 0;
	let checks = 0;
	for (const row of courseRows) {
		const data = parseData(row);
		if (typeof data.verdict !== "string") continue;
		checks += 1;
		if (data.verdict === "off_track") offTrack += 1;
	}
	const reworkEstimate = offTrack > 0 && avgCallCost != null ? offTrack * avgCallCost : null;

	// ---- judgment tools: spend on asking vs the read it replaced
	// Sizing hierarchy: the judged file's real size on disk where the path is still
	// there, otherwise the average read size observed in the curator ledger. One
	// turn only (no carry), so this stays conservative.
	const askRows = db.query<{ data: string; cost_usd: number | null }, [number, number]>("SELECT data, cost_usd FROM events WHERE system = 'ask-jev' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	let askCost = 0;
	const askTools: Record<string, number> = {};
	let exactChars = 0;
	let exactCount = 0;
	let unmatched = 0;
	// Judged paths are usually relative to the session's cwd — resolve them against
	// the cwds we have seen, so more of the estimate is measured rather than modelled.
	const cwds = db
		.query<{ cwd: string | null }, []>("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL ORDER BY last_ts DESC LIMIT 40")
		.all()
		.map((row) => row.cwd)
		.filter((cwd): cwd is string => Boolean(cwd));
	for (const row of askRows) {
		const data = parseData(row);
		askCost += row.cost_usd ?? 0;
		const tool = typeof data.tool === "string" ? data.tool : "unknown";
		askTools[tool] = (askTools[tool] ?? 0) + 1;

		const candidates: string[] = [];
		if (typeof data.path === "string") candidates.push(data.path);
		if (Array.isArray(data.files)) {
			for (const file of data.files) if (typeof file === "string") candidates.push(file);
		}
		let sized = false;
		for (const candidate of candidates) {
			const resolved = candidate.startsWith("~") ? path.join(homedir(), candidate.slice(1)) : candidate;
			const attempts = path.isAbsolute(resolved) ? [resolved] : [resolved, ...cwds.map((cwd) => path.join(cwd, resolved))];
			for (const attempt of attempts) {
				try {
					const stat = statSync(attempt);
					if (stat.isFile()) {
						exactChars += stat.size;
						sized = true;
						break;
					}
				} catch {
					// Not this path/cwd — try the next, then fall back to the average.
				}
			}
		}
		if (sized) exactCount += 1;
		else unmatched += 1;
	}

	let readCharsTotal = 0;
	let readCount = 0;
	let anyCharsTotal = 0;
	let anyCount = 0;
	for (const row of db
		.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE kind = 'curator.ledger' AND ts_ms BETWEEN ? AND ? LIMIT 20000")
		.all(range.from, range.to)) {
		const data = parseData(row);
		for (const rawItem of Array.isArray(data.items) ? data.items : []) {
			const item = (rawItem ?? {}) as Record<string, unknown>;
			if (typeof item.chars !== "number") continue;
			anyCharsTotal += item.chars;
			anyCount += 1;
			if (item.tool !== "read") continue;
			readCharsTotal += item.chars;
			readCount += 1;
		}
	}
	const avgReadChars = readCount > 0 ? readCharsTotal / readCount : anyCount > 0 ? anyCharsTotal / anyCount : 0;
	const avoidedChars = exactChars + unmatched * avgReadChars;
	const avoidedTokens = Math.round(avoidedChars / 4);
	const avoidedUsd = effectiveRate != null ? avoidedTokens * effectiveRate : null;
	const judgmentNet = avoidedUsd != null ? avoidedUsd - askCost : null;
	// How big a read each call must stand in for to pay for itself on tokens alone.
	const askCostPerCall = askRows.length > 0 ? askCost / askRows.length : null;
	const breakEvenCharsPerCall = askCostPerCall != null && effectiveRate != null && effectiveRate > 0 ? Math.round((askCostPerCall / effectiveRate) * 4) : null;

	// ---- memory: residency on disk + whether consolidation is shrinking it
	let memoryChars = 0;
	let memoryFiles = 0;
	try {
		const dir = path.join(agentDir(), "jev-memory");
		if (existsSync(dir)) {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md") || file.startsWith(".")) continue;
				memoryChars += statSync(path.join(dir, file)).size;
				memoryFiles += 1;
			}
		}
	} catch (err) {
		log.warn(`cannot size memory store: ${err instanceof Error ? err.message : String(err)}`);
	}
	const memoryRows = db.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE system = 'memory' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	let consolidations = 0;
	let shrinkBytes = 0;
	for (const row of memoryRows) {
		const data = parseData(row);
		if (data.decision !== "consolidation") continue;
		consolidations += 1;
		const scores = (data.scores ?? {}) as Record<string, unknown>;
		if (typeof scores.shrink_bytes === "number") shrinkBytes += scores.shrink_bytes;
	}

	// ---- Jev request spend: every harness decision is a Jev call, but only some
	// subsystems log a cost. Logged costs are summed, curator verifier batches are
	// priced from their logged model+usage, and the rest are counted only.
	const jevRows = db
		.query<{ system: string; n: number; cost: number; priced: number }, [number, number]>(
			`SELECT system, COUNT(*) n, COALESCE(SUM(cost_usd),0) cost,
			        COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END),0) priced
			 FROM events WHERE origin LIKE 'adapter:%' AND ts_ms BETWEEN ? AND ? GROUP BY system ORDER BY n DESC`,
		)
		.all(range.from, range.to);
	let derivedCost = 0;
	let derivedRequests = 0;
	for (const row of db
		.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE system = 'curator' AND ts_ms BETWEEN ? AND ? LIMIT 40000")
		.all(range.from, range.to)) {
		const data = parseData(row);
		if (data.decision !== "verifier-batch") continue;
		const usage = (data.usage ?? {}) as Record<string, unknown>;
		const model = typeof data.model === "string" ? data.model : null;
		const price = model ? priceFor(priceList, model) : null;
		if (!price || price.input == null || price.output == null) continue;
		const input = typeof usage.input === "number" ? usage.input : 0;
		const output = typeof usage.output === "number" ? usage.output : 0;
		const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
		derivedCost += (input * price.input + output * price.output + cacheRead * (price.cache_read ?? price.input)) / 1_000_000;
		derivedRequests += 1;
	}
	const jevRequests = jevRows.reduce((total, row) => total + row.n, 0);
	const jevLoggedCost = jevRows.reduce((total, row) => total + row.cost, 0);
	const jevPricedRequests = jevRows.reduce((total, row) => total + row.priced, 0) + derivedRequests;
	const jevCost = jevLoggedCost + derivedCost;

	return {
		range,
		calls,
		spend,
		avgCallCost,
		rates: { effectivePerToken: effectiveRate, blendedInputPerToken: blendedInput, blendedCachePerToken: blendedCache, cacheHitRate },
		baseline: { chars: baselineChars, tokens: baselineTokens, calls, cost: baselineCost, sessions: baselineRow?.sessions ?? 0 },
		rules: {
			ruleCount: ruleFiles.length,
			chars: ruleChars,
			tokens: ruleTokens,
			alwaysOnCost: alwaysOnRulesCost,
			shareOfBaseline: baselineTokens > 0 ? ruleTokens / baselineTokens : null,
			fired,
			deliveries,
			deliveredTokens: injectedTokens,
			injectedCost,
			net: rulesNet,
		},
		guard: { screens: guardRows.length, blocked, flagged, cost: guardCost, costPerBlock: blocked > 0 ? guardCost / blocked : null },
		goalLoop: { checks, offTrack, reworkEstimate },
		judgment: {
			calls: askRows.length,
			cost: askCost,
			tools: askTools,
			exactCount,
			estimatedCount: unmatched,
			avgReadChars: Math.round(avgReadChars),
			avoidedChars,
			avoidedTokens,
			avoidedUsd,
			net: judgmentNet,
			breakEvenCharsPerCall,
		},
		memory: { chars: memoryChars, files: memoryFiles, tokens: Math.round(memoryChars / 4), consolidations, shrinkBytes },
		jev: {
			requests: jevRequests,
			cost: jevCost,
			costLogged: jevLoggedCost,
			costDerived: derivedCost,
			pricedRequests: jevPricedRequests,
			costPerRequest: jevRequests > 0 ? jevCost / jevRequests : null,
			bySystem: jevRows.map((row) => ({ system: row.system, requests: row.n, cost: row.cost, priced: row.priced })),
		},
	};
}

// ------------------------------------------------------------------ models

export function models(db: Database, range: Range) {
	const byModel = db
		.query<
			{
				model: string;
				calls: number;
				cost: number;
				input: number;
				output: number;
				cache_read: number;
				cache_write: number;
				reasoning: number;
				total_tokens: number;
				errors: number;
				last_ts: number;
			},
			[number, number]
		>(
			`SELECT model, COUNT(*) calls, COALESCE(SUM(cost),0) cost, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
			        COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write, COALESCE(SUM(reasoning),0) reasoning,
			        COALESCE(SUM(total_tokens),0) total_tokens,
			        COALESCE(SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END),0) errors, MAX(ts_ms) last_ts
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ? AND model IS NOT NULL GROUP BY model ORDER BY cost DESC`,
		)
		.all(range.from, range.to);

	const priceList = prices(db);
	let cacheSavings = 0;
	let pricedCalls = 0;
	let unpricedCalls = 0;
	const perModel = byModel.map((row) => {
		const price = priceFor(priceList, row.model);
		if (price?.input != null && price.cache_read != null) {
			cacheSavings += (row.cache_read * (price.input - price.cache_read)) / 1_000_000;
			pricedCalls += row.calls;
		} else {
			unpricedCalls += row.calls;
		}
		return {
			model: row.model,
			calls: row.calls,
			cost: row.cost,
			input: row.input,
			output: row.output,
			cacheRead: row.cache_read,
			cacheWrite: row.cache_write,
			reasoning: row.reasoning,
			tokens: row.total_tokens,
			errors: row.errors,
			errorRate: row.calls ? row.errors / row.calls : null,
			cacheRate: row.input + row.cache_read > 0 ? row.cache_read / (row.input + row.cache_read) : null,
			costPerCall: row.calls ? row.cost / row.calls : null,
			tokensPerCall: row.calls ? row.total_tokens / row.calls : null,
			lastTs: row.last_ts ? new Date(row.last_ts).toISOString() : null,
			priced: price?.input != null,
		};
	});

	const dailyRows = db
		.query<{ day: string; model: string; cost: number; tokens: number; calls: number }, [number, number]>(
			`SELECT ${dayExpr} day, model, COALESCE(SUM(cost),0) cost, COALESCE(SUM(total_tokens),0) tokens, COUNT(*) calls
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ? AND model IS NOT NULL GROUP BY day, model`,
		)
		.all(range.from, range.to);
	const top = perModel.slice(0, 5).map((m) => m.model);
	const labels = [...new Set(dailyRows.map((r) => r.day))].sort();
	// Per-model daily cost, aligned to `labels`, for the efficiency sparklines.
	const labelIndex = new Map(labels.map((day, i) => [day, i]));
	const trendByModel = new Map<string, number[]>();
	for (const model of perModel) trendByModel.set(model.model, labels.map(() => 0));
	for (const row of dailyRows) {
		const seriesForModel = trendByModel.get(row.model);
		const i = labelIndex.get(row.day);
		if (seriesForModel && i !== undefined) seriesForModel[i] += row.cost;
	}
	const metricSeries = (pick: (row: (typeof dailyRows)[number]) => number) =>
		[...top, "other"].map((name) => ({
			name,
			values: labels.map((day) => {
				const rows = dailyRows.filter((r) => r.day === day);
				if (name === "other") return rows.filter((r) => !top.includes(r.model)).reduce((a, r) => a + pick(r), 0);
				return rows.filter((r) => r.model === name).reduce((a, r) => a + pick(r), 0);
			}),
		}));
	const series = metricSeries((r) => r.cost);
	// The chart's Cost / Tokens / Requests switch reads the same top-5 grouping.
	const byMetric = { cost: series, tokens: metricSeries((r) => r.tokens), requests: metricSeries((r) => r.calls) };

	const thinking = db
		.query<{ level: string; calls: number; cost: number }, [number, number]>(
			"SELECT COALESCE(thinking_level,'default') level, COUNT(*) calls, COALESCE(SUM(cost),0) cost FROM model_calls WHERE ts_ms BETWEEN ? AND ? GROUP BY level ORDER BY calls DESC",
		)
		.all(range.from, range.to);

	return {
		byModel: perModel.map((model) => ({ ...model, trend: trendByModel.get(model.model) ?? [] })),
		trendLabels: labels,
		daily: { labels, series, byMetric },
		thinking,
		cache: { savingsUsd: cacheSavings, pricedCalls, unpricedCalls },
	};
}

/**
 * Which way a verdict counts on the router's quality card. `verdict` is the
 * universal answer; `outcome` is domain-specific and only votes where its writer
 * says how it scores. model-router classes a `model_override` as bad — the routed
 * model was replaced — so it gets a column of its own instead of landing in "other",
 * which is what made the biggest signal in the table invisible.
 */
function verdictKind(verdict: unknown, outcome: unknown): "good" | "bad" | "override" | "other" {
	const o = typeof outcome === "string" ? outcome : null;
	// A replaced model is split out even though model-router stamps those records
	// `verdict: "bad"` as well: replacement and correction are different failures,
	// and this column is what shows how much of the badness is which.
	if (o === "model_override") return "override";
	const v = typeof verdict === "string" ? verdict : null;
	if (v === "good") return "good";
	if (v === "bad") return "bad";
	if (o === "tests_passed" || o === "good") return "good";
	if (o === "tests_failed" || o === "user_corrected" || o === "bad") return "bad";
	return "other";
}

// ------------------------------------------------------------------ router

export function router(db: Database, range: Range, limit = 300) {
	const rows = db
		.query<EventRow, [number, number, number]>("SELECT * FROM events WHERE system = 'router' AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms DESC LIMIT ?")
		.all(range.from, range.to, limit);

	const decisions = rows.map((row) => {
		const data = parseData(row);
		return {
			id: row.id,
			ts: row.ts,
			session: row.session_id,
			turn: row.turn,
			from: typeof data.from === "string" ? data.from : null,
			to: typeof data.to === "string" ? data.to : null,
			tier: typeof data.tier === "string" ? data.tier : null,
			p: typeof data.p === "number" ? data.p : null,
			confidence: typeof data.confidence === "number" ? data.confidence : null,
			newTaskP: typeof data.newTaskP === "number" ? data.newTaskP : null,
			acted: data.acted === true,
			reason: typeof data.reason === "string" ? data.reason : null,
			latencyMs: row.latency_ms,
			kind: row.kind,
			verdict: typeof data.verdict === "string" ? data.verdict : null,
			outcome: typeof data.outcome === "string" ? data.outcome : null,
			prompt: typeof data.prompt === "string" ? data.prompt : null,
		};
	});

	const all = db.query<EventRow, [number, number]>("SELECT * FROM events WHERE system = 'router' AND ts_ms BETWEEN ? AND ? LIMIT 20000").all(range.from, range.to);
	const tiers: Record<string, { count: number; latencies: number[] }> = {};
	const outcomes: Record<string, number> = {};
	// Outcome verdicts attach to the decision they judged, so per-tier quality is
	// the missing half of the tier picture: volume alone says nothing about value.
	const tierOutcomes: Record<string, { good: number; bad: number; override: number; other: number }> = {};
	const ps: number[] = [];
	const latencies: number[] = [];
	for (const row of all) {
		const data = parseData(row);
		const tier = typeof data.tier === "string" ? data.tier : "unknown";
		const entry = (tiers[tier] ??= { count: 0, latencies: [] });
		entry.count += 1;
		if (row.latency_ms != null) {
			entry.latencies.push(row.latency_ms);
			latencies.push(row.latency_ms);
		}
		if (typeof data.p === "number") ps.push(data.p);
		const outcome = typeof data.outcome === "string" ? data.outcome : typeof data.verdict === "string" ? data.verdict : null;
		if (outcome) {
			outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
			const bucket = (tierOutcomes[tier] ??= { good: 0, bad: 0, override: 0, other: 0 });
			bucket[verdictKind(data.verdict, data.outcome)] += 1;
		}
	}
	const edges = [0, 0.2, 0.4, 0.6, 0.8, 1.01];
	const pHist = edges.slice(0, -1).map((edge, i) => ({
		label: `${edge.toFixed(1)}–${edges[i + 1] >= 1 ? "1.0" : edges[i + 1].toFixed(1)}`,
		count: ps.filter((p) => p >= edge && p < edges[i + 1]).length,
	}));

	const judgedTotal = Object.values(tierOutcomes).reduce((a, e) => a + e.good + e.bad + e.override + e.other, 0);

	// The router logs a decision, not a price: cost_usd is null on every router event,
	// so there is no cost to show here — a `$0` would be a missing field, not a cheap
	// router, and the calls a decision steers are the sessions' spend, not its own.
	return {
		decisions,
		stats: {
			total: all.length,
			byTier: Object.entries(tiers).map(([tier, e]) => ({ tier, count: e.count, p50: pct(e.latencies, 50), p90: pct(e.latencies, 90) })),
			pHist,
			latencyP50: pct(latencies, 50),
			latencyP90: pct(latencies, 90),
			outcomes: Object.entries(outcomes).map(([label, count]) => ({ label, count })),
			outcomeCoverage: { judged: judgedTotal, total: all.length },
			// Every tier appears, judged or not — the unjudged count is the honest
			// denominator, and the reason this table moves as slowly as it does.
			outcomesByTier: Object.keys(tiers)
				.map((tier) => {
					const entry = tierOutcomes[tier] ?? { good: 0, bad: 0, override: 0, other: 0 };
					const judged = entry.good + entry.bad + entry.override + entry.other;
					const negatives = entry.bad + entry.override;
					return {
						tier,
						...entry,
						total: tiers[tier].count,
						judged,
						unjudged: Math.max(0, tiers[tier].count - judged),
						// Unclassified verdicts stay out of the ratio rather than scoring as wins or losses.
						precision: entry.good + negatives > 0 ? entry.good / (entry.good + negatives) : null,
					};
				})
				.sort((a, b) => b.total - a.total),
		},
	};
}

// ------------------------------------------------------------------ ledger

export interface LedgerFilters {
	system?: string;
	kind?: string;
	severity?: string;
	q?: string;
	range: Range;
	limit: number;
	offset: number;
}

export function ledger(db: Database, filters: LedgerFilters) {
	const where: string[] = ["ts_ms BETWEEN ? AND ?"];
	const params: Array<string | number> = [filters.range.from, filters.range.to];
	if (filters.system) {
		where.push("system = ?");
		params.push(filters.system);
	}
	if (filters.kind) {
		where.push("kind = ?");
		params.push(filters.kind);
	}
	if (filters.severity) {
		where.push("severity = ?");
		params.push(filters.severity);
	}
	if (filters.q) {
		where.push("(title LIKE ? OR summary LIKE ? OR ref LIKE ? OR session_id LIKE ?)");
		const like = `%${filters.q}%`;
		params.push(like, like, like, like);
	}
	const clause = where.join(" AND ");
	const total = db.query<{ n: number }, Array<string | number>>(`SELECT COUNT(*) n FROM events WHERE ${clause}`).get(...params);
	const rows = db
		.query<EventRow, Array<string | number>>(`SELECT * FROM events WHERE ${clause} ORDER BY ts_ms DESC LIMIT ? OFFSET ?`)
		.all(...params, filters.limit, filters.offset);

	// Decision volume per system per day — how busy each subsystem is over time.
	const dayExprLedger = "strftime('%Y-%m-%d', ts_ms / 1000, 'unixepoch', 'localtime')";
	const dailyRows = db
		.query<{ day: string; system: string; n: number }, [number, number]>(
			`SELECT ${dayExprLedger} day, system, COUNT(*) n FROM events WHERE ts_ms BETWEEN ? AND ? GROUP BY day, system`,
		)
		.all(filters.range.from, filters.range.to);
	const dailyLabels = [...new Set(dailyRows.map((row) => row.day))].sort();
	const dailyIndex = new Map(dailyLabels.map((day, i) => [day, i]));
	const dailyBySystem = new Map<string, number[]>();
	for (const row of dailyRows) {
		const values = dailyBySystem.get(row.system) ?? dailyLabels.map(() => 0);
		const i = dailyIndex.get(row.day);
		if (i !== undefined) values[i] += row.n;
		dailyBySystem.set(row.system, values);
	}

	// decision → outcome linkage: outcome records carry the id of the decision
	// they judged, so a row can show what became of it.
	const fates = new Map<string, { outcome: string; verdict: string | null; turnsAfter: number | null }>();
	for (const row of db
		.query<{ ref: string | null; data: string }, [number, number]>(
			"SELECT ref, data FROM events WHERE origin LIKE 'adapter:%' AND kind LIKE '%.outcome' AND ref IS NOT NULL AND ts_ms BETWEEN ? AND ? LIMIT 40000",
		)
		.all(filters.range.from, filters.range.to)) {
		if (!row.ref || fates.has(row.ref)) continue;
		const data = parseData(row);
		fates.set(row.ref, {
			outcome: typeof data.outcome === "string" ? data.outcome : "judged",
			verdict: typeof data.verdict === "string" ? data.verdict : null,
			turnsAfter: typeof data.turnsAfter === "number" ? data.turnsAfter : null,
		});
	}

	return {
		total: total?.n ?? 0,
		daily: {
			labels: dailyLabels,
			bySystem: [...dailyBySystem.entries()]
				.map(([system, values]) => ({ system, values, total: values.reduce((a, b) => a + b, 0) }))
				.sort((a, b) => b.total - a.total)
				.slice(0, 8),
		},
		rows: rows.map((row) => ({
			id: row.id,
			ts: row.ts,
			system: row.system,
			kind: row.kind,
			severity: row.severity,
			sessionId: row.session_id,
			turn: row.turn,
			costUsd: row.cost_usd,
			latencyMs: row.latency_ms,
			ref: row.ref,
			title: row.title,
			summary: row.summary,
			fate: row.ref ? (fates.get(row.ref) ?? null) : null,
		})),
		systems: db
			.query<{ system: string; count: number; warn: number; error: number; cost: number; last: number }, [number, number]>(
				`SELECT system, COUNT(*) count,
				        COALESCE(SUM(CASE WHEN severity = 'warn' THEN 1 ELSE 0 END),0) warn,
				        COALESCE(SUM(CASE WHEN severity = 'error' THEN 1 ELSE 0 END),0) error,
				        COALESCE(SUM(cost_usd),0) cost, MAX(ts_ms) last
				 FROM events WHERE ts_ms BETWEEN ? AND ? GROUP BY system ORDER BY count DESC`,
			)
			.all(filters.range.from, filters.range.to)
			.map((s) => ({ system: s.system, count: s.count, warn: s.warn, error: s.error, cost: s.cost, lastTs: s.last ? new Date(s.last).toISOString() : null })),
	};
}

export function ledgerStats(db: Database, range: Range) {
	const rows = db.query<EventRow, [number, number]>("SELECT * FROM events WHERE ts_ms BETWEEN ? AND ? LIMIT 40000").all(range.from, range.to);
	const bySystem: Record<string, { count: number; warn: number; error: number; cost: number; latencies: number[]; kinds: Record<string, number> }> = {};
	for (const row of rows) {
		const entry = (bySystem[row.system] ??= { count: 0, warn: 0, error: 0, cost: 0, latencies: [], kinds: {} });
		entry.count += 1;
		if (row.severity === "warn") entry.warn += 1;
		if (row.severity === "error") entry.error += 1;
		entry.cost += row.cost_usd ?? 0;
		if (row.latency_ms != null) entry.latencies.push(row.latency_ms);
		entry.kinds[row.kind] = (entry.kinds[row.kind] ?? 0) + 1;
	}

	const ttsrRules: Record<string, { rule: string; fired: number; suppressed: number; good: number; bad: number; blocked: number }> = {};
	for (const row of rows) {
		if (row.system !== "ttsr") continue;
		const data = parseData(row);
		const rule = typeof data.rule === "string" ? data.rule : row.title ?? "unknown";
		const entry = (ttsrRules[rule] ??= { rule, fired: 0, suppressed: 0, good: 0, bad: 0, blocked: 0 });
		if (data.decision === "fired") entry.fired += 1;
		if (data.decision === "suppressed") entry.suppressed += 1;
		if (data.verdict === "good") entry.good += 1;
		if (data.verdict === "bad") entry.bad += 1;
		if (data.blocked === true) entry.blocked += 1;
	}

	const curatorRows = rows.filter((r) => r.system === "curator");
	const guardRows = rows.filter((r) => r.system === "guard");
	const memoryRows = rows.filter((r) => r.system === "memory");
	const courseRows = rows.filter((r) => r.system === "course-check");
	const refineRows = rows.filter((r) => r.system === "refine");

	const pick = (list: EventRow[], key: string) => {
		const out: Record<string, number> = {};
		for (const row of list) {
			const data = parseData(row);
			const value = data[key];
			if (typeof value === "string") out[value] = (out[value] ?? 0) + 1;
		}
		return out;
	};

	return {
		systems: Object.fromEntries(
			Object.entries(bySystem).map(([system, e]) => [
				system,
				{ count: e.count, warn: e.warn, error: e.error, cost: e.cost, p50: pct(e.latencies, 50), p90: pct(e.latencies, 90), kinds: e.kinds },
			]),
		),
		ttsrRules: Object.values(ttsrRules).sort((a, b) => b.fired + b.suppressed - (a.fired + a.suppressed)).slice(0, 40),
		curatorVerdicts: pick(curatorRows, "verifierVerdict"),
		curatorRoles: pick(curatorRows, "role"),
		curatorSourceTypes: pick(curatorRows, "sourceType"),
		guardVerdicts: pick(guardRows, "verdict"),
		guardHooks: pick(guardRows, "hook"),
		memoryDecisions: pick(memoryRows, "decision"),
		memoryOutcomes: pick(memoryRows, "outcome"),
		courseVerdicts: pick(courseRows, "verdict"),
		refineDecisions: pick(refineRows, "decision"),
	};
}

// ------------------------------------------------------------------ curator

export function curatorSessions(db: Database) {
	const ledgerRows = db
		.query<{ session_id: string; ts: string; data: string; project: string | null; title: string | null }, []>(
			`SELECT e.session_id, e.ts, e.data, s.project, s.title
			 FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
			 WHERE e.kind = 'curator.ledger' AND e.session_id IS NOT NULL
			 ORDER BY e.ts_ms DESC LIMIT 2000`,
		)
		.all();
	const editRows = db
		.query<{ session_id: string; n: number }, []>(
			"SELECT session_id, COUNT(*) n FROM events WHERE kind = 'curator.context_edit' AND session_id IS NOT NULL GROUP BY session_id",
		)
		.all();

	interface Aggregate {
		sessionId: string;
		project: string | null;
		title: string | null;
		events: number;
		candidates: number;
		emits: number;
		retainFull: number;
		chars: number;
		edits: number;
		lastTs: string | null;
	}
	const bySession = new Map<string, Aggregate>();
	const ensure = (sessionId: string, project: string | null, title: string | null, ts: string | null): Aggregate => {
		let entry = bySession.get(sessionId);
		if (!entry) {
			entry = { sessionId, project, title, events: 0, candidates: 0, emits: 0, retainFull: 0, chars: 0, edits: 0, lastTs: ts };
			bySession.set(sessionId, entry);
		}
		return entry;
	};

	for (const row of ledgerRows) {
		const entry = ensure(row.session_id, row.project, row.title, row.ts);
		const data = parseData(row);
		const list = Array.isArray(data.items) ? data.items : [];
		for (const item of list) {
			const it = (item ?? {}) as Record<string, unknown>;
			entry.candidates += 1;
			if (it.verdict === "useExtract" || it.verdict === "indexOnly") entry.emits += 1;
			if (it.verdict === "retainFull") entry.retainFull += 1;
			if (typeof it.chars === "number") entry.chars += it.chars;
		}
		entry.events += list.length;
	}
	for (const row of editRows) {
		const entry = ensure(row.session_id, null, null, null);
		entry.edits = row.n;
		entry.events += row.n;
	}

	return { sessions: [...bySession.values()].sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? "")).slice(0, 200) };
}

export function curatorDetail(db: Database, sessionId: string) {
	const rows = db
		.query<EventRow, [string]>("SELECT * FROM events WHERE session_id = ? AND system IN ('curator','curator-v2','curator-v3-shadow') ORDER BY ts_ms LIMIT 2000")
		.all(sessionId);

	const timeline = rows.map((row) => {
		const data = parseData(row);
		return {
			id: row.id,
			ts: row.ts,
			tsMs: row.ts_ms,
			turn: row.turn,
			system: row.system,
			kind: row.kind,
			title: row.title,
			summary: row.summary,
			severity: row.severity,
			verdict: typeof data.verifierVerdict === "string" ? data.verifierVerdict : typeof data.verdict === "string" ? data.verdict : null,
			role: typeof data.role === "string" ? data.role : null,
			sourceType: typeof data.sourceType === "string" ? data.sourceType : null,
			chars: typeof data.chars === "number" ? data.chars : null,
			ref: row.ref,
		};
	});

	// Ledger items written into the session transcript are the per-session truth:
	// jev-curator decision rows are not session-tagged.
	const items: Array<Record<string, unknown>> = [];
	for (const row of rows) {
		if (row.kind !== "curator.ledger") continue;
		const data = parseData(row);
		const list = Array.isArray(data.items) ? data.items : [];
		for (const item of list) {
			if (item && typeof item === "object") items.push({ ...(item as Record<string, unknown>), ts: row.ts, turn: row.turn });
		}
	}

	const tally = (key: string): Record<string, number> => {
		const out: Record<string, number> = {};
		for (const item of items) {
			const value = item[key];
			if (typeof value === "string") out[value] = (out[value] ?? 0) + 1;
		}
		return out;
	};

	const verdicts = tally("verdict");
	const roles = tally("role");
	const sourceTypes = tally("sourceType");
	const chars = items.reduce((a, item) => a + (typeof item.chars === "number" ? item.chars : 0), 0);

	const linkCounts = new Map<string, number>();
	const bump = (key: string) => linkCounts.set(key, (linkCounts.get(key) ?? 0) + 1);
	for (const item of items) {
		const sourceType = typeof item.sourceType === "string" ? item.sourceType : "?";
		const role = typeof item.role === "string" ? item.role : "?";
		const verdict = typeof item.verdict === "string" ? item.verdict : "?";
		bump(`sourceType|${sourceType}|role|${role}`);
		bump(`role|${role}|verdict|${verdict}`);
	}

	const goalspec = rows
		.filter((row) => row.kind === "goalspec-amended")
		.map((row) => ({ ts: row.ts, summary: row.summary, ref: row.ref }));

	return {
		timeline,
		items,
		fates: {
			columns: [
				{ id: "sourceType", title: "Source type" },
				{ id: "role", title: "Role" },
				{ id: "verdict", title: "Verifier verdict" },
			],
			nodes: Object.fromEntries([
				...Object.entries(sourceTypes).map(([value, count]) => [`sourceType:${value}`, count] as const),
				...Object.entries(roles).map(([value, count]) => [`role:${value}`, count] as const),
				...Object.entries(verdicts).map(([value, count]) => [`verdict:${value}`, count] as const),
			]),
			links: Object.fromEntries(linkCounts),
		},
		stats: {
			events: rows.length,
			candidates: items.length,
			emits: (verdicts.useExtract ?? 0) + (verdicts.indexOnly ?? 0),
			chars,
			verdicts,
			roles,
			sourceTypes,
		},
		goalspec,
		hasData: rows.length > 0,
	};
}

// ------------------------------------------------------------------ sessions

export function sessionsList(db: Database, opts: { q?: string; limit?: number; sort?: string }) {
	const where: string[] = [];
	const params: Array<string | number> = [];
	if (opts.q) {
		where.push("(session_id LIKE ? OR title LIKE ? OR project LIKE ?)");
		const like = `%${opts.q}%`;
		params.push(like, like, like);
	}
	const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const rows = db
		.query<
			{
				session_id: string;
				project: string;
				title: string | null;
				started_ts: string | null;
				last_ts: string | null;
				turns: number;
				calls: number;
				total_tokens: number;
				cost: number;
				errors: number;
				models: string;
				harness_events: number;
			},
			Array<string | number>
		>(`SELECT * FROM sessions ${clause} LIMIT 2000`)
		.all(...params);

	// Per-session harness rollups (all-time, matching this all-time list). This is
	// what turns the session list into a lever-hunting tool: which session burned
	// context, which one needed your intervention.
	const priceList = prices(db);
	const turnsBySession = new Map<string, number>();
	for (const row of db.query<{ session_id: string; turns: number }, []>("SELECT session_id, turns FROM sessions").all()) turnsBySession.set(row.session_id, row.turns);

	const curatorBySession = new Map<string, number>();
	for (const row of db
		.query<{ session_id: string; turn: number | null; data: string }, []>("SELECT session_id, turn, data FROM events WHERE kind = 'curator.ledger' AND session_id IS NOT NULL")
		.all()) {
		const data = parseData(row);
		let chars = 0;
		for (const rawItem of Array.isArray(data.items) ? data.items : []) {
			const item = (rawItem ?? {}) as Record<string, unknown>;
			const sourceChars = typeof item.chars === "number" ? item.chars : null;
			const extractChars = typeof item.extractChars === "number" ? item.extractChars : null;
			const verdict = typeof item.verdict === "string" ? item.verdict : null;
			if (sourceChars == null || extractChars == null || (verdict !== "useExtract" && verdict !== "indexOnly")) continue;
			const delta = Math.max(0, sourceChars - extractChars);
			if (delta === 0) continue;
			const turn = typeof item.turn === "number" ? item.turn : (row.turn ?? 0);
			chars += delta * Math.max(0, (turnsBySession.get(row.session_id) ?? 0) - turn);
		}
		if (chars) curatorBySession.set(row.session_id, (curatorBySession.get(row.session_id) ?? 0) + chars);
	}

	const discountBySession = new Map<string, number>();
	for (const row of db
		.query<{ session_id: string; model: string; cache_read: number }, []>(
			"SELECT session_id, model, COALESCE(SUM(cache_read),0) cache_read FROM model_calls WHERE model IS NOT NULL GROUP BY session_id, model",
		)
		.all()) {
		const price = priceFor(priceList, row.model);
		if (price?.input == null || price.cache_read == null) continue;
		discountBySession.set(row.session_id, (discountBySession.get(row.session_id) ?? 0) + (row.cache_read * (price.input - price.cache_read)) / 1_000_000);
	}

	const flagsBySession = new Map<string, { delivered: number; corrections: number; offTrack: number; good: number; bad: number }>();
	for (const row of db
		.query<{ session_id: string; system: string; data: string }, []>("SELECT session_id, system, data FROM events WHERE session_id IS NOT NULL AND system IN ('ttsr','router','course-check')")
		.all()) {
		const data = parseData(row);
		const entry = flagsBySession.get(row.session_id) ?? { delivered: 0, corrections: 0, offTrack: 0, good: 0, bad: 0 };
		if (row.system === "ttsr") {
			if (data.delivered === true) entry.delivered += 1;
			if (data.verdict === "good") entry.good += 1;
			if (data.verdict === "bad") entry.bad += 1;
		}
		if (data.outcome === "user_corrected") entry.corrections += 1;
		if (row.system === "course-check" && data.verdict === "off_track") entry.offTrack += 1;
		flagsBySession.set(row.session_id, entry);
	}

	const enriched = rows.map((row) => {
		const flags = flagsBySession.get(row.session_id);
		return {
			sessionId: row.session_id,
			project: row.project,
			title: row.title,
			startedTs: row.started_ts,
			lastTs: row.last_ts,
			turns: row.turns,
			calls: row.calls,
			tokens: row.total_tokens,
			cost: row.cost,
			errors: row.errors,
			models: safeJsonArray(row.models),
			harnessEvents: row.harness_events,
			curatorTokens: Math.round((curatorBySession.get(row.session_id) ?? 0) / 4),
			cacheDiscount: discountBySession.get(row.session_id) ?? 0,
			rulesDelivered: flags?.delivered ?? 0,
			corrections: flags?.corrections ?? 0,
			offTrack: flags?.offTrack ?? 0,
			rulePrecision: flags && flags.good + flags.bad > 0 ? flags.good / (flags.good + flags.bad) : null,
			problems: (flags?.corrections ?? 0) + (flags?.offTrack ?? 0) + row.errors,
			costPerCall: row.calls > 0 ? row.cost / row.calls : null,
		};
	});

	const sorted = (() => {
		switch (opts.sort) {
			case "cost":
				return [...enriched].sort((a, b) => b.cost - a.cost);
			case "tokens":
				return [...enriched].sort((a, b) => b.tokens - a.tokens);
			case "impact":
				return [...enriched].sort((a, b) => b.cacheDiscount - a.cacheDiscount || b.curatorTokens - a.curatorTokens);
			case "condensed":
				return [...enriched].sort((a, b) => b.curatorTokens - a.curatorTokens);
			case "problems":
				return [...enriched].sort((a, b) => b.problems - a.problems);
			default:
				return [...enriched].sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""));
		}
	})();
	return { sessions: sorted.slice(0, opts.limit ?? 400) };
}

function safeJsonArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? (parsed as string[]) : [];
	} catch {
		return [];
	}
}

export function sessionDetail(db: Database, sessionId: string) {
	const session = db
		.query<
			{
				session_id: string;
				project: string;
				title: string | null;
				started_ts: string | null;
				last_ts: string | null;
				turns: number;
				calls: number;
				cost: number;
				total_tokens: number;
				input: number;
				output: number;
				cache_read: number;
				cache_write: number;
				reasoning: number;
				errors: number;
				models: string;
				cwd: string | null;
				harness_events: number;
			},
			[string]
		>("SELECT * FROM sessions WHERE session_id = ?")
		.get(sessionId);
	if (!session) return { session: null, calls: [], messages: [], events: [], models: [] };

	const calls = db
		.query<
			{
				msg_id: string;
				ts: string;
				ts_ms: number;
				model: string | null;
				provider: string | null;
				thinking_level: string | null;
				turn: number;
				input: number;
				output: number;
				cache_read: number;
				cache_write: number;
				reasoning: number;
				total_tokens: number;
				cost: number;
				tool_count: number;
				tools: string | null;
				stop_reason: string | null;
			},
			[string]
		>("SELECT msg_id, ts, ts_ms, model, provider, thinking_level, turn, input, output, cache_read, cache_write, reasoning, total_tokens, cost, tool_count, tools, stop_reason FROM model_calls WHERE session_id = ? ORDER BY ts_ms LIMIT 1000")
		.all(sessionId);

	const messages = db
		.query<{ msg_id: string; ts_ms: number; role: string; turn: number; chars: number; preview: string; model: string | null }, [string]>(
			"SELECT msg_id, ts_ms, role, turn, chars, preview, model FROM messages WHERE session_id = ? ORDER BY ts_ms LIMIT 1500",
		)
		.all(sessionId);

	const events = db
		.query<
			{ ts: string; ts_ms: number; system: string; kind: string; severity: string; turn: number | null; title: string | null; summary: string | null; ref: string | null },
			[string]
		>("SELECT ts, ts_ms, system, kind, severity, turn, title, summary, ref FROM events WHERE session_id = ? ORDER BY ts_ms LIMIT 800")
		.all(sessionId);

	const models = db
		.query<{ model: string; calls: number; cost: number; tokens: number }, [string]>(
			"SELECT model, COUNT(*) calls, COALESCE(SUM(cost),0) cost, COALESCE(SUM(total_tokens),0) tokens FROM model_calls WHERE session_id = ? AND model IS NOT NULL GROUP BY model ORDER BY cost DESC",
		)
		.all(sessionId);

	return {
		session: {
			...session,
			models: safeJsonArray(session.models),
		},
		calls: calls.map((call) => ({ ...call, tools: call.tools ? safeJsonArray(call.tools) : [] })),
		messages,
		events,
		models,
	};
}

// ------------------------------------------------------------------ extensions

export interface ExtensionCard {
	name: string;
	kind: "dir" | "file";
	description: string | null;
	adapter: { id: string; title: string } | null;
	events: number;
	lastEvent: string | null;
	cost: number;
	/** Days since its last recorded event — a covered extension that went quiet is a signal. */
	silentDays: number | null;
	silent: boolean;
}

export async function extensionsInventory(db: Database): Promise<{ extensions: ExtensionCard[]; adapters: Array<Pick<Adapter, "id" | "title" | "description" | "file" | "panels"> & { exists: boolean }> }> {
	const adapters = await loadAdapters();
	const dir = extensionsDir();
	const cards: ExtensionCard[] = [];
	const usageRows = db
		.query<{ system: string; count: number; cost: number; last: number }, []>(
			"SELECT system, COUNT(*) count, COALESCE(SUM(cost_usd),0) cost, MAX(ts_ms) last FROM events GROUP BY system",
		)
		.all();
	const usage = new Map(usageRows.map((row) => [row.system, row]));

	const adapterBySystem = new Map<string, Adapter>();
	for (const adapter of adapters) adapterBySystem.set(adapter.id, adapter);

	if (existsSync(dir)) {
		for (const entry of readdirSync(dir)) {
			const full = path.join(dir, entry);
			let kind: "dir" | "file" = "file";
			try {
				kind = statSync(full).isDirectory() ? "dir" : "file";
			} catch {
				continue;
			}
			let description: string | null = null;
			if (kind === "dir") {
				const readme = path.join(full, "README.md");
				if (existsSync(readme)) {
					try {
						const lines = readFileSync(readme, "utf8").split("\n");
						description =
							lines
								.find((line) => line.trim() && !line.startsWith("#"))
								?.replace(/[*_`]/g, "")
								.trim()
								.slice(0, 200) ?? null;
					} catch (err) {
						log.error(`cannot read ${readme}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			}
			const name = kind === "dir" ? entry : entry.replace(/\.ts$/, "");
			const card: ExtensionCard = { name, kind, description, adapter: null, events: 0, lastEvent: null, cost: 0, silentDays: null, silent: false };
			// Ownership first: an adapter names its extension, so a log like `tuner`
			// still belongs to decision-tuner and two adapters can share one owner.
			const owned = new Set(adapters.filter((adapter) => (adapter.extension ?? adapter.id) === name).map((adapter) => adapter.id));
			for (const [system, row] of usage) {
				const claimed = owned.size > 0 ? owned.has(system) : system === name || system.startsWith(name);
				if (!claimed) continue;
				card.events += row.count;
				card.cost += row.cost;
				if (!card.lastEvent || row.last > Date.parse(card.lastEvent)) card.lastEvent = new Date(row.last).toISOString();
				const adapter = adapterBySystem.get(system);
				if (adapter && (!card.adapter || card.adapter.id === "refine")) card.adapter = { id: adapter.id, title: adapter.title };
			}
			if (card.lastEvent) {
				card.silentDays = Math.floor((Date.now() - Date.parse(card.lastEvent)) / 86_400_000);
				card.silent = card.silentDays >= 7;
			} else if (card.adapter) {
				// An adapter exists but nothing was ever recorded — never ran, or broke quietly.
				card.silent = true;
			}
			cards.push(card);
		}
	}

	return {
		extensions: cards.sort((a, b) => b.events - a.events || a.name.localeCompare(b.name)),
		adapters: adapters.map((adapter) => ({
			id: adapter.id,
			title: adapter.title,
			description: adapter.description,
			file: adapter.file,
			resolved: displayPath(adapterFilePath(adapter)),
			panels: adapter.panels,
			exists: adapterFilePath(adapter) ? existsSync(adapterFilePath(adapter) as string) : true,
		})),
	};
}

// ------------------------------------------------------------------ health

export function health(db: Database, range: Range) {
	const bySystem = db
		.query<{ system: string; count: number; warn: number; error: number; last: number }, [number, number]>(
			`SELECT system, COUNT(*) count,
			        COALESCE(SUM(CASE WHEN severity='warn' THEN 1 ELSE 0 END),0) warn,
			        COALESCE(SUM(CASE WHEN severity='error' THEN 1 ELSE 0 END),0) error,
			        MAX(ts_ms) last
			 FROM events WHERE ts_ms BETWEEN ? AND ? GROUP BY system ORDER BY (warn + error * 2) DESC`,
		)
		.all(range.from, range.to);

	const recent = db
		.query<EventRow, [number, number]>("SELECT * FROM events WHERE ts_ms BETWEEN ? AND ? AND severity IN ('warn','error') ORDER BY ts_ms DESC LIMIT 40")
		.all(range.from, range.to);

	const counts = db
		.query<{ events: number; calls: number; messages: number; sessions: number; files: number }, []>(
			`SELECT (SELECT COUNT(*) FROM events) events, (SELECT COUNT(*) FROM model_calls) calls,
			        (SELECT COUNT(*) FROM messages) messages, (SELECT COUNT(*) FROM sessions) sessions,
			        (SELECT COUNT(*) FROM files) files`,
		)
		.get();

	const lastIngest = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get("last_ingest");
	const lastMs = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get("last_ingest_ms");
	const dayExprHealth = "strftime('%Y-%m-%d', ts_ms / 1000, 'unixepoch', 'localtime')";

	// Warnings over time: a flat line is healthy, a rise is the thing to chase.
	const daily = db
		.query<{ day: string; n: number; warn: number; error: number }, [number, number]>(
			`SELECT ${dayExprHealth} day, COUNT(*) n,
			        COALESCE(SUM(CASE WHEN severity = 'warn' THEN 1 ELSE 0 END),0) warn,
			        COALESCE(SUM(CASE WHEN severity = 'error' THEN 1 ELSE 0 END),0) error
			 FROM events WHERE ts_ms BETWEEN ? AND ? GROUP BY day ORDER BY day`,
		)
		.all(range.from, range.to);

	// A subsystem that used to log and went quiet is usually broken, not idle.
	const quiet = db
		.query<{ system: string; n: number; last: number }, []>("SELECT system, COUNT(*) n, MAX(ts_ms) last FROM events GROUP BY system")
		.all()
		.map((row) => ({ system: row.system, count: row.n, daysSinceLast: Math.max(0, Math.floor((Date.now() - row.last) / 86_400_000)) }))
		.filter((row) => row.daysSinceLast >= 7)
		.sort((a, b) => b.daysSinceLast - a.daysSinceLast)
		.slice(0, 12);

	const degradedDays = db
		.query<{ day: string }, []>(`SELECT DISTINCT ${dayExprHealth} day FROM events WHERE system = 'memory' AND severity = 'warn' ORDER BY day`)
		.all()
		.map((row) => row.day);
	let degradedStreak = 0;
	if (degradedDays.length) {
		const cursor = new Date(`${degradedDays[degradedDays.length - 1]}T00:00:00Z`);
		for (let i = degradedDays.length - 1; i >= 0; i -= 1) {
			if (degradedDays[i] !== cursor.toISOString().slice(0, 10)) break;
			degradedStreak += 1;
			cursor.setUTCDate(cursor.getUTCDate() - 1);
		}
	}

	return {
		bySystem: bySystem.map((row) => ({
			system: row.system,
			count: row.count,
			warn: row.warn,
			error: row.error,
			lastTs: row.last ? new Date(row.last).toISOString() : null,
		})),
		recent: recent.map((row) => ({
			id: row.id,
			ts: row.ts,
			system: row.system,
			kind: row.kind,
			severity: row.severity,
			title: row.title,
			summary: row.summary,
			sessionId: row.session_id,
			ref: row.ref,
		})),
		counts,
		daily,
		quiet,
		degradedDays,
		degradedStreak,
		lastIngest: lastIngest?.value ? new Date(Number(lastIngest.value)).toISOString() : null,
		lastIngestMs: lastMs?.value ? Number(lastMs.value) : null,
	};
}

// ------------------------------------------------------------------ live

export function eventDetail(db: Database, id: number) {
	const row = db.query<EventRow, [number]>("SELECT * FROM events WHERE id = ?").get(id);
	if (!row) return { event: null };
	return {
		event: {
			id: row.id,
			ts: row.ts,
			origin: row.origin,
			system: row.system,
			kind: row.kind,
			severity: row.severity,
			sessionId: row.session_id,
			turn: row.turn,
			costUsd: row.cost_usd,
			latencyMs: row.latency_ms,
			ref: row.ref,
			title: row.title,
			summary: row.summary,
			data: parseData(row),
		},
	};
}

export function live(db: Database, limit = 80) {	const rows = db.query<EventRow, [number]>("SELECT * FROM events ORDER BY ts_ms DESC LIMIT ?").all(limit);
	return {
		rows: rows.map((row) => {
			const data = parseData(row);
			return {
				id: row.id,
				ts: row.ts,
				system: row.system,
				kind: row.kind,
				severity: row.severity,
				sessionId: row.session_id,
				turn: row.turn,
				costUsd: row.cost_usd,
				latencyMs: row.latency_ms,
				title: row.title,
				summary: row.summary,
				ref: row.ref,
				verdict: typeof data.verifierVerdict === "string" ? data.verifierVerdict : typeof data.verdict === "string" ? data.verdict : null,
			};
		}),
	};
}

// ------------------------------------------------------------------ status

export async function status(db: Database, runtime: { port: number; host: string; startedAt: number; dbPath: string }) {
	const adapters = await loadAdapters();
	const counts = db
		.query<{ events: number; calls: number; sessions: number; messages: number }, []>(
			`SELECT (SELECT COUNT(*) FROM events) events, (SELECT COUNT(*) FROM model_calls) calls,
			        (SELECT COUNT(*) FROM sessions) sessions, (SELECT COUNT(*) FROM messages) messages`,
		)
		.get();
	return {
		ok: true,
		version: "0.1.0",
		port: runtime.port,
		host: runtime.host,
		uptimeMs: Date.now() - runtime.startedAt,
		dbPath: runtime.dbPath,
		counts,
		adapters: adapters.map((adapter) => ({
			id: adapter.id,
			title: adapter.title,
			file: adapter.file,
			resolved: displayPath(adapterFilePath(adapter)),
			exists: adapterFilePath(adapter) ? existsSync(adapterFilePath(adapter) as string) : true,
		})),
	};
}

// ------------------------------------------------------------------ trends

export interface TrendWindow {
	// absolutes — kept for context only; they grow with usage
	cost: number;
	calls: number;
	cacheRead: number;
	input: number;
	cacheDiscount: number;
	curatorTokens: number;
	rulesTokensAvoided: number;
	corrections: number;
	guardBlocks: number;
	offTrack: number;
	jevSpend: number;
	// ratios — usage-independent, so a window can be compared to another
	costPerCall: number | null;
	jevSpendPerCall: number | null;
	cacheDiscountPerCall: number | null;
	cacheRate: number | null;
	promptTokensPerCall: number | null;
	curatorTokensPerCall: number | null;
	rulesTokensAvoidedPerCall: number | null;
	errorRate: number | null;
	rulePrecision: number | null;
	verifierAgreement: number | null;
	correctionsPer100Calls: number | null;
	guardBlocksPer100Calls: number | null;
	// denominators behind the rates, so a swing can be judged against its sample
	verifierSamples: number;
	verifierHits: number;
	judgedOutcomes: number;
}

/** Headline numbers for one window, computed from the same primitives as the Impact tab. */
function summarizeWindow(db: Database, priceList: Price[], rules: Array<{ name: string; chars: number }>, from: number, to: number): TrendWindow {
	const callStats = db
		.query<{ calls: number; input: number; cache_read: number; cost: number; errors: number }, [number, number]>(
			`SELECT COUNT(*) calls, COALESCE(SUM(input),0) input, COALESCE(SUM(cache_read),0) cache_read,
			        COALESCE(SUM(cost),0) cost, COALESCE(SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END),0) errors
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ?`,
		)
		.get(from, to);
	const calls = callStats?.calls ?? 0;
	const input = callStats?.input ?? 0;
	const cacheRead = callStats?.cache_read ?? 0;

	let cacheDiscount = 0;
	for (const row of db
		.query<{ model: string | null; cache_read: number }, [number, number]>(
			"SELECT model, COALESCE(SUM(cache_read),0) cache_read FROM model_calls WHERE ts_ms BETWEEN ? AND ? AND model IS NOT NULL GROUP BY model",
		)
		.all(from, to)) {
		const price = row.model ? priceFor(priceList, row.model) : null;
		if (price?.input != null && price.cache_read != null) cacheDiscount += (row.cache_read * (price.input - price.cache_read)) / 1_000_000;
	}

	// curator condensation (chars → tokens, carried across remaining turns)
	const turnCounts = new Map<string, number>();
	for (const row of db.query<{ session_id: string; turns: number }, []>("SELECT session_id, turns FROM sessions").all()) turnCounts.set(row.session_id, row.turns);
	let curatorChars = 0;
	for (const row of db
		.query<{ session_id: string; turn: number | null; data: string }, [number, number]>(
			"SELECT session_id, turn, data FROM events WHERE kind = 'curator.ledger' AND session_id IS NOT NULL AND ts_ms BETWEEN ? AND ? LIMIT 40000",
		)
		.all(from, to)) {
		const data = parseData(row);
		for (const rawItem of Array.isArray(data.items) ? data.items : []) {
			const item = (rawItem ?? {}) as Record<string, unknown>;
			const sourceChars = typeof item.chars === "number" ? item.chars : null;
			const extractChars = typeof item.extractChars === "number" ? item.extractChars : null;
			const verdict = typeof item.verdict === "string" ? item.verdict : null;
			if (sourceChars == null || extractChars == null || (verdict !== "useExtract" && verdict !== "indexOnly")) continue;
			const delta = Math.max(0, sourceChars - extractChars);
			if (delta === 0) continue;
			const turn = typeof item.turn === "number" ? item.turn : (row.turn ?? 0);
			curatorChars += delta * Math.max(0, (turnCounts.get(row.session_id) ?? 0) - turn);
		}
	}

	// rules: delivered tokens vs resident tokens (tokens, not dollars — rate-free)
	const ruleTokens = Math.round(rules.reduce((total, file) => total + file.chars, 0) / 4);
	let deliveredChars = 0;
	let ruleGood = 0;
	let ruleBad = 0;
	let corrections = 0;
	for (const row of db.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE system = 'ttsr' AND ts_ms BETWEEN ? AND ? LIMIT 40000").all(from, to)) {
		const data = parseData(row);
		if (data.delivered === true && typeof data.rule === "string") {
			deliveredChars += rules.find((file) => file.name === data.rule)?.chars ?? 0;
		}
		if (data.verdict === "good") ruleGood += 1;
		if (data.verdict === "bad") ruleBad += 1;
		if (data.outcome === "user_corrected") corrections += 1;
	}
	let guardBlocks = 0;
	let offTrack = 0;
	for (const row of db.query<{ system: string; data: string }, [number, number]>("SELECT system, data FROM events WHERE system IN ('guard','course-check','router') AND ts_ms BETWEEN ? AND ? LIMIT 40000").all(from, to)) {
		const data = parseData(row);
		if (row.system === "guard" && data.verdict === "blocked") guardBlocks += 1;
		if (row.system === "course-check" && data.verdict === "off_track") offTrack += 1;
		if (row.system === "router" && data.outcome === "user_corrected") corrections += 1;
	}

	let agreementSamples = 0;
	let agreementHits = 0;
	for (const row of db.query<{ data: string }, [number, number]>("SELECT data FROM events WHERE system = 'curator' AND ts_ms BETWEEN ? AND ? LIMIT 40000").all(from, to)) {
		const data = parseData(row);
		if (data.decision === "verifier-ab" && typeof data.agree === "boolean") {
			agreementSamples += 1;
			if (data.agree) agreementHits += 1;
		}
	}

	const jevRow = db
		.query<{ cost: number }, [number, number]>("SELECT COALESCE(SUM(cost_usd),0) cost FROM events WHERE origin LIKE 'adapter:%' AND ts_ms BETWEEN ? AND ?")
		.get(from, to);
	const judged = ruleGood + ruleBad;
	const curatorTokens = Math.round(curatorChars / 4);
	const rulesTokensAvoided = Math.max(0, ruleTokens * calls - Math.round(deliveredChars / 4));
	const perCall = (value: number): number | null => (calls > 0 ? value / calls : null);
	return {
		cost: callStats?.cost ?? 0,
		calls,
		cacheRead,
		input,
		cacheDiscount,
		curatorTokens,
		rulesTokensAvoided,
		corrections,
		guardBlocks,
		offTrack,
		jevSpend: jevRow?.cost ?? 0,
		costPerCall: perCall(callStats?.cost ?? 0),
		jevSpendPerCall: perCall(jevRow?.cost ?? 0),
		cacheDiscountPerCall: perCall(cacheDiscount),
		cacheRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
		promptTokensPerCall: perCall(input + cacheRead),
		curatorTokensPerCall: perCall(curatorTokens),
		rulesTokensAvoidedPerCall: perCall(rulesTokensAvoided),
		errorRate: calls > 0 ? (callStats?.errors ?? 0) / calls : null,
		rulePrecision: judged > 0 ? ruleGood / judged : null,
		verifierAgreement: agreementSamples > 0 ? agreementHits / agreementSamples : null,
		correctionsPer100Calls: calls > 0 ? (corrections / calls) * 100 : null,
		guardBlocksPer100Calls: calls > 0 ? (guardBlocks / calls) * 100 : null,
		verifierSamples: agreementSamples,
		verifierHits: agreementHits,
		judgedOutcomes: judged,
	};
}

/**
 * Per-day series plus the same headline numbers for this window and the one
 * before it, so "am I improving?" has an answer rather than a snapshot.
 */
export function trends(db: Database, range: Range) {
	const priceList = prices(db);
	const rules = ruleSizes();
	const dayExpr = "strftime('%Y-%m-%d', ts_ms / 1000, 'unixepoch', 'localtime')";

	const labels = db
		.query<{ day: string }, [number, number]>(`SELECT ${dayExpr} day FROM model_calls WHERE ts_ms BETWEEN ? AND ? GROUP BY day ORDER BY day`)
		.all(range.from, range.to)
		.map((row) => row.day);
	const index = new Map(labels.map((day, i) => [day, i]));
	const zero = () => new Array(labels.length).fill(0) as number[];
	const series: Record<string, number[]> = {
		cost: zero(),
		calls: zero(),
		cacheDiscount: zero(),
		curatorTokens: zero(),
		rulesTokensAvoided: zero(),
		errors: zero(),
		ruleGood: zero(),
		ruleBad: zero(),
		corrections: zero(),
		guardBlocks: zero(),
		jevSpend: zero(),
		agreementSamples: zero(),
		agreementHits: zero(),
	};

	for (const row of db
		.query<{ day: string; model: string | null; calls: number; cache_read: number; cost: number; errors: number }, [number, number]>(
			`SELECT ${dayExpr} day, model, COUNT(*) calls, COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cost),0) cost,
			        COALESCE(SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END),0) errors
			 FROM model_calls WHERE ts_ms BETWEEN ? AND ? GROUP BY day, model`,
		)
		.all(range.from, range.to)) {
		const i = index.get(row.day);
		if (i === undefined) continue;
		series.calls[i] += row.calls;
		series.cost[i] += row.cost;
		series.errors[i] += row.errors;
		const price = row.model ? priceFor(priceList, row.model) : null;
		if (price?.input != null && price.cache_read != null) series.cacheDiscount[i] += (row.cache_read * (price.input - price.cache_read)) / 1_000_000;
	}

	const ruleTokens = Math.round(rules.reduce((total, file) => total + file.chars, 0) / 4);
	series.rulesTokensAvoided = series.calls.map((count) => ruleTokens * count);

	for (const row of db
		.query<{ day: string; session_id: string; turn: number | null; data: string }, [number, number]>(
			`SELECT ${dayExpr} day, session_id, turn, data FROM events WHERE kind = 'curator.ledger' AND session_id IS NOT NULL AND ts_ms BETWEEN ? AND ? LIMIT 40000`,
		)
		.all(range.from, range.to)) {
		const i = index.get(row.day);
		if (i === undefined) continue;
		const data = parseData(row);
		for (const rawItem of Array.isArray(data.items) ? data.items : []) {
			const item = (rawItem ?? {}) as Record<string, unknown>;
			const sourceChars = typeof item.chars === "number" ? item.chars : null;
			const extractChars = typeof item.extractChars === "number" ? item.extractChars : null;
			const verdict = typeof item.verdict === "string" ? item.verdict : null;
			if (sourceChars == null || extractChars == null || (verdict !== "useExtract" && verdict !== "indexOnly")) continue;
			series.curatorTokens[i] += Math.round(Math.max(0, sourceChars - extractChars) / 4);
		}
	}

	for (const row of db
		.query<{ day: string; system: string; data: string }, [number, number]>(
			`SELECT ${dayExpr} day, system, data FROM events WHERE ts_ms BETWEEN ? AND ? AND origin LIKE 'adapter:%' LIMIT 40000`,
		)
		.all(range.from, range.to)) {
		const i = index.get(row.day);
		if (i === undefined) continue;
		const data = parseData(row);
		if (row.system === "ttsr") {
			if (data.delivered === true && typeof data.rule === "string") {
				const chars = rules.find((file) => file.name === data.rule)?.chars ?? 0;
				series.rulesTokensAvoided[i] -= Math.round(chars / 4);
			}
			if (data.outcome === "user_corrected") series.corrections[i] += 1;
		}
		if (row.system === "router" && data.outcome === "user_corrected") series.corrections[i] += 1;
		if (row.system === "guard" && data.verdict === "blocked") series.guardBlocks[i] += 1;
		if (row.system === "curator" && data.decision === "verifier-ab" && typeof data.agree === "boolean") {
			series.agreementSamples[i] += 1;
			if (data.agree) series.agreementHits[i] += 1;
		}
	}

	for (const row of db
		.query<{ day: string; cost: number; n: number }, [number, number]>(
			`SELECT ${dayExpr} day, COALESCE(SUM(cost_usd),0) cost, COUNT(*) n FROM events WHERE origin LIKE 'adapter:%' AND ts_ms BETWEEN ? AND ? GROUP BY day`,
		)
		.all(range.from, range.to)) {
		const i = index.get(row.day);
		if (i !== undefined) series.jevSpend[i] += row.cost;
	}

	const span = range.to - range.from;
	const current = summarizeWindow(db, priceList, rules, range.from, range.to);
	const previous = summarizeWindow(db, priceList, rules, range.from - span, range.from);

	const pct = (now: number | null, before: number | null): number | null =>
		now == null || before == null || before === 0 ? null : (now - before) / Math.abs(before);

	const ratio = (value: number, calls: number): number => (calls > 0 ? value / calls : 0);
	return {
		labels,
		series: {
			...series,
			errorRate: series.calls.map((count, i) => (count > 0 ? series.errors[i] / count : null)),
			rulePrecision: series.ruleGood.map((good, i) => {
				const judged = good + series.ruleBad[i];
				return judged > 0 ? good / judged : null;
			}),
			verifierAgreement: series.agreementSamples.map((samples, i) => (samples > 0 ? series.agreementHits[i] / samples : null)),
			costPerCall: series.calls.map((count, i) => ratio(series.cost[i], count)),
			cacheDiscountPerCall: series.calls.map((count, i) => ratio(series.cacheDiscount[i], count)),
			curatorTokensPerCall: series.calls.map((count, i) => ratio(series.curatorTokens[i], count)),
			rulesTokensAvoidedPerCall: series.calls.map((count, i) => ratio(series.rulesTokensAvoided[i], count)),
			correctionsPer100Calls: series.calls.map((count, i) => ratio(series.corrections[i] * 100, count)),
		},
		current,
		previous,
		// Deltas compare ratios only: absolutes rise with usage and would read as
		// "worse" every busy period regardless of the harness itself.
		delta: {
			costPerCall: pct(current.costPerCall, previous.costPerCall),
			jevSpendPerCall: pct(current.jevSpendPerCall, previous.jevSpendPerCall),
			cacheDiscountPerCall: pct(current.cacheDiscountPerCall, previous.cacheDiscountPerCall),
			cacheRate: pct(current.cacheRate, previous.cacheRate),
			promptTokensPerCall: pct(current.promptTokensPerCall, previous.promptTokensPerCall),
			curatorTokensPerCall: pct(current.curatorTokensPerCall, previous.curatorTokensPerCall),
			rulesTokensAvoidedPerCall: pct(current.rulesTokensAvoidedPerCall, previous.rulesTokensAvoidedPerCall),
			errorRate: pct(current.errorRate, previous.errorRate),
			rulePrecision: pct(current.rulePrecision, previous.rulePrecision),
			verifierAgreement: pct(current.verifierAgreement, previous.verifierAgreement),
			correctionsPer100Calls: pct(current.correctionsPer100Calls, previous.correctionsPer100Calls),
			guardBlocksPer100Calls: pct(current.guardBlocksPer100Calls, previous.guardBlocksPer100Calls),
		},
	};
}

// ------------------------------------------------------------------ session impact

/** One session's benefit, quality signal and improvement hints — the drill-down view. */
export function sessionImpact(db: Database, sessionId: string) {
	const priceList = prices(db);
	const session = db
		.query<{ session_id: string; project: string; title: string | null; turns: number; calls: number; cost: number; total_tokens: number; cache_read: number; input: number; output: number; errors: number }, [string]>(
			"SELECT session_id, project, title, turns, calls, cost, total_tokens, cache_read, input, output, errors FROM sessions WHERE session_id = ?",
		)
		.get(sessionId);
	if (!session) return { session: null };

	// benefit side
	const rows = db
		.query<{ ts: string; turn: number | null; data: string }, [string]>("SELECT ts, turn, data FROM events WHERE session_id = ? AND kind = 'curator.ledger' ORDER BY ts_ms LIMIT 4000")
		.all(sessionId);
	const items: Array<{ tool: string; sourceType: string; verdict: string; role: string; chars: number; extractChars: number | null; turn: number | null; path: string | null }> = [];
	for (const row of rows) {
		const data = parseData(row);
		for (const rawItem of Array.isArray(data.items) ? data.items : []) {
			const item = (rawItem ?? {}) as Record<string, unknown>;
			const shape = typeof item.inputShape === "string" ? item.inputShape : "";
			const pathMatch = /"path"\s*:\s*"([^"]+)"/.exec(shape);
			items.push({
				tool: typeof item.tool === "string" ? item.tool : "?",
				sourceType: typeof item.sourceType === "string" ? item.sourceType : "?",
				verdict: typeof item.verdict === "string" ? item.verdict : "?",
				role: typeof item.role === "string" ? item.role : "?",
				chars: typeof item.chars === "number" ? item.chars : 0,
				extractChars: typeof item.extractChars === "number" ? item.extractChars : null,
				turn: typeof item.turn === "number" ? item.turn : row.turn,
				path: pathMatch ? pathMatch[1] : null,
			});
		}
	}
	let curatorCharsOneTime = 0;
	let curatorCharsCarried = 0;
	let emits = 0;
	for (const item of items) {
		const condensed = item.verdict === "useExtract" || item.verdict === "indexOnly";
		if (!condensed || item.extractChars == null) continue;
		const delta = Math.max(0, item.chars - item.extractChars);
		if (delta === 0) continue;
		emits += 1;
		curatorCharsOneTime += delta;
		curatorCharsCarried += delta * Math.max(0, session.turns - (item.turn ?? 0));
	}
	const perModel = db
		.query<{ model: string | null; calls: number; cache_read: number; cost: number; errors: number }, [string]>(
			`SELECT model, COUNT(*) calls, COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cost),0) cost,
			        COALESCE(SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END),0) errors
			 FROM model_calls WHERE session_id = ? AND model IS NOT NULL GROUP BY model ORDER BY cost DESC`,
		)
		.all(sessionId);
	let cacheDiscount = 0;
	for (const row of perModel) {
		const price = row.model ? priceFor(priceList, row.model) : null;
		if (price?.input != null && price.cache_read != null) cacheDiscount += (row.cache_read * (price.input - price.cache_read)) / 1_000_000;
	}
	const rules = ruleSizes();
	let delivered = 0;
	let ruleGood = 0;
	let ruleBad = 0;
	let corrections = 0;
	let offTrack = 0;
	let deliveredChars = 0;
	for (const row of db.query<{ system: string; data: string }, [string]>("SELECT system, data FROM events WHERE session_id = ? AND system IN ('ttsr','router','course-check')").all(sessionId)) {
		const data = parseData(row);
		if (row.system === "ttsr") {
			if (data.delivered === true) {
				delivered += 1;
				if (typeof data.rule === "string") deliveredChars += rules.find((file) => file.name === data.rule)?.chars ?? 0;
			}
			if (data.verdict === "good") ruleGood += 1;
			if (data.verdict === "bad") ruleBad += 1;
		}
		if (data.outcome === "user_corrected") corrections += 1;
		if (row.system === "course-check" && data.verdict === "off_track") offTrack += 1;
	}
	const switches = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM events WHERE session_id = ? AND kind = 'model.switch'").get(sessionId)?.n ?? 0;
	const edits = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM events WHERE session_id = ? AND kind = 'curator.context_edit'").get(sessionId)?.n ?? 0;

	// improvement hints
	const findings: Array<{ tone: "warn" | "info" | "ok"; label: string; detail: string }> = [];
	const biggest = [...items].sort((a, b) => b.chars - a.chars).slice(0, 5);
	const readCounts = new Map<string, { count: number; chars: number }>();
	for (const item of items) {
		if (!item.path) continue;
		const entry = readCounts.get(item.path) ?? { count: 0, chars: 0 };
		entry.count += 1;
		entry.chars += item.chars;
		readCounts.set(item.path, entry);
	}
	const repeats = [...readCounts.entries()].filter(([, value]) => value.count >= 3).sort((a, b) => b[1].count - a[1].count);
	if (repeats.length) {
		findings.push({ tone: "warn", label: `${repeats.length} file(s) read 3+ times`, detail: repeats.slice(0, 3).map(([path, value]) => `${path.split("/").slice(-2).join("/")} ×${value.count}`).join(" · ") });
	}
	const bigItems = items.filter((item) => item.chars >= 25000 && (item.verdict === "retainFull" || item.verdict === "?"));
	if (bigItems.length) {
		findings.push({ tone: "warn", label: `${bigItems.length} oversized item(s) kept in full`, detail: bigItems.slice(0, 3).map((item) => `${item.tool} ${(item.chars / 1000).toFixed(0)}k`).join(" · ") });
	}
	if (switches >= 2) findings.push({ tone: "info", label: `${switches} model switches`, detail: "each switch re-bills the prompt prefix uncached" });
	if (session.errors > 0) findings.push({ tone: "warn", label: `${session.errors} errored call(s)`, detail: "billed work that produced nothing" });
	if (corrections > 0) findings.push({ tone: "warn", label: `${corrections} correction(s)`, detail: "you had to step in — check the rule or tier that preceded it" });
	if (offTrack > 0) findings.push({ tone: "warn", label: "drifted off goal", detail: "the goal loop caught it; the fix is usually the first prompt" });
	if (!findings.length) findings.push({ tone: "ok", label: "nothing flagged", detail: "no oversized items, repeated reads, corrections or errors in this session" });

	return {
		session,
		benefit: {
			emits,
			curatorTokensOneTime: Math.round(curatorCharsOneTime / 4),
			curatorTokensCarried: Math.round(curatorCharsCarried / 4),
			cacheDiscount,
			rulesDelivered: delivered,
			rulesTokens: Math.round(deliveredChars / 4),
			contextEdits: edits,
			cacheRate: session.input + session.cache_read > 0 ? session.cache_read / (session.input + session.cache_read) : null,
			costPerTurn: session.turns > 0 ? session.cost / session.turns : null,
		},
		quality: {
			errors: session.errors,
			errorRate: session.calls > 0 ? session.errors / session.calls : null,
			corrections,
			offTrack,
			ruleGood,
			ruleBad,
			rulePrecision: ruleGood + ruleBad > 0 ? ruleGood / (ruleGood + ruleBad) : null,
			modelSwitches: switches,
		},
		items: biggest,
		findings,
	};
}

// ------------------------------------------------------------------ curator overview

/**
 * The curator funnel across every session in the range. The per-session view
 * answers "what did it do here"; this answers "is the pipeline healthy".
 */
export function curatorOverview(db: Database, range: Range) {
	const priceList = prices(db);
	const rows = db
		.query<{ kind: string; data: string }, [number, number]>("SELECT kind, data FROM events WHERE system = 'curator' AND ts_ms BETWEEN ? AND ? LIMIT 40000")
		.all(range.from, range.to);

	let candidates = 0;
	let emits = 0;
	let retainFull = 0;
	const verdicts: Record<string, number> = {};
	const roles: Record<string, number> = {};
	const sourceTypes: Record<string, number> = {};
	const nodeCounts = new Map<string, number>();
	const linkCounts = new Map<string, number>();
	let escalations = 0;
	let verified = 0;
	let repaired = 0;
	let lostLines = 0;
	let abSamples = 0;
	let abAgree = 0;
	let verifierCost = 0;

	for (const row of rows) {
		const data = parseData(row);
		if (row.kind === "shadow") {
			candidates += 1;
			const role = typeof data.role === "string" ? data.role : "?";
			const sourceType = typeof data.sourceType === "string" ? data.sourceType : "?";
			const verdict = typeof data.verifierVerdict === "string" ? data.verifierVerdict : "?";
			roles[role] = (roles[role] ?? 0) + 1;
			sourceTypes[sourceType] = (sourceTypes[sourceType] ?? 0) + 1;
			verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
			if (verdict === "retainFull") retainFull += 1;
			nodeCounts.set(`sourceType:${sourceType}`, (nodeCounts.get(`sourceType:${sourceType}`) ?? 0) + 1);
			nodeCounts.set(`role:${role}`, (nodeCounts.get(`role:${role}`) ?? 0) + 1);
			nodeCounts.set(`verdict:${verdict}`, (nodeCounts.get(`verdict:${verdict}`) ?? 0) + 1);
			linkCounts.set(`sourceType|${sourceType}|role|${role}`, (linkCounts.get(`sourceType|${sourceType}|role|${role}`) ?? 0) + 1);
			linkCounts.set(`role|${role}|verdict|${verdict}`, (linkCounts.get(`role|${role}|verdict|${verdict}`) ?? 0) + 1);
		}
		if (data.action === "emit" || row.kind === "emit-evidence") emits += 1;
		if (typeof data.verifierModel === "string" && data.verifierModel.includes("frontier")) escalations += 1;
		if (data.decision === "jev-verify") {
			verified += 1;
			if (data.repaired === true) repaired += 1;
			if (Array.isArray(data.lostLines)) lostLines += data.lostLines.length;
		}
		if (data.decision === "verifier-ab" && typeof data.agree === "boolean") {
			abSamples += 1;
			if (data.agree) abAgree += 1;
		}
		if (data.decision === "verifier-batch") {
			const usage = (data.usage ?? {}) as Record<string, unknown>;
			const model = typeof data.model === "string" ? data.model : null;
			const price = model ? priceFor(priceList, model) : null;
			if (price?.input != null && price.output != null) {
				const input = typeof usage.input === "number" ? usage.input : 0;
				const output = typeof usage.output === "number" ? usage.output : 0;
				const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
				verifierCost += (input * price.input + output * price.output + cacheRead * (price.cache_read ?? price.input)) / 1_000_000;
			}
		}
	}

	const totals = condensedTotals(db, range.from, range.to);
	return {
		candidates,
		emits,
		emitRate: candidates > 0 ? emits / candidates : null,
		retainFull,
		retainShare: candidates > 0 ? retainFull / candidates : null,
		verdicts,
		roles,
		sourceTypes,
		fates: {
			columns: [
				{ id: "sourceType", title: "Source type" },
				{ id: "role", title: "Role" },
				{ id: "verdict", title: "Verifier verdict" },
			],
			nodes: Object.fromEntries(nodeCounts),
			links: Object.fromEntries(linkCounts),
		},
		escalations,
		escalationRate: candidates > 0 ? escalations / candidates : null,
		repairs: { verified, repaired, lostLines, rate: verified > 0 ? repaired / verified : null },
		agreement: { samples: abSamples, hits: abAgree, rate: abSamples > 0 ? abAgree / abSamples : null },
		verifierCost,
		costPerEmit: emits > 0 ? verifierCost / emits : null,
		tokensOneTime: Math.round(totals.oneTimeChars / 4),
		tokensCarried: Math.round(totals.carriedChars / 4),
		emittedItems: totals.items,
	};
}

/**
 * Findings for this window, annotated against the identical previous window so
 * a recurring problem is distinguishable from a new one.
 */
export function findings(db: Database, range: Range, adapters: Adapter[] = []): { findings: Array<Finding & { persistent: boolean; isNew: boolean }>; generatedAt: number; previousCount: number } {
	const current = computeFindings(db, range, adapters);
	const span = range.to - range.from;
	const previous = computeFindings(db, { from: range.from - span, to: range.from }, adapters);
	const previousIds = new Set(previous.findings.map((finding) => finding.id));
	return {
		findings: current.findings.map((finding) => ({ ...finding, persistent: previousIds.has(finding.id), isNew: !previousIds.has(finding.id) })),
		generatedAt: current.generatedAt,
		previousCount: previous.findings.length,
	};
}

// ------------------------------------------------------------------ digest

/** Markdown digest of a window: what the harness cost, earned, and what to fix. */
export function digest(db: Database, range: Range, rangeLabel: string, adapters: Adapter[] = []): { markdown: string; generatedAt: number } {
	const impactData = impact(db, range, null);
	const benefits = harnessBenefits(db, range);
	const trendData = trends(db, range);
	const findingData = findings(db, range, adapters);
	const lines: string[] = [];
	const usd = (value: number | null | undefined): string => (value == null ? "—" : `$${value.toFixed(value >= 1 ? 2 : 4)}`);
	const tokens = (value: number | null | undefined): string => (value == null ? "—" : Math.round(value).toLocaleString("en-US"));
	const pct = (value: number | null | undefined): string => (value == null ? "—" : `${(value * 100).toFixed(1)}%`);

	lines.push(`# Pi harness digest — ${rangeLabel}`);
	lines.push(`Generated ${new Date().toISOString()}`);
	lines.push("");
	lines.push("## Spend and context");
	lines.push(`- Model cost ${usd(trendData.current.cost)} over ${trendData.current.calls.toLocaleString("en-US")} calls (${usd(trendData.current.costPerCall)}/call)`);
	lines.push(`- Prompt tokens per call ${tokens(trendData.current.promptTokensPerCall)} · cache rate ${pct(trendData.current.cacheRate)}`);
	lines.push(`- Cache discount ${usd(trendData.current.cacheDiscount)} (${usd(trendData.current.cacheDiscountPerCall)}/call)`);
	lines.push("");
	lines.push("## Harness benefit");
	lines.push(`- Rules: ${benefits.rules.deliveries} deliveries (${tokens(benefits.rules.deliveredTokens)} tok) vs ${usd(benefits.rules.alwaysOnCost)} if always resident — net ${usd(benefits.rules.net)}`);
	lines.push(`- Curator: ${tokens(impactData.curator.savedTokensEst)} tokens condensed (carried) ≈ ${usd(impactData.curator.savedUsdEst)}`);
	lines.push(`- Always-on prompt: ${tokens(benefits.baseline.tokens)} tok/call = ${usd(benefits.baseline.cost)} for the window`);
	lines.push(`- Jev request spend: ${benefits.jev.requests.toLocaleString("en-US")} requests, ${usd(benefits.jev.cost)} (${pct(benefits.jev.pricedRequests / Math.max(1, benefits.jev.requests))} costed)`);
	lines.push(`- Guard: ${benefits.guard.blocked} blocked / ${benefits.guard.flagged} flagged of ${benefits.guard.screens} screens, ${usd(benefits.guard.cost)}`);
	lines.push(`- Goal loop: ${benefits.goalLoop.offTrack} off-track of ${benefits.goalLoop.checks} checks ≈ ${usd(benefits.goalLoop.reworkEstimate)} rework avoided`);
	lines.push("");
	lines.push("## Change vs previous window (ratios only)");
	for (const [key, value] of Object.entries(trendData.delta)) {
		lines.push(`- ${key}: ${value == null ? "no prior data" : `${(value * 100).toFixed(1)}%`}`);
	}
	lines.push("");
	lines.push("## Findings");
	if (!findingData.findings.length) lines.push("- None in this window.");
	for (const finding of findingData.findings) {
		lines.push(`- [${finding.tone}] ${finding.title} (${finding.isNew ? "new" : "recurring"})`);
		lines.push(`  - ${finding.summary}`);
		lines.push(`  - Lever: ${finding.action}`);
	}
	lines.push("");
	lines.push("_Generated locally by the Pi Harness Observatory. Ratios come from logged data; guard/memory value is counted, not priced._");
	return { markdown: lines.join("\n"), generatedAt: Date.now() };
}

// ------------------------------------------------------------------ refine

/** Markdown files in a directory, with size and a short preview for review. */
function markdownFiles(dir: string): Array<{ name: string; path: string; chars: number; preview: string }> {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((file) => file.endsWith(".md") && !file.startsWith("."))
			.map((file) => {
				const full = path.join(dir, file);
				const content = readFileSync(full, "utf8");
				return {
					name: file.replace(/\.md$/, ""),
					path: full,
					chars: content.length,
					preview: content.replace(/\s+/g, " ").slice(0, 220),
				};
			});
	} catch (err) {
		log.warn(`cannot list ${dir}: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}

/**
 * The refinement pipeline: what the auto-loop proposed, what was applied, what
 * is staged for arming, and the notes it wrote — with file paths so anything
 * can be opened and read in full.
 */
export function refineOverview(db: Database, range: Range) {
	const rows = db
		.query<{ ts: string; data: string }, [number, number]>("SELECT ts, data FROM events WHERE system = 'refine' AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms LIMIT 5000")
		.all(range.from, range.to);
	const byDecision: Record<string, number> = {};
	const byStage: Record<string, number> = {};
	const byKind: Record<string, number> = {};
	let latencyTotal = 0;
	let latencyCount = 0;
	let degraded = 0;
	const proposals: Array<{ ts: string; decision: string; stage: string; kind: string | null; name: string | null; score: number | null; latencyMs: number | null; err: string | null; tier: string | null }> = [];
	// The rule gate scores three parts and stages in two bands (ready / near-miss).
	// Re-deriving the bands here is what makes the gate legible — and it is editable,
	// since the floors are env vars the extension reads.
	const clamp01 = (raw?: string, fallback = 0.6): number => {
		const parsed = Number(raw ?? fallback);
		return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
	};
	const floors = {
		evidence: clamp01(process.env.REFINE_AUTO_RULE_EVIDENCE_FLOOR, 0.6),
		novelty: clamp01(process.env.REFINE_AUTO_RULE_NOVELTY_FLOOR, 0.6),
		trigger: clamp01(process.env.REFINE_AUTO_RULE_TRIGGER_FLOOR, 0.5),
		nearMiss: clamp01(process.env.REFINE_AUTO_NEAR_MISS_FLOOR, 0.4),
	};
	const bandOf = (parts: { evidence: number; novelty: number; trigger: number }): "ready" | "near-miss" | "below" => {
		if (parts.evidence >= floors.evidence && parts.novelty >= floors.novelty && parts.trigger >= floors.trigger) return "ready";
		return Math.min(parts.evidence, parts.novelty) >= floors.nearMiss ? "near-miss" : "below";
	};
	const bands: Record<string, number> = { ready: 0, "near-miss": 0, below: 0 };
	const partStats: Record<string, number[]> = { evidence: [], novelty: [], trigger: [] };
	let nearMissEligibleSuppressed = 0;
	for (const row of rows) {
		const data = parseData(row);
		const decision = typeof data.decision === "string" ? data.decision : "unknown";
		const stage = typeof data.stage === "string" ? data.stage : "unknown";
		byDecision[decision] = (byDecision[decision] ?? 0) + 1;
		byStage[stage] = (byStage[stage] ?? 0) + 1;
		if (typeof data.kind === "string") byKind[data.kind] = (byKind[data.kind] ?? 0) + 1;
		const rawParts = (data.parts ?? null) as Record<string, unknown> | null;
		if (data.kind === "rule" && rawParts && typeof rawParts.evidence === "number" && typeof rawParts.novelty === "number" && typeof rawParts.trigger === "number") {
			const scored = { evidence: rawParts.evidence, novelty: rawParts.novelty, trigger: rawParts.trigger };
			bands[bandOf(scored)] += 1;
			for (const part of ["evidence", "novelty", "trigger"]) partStats[part].push(scored[part as "evidence" | "novelty" | "trigger"]);
			if (decision === "suppressed" && bandOf(scored) !== "below") nearMissEligibleSuppressed += 1;
		}
		if (typeof data.latencyMs === "number") {
			latencyTotal += data.latencyMs;
			latencyCount += 1;
		}
		if (decision === "degraded" || data.err) degraded += 1;
		proposals.push({
			ts: row.ts,
			decision,
			stage,
			kind: typeof data.kind === "string" ? data.kind : null,
			name: typeof data.name === "string" ? data.name : null,
			score: typeof data.score === "number" ? data.score : null,
			latencyMs: typeof data.latencyMs === "number" ? data.latencyMs : null,
			err: typeof data.err === "string" ? data.err.slice(0, 160) : null,
			tier: typeof data.tier === "string" ? data.tier : null,
		});
	}

	// What actually landed on disk (rules + notes), with liveness checked against the rulebook.
	const history = db
		.query<{ ts: string; data: string }, [number, number]>("SELECT ts, data FROM events WHERE system = 'refine-history' AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms DESC LIMIT 500")
		.all(range.from, range.to);
	let liveRules = new Set<string>();
	try {
		if (existsSync(rulesDir())) liveRules = new Set(readdirSync(rulesDir()).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")));
	} catch (err) {
		log.warn(`cannot list rules: ${err instanceof Error ? err.message : String(err)}`);
	}
	// History records the absolute path it wrote at the time, which goes stale when
	// a directory moves. Resolve by name against the current locations instead, and
	// say plainly when nothing readable is left rather than offering a dead button.
	const resolveArtifactPath = (kind: string, name: string, recorded: string | null): string | null => {
		const candidates: string[] = [];
		if (kind === "note") candidates.push(path.join(refineDir(), "notes", `${name}.md`));
		if (kind === "rule") {
			candidates.push(path.join(rulesDir(), `${name}.md`));
			candidates.push(path.join(refineDir(), "rules-staging", `${name}.md`));
		}
		if (recorded) candidates.push(recorded);
		return candidates.find((candidate) => existsSync(candidate)) ?? null;
	};
	// Staged rules first: their tiers decide the lifecycle state of each rule artifact.
	const stagingEntries = markdownFiles(path.join(refineDir(), "rules-staging")).map((entry) => {
		// Each staged rule carries a sibling meta file with its tier and part scores —
		// that is what tells you whether to arm it or send it for review.
		let meta: Record<string, unknown> | null = null;
		const metaPath = path.join(refineDir(), "rules-staging", `${entry.name}.meta.json`);
		try {
			if (existsSync(metaPath)) meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
		} catch (err) {
			log.warn(`cannot read ${metaPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
		return {
			...entry,
			metaPath: existsSync(metaPath) ? metaPath : null,
			tier: typeof meta?.tier === "string" ? meta.tier : null,
			parts: (meta?.parts ?? null) as Record<string, unknown> | null,
			score: typeof meta?.score === "number" ? meta.score : null,
			stagedAt: typeof meta?.stagedAt === "string" ? meta.stagedAt : null,
			evidence: typeof meta?.evidence === "string" ? meta.evidence.slice(0, 200) : null,
		};
	});
	const stagedNames = new Set(stagingEntries.map((entry) => entry.name));

	const artifacts = history.map((row) => {
		const data = parseData(row);
		const kind = typeof data.kind === "string" ? data.kind : "artifact";
		const name = typeof data.name === "string" ? data.name : "?";
		const recorded = typeof data.path === "string" ? data.path : null;
		const resolved = resolveArtifactPath(kind, name, recorded);
		return {
			id: typeof data.id === "string" ? data.id : row.ts,
			ts: row.ts,
			kind,
			name,
			path: resolved,
			available: resolved != null,
			recordedPath: recorded,
			evidence: typeof data.evidence === "string" ? data.evidence.slice(0, 260) : null,
			source: typeof data.source === "string" ? data.source : null,
			live: kind === "rule" ? liveRules.has(name) : true,
			rolledBack: data.rolledBack === true,
			// The lifecycle a rule passes through: proposed → staged → armed, or rolled back.
			state: data.rolledBack === true ? "rolled back" : kind === "note" ? "written" : liveRules.has(name) ? "armed" : stagedNames.has(name) ? "staged" : "proposed",
		};
	});

	return {
		runs: rows.length,
		byDecision,
		byStage,
		byKind,
		degraded,
		avgLatencyMs: latencyCount > 0 ? Math.round(latencyTotal / latencyCount) : null,
		stagedRate: byDecision.applied !== undefined && rows.length > 0 ? byDecision.applied / rows.length : null,
		proposals: proposals.slice(-80).reverse(),
		artifacts,
		staging: stagingEntries,
		artifactCounts: {
			rules: artifacts.filter((artifact) => artifact.kind === "rule").length,
			notes: artifacts.filter((artifact) => artifact.kind === "note").length,
			byState: artifacts.reduce<Record<string, number>>((counts, artifact) => {
				counts[artifact.state] = (counts[artifact.state] ?? 0) + 1;
				return counts;
			}, {}),
		},
		gate: {
			floors,
			bands,
			nearMissEligibleSuppressed,
			parts: Object.fromEntries(
				Object.entries(partStats).map(([part, values]) => [
					part,
					{
						count: values.length,
						avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
						max: values.length ? Math.max(...values) : null,
						min: values.length ? Math.min(...values) : null,
						floor: floors[part as "evidence" | "novelty" | "trigger"],
					},
				]),
			),
		},
		notes: markdownFiles(path.join(refineDir(), "notes")),
		liveRuleCount: liveRules.size,
	};
}

// ------------------------------------------------------------------ tuner

/** Decision-tuner runs, its proposals and their review status, plus its own state. */
export function tunerOverview(db: Database, range: Range) {
	const runs = db
		.query<{ ts: string; data: string }, [number, number]>("SELECT ts, data FROM events WHERE system = 'tuner' AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms DESC LIMIT 200")
		.all(range.from, range.to)
		.map((row) => {
			const data = parseData(row);
			return {
				ts: row.ts,
				event: typeof data.event === "string" ? data.event : "run",
				days: typeof data.days === "number" ? data.days : null,
				proposals: typeof data.proposals === "number" ? data.proposals : null,
				target: typeof data.target === "string" ? data.target : null,
			};
		});
	const proposalLog = path.join(tunerDir(), "proposals.jsonl");
	const proposalRows = db
		.query<{ ts: string; data: string }, [number, number]>("SELECT ts, data FROM events WHERE system = 'tuner-proposals' AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms DESC LIMIT 200")
		.all(range.from, range.to)
		.map((row) => {
			const data = parseData(row);
			const recordedFile = typeof data.file === "string" ? data.file : null;
			const where = resolveProposalFile(recordedFile, typeof data.kind === "string" ? data.kind : null, proposalLog);
			return {
				id: typeof data.id === "string" ? data.id : row.ts,
				ts: row.ts,
				kind: typeof data.kind === "string" ? data.kind : "?",
				system: typeof data.system === "string" ? data.system : "?",
				target: typeof data.target === "string" ? data.target : "?",
				evidence: typeof data.evidence === "string" ? data.evidence.slice(0, 300) : null,
				status: typeof data.status === "string" ? data.status : "open",
				createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
				decidedAt: typeof data.decidedAt === "string" ? data.decidedAt : null,
				file: where.file,
				fileKind: where.fileKind,
				fileExists: where.fileExists,
			};
		});
	const statusCounts: Record<string, number> = {};
	for (const proposal of proposalRows) statusCounts[proposal.status] = (statusCounts[proposal.status] ?? 0) + 1;

	const readJson = (file: string): unknown => {
		try {
			return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as unknown) : null;
		} catch (err) {
			log.warn(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	};
	return {
		runs,
		proposals: proposalRows,
		statusCounts,
		state: readJson(path.join(tunerDir(), "state.json")),
		config: readJson(path.join(tunerDir(), "config.json")),
		proposalsFile: path.join(tunerDir(), "proposals.jsonl"),
	};
}

// ------------------------------------------------------------------ file reader

const READABLE_ROOTS = (): string[] => [rulesDir(), refineDir(), tunerDir(), agentDir()];

/** Read a file for review in the UI, restricted to the harness directories. */
export function readHarnessFile(requested: string): { path: string; content: string } | { error: string } {
	const resolved = path.resolve(requested.startsWith("~") ? path.join(homedir(), requested.slice(1)) : requested);
	const roots = READABLE_ROOTS().map((root) => path.resolve(root));
	if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) return { error: "path is outside the readable harness directories" };
	if (!existsSync(resolved)) return { error: "file not found" };
	const stat = statSync(resolved);
	if (!stat.isFile()) return { error: "not a file" };
	if (stat.size > 200_000) return { error: `too large to render (${Math.round(stat.size / 1024)} KB)` };
	return { path: resolved, content: readFileSync(resolved, "utf8") };
}

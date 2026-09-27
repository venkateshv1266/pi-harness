/**
 * Decision-telemetry discovery and analysis.
 *
 * Reads every *.jsonl under ~/.pi/agent/jev-decisions/ and groups records by
 * system. Records carrying the envelope from utils/jev-outcomes.ts
 * (kind/system/id/ref/outcome/verdict) are analyzed generically; legacy
 * shapes written before the envelope are normalized so they still join.
 *
 * A new extension that logs decisions/outcomes to its own file appears in
 * /decisions-report automatically — no change needed here.
 */

import { readdirSync } from "node:fs";
import { basename } from "node:path";
import { DECISIONS_DIR, parseTs, readDecisionLines } from "./jev-outcomes.ts";

export const TTSR_FILE = "ttsr-jev.jsonl";
export const ROUTER_FILE = "model-router.jsonl";
export const CURATOR_FILE = "jev-curator-v3-shadow.jsonl";
export const MEMORY_FILE = "jev-memory.jsonl";

export const KNOWN_SYSTEMS: Record<string, string> = {
	[TTSR_FILE]: "ttsr",
	[ROUTER_FILE]: "router",
	[CURATOR_FILE]: "curator",
	[MEMORY_FILE]: "memory",
};

const ZERO_FIRE_MIN_EVALS = 20;
const ADVERSE_MIN_RESOLVED = 3;
const ADVERSE_RATE_FLAG = 0.5;
const UNUSED_EXTRACT_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const UNRESOLVED_DECISION_AGE_MS = 24 * 60 * 60 * 1000;

// ─── Envelope + legacy normalization ─────────────────────────────────────

export type EventKind = "decision" | "outcome" | "event" | "untyped";

export interface TelemetryRecord {
	system: string;
	file: string;
	kind: EventKind;
	id: string | null;
	ref: string | null;
	outcome: string | null;
	verdict: string | null;
	ts: number;
	raw: Record<string, unknown>;
}

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function normalizeRecord(raw: Record<string, unknown>, system: string, file: string): TelemetryRecord {
	const base = {
		system,
		file,
		ts: parseTs(raw.ts),
		raw,
		id: null as string | null,
		ref: null as string | null,
		outcome: null as string | null,
		verdict: null as string | null,
	};
	if (raw.kind === "decision" || raw.kind === "outcome" || raw.kind === "event") {
		return { ...base, kind: raw.kind, id: asString(raw.id), ref: asString(raw.ref), outcome: asString(raw.outcome), verdict: asString(raw.verdict) };
	}
	// Legacy shapes written before the envelope
	if (raw.record === "fire") return { ...base, kind: "decision", id: asString(raw.fireId) };
	if (raw.record === "outcome") {
		return { ...base, kind: "outcome", ref: asString(raw.ref) ?? asString(raw.fireId) ?? asString(raw.routeId), outcome: asString(raw.outcome), verdict: asString(raw.verdict) };
	}
	if (raw.decision === "emit-evidence") return { ...base, kind: "decision", id: asString(raw.entryId) };
	if (raw.decision === "recall") return { ...base, kind: "outcome", ref: asString(raw.entryId), outcome: "recalled", verdict: "good" };
	// Router route records predate the envelope and carry no marker of their own
	if (system === "router" && (raw.routeId !== undefined || raw.from !== undefined)) return { ...base, kind: "decision", id: asString(raw.routeId) };
	return { ...base, kind: "untyped" };
}

// ─── Generic per-system analysis (auto-discovery) ────────────────────────

export interface SystemAnalysis {
	system: string;
	files: string[];
	decisions: number;
	outcomes: number;
	events: number;
	joined: number;
	orphanOutcomes: number;
	unresolvedDecisions: number;
	verdicts: Record<string, number>;
	outcomeNames: Record<string, number>;
	untyped: number;
	firstTs: number | null;
	attention: string[];
}

export function discoverLogFiles(): string[] {
	try {
		return readdirSync(DECISIONS_DIR)
			.filter((f) => f.endsWith(".jsonl"))
			.sort();
	} catch {
		return [];
	}
}

export function analyzeSystems(files: string[], sinceMs: number, nowMs: number): SystemAnalysis[] {
	const bySystem = new Map<string, { files: Set<string>; records: TelemetryRecord[] }>();
	for (const file of files) {
		const records = readDecisionLines(file);
		for (const raw of records) {
			if (parseTs(raw.ts) < sinceMs) continue;
			const explicit = asString(raw.system);
			const system = explicit ?? KNOWN_SYSTEMS[file] ?? basename(file, ".jsonl");
			const entry = bySystem.get(system) ?? { files: new Set<string>(), records: [] };
			entry.files.add(file);
			entry.records.push(normalizeRecord(raw, system, file));
			bySystem.set(system, entry);
		}
	}
	const out: SystemAnalysis[] = [];
	for (const [system, entry] of bySystem) {
		const decisionIds = new Set<string>();
		const resolvedRefs = new Set<string>();
		let unresolvedDecisions = 0;
		let firstTs: number | null = null;
		const verdicts: Record<string, number> = {};
		const outcomeNames: Record<string, number> = {};
		let decisions = 0;
		let outcomes = 0;
		let events = 0;
		let untyped = 0;
		for (const r of entry.records) {
			if (firstTs === null || r.ts < firstTs) firstTs = r.ts;
			if (r.kind === "decision") {
				decisions++;
				if (r.id) decisionIds.add(r.id);
			} else if (r.kind === "outcome") {
				outcomes++;
				if (r.ref) resolvedRefs.add(r.ref);
				const outcome = r.outcome ?? "unknown";
				outcomeNames[outcome] = (outcomeNames[outcome] ?? 0) + 1;
				const verdict = r.verdict ?? "unknown";
				verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
			} else if (r.kind === "event") {
				events++;
			} else {
				untyped++;
			}
		}
		// decisions whose ts is old and whose id never appears as a ref
		for (const r of entry.records) {
			if (r.kind !== "decision" || !r.id) continue;
			if (r.ts < nowMs - UNRESOLVED_DECISION_AGE_MS && !resolvedRefs.has(r.id)) unresolvedDecisions++;
		}
		const orphanOutcomes = entry.records.filter((r) => r.kind === "outcome" && (!r.ref || !decisionIds.has(r.ref))).length;
		const joined = outcomes - orphanOutcomes;
		const attention: string[] = [];
		if (orphanOutcomes > 0) attention.push(`${orphanOutcomes} outcome(s) reference no logged decision`);
		if (unresolvedDecisions > 0) attention.push(`${unresolvedDecisions} decision(s) >24h with no outcome`);
		if (decisions === 0 && outcomes === 0 && untyped > 0) attention.push("legacy-only log (no contract records)");
		out.push({
			system,
			files: [...entry.files].sort(),
			decisions,
			outcomes,
			events,
			joined,
			orphanOutcomes,
			unresolvedDecisions,
			verdicts,
			outcomeNames,
			untyped,
			firstTs,
			attention,
		});
	}
	return out.sort((a, b) => b.decisions + b.outcomes - (a.decisions + a.outcomes) || a.system.localeCompare(b.system));
}

// ─── TTSR ────────────────────────────────────────────────────────────────

export interface TtsrRuleStat {
	rule: string;
	evals: number;
	suppressed: number;
	gateFired: number;
	fires: number;
	delivered: number;
	outcomes: Record<string, number>;
	adverse: number;
	resolved: number;
	adverseRate: number | null;
}

export interface TtsrAnalysis {
	evals: number;
	suppressed: number;
	gateFired: number;
	fires: number;
	delivered: number;
	telemetrySince: string | null;
	rules: TtsrRuleStat[];
	prune: TtsrRuleStat[];
	adverse: TtsrRuleStat[];
}

const isTtsrFire = (r: Record<string, unknown>): boolean => (r.kind === "decision" && r.system === "ttsr") || r.record === "fire";
const isTtsrOutcome = (r: Record<string, unknown>): boolean => (r.kind === "outcome" && r.system === "ttsr") || r.record === "outcome";

export function analyzeTtsr(records: Record<string, unknown>[], sinceMs: number): TtsrAnalysis {
	const byRule = new Map<string, TtsrRuleStat>();
	const stat = (rule: string): TtsrRuleStat => {
		let s = byRule.get(rule);
		if (!s) {
			s = { rule, evals: 0, suppressed: 0, gateFired: 0, fires: 0, delivered: 0, outcomes: {}, adverse: 0, resolved: 0, adverseRate: null };
			byRule.set(rule, s);
		}
		return s;
	};
	let evals = 0;
	let suppressed = 0;
	let gateFired = 0;
	let fires = 0;
	let delivered = 0;
	let telemetrySince: string | null = null;
	for (const r of records) {
		if (parseTs(r.ts) < sinceMs) continue;
		if (typeof r.rule !== "string") continue;
		const s = stat(r.rule);
		if (isTtsrFire(r)) {
			s.fires++;
			fires++;
			if (!telemetrySince && typeof r.ts === "string") telemetrySince = r.ts;
			if (r.delivered !== false) {
				s.delivered++;
				delivered++;
			}
		} else if (isTtsrOutcome(r)) {
			const outcome = String(r.outcome ?? "unknown");
			s.outcomes[outcome] = (s.outcomes[outcome] ?? 0) + 1;
		} else {
			s.evals++;
			evals++;
			if (r.decision === "suppressed") {
				s.suppressed++;
				suppressed++;
			} else if (r.decision === "fired") {
				s.gateFired++;
				gateFired++;
			}
		}
	}
	for (const s of byRule.values()) {
		s.adverse = (s.outcomes.retried ?? 0) + (s.outcomes.repeated ?? 0) + (s.outcomes.user_corrected ?? 0);
		s.resolved = (s.outcomes.survived ?? 0) + s.adverse;
		s.adverseRate = s.resolved > 0 ? s.adverse / s.resolved : null;
	}
	const rules = [...byRule.values()].sort((a, b) => b.fires - a.fires || b.evals - a.evals);
	// gateFired > 0 without a fire record means soft-only or pre-telemetry data —
	// keep those out of the prune set rather than mislabel a rule that did fire
	const prune = rules.filter((r) => r.evals >= ZERO_FIRE_MIN_EVALS && r.delivered === 0 && r.gateFired === 0);
	const adverse = rules.filter((r) => r.resolved >= ADVERSE_MIN_RESOLVED && (r.adverseRate ?? 0) >= ADVERSE_RATE_FLAG);
	return { evals, suppressed, gateFired, fires, delivered, telemetrySince, rules, prune, adverse };
}

// ─── Router ──────────────────────────────────────────────────────────────

export interface RouterAnalysis {
	routes: number;
	acted: number;
	actedTiers: Record<string, number>;
	outcomes: Record<string, number>;
	actedTestFailures: number;
	telemetryRoutes: number;
	telemetryActed: number;
	telemetryActedTiers: Record<string, number>;
	telemetrySince: string | null;
}

export function analyzeRouter(records: Record<string, unknown>[], sinceMs: number): RouterAnalysis {
	let routes = 0;
	let acted = 0;
	let actedTestFailures = 0;
	let telemetryRoutes = 0;
	let telemetryActed = 0;
	let telemetrySince: string | null = null;
	const actedTiers: Record<string, number> = {};
	const telemetryActedTiers: Record<string, number> = {};
	const outcomes: Record<string, number> = {};
	for (const r of records) {
		if (parseTs(r.ts) < sinceMs) continue;
		if ((r.kind === "outcome" && r.system === "router") || r.record === "outcome") {
			const outcome = String(r.outcome ?? "unknown");
			outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
			if (outcome === "tests_failed" && r.acted === true) actedTestFailures++;
			continue;
		}
		routes++;
		const telemetry = typeof r.id === "string" || typeof r.routeId === "string";
		if (telemetry) {
			telemetryRoutes++;
			if (!telemetrySince && typeof r.ts === "string") telemetrySince = r.ts;
		}
		if (r.acted === true) {
			acted++;
			const tier = String(r.tier ?? "unknown");
			actedTiers[tier] = (actedTiers[tier] ?? 0) + 1;
			if (telemetry) {
				telemetryActed++;
				telemetryActedTiers[tier] = (telemetryActedTiers[tier] ?? 0) + 1;
			}
		}
	}
	return { routes, acted, actedTiers, outcomes, actedTestFailures, telemetryRoutes, telemetryActed, telemetryActedTiers, telemetrySince };
}

// ─── Curator ─────────────────────────────────────────────────────────────

export interface CuratorAnalysis {
	verdicts: Record<string, number>;
	emits: Record<string, number>;
	skips: number;
	useExtractWithoutEmit: number;
	recalls: number;
	finds: number;
	recallsBySource: Record<string, number>;
	recallSince: string | null;
	emittedRecalled: number;
	emittedTotal: number;
	emittedStaleUnused: number;
	topRecalled: Array<{ entryId: string; count: number }>;
}

const isCuratorEmit = (r: Record<string, unknown>): boolean => (r.kind === "decision" && r.system === "curator" && r.action === "emit") || r.decision === "emit-evidence";
const isCuratorRecall = (r: Record<string, unknown>): boolean =>
	(r.kind === "outcome" && r.system === "curator" && r.outcome === "recalled") || (r.decision === "recall" && r.source !== "curator_find");
const isCuratorFind = (r: Record<string, unknown>): boolean =>
	(r.kind === "event" && r.system === "curator" && r.action === "find") || (r.decision === "recall" && r.source === "curator_find");

export function analyzeCurator(records: Record<string, unknown>[], sinceMs: number, nowMs = Date.now()): CuratorAnalysis {
	const verdicts: Record<string, number> = {};
	const emits: Record<string, number> = {};
	const recallsBySource: Record<string, number> = {};
	const emitted = new Map<string, number>();
	const useExtract = new Set<string>();
	const recalled = new Map<string, number>();
	let skips = 0;
	let recalls = 0;
	let finds = 0;
	let recallSince: string | null = null;
	for (const r of records) {
		const ts = parseTs(r.ts);
		if (ts < sinceMs) continue;
		if (r.decision === "shadow") {
			const v = String(r.verifierVerdict ?? "none");
			verdicts[v] = (verdicts[v] ?? 0) + 1;
			if (v === "useExtract" && typeof r.entryId === "string") useExtract.add(r.entryId);
		} else if (isCuratorEmit(r)) {
			const v = String(r.verdict ?? "unknown");
			emits[v] = (emits[v] ?? 0) + 1;
			const entryId = typeof r.entryId === "string" ? r.entryId : typeof r.id === "string" ? r.id : null;
			if (entryId && !emitted.has(entryId)) emitted.set(entryId, ts);
		} else if (r.decision === "evidence-skip") {
			skips++;
		} else if (isCuratorFind(r)) {
			finds++;
		} else if (isCuratorRecall(r)) {
			const source = String(r.source ?? "unknown");
			recallsBySource[source] = (recallsBySource[source] ?? 0) + 1;
			recalls++;
			if (!recallSince && typeof r.ts === "string") recallSince = r.ts;
			const entryId = typeof r.ref === "string" ? r.ref : typeof r.entryId === "string" ? r.entryId : null;
			if (source === "jev_recall" && entryId) recalled.set(entryId, (recalled.get(entryId) ?? 0) + 1);
		}
	}
	const emittedIds = [...emitted.keys()];
	const emittedRecalled = emittedIds.filter((id) => (recalled.get(id) ?? 0) > 0).length;
	const emittedStaleUnused = emittedIds.filter(
		(id) => nowMs - (emitted.get(id) ?? nowMs) > UNUSED_EXTRACT_AGE_MS && (recalled.get(id) ?? 0) === 0,
	).length;
	const useExtractWithoutEmit = [...useExtract].filter((id) => !emitted.has(id)).length;
	const topRecalled = [...recalled.entries()]
		.map(([entryId, count]) => ({ entryId, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 5);
	return { verdicts, emits, skips, useExtractWithoutEmit, recalls, finds, recallsBySource, recallSince, emittedRecalled, emittedTotal: emittedIds.length, emittedStaleUnused, topRecalled };
}

// ─── Memory (legacy rows; the pipeline keeps its own decision/outcome field) ─

export interface MemoryAnalysis {
	decisions: Record<string, number>;
	corrections: Record<string, number>;
	consolidation: Record<string, number>;
}

export function analyzeMemory(records: Record<string, unknown>[], sinceMs: number): MemoryAnalysis {
	const decisions: Record<string, number> = {};
	const corrections: Record<string, number> = {};
	const consolidation: Record<string, number> = {};
	for (const r of records) {
		if (parseTs(r.ts) < sinceMs) continue;
		const decision = String(r.decision ?? "unknown");
		decisions[decision] = (decisions[decision] ?? 0) + 1;
		if (decision === "correction") {
			const outcome = String(r.outcome ?? "unknown");
			corrections[outcome] = (corrections[outcome] ?? 0) + 1;
		} else if (decision === "consolidation") {
			const outcome = String(r.outcome ?? "unknown");
			consolidation[outcome] = (consolidation[outcome] ?? 0) + 1;
		}
	}
	return { decisions, corrections, consolidation };
}

// ─── Report assembly ─────────────────────────────────────────────────────

export interface Report {
	days: number;
	generatedAt: string;
	since: string;
	ttsr: TtsrAnalysis;
	router: RouterAnalysis;
	curator: CuratorAnalysis;
	memory: MemoryAnalysis;
	systems: SystemAnalysis[];
}

export function collectReport(days: number, sinceMs: number, nowMs = Date.now()): Report {
	return {
		days,
		generatedAt: new Date(nowMs).toISOString(),
		since: new Date(sinceMs).toISOString(),
		ttsr: analyzeTtsr(readDecisionLines(TTSR_FILE), sinceMs),
		router: analyzeRouter(readDecisionLines(ROUTER_FILE), sinceMs),
		curator: analyzeCurator(readDecisionLines(CURATOR_FILE), sinceMs, nowMs),
		memory: analyzeMemory(readDecisionLines(MEMORY_FILE), sinceMs),
		systems: analyzeSystems(discoverLogFiles(), sinceMs, nowMs),
	};
}

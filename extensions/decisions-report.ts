/**
 * /decisions-report — joins the Jev decision logs to their outcome records.
 *
 * Outcome telemetry (R1): TTSR writes fire/outcome records, model-router
 * writes outcome records, the curator writes recall records. This command
 * reads them back and reports which decisions helped and which did not.
 *
 * Usage: /decisions-report [days]   (default 7; writes a markdown file under
 * jev-decisions/reports and notifies a summary).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DECISIONS_DIR, parseTs, readDecisionLines } from "../utils/jev-outcomes.ts";

const TTSR_FILE = "ttsr-jev.jsonl";
const ROUTER_FILE = "model-router.jsonl";
const CURATOR_FILE = "jev-curator-v3-shadow.jsonl";
const MEMORY_FILE = "jev-memory.jsonl";

const ZERO_FIRE_MIN_EVALS = 20;
const ADVERSE_MIN_RESOLVED = 3;
const ADVERSE_RATE_FLAG = 0.5;
const UNUSED_EXTRACT_AGE_MS = 3 * 24 * 60 * 60 * 1000;

// ─── Types ───────────────────────────────────────────────────────────────

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

export interface CuratorAnalysis {
	verdicts: Record<string, number>;
	emits: Record<string, number>;
	skips: number;
	useExtractWithoutEmit: number;
	recalls: number;
	recallsBySource: Record<string, number>;
	recallSince: string | null;
	emittedRecalled: number;
	emittedTotal: number;
	emittedStaleUnused: number;
	topRecalled: Array<{ entryId: string; count: number }>;
}

export interface MemoryAnalysis {
	decisions: Record<string, number>;
	corrections: Record<string, number>;
	consolidation: Record<string, number>;
}

export interface Report {
	days: number;
	generatedAt: string;
	since: string;
	ttsr: TtsrAnalysis;
	router: RouterAnalysis;
	curator: CuratorAnalysis;
	memory: MemoryAnalysis;
}

// ─── Analysis ────────────────────────────────────────────────────────────

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
		if (r.record === "fire") {
			s.fires++;
			fires++;
			if (!telemetrySince && typeof r.ts === "string") telemetrySince = r.ts;
			if (r.delivered !== false) {
				s.delivered++;
				delivered++;
			}
		} else if (r.record === "outcome") {
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
		if (r.record === "outcome") {
			const outcome = String(r.outcome ?? "unknown");
			outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
			if (outcome === "tests_failed" && r.acted === true) actedTestFailures++;
			continue;
		}
		routes++;
		const telemetry = typeof r.routeId === "string";
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

export function analyzeCurator(records: Record<string, unknown>[], sinceMs: number, nowMs = Date.now()): CuratorAnalysis {
	const verdicts: Record<string, number> = {};
	const emits: Record<string, number> = {};
	const recallsBySource: Record<string, number> = {};
	const emitted = new Map<string, number>();
	const useExtract = new Set<string>();
	const recalled = new Map<string, number>();
	let skips = 0;
	let recalls = 0;
	let recallSince: string | null = null;
	for (const r of records) {
		const ts = parseTs(r.ts);
		if (ts < sinceMs) continue;
		if (r.decision === "shadow") {
			const v = String(r.verifierVerdict ?? "none");
			verdicts[v] = (verdicts[v] ?? 0) + 1;
			if (v === "useExtract" && typeof r.entryId === "string") useExtract.add(r.entryId);
		} else if (r.decision === "emit-evidence") {
			const v = String(r.verdict ?? "unknown");
			emits[v] = (emits[v] ?? 0) + 1;
			if (typeof r.entryId === "string" && !emitted.has(r.entryId)) emitted.set(r.entryId, ts);
		} else if (r.decision === "evidence-skip") {
			skips++;
		} else if (r.decision === "recall") {
			const source = String(r.source ?? "unknown");
			recallsBySource[source] = (recallsBySource[source] ?? 0) + 1;
			recalls++;
			if (!recallSince && typeof r.ts === "string") recallSince = r.ts;
			if (source === "jev_recall" && typeof r.entryId === "string") {
				recalled.set(r.entryId, (recalled.get(r.entryId) ?? 0) + 1);
			}
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
	return { verdicts, emits, skips, useExtractWithoutEmit, recalls, recallsBySource, recallSince, emittedRecalled, emittedTotal: emittedIds.length, emittedStaleUnused, topRecalled };
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

// ─── Rendering ───────────────────────────────────────────────────────────

function countLine(counts: Record<string, number>): string {
	const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
	return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(" · ") : "none";
}

function pct(n: number, d: number): string {
	return d > 0 ? `${Math.round((100 * n) / d)}%` : "—";
}

function fmtTs(ts: string | null): string {
	return ts ? ts.slice(0, 16).replace("T", " ") : "—";
}

export function renderMarkdown(report: Report): string {
	const { ttsr, router, curator, memory } = report;
	const lines: string[] = [];
	lines.push(`# Decision outcome report — last ${report.days} days`);
	lines.push("");
	lines.push(`Generated ${report.generatedAt} · window start ${report.since}`);
	lines.push(`Sources: ${TTSR_FILE} · ${ROUTER_FILE} · ${CURATOR_FILE} · ${MEMORY_FILE}`);
	lines.push(
		`Telemetry coverage: ttsr fires since ${fmtTs(ttsr.telemetrySince)} · router routes since ${fmtTs(router.telemetrySince)} · curator recalls since ${fmtTs(curator.recallSince)}`,
	);
	lines.push("");

	lines.push("## TTSR");
	lines.push("");
	lines.push(`- Gate evaluations: ${ttsr.evals} (${ttsr.suppressed} suppressed, ${ttsr.gateFired} fired)`);
	lines.push(`- Fire events: ${ttsr.fires} logged, ${ttsr.delivered} delivered to the model`);
	lines.push("");
	if (ttsr.rules.length) {
		lines.push("| rule | evals | delivered fires | survived | retried | repeated | corrected | unresolved | adverse rate |");
		lines.push("|---|---|---|---|---|---|---|---|---|");
		for (const r of ttsr.rules) {
			const o = r.outcomes;
			lines.push(
				`| ${r.rule} | ${r.evals} | ${r.delivered} | ${o.survived ?? 0} | ${o.retried ?? 0} | ${o.repeated ?? 0} | ${o.user_corrected ?? 0} | ${o.unresolved ?? 0} | ${pct(r.adverse, r.resolved)} |`,
			);
		}
	} else {
		lines.push("_No TTSR fire records in window._");
	}
	lines.push("");
	if (ttsr.prune.length) {
		lines.push(`- Prune candidates (≥${ZERO_FIRE_MIN_EVALS} evals, never delivered): ${ttsr.prune.map((r) => r.rule).join(", ")}`);
	}
	if (ttsr.adverse.length) {
		lines.push(
			`- Revisit wording (adverse ≥${Math.round(ADVERSE_RATE_FLAG * 100)}% of resolved): ${ttsr.adverse.map((r) => `${r.rule} (${pct(r.adverse, r.resolved)})`).join(", ")}`,
		);
	}
	lines.push("");

	lines.push("## Router");
	lines.push("");
	lines.push(`- Routes: ${router.routes} (${router.acted} acted) · telemetry-era: ${router.telemetryRoutes} (${router.telemetryActed} acted) · acted tiers: ${countLine(router.telemetryActedTiers)}`);
	const legacyRoutes = router.routes - router.telemetryRoutes;
	lines.push(
		`- Outcome events: ${countLine(router.outcomes)}${legacyRoutes > 0 ? ` · ${legacyRoutes} legacy route(s) predate telemetry and cannot be joined` : ""}`,
	);
	if (router.actedTestFailures) lines.push(`- Flag: ${router.actedTestFailures} acted route(s) followed by failing tests`);
	lines.push("");

	lines.push("## Curator");
	lines.push("");
	lines.push(`- Shadow verdicts: ${countLine(curator.verdicts)}`);
	lines.push(`- Emits: ${countLine(curator.emits)} · evidence-skips: ${curator.skips}`);
	lines.push(`- useExtract verdicts without an emission: ${curator.useExtractWithoutEmit}`);
	lines.push(`- Recalls: ${curator.recalls} (${countLine(curator.recallsBySource)})${curator.recalls === 0 ? " — recall logging is new; earlier recalls left no record" : ` · since ${fmtTs(curator.recallSince)}`}`);
	lines.push(`- Emitted-and-recalled: ${curator.emittedRecalled}/${curator.emittedTotal}`);
	if (curator.topRecalled.length) lines.push(`- Top recalled: ${curator.topRecalled.map((r) => `${r.entryId} (${r.count})`).join(", ")}`);
	lines.push(`- Emitted >3d ago, never recalled: ${curator.emittedStaleUnused}`);
	lines.push("");

	lines.push("## Memory pipeline");
	lines.push("");
	lines.push(`- Decisions: ${countLine(memory.decisions)}`);
	lines.push(`- Corrections: ${countLine(memory.corrections)}`);
	lines.push(`- Consolidation: ${countLine(memory.consolidation)}`);
	lines.push("");
	return lines.join("\n");
}

export function renderSummary(report: Report): string {
	const { ttsr, router, curator } = report;
	const adverse = ttsr.rules.reduce((n, r) => n + r.adverse, 0);
	const resolved = ttsr.rules.reduce((n, r) => n + r.resolved, 0);
	return [
		`Decisions (last ${report.days}d):`,
		`  ttsr: ${ttsr.delivered} delivered fires, adverse ${adverse}/${resolved} resolved`,
		`  router: ${router.telemetryActed}/${router.telemetryRoutes} acted since telemetry (${router.acted}/${router.routes} all-time), outcomes ${countLine(router.outcomes)}`,
		`  curator: ${curator.emittedTotal} emits, ${curator.recalls} recalls, ${curator.emittedStaleUnused} stale-unused`,
	].join("\n");
}

// ─── Command ─────────────────────────────────────────────────────────────

export function collectReport(days: number, sinceMs: number): Report {
	return {
		days,
		generatedAt: new Date().toISOString(),
		since: new Date(sinceMs).toISOString(),
		ttsr: analyzeTtsr(readDecisionLines(TTSR_FILE), sinceMs),
		router: analyzeRouter(readDecisionLines(ROUTER_FILE), sinceMs),
		curator: analyzeCurator(readDecisionLines(CURATOR_FILE), sinceMs),
		memory: analyzeMemory(readDecisionLines(MEMORY_FILE), sinceMs),
	};
}

export default function decisionsReportExtension(pi: ExtensionAPI) {
	pi.registerCommand("decisions-report", {
		description: "Join decision logs to outcomes (TTSR fires, router tiers, curator emits→recall). Usage: /decisions-report [days]",
		handler: async (args, ctx) => {
			const parsed = Number(args.trim());
			const days = Number.isFinite(parsed) && parsed > 0 ? Math.min(365, Math.max(1, Math.floor(parsed))) : 7;
			const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
			const report = collectReport(days, sinceMs);
			const markdown = renderMarkdown(report);
			let outPath = "";
			try {
				const dir = join(DECISIONS_DIR, "reports");
				mkdirSync(dir, { recursive: true });
				outPath = join(dir, `decisions-${new Date().toISOString().slice(0, 10)}.md`);
				writeFileSync(outPath, markdown + "\n");
			} catch (err) {
				ctx.ui.notify(`decisions-report: write failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
			ctx.ui.notify(renderSummary(report) + (outPath ? `\n\nFull report: ${outPath}` : ""), "info");
		},
	});
}

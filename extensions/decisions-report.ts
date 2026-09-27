/**
 * /decisions-report — joins the decision logs to their outcome records.
 *
 * Analysis and discovery live in utils/decision-analysis.ts; every *.jsonl
 * log under jev-decisions/ appears in the "Systems" table automatically, so a
 * new extension only needs to log decisions/outcomes via utils/jev-outcomes.ts.
 *
 * Usage: /decisions-report [days]   (default 7; writes a markdown file under
 * jev-decisions/reports and notifies a summary).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectReport, type Report, type SystemAnalysis } from "../utils/decision-analysis.ts";
import { DECISIONS_DIR } from "../utils/jev-outcomes.ts";

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

function systemsTable(systems: SystemAnalysis[]): string[] {
	const visible = systems.filter((s) => s.decisions + s.outcomes + s.untyped > 0);
	if (visible.length === 0) return ["_No decision logs in window._", ""];
	const lines: string[] = [];
	lines.push("| system | log | decisions | outcomes | events | joined | good | bad | stale >24h | untyped | notes |");
	lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
	for (const s of visible) {
		lines.push(
			`| ${s.system} | ${s.files.join(", ")} | ${s.decisions} | ${s.outcomes} | ${s.events} | ${s.joined} | ${s.verdicts.good ?? 0} | ${s.verdicts.bad ?? 0} | ${s.unresolvedDecisions} | ${s.untyped} | ${s.attention.join("; ")} |`,
		);
	}
	lines.push("");
	return lines;
}

export function renderMarkdown(report: Report): string {
	const { ttsr, router, curator, memory } = report;
	const lines: string[] = [];
	lines.push(`# Decision outcome report — last ${report.days} days`);
	lines.push("");
	lines.push(`Generated ${report.generatedAt} · window start ${report.since}`);
	lines.push(`Sources: every *.jsonl under ${DECISIONS_DIR}`);
	lines.push(
		`Telemetry coverage: ttsr fires since ${fmtTs(ttsr.telemetrySince)} · router routes since ${fmtTs(router.telemetrySince)} · curator recalls since ${fmtTs(curator.recallSince)}`,
	);
	lines.push("");

	lines.push("## Systems (auto-discovered)");
	lines.push("");
	lines.push(...systemsTable(report.systems));

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
		lines.push(`- Prune candidates (≥20 evals, never delivered): ${ttsr.prune.map((r) => r.rule).join(", ")}`);
	}
	if (ttsr.adverse.length) {
		lines.push(
			`- Revisit wording (adverse ≥${Math.round(0.5 * 100)}% of resolved): ${ttsr.adverse.map((r) => `${r.rule} (${pct(r.adverse, r.resolved)})`).join(", ")}`,
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
	lines.push(`- Recalls: ${curator.recalls} (${countLine(curator.recallsBySource)}) · finds: ${curator.finds}${curator.recalls === 0 ? " — recall logging is new; earlier recalls left no record" : ` · since ${fmtTs(curator.recallSince)}`}`);
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
		`  systems: ${report.systems.length} log(s) discovered`,
	].join("\n");
}

export function writeReportFile(markdown: string): string {
	const dir = join(DECISIONS_DIR, "reports");
	mkdirSync(dir, { recursive: true });
	const outPath = join(dir, `decisions-${new Date().toISOString().slice(0, 10)}.md`);
	writeFileSync(outPath, markdown + "\n");
	return outPath;
}

export default function decisionsReportExtension(pi: ExtensionAPI) {
	pi.registerCommand("decisions-report", {
		description: "Join decision logs to outcomes (TTSR fires, router tiers, curator emits→recall, plus any auto-discovered system log). Usage: /decisions-report [days]",
		handler: async (args, ctx) => {
			const parsed = Number(args.trim());
			const days = Number.isFinite(parsed) && parsed > 0 ? Math.min(365, Math.max(1, Math.floor(parsed))) : 7;
			const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
			const report = collectReport(days, sinceMs);
			const markdown = renderMarkdown(report);
			let outPath = "";
			try {
				outPath = writeReportFile(markdown);
			} catch (err) {
				ctx.ui.notify(`decisions-report: write failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
			ctx.ui.notify(renderSummary(report) + (outPath ? `\n\nFull report: ${outPath}` : ""), "info");
		},
	});
}

/**
 * /setup → Decisions: run the report, see tuner state, and apply/dismiss open
 * proposals without remembering the slash commands.
 *
 * Contributed via the directory convention (decision-tuner/setup.ts); /setup
 * auto-discovers it. Every action row re-reads its own state on render, so the
 * right column confirms what happened even though the shared window's status
 * line is too narrow to show the action flash.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SetupItem, SetupSection } from "../setup/types.ts";
import { applyProposal, dismissProposal, markAction, readProposals, readState, runTuner } from "./index.ts";
import { collectReport } from "../../utils/decision-analysis.ts";
import { renderMarkdown, writeReportFile } from "../decisions-report.ts";
import { DECISIONS_DIR } from "../../utils/jev-outcomes.ts";

const ENABLED = process.env.DECISION_TUNER !== "0";

function newestReport(): { day: string; mtime: number } | null {
	try {
		const dir = join(DECISIONS_DIR, "reports");
		const files = readdirSync(dir)
			.filter((f) => f.startsWith("decisions-") && f.endsWith(".md"))
			.sort();
		const latest = files[files.length - 1];
		if (!latest) return null;
		return { day: latest.slice("decisions-".length, -3), mtime: statSync(join(dir, latest)).mtimeMs };
	} catch {
		return null;
	}
}

function proposalStatus(id: string): string {
	return readProposals().find((p) => p.id === id)?.status ?? "open";
}

function liveOpenCount(): number {
	return readProposals().filter((p) => p.status === "open").length;
}

function timeOfIso(iso: string | undefined): string {
	return iso ? iso.slice(11, 19) : "never";
}

function lastActionResult(kind: "report" | "tuner"): string | null {
	const state = readState();
	return state.lastAction?.kind === kind ? timeOfIso(state.lastAction.at) : null;
}

export default function decisionTunerSetup(): SetupSection {
	const open = readProposals().filter((p) => p.status === "open");
	const items: SetupItem[] = [
		{
			id: "decisions:report",
			label: "Decision report",
			detail:
				"Join every discovered decision log to its outcome records (TTSR fires, router routes, curator emits→recall) and flag prune/reword candidates, failing-test routes, and unused extracts.",
			effect: "immediately",
			owner: "decisions-report · /decisions-report",
			kind: "action",
			get: () => {
				const confirmed = lastActionResult("report");
				if (confirmed) return `✓ regenerated ${confirmed}`;
				const report = newestReport();
				return report ? `generated ${report.day} ${timeOfIso(new Date(report.mtime).toISOString())} · enter: regenerate` : "enter: generate";
			},
			run: () => {
				const report = collectReport(7, Date.now() - 7 * 24 * 60 * 60 * 1000);
				const path = writeReportFile(renderMarkdown(report));
				markAction("report");
				return `report written: ${path}`;
			},
		},
		{
			id: "decisions:tuner",
			label: "Decision tuner",
			detail:
				"Outcome-driven tuning with sample gates: proposes pruning rules that never deliver, plus advisory reword/router/curator flags. Runs automatically when stale; proposals below are applied only when you choose.",
			effect: "immediately",
			owner: "decision-tuner · /decision-tuner",
			kind: "action",
			get: () => {
				const confirmed = lastActionResult("tuner");
				const state = readState();
				return confirmed
					? `✓ ran ${confirmed} · ${liveOpenCount()} open`
					: `${ENABLED ? "on" : "off"} · ran ${timeOfIso(state.lastRun)} · ${liveOpenCount()} open · enter: run`;
			},
			run: (ctx) => {
				if (!ENABLED) return "✗ disabled (DECISION_TUNER=0)";
				const run = runTuner(ctx.cwd);
				markAction("tuner");
				return run.proposals.length ? `${run.proposals.length} new proposal(s) — reopen /setup to see them` : "no new proposals";
			},
		},
	];

	for (const p of open) {
		const evidence = `[${p.kind}] ${p.evidence}${p.file ? ` — ${p.file}` : ""}`;
		if (p.kind === "prune") {
			items.push({
				id: `decisions:apply:${p.id}`,
				label: `Disable rule: ${p.target}`,
				detail: `${evidence}\nRenames the rule file to <name>.md.disabled — reversible, never deletes. Run /ttsr-reload to apply now.`,
				owner: "decision-tuner · /decision-tuner apply",
				kind: "action",
				get: () => (proposalStatus(p.id) === "applied" ? "✓ disabled" : "enter: disable"),
				run: () => applyProposal(p.id),
			});
		}
		items.push({
			id: `decisions:dismiss:${p.id}`,
			label: `Dismiss: ${p.target}`,
			detail: `${evidence}\nHides this proposal; it will not be re-proposed for 30 days.`,
			owner: "decision-tuner · /decision-tuner dismiss",
			kind: "action",
			get: () => {
				const status = proposalStatus(p.id);
				return status === "open" ? "enter: dismiss" : `✓ ${status === "applied" ? "disabled" : "dismissed"}`;
			},
			run: () => {
				const status = proposalStatus(p.id);
				return status === "open" ? dismissProposal(p.id) : `Proposal already ${status}`;
			},
		});
	}
	if (open.length === 0) {
		items.push({
			id: "decisions:none",
			label: "No open proposals",
			detail: "The tuner runs automatically when stale — use Run above to force a fresh analysis now.",
			kind: "info",
			get: () => "—",
		});
	}

	return {
		id: "decisions",
		title: "Decisions",
		detail: "Decision-outcome telemetry: weekly report, tuner state, and open proposals.",
		items,
	};
}

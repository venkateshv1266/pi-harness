/**
 * /decision-tuner — harness tuning from decision-outcome telemetry.
 *
 * Phase 0: runs on session_start when the last run is stale (default 7 days),
 * regenerates the decisions report, and notifies only when there is something
 * to look at.
 *
 * Phase 1: deterministic proposals with sample gates. `prune` proposals come
 * from the analysis' prune set (many evaluations, never a delivered fire), are
 * skipped for rules marked `safety: true` in frontmatter or listed in
 * config.json neverPrune, and are applied only on explicit request — apply
 * renames the rule file to <name>.md.disabled, never deletes. `reword` /
 * `config` flags are advisory: the tuner shows evidence, a human decides.
 *
 * DECISION_TUNER=0 disables; DECISION_TUNER_DAYS overrides the interval.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { collectReport, type Report } from "../utils/decision-analysis.ts";
import { newId } from "../utils/jev-outcomes.ts";
import { renderMarkdown, renderSummary, writeReportFile } from "./decisions-report.ts";

const TUNER_DIR = join(homedir(), ".pi", "agent", "decision-tuner");
const STATE_FILE = join(TUNER_DIR, "state.json");
const PROPOSALS_FILE = join(TUNER_DIR, "proposals.jsonl");
const AUDIT_FILE = join(TUNER_DIR, "tuner.jsonl");
const CONFIG_FILE = join(TUNER_DIR, "config.json");

const ENABLED = process.env.DECISION_TUNER !== "0";
const INTERVAL_DAYS = Math.max(1, Number(process.env.DECISION_TUNER_DAYS ?? "7") || 7);
const DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export interface Proposal {
	id: string;
	kind: "prune" | "reword" | "config" | "instrument";
	system: string;
	target: string;
	file?: string;
	evidence: string;
	createdAt: string;
	status: "open" | "applied" | "dismissed";
	decidedAt?: string;
}

interface TunerConfig {
	neverPrune?: string[];
}

interface TunerState {
	lastRun?: string;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

function readConfig(): TunerConfig {
	return readJson<TunerConfig>(CONFIG_FILE) ?? {};
}

function readState(): TunerState {
	return readJson<TunerState>(STATE_FILE) ?? {};
}

function writeState(state: TunerState) {
	mkdirSync(TUNER_DIR, { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function appendTunerAudit(record: Record<string, unknown>) {
	try {
		mkdirSync(TUNER_DIR, { recursive: true });
		appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
	} catch (err) {
		process.stderr.write(`[decision-tuner] audit write failed: ${errorMessage(err)}\n`);
	}
}

export function readProposals(): Proposal[] {
	try {
		return readFileSync(PROPOSALS_FILE, "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as Proposal];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

function writeProposals(list: Proposal[]) {
	mkdirSync(TUNER_DIR, { recursive: true });
	writeFileSync(PROPOSALS_FILE, list.map((p) => JSON.stringify(p)).join("\n") + (list.length ? "\n" : ""));
}

// ─── Rule lookup + safety exemption ──────────────────────────────────────

function ruleDirs(cwd: string): string[] {
	// project rules win over user rules, matching TTSR load order
	return [
		join(cwd, ".pi", "rules"),
		join(cwd, ".omp", "rules"),
		join(homedir(), ".pi", "agent", "rules"),
		join(homedir(), ".omp", "agent", "rules"),
	];
}

function frontmatterField(file: string, field: string): string | null {
	try {
		const raw = readFileSync(file, "utf8");
		const block = raw.match(/^---\n([\s\S]*?)\n---/);
		if (!block) return null;
		const line = block[1].split("\n").find((l) => l.trimStart().startsWith(`${field}:`));
		return line ? line.slice(line.indexOf(":") + 1).trim() : null;
	} catch {
		return null;
	}
}

export function findRuleFile(name: string, cwd: string): string | null {
	for (const dir of ruleDirs(cwd)) {
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".md"));
		} catch {
			continue;
		}
		for (const file of files) {
			const full = join(dir, file);
			if (basename(file, ".md") === name) return full;
			if (frontmatterField(full, "name") === name) return full;
		}
	}
	return null;
}

export function isSafetyRule(file: string, name: string): boolean {
	if (frontmatterField(file, "safety") === "true") return true;
	return (readConfig().neverPrune ?? []).includes(name);
}

// ─── Proposal generation ─────────────────────────────────────────────────

function makeProposal(
	existing: Proposal[],
	kind: Proposal["kind"],
	system: string,
	target: string,
	file: string | undefined,
	evidence: string,
): Proposal | null {
	const prior = existing.find((p) => p.kind === kind && p.system === system && p.target === target);
	if (prior) {
		if (prior.status === "open" || prior.status === "applied") return null;
		if (Date.parse(prior.createdAt) > Date.now() - DISMISS_COOLDOWN_MS) return null;
	}
	return { id: newId(), kind, system, target, file, evidence, createdAt: new Date().toISOString(), status: "open" };
}

export function collectProposals(report: Report, cwd: string, existing: Proposal[] = readProposals()): Proposal[] {
	const out: Proposal[] = [];
	const add = (kind: Proposal["kind"], system: string, target: string, file: string | undefined, evidence: string) => {
		const p = makeProposal(existing, kind, system, target, file, evidence);
		if (p) out.push(p);
	};
	for (const rule of report.ttsr.prune) {
		const file = findRuleFile(rule.rule, cwd);
		if (!file || isSafetyRule(file, rule.rule)) continue;
		add("prune", "ttsr", rule.rule, file, `${rule.evals} evaluations, 0 delivered fires`);
	}
	for (const rule of report.ttsr.adverse) {
		const rate = rule.adverseRate === null ? "n/a" : `${Math.round(rule.adverseRate * 100)}%`;
		add("reword", "ttsr", rule.rule, findRuleFile(rule.rule, cwd) ?? undefined, `${rule.adverse}/${rule.resolved} resolved outcomes adverse (${rate})`);
	}
	if (report.router.actedTestFailures > 0) {
		add("config", "router", "tier-map", undefined, `${report.router.actedTestFailures} acted route(s) followed by failing tests`);
	}
	if (report.curator.useExtractWithoutEmit > 0) {
		add("config", "curator", "extract-guard", undefined, `${report.curator.useExtractWithoutEmit} useExtract verdict(s) without an emission`);
	}
	if (report.curator.emittedStaleUnused > 0) {
		add("config", "curator", "extract-policy", undefined, `${report.curator.emittedStaleUnused} emitted extract(s) >3d never recalled`);
	}
	return out;
}

// ─── Run + apply ─────────────────────────────────────────────────────────

export interface TunerRun {
	report: Report;
	proposals: Proposal[];
	reportPath: string;
	summary: string;
}

export function runTuner(cwd: string): TunerRun {
	const days = INTERVAL_DAYS;
	const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
	const report = collectReport(days, sinceMs);
	const existing = readProposals();
	const fresh = collectProposals(report, cwd, existing);
	if (fresh.length) writeProposals([...existing, ...fresh]);
	const reportPath = writeReportFile(renderMarkdown(report));
	writeState({ lastRun: new Date().toISOString() });
	appendTunerAudit({ event: "run", days, proposals: fresh.map((p) => `${p.kind}:${p.target}`) });
	const open = [...existing, ...fresh].filter((p) => p.status === "open").length;
	const summary = [
		renderSummary(report),
		fresh.length ? `Tuner: ${fresh.length} new proposal(s), ${open} open — /decision-tuner list` : `Tuner: no new proposals, ${open} open`,
	].join("\n");
	return { report, proposals: fresh, reportPath, summary };
}

export function applyProposal(id: string): string {
	const list = readProposals();
	const p = list.find((x) => x.id === id);
	if (!p) return `No proposal ${id}`;
	if (p.status !== "open") return `Proposal ${id} is already ${p.status}`;
	if (p.kind !== "prune") return `Proposal ${id} is advisory (${p.kind}) — nothing is applied automatically. Evidence: ${p.evidence}`;
	if (!p.file || !existsSync(p.file)) return `Rule file missing for ${p.target}: ${p.file ?? "(none)"}`;
	renameSync(p.file, `${p.file}.disabled`);
	p.status = "applied";
	p.decidedAt = new Date().toISOString();
	writeProposals(list);
	appendTunerAudit({ event: "apply", id, target: p.target, file: p.file });
	return `Disabled ${p.target}: ${p.file} → ${p.file}.disabled (rename back to re-enable; /ttsr-reload to apply now)`;
}

export function dismissProposal(id: string): string {
	const list = readProposals();
	const p = list.find((x) => x.id === id);
	if (!p) return `No proposal ${id}`;
	if (p.status !== "open") return `Proposal ${id} is already ${p.status}`;
	p.status = "dismissed";
	p.decidedAt = new Date().toISOString();
	writeProposals(list);
	appendTunerAudit({ event: "dismiss", id, target: p.target });
	return `Dismissed ${p.target} (won't be proposed again for 30 days)`;
}

// ─── Extension ───────────────────────────────────────────────────────────

export default function decisionTunerExtension(pi: ExtensionAPI) {
	pi.registerCommand("decision-tuner", {
		description: "Tune the harness from decision outcomes: /decision-tuner [status|run|list|apply <id>|dismiss <id>]",
		handler: async (args, ctx) => {
			const [sub = "status", arg] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "run") {
				if (!ENABLED) {
					ctx.ui.notify("decision-tuner disabled (DECISION_TUNER=0)", "warning");
					return;
				}
				try {
					const run = runTuner(ctx.cwd);
					ctx.ui.notify(`${run.summary}\nReport: ${run.reportPath}`, "info");
				} catch (err) {
					ctx.ui.notify(`decision-tuner run failed: ${errorMessage(err)}`, "error");
				}
				return;
			}
			if (sub === "list") {
				const open = readProposals().filter((p) => p.status === "open");
				if (open.length === 0) {
					ctx.ui.notify("decision-tuner: no open proposals", "info");
					return;
				}
				ctx.ui.notify(
					open
						.map((p) => `${p.id}  [${p.kind}] ${p.system}/${p.target}\n    ${p.evidence}${p.file ? `\n    ${p.file}` : ""}`)
						.join("\n"),
					"info",
				);
				return;
			}
			if (sub === "apply" || sub === "dismiss") {
				if (!arg) {
					ctx.ui.notify(`Usage: /decision-tuner ${sub} <id>`, "warning");
					return;
				}
				ctx.ui.notify(sub === "apply" ? applyProposal(arg) : dismissProposal(arg), "info");
				return;
			}
			const state = readState();
			const proposals = readProposals();
			const open = proposals.filter((p) => p.status === "open").length;
			ctx.ui.notify(
				[
					`decision-tuner: ${ENABLED ? "enabled" : "disabled (DECISION_TUNER=0)"} · interval ${INTERVAL_DAYS}d`,
					`last run: ${state.lastRun ?? "never"}`,
					`proposals: ${open} open, ${proposals.length} total`,
					`state: ${TUNER_DIR}`,
					`config (neverPrune): ${CONFIG_FILE}`,
				].join("\n"),
				"info",
			);
		},
	});

	// Weekly auto-run: regenerates the report; only notifies when there is
	// something to look at.
	pi.on("session_start", async (_event, ctx) => {
		if (!ENABLED) return;
		const lastRun = Date.parse(readState().lastRun ?? "") || 0;
		if (Date.now() - lastRun < INTERVAL_DAYS * 24 * 60 * 60 * 1000) return;
		try {
			const run = runTuner(ctx.cwd);
			if (run.proposals.length > 0 && ctx.hasUI) ctx.ui.notify(run.summary, "info");
		} catch (err) {
			process.stderr.write(`[decision-tuner] auto-run failed: ${errorMessage(err)}\n`);
		}
	});
}

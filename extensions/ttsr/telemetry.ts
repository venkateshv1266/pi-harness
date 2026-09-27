/**
 * Context-registry telemetry: aggregate gate decisions + outcomes per entry
 * from ~/.pi/agent/jev-decisions/ttsr-jev.jsonl.
 *
 * Shared by the `/contexts` command, the `/setup` → Context registry section,
 * and the context-registry-audit skill. Dependency-free except node builtins +
 * the LoadedEntry type, so it is unit-testable standalone.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadedEntry } from "./registry.ts";

export interface CtxStat {
	fired: number;
	suppressed: number;
	adverse: number;
	good: number;
	lastTs: string;
}

export interface PruneCandidate {
	entry: LoadedEntry;
	reasons: string[];
}

export function statsFile(): string {
	return process.env.TTSR_CONTEXT_STATS_FILE ?? path.join(os.homedir(), ".pi", "agent", "jev-decisions", "ttsr-jev.jsonl");
}

export function contextStats(file: string = statsFile()): Map<string, CtxStat> {
	const out = new Map<string, CtxStat>();
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return out;
	}
	for (const line of raw.split("\n")) {
		if (!line) continue;
		let j: { kind?: string; ts?: string; rule?: string; decision?: string; verdict?: string; detail?: { rule?: string } };
		try { j = JSON.parse(line) as typeof j; } catch { continue; }
		const rule = j.rule ?? j.detail?.rule;
		if (!rule || !(rule.startsWith("ctx-") || rule.startsWith("ctxdelegate-"))) continue;
		const s = out.get(rule) ?? { fired: 0, suppressed: 0, adverse: 0, good: 0, lastTs: "" };
		// Gate verdict lines (logAdjudication) carry `decision` but no `kind`;
		// delivery records carry kind:"decision" but no `decision` field —
		// counting both would double-count fires.
		if (j.decision === "fired") s.fired++;
		else if (j.decision === "suppressed") s.suppressed++;
		if (j.kind === "outcome") {
			if (j.verdict === "bad") s.adverse++;
			else if (j.verdict === "good") s.good++;
		}
		if (j.ts) s.lastTs = j.ts;
		out.set(rule, s);
	}
	return out;
}

/** Merge the trigger rule + delegate rule stats for one entry. */
export function statsFor(entry: LoadedEntry, stats: Map<string, CtxStat>): CtxStat {
	const t = stats.get(`ctx-${entry.id}`);
	const d = stats.get(`ctxdelegate-${entry.id}`);
	return {
		fired: (t?.fired ?? 0) + (d?.fired ?? 0),
		suppressed: (t?.suppressed ?? 0) + (d?.suppressed ?? 0),
		adverse: (t?.adverse ?? 0) + (d?.adverse ?? 0),
		good: (t?.good ?? 0) + (d?.good ?? 0),
		lastTs: [t?.lastTs, d?.lastTs].filter(Boolean).sort().pop() ?? "",
	};
}

export function pruneCandidates(entries: LoadedEntry[], stats: Map<string, CtxStat>): PruneCandidate[] {
	const out: PruneCandidate[] = [];
	for (const entry of entries) {
		if (entry.status === "retired") continue;
		const t = statsFor(entry, stats);
		const reasons: string[] = [];
		if (t.fired === 0 && t.suppressed >= 5) reasons.push("trigger fires but the gate always declines");
		if (t.fired > 0 && t.suppressed > 4 * t.fired) reasons.push(`gate suppresses most matches (${t.suppressed} suppressed vs ${t.fired} fired)`);
		if (t.adverse > t.good + 2) reasons.push(`adverse outcomes (${t.adverse} bad vs ${t.good} good)`);
		if (reasons.length) out.push({ entry, reasons });
	}
	return out;
}

export function entryStatLine(entry: LoadedEntry, t: CtxStat): string {
	const flags = [entry.status === "retired" ? "retired" : null, entry.subagents ? "subagents" : null].filter(Boolean).join(",");
	return `  ${entry.id.padEnd(24)} tier=${entry.tier.padEnd(10)} docs=${entry.resolvedReads.length} fired=${t.fired} suppressed=${t.suppressed}${flags ? ` [${flags}]` : ""}`;
}

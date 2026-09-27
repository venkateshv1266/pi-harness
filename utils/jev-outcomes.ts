/**
 * Shared primitives for decision-outcome telemetry.
 *
 * Every extension that makes non-trivial decisions (a rule intervened, a model
 * was routed, context was condensed, a memory write was gated) can log them to
 * its own file under ~/.pi/agent/jev-decisions/. The reports and the tuner
 * auto-discover those files, so a new system needs no changes anywhere else.
 *
 * Contract — three record kinds, one file per system:
 *
 *   logDecision(system, file, payload)              // what was decided
 *     -> { kind:"decision", system, id, ts, ...payload }
 *
 *   logOutcome(system, file, ref, outcome, {verdict, detail})
 *     -> { kind:"outcome", system, ref, outcome, verdict, ts, ...detail }
 *
 *   logEvent(system, file, payload)                 // context, not a decision
 *     -> { kind:"event", system, ts, ...payload }
 *
 * `ref` joins an outcome to the decision `id` it resolves. `verdict` is the
 * universal "was this decision right" answer — good / bad / mixed / unknown —
 * while `outcome` stays domain-specific (retried, tests_failed, recalled, …).
 * A decision with no outcome record is reported as unresolved once it ages.
 *
 * Reserved keys (the envelope + generic analysis): kind, system, id, ref,
 * outcome, verdict, ts. Keep them out of domain payloads.
 *
 * Telemetry is advisory: a failed write is reported on stderr and otherwise
 * ignored, never propagated into the host flow.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DECISIONS_DIR = join(homedir(), ".pi", "agent", "jev-decisions");

export type Verdict = "good" | "bad" | "mixed" | "unknown";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function newId(): string {
	return randomUUID().slice(0, 8);
}

export function appendDecision(file: string, record: Record<string, unknown>): void {
	try {
		mkdirSync(DECISIONS_DIR, { recursive: true });
		appendFileSync(join(DECISIONS_DIR, file), JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
	} catch (err) {
		process.stderr.write(`[jev-outcomes] append ${file} failed: ${errorMessage(err)}\n`);
	}
}

/** Log a decision; returns its id for later logOutcome refs. */
export function logDecision(system: string, file: string, payload: Record<string, unknown> = {}): string {
	const id = typeof payload.id === "string" ? payload.id : newId();
	appendDecision(file, { kind: "decision", system, ...payload, id });
	return id;
}

/** Resolve a decision with how it turned out. */
export function logOutcome(
	system: string,
	file: string,
	ref: string,
	outcome: string,
	opts: { verdict?: Verdict; detail?: Record<string, unknown> } = {},
): void {
	appendDecision(file, { kind: "outcome", system, ref, outcome, verdict: opts.verdict ?? "unknown", ...opts.detail });
}

/** Log context around decisions (inputs, attempts) that is not itself a decision. */
export function logEvent(system: string, file: string, payload: Record<string, unknown> = {}): void {
	appendDecision(file, { kind: "event", system, ...payload });
}

export function readDecisionLines(file: string): Record<string, unknown>[] {
	const full = join(DECISIONS_DIR, file);
	if (!existsSync(full)) return [];
	let text: string;
	try {
		text = readFileSync(full, "utf8");
	} catch (err) {
		process.stderr.write(`[jev-outcomes] read ${file} failed: ${errorMessage(err)}\n`);
		return [];
	}
	const out: Record<string, unknown>[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			out.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			continue;
		}
	}
	return out;
}

export function parseTs(value: unknown): number {
	return typeof value === "string" ? Date.parse(value) || 0 : 0;
}

// ─── Correction heuristic ────────────────────────────────────────────────
// Deterministic first pass of the jev-memory correction detector: strong
// patterns always fire, weak patterns need a directive, negatives suppress.

const CORRECTION_STRONG: RegExp[] = [
	/don'?t do that/i,
	/not like that/i,
	/^I said\b/i,
	/^I told you\b/i,
	/we already discussed/i,
	/^please don'?t/i,
	/^that'?s not what I/i,
];

const CORRECTION_WEAK: RegExp[] = [
	/^no[,\.\s!]/i,
	/^wrong[,\.\s!]/i,
	/^actually[,\.\s]/i,
	/^stop[,\.\s!]/i,
];

const CORRECTION_NEGATIVE: RegExp[] = [
	/^no worries/i,
	/^no problem/i,
	/^no thanks/i,
	/^no need/i,
	/^actually.{0,10}(looks? great|perfect|good|correct|right)/i,
	/^stop.{0,5}(there|here|for now)/i,
];

const CORRECTION_DIRECTIVES: RegExp =
	/\b(use|don't|dont|do|try|make|run|install|add|remove|delete|change|fix|put|set|write|go|stop|start|the|that|this|it)\b/i;

export function looksLikeUserCorrection(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed || trimmed.startsWith("/")) return false;
	if (CORRECTION_NEGATIVE.some((re) => re.test(trimmed))) return false;
	if (CORRECTION_STRONG.some((re) => re.test(trimmed))) return true;
	for (const re of CORRECTION_WEAK) {
		const match = re.exec(trimmed);
		if (match && match.index === 0) {
			const remainder = trimmed.slice(match[0].length).trim();
			if (CORRECTION_DIRECTIVES.test(remainder)) return true;
		}
	}
	return false;
}

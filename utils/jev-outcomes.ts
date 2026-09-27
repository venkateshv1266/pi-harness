/**
 * Shared primitives for decision-outcome telemetry.
 *
 * The Jev decision layer (ttsr, model-router, jev-context-curator, jev-memory)
 * logs its decisions to ~/.pi/agent/jev-decisions/*.jsonl. These helpers let
 * each layer also log whether a decision helped, into the same per-system
 * files, so /decisions-report can join decisions to outcomes.
 *
 * Telemetry is advisory: a failed write is reported on stderr and otherwise
 * ignored, never propagated into the host flow.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DECISIONS_DIR = join(homedir(), ".pi", "agent", "jev-decisions");

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

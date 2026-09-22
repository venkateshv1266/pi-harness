import type { MemoryStore } from "../store/memory-store.js";
import { normalizeMemoryLookupText } from "../store/memory-lookup.js";
import type { ChoiceAnswer, JevAnswers, NoulAnswer } from "./client.js";
import type { JevConfig } from "./config.js";
import { admissionScore } from "./scoring.js";

/** Wall-clock slack for a single gate call budget. The budget only gates call
 * start (immediate); the fetch inside jevCall applies its own timeout. */
export const GATE_CALL_DEADLINE_MS = 5000;

export interface AdmissionState {
	content: string;
	exact_duplicate: boolean;
	candidates: string[];
	[key: string]: unknown;
}

export interface AdmissionGateResult {
	verdict: "allow" | "block" | "pass-through";
	reason?: string;
	scores?: Record<string, number>;
	score?: number;
}

function noulValue(answer: unknown): number | undefined {
	if (typeof answer === "number") return answer;
	const noul = (answer as NoulAnswer | undefined)?.noul;
	return typeof noul === "number" ? noul : undefined;
}

/** Same store accessors matchingMutationTargets uses, per target scope. */
export function scopeEntriesForTarget(
	rawTarget: "memory" | "user" | "project" | "failure",
	store: MemoryStore,
	projectStore: MemoryStore | null,
): string[] {
	if (rawTarget === "failure") return store.getAllFailureEntries();
	if (rawTarget === "user") return store.getUserEntries();
	if (rawTarget === "project") return projectStore?.getMemoryEntries() ?? [];
	return store.getMemoryEntries();
}

export function isExactDuplicate(content: string, entries: string[]): boolean {
	const normalized = normalizeMemoryLookupText(content);
	if (!normalized) return false;
	return entries.some((entry) => normalizeMemoryLookupText(entry) === normalized);
}

function lookupTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const token of normalizeMemoryLookupText(text).toLowerCase().split(/[^a-z0-9]+/)) {
		if (token.length > 2) tokens.add(token);
	}
	return tokens;
}

/** Top entries of the same target scope by token-set Jaccard (>2-char tokens). */
export function selectAdmissionCandidates(content: string, entries: string[], limit = 10): string[] {
	const contentTokens = lookupTokens(content);
	if (contentTokens.size === 0) return [];
	const scored: Array<{ entry: string; overlap: number }> = [];
	for (const entry of entries) {
		const entryTokens = lookupTokens(entry);
		if (entryTokens.size === 0) continue;
		let shared = 0;
		for (const token of contentTokens) if (entryTokens.has(token)) shared++;
		const union = contentTokens.size + entryTokens.size - shared;
		const overlap = union > 0 ? shared / union : 0;
		if (overlap > 0) scored.push({ entry, overlap });
	}
	scored.sort((a, b) => b.overlap - a.overlap);
	return scored.slice(0, limit).map((candidate) => candidate.entry);
}

/** Pure admission decision. `answers === null` (Jev down/kill switch) is a
 * pass-through: a Jev outage must never drop a save the agent requested. */
export function admissionGate(state: AdmissionState, answers: JevAnswers | null, config: JevConfig): AdmissionGateResult {
	if (state.exact_duplicate) {
		return { verdict: "block", reason: "jev-memory admission: exact duplicate of an existing entry" };
	}
	if (!answers) return { verdict: "pass-through" };
	const shouldStore = noulValue(answers.should_store);
	const futureUtility = noulValue(answers.future_utility);
	const importance = noulValue(answers.importance);
	const novelty = noulValue(answers.novelty);
	const redundancy = noulValue(answers.redundancy);
	// A non-null response with missing or malformed answers is a Jev failure — fail open like null.
	if (shouldStore === undefined || futureUtility === undefined || importance === undefined || novelty === undefined || redundancy === undefined) {
		return { verdict: "pass-through" };
	}
	const scores = {
		should_store: shouldStore,
		future_utility: futureUtility,
		importance,
		novelty,
		redundancy,
	};
	const score = admissionScore(scores, config.admissionWeights);
	if (score >= config.admission.threshold) return { verdict: "allow", score, scores };
	const detail = Object.entries(scores).map(([name, value]) => `${name}=${value.toFixed(2)}`).join(", ");
	return {
		verdict: "block",
		score,
		scores,
		reason: `jev-memory admission: not worth storing (score ${score.toFixed(2)} < ${config.admission.threshold.toFixed(2)} — ${detail}). If this is genuinely important, rephrase and retry with specific durable content.`,
	};
}

export interface PregateGateResult {
	run: boolean;
	degraded: boolean;
	worthReview?: number;
}

/** Jev unavailable or a malformed non-null response → run the review unchanged (fail-open). */
export function pregateGate(answers: JevAnswers | null, config: JevConfig): PregateGateResult {
	if (!answers) return { run: true, degraded: true };
	const worthReview = noulValue(answers.worth_review);
	if (worthReview === undefined) return { run: true, degraded: true };
	return { run: worthReview >= config.pregate.threshold, degraded: false, worthReview };
}

export interface CorrectionGateResult {
	save: boolean;
	degraded: boolean;
	isCorrection?: number;
	target?: "user" | "memory" | "project" | "failure";
}

const CORRECTION_SAVE_THRESHOLD = 0.6;

/** Jev unavailable or a malformed non-null response → save as before (fail-open).
 * Below-threshold is_correction means the regex match was a false positive;
 * a missing directive_target only omits the routing hint. */
export function correctionGate(answers: JevAnswers | null): CorrectionGateResult {
	if (!answers) return { save: true, degraded: true };
	const isCorrection = noulValue(answers.is_correction);
	if (isCorrection === undefined) return { save: true, degraded: true };
	if (isCorrection < CORRECTION_SAVE_THRESHOLD) return { save: false, degraded: false, isCorrection };
	const choice = answers.directive_target as ChoiceAnswer | undefined;
	const target = choice?.choice;
	return {
		save: true,
		degraded: false,
		isCorrection,
		target: target === "user" || target === "memory" || target === "project" || target === "failure" ? target : undefined,
	};
}

export function buildTurnDigest(parts: string[]): string {
	return parts.join("\n\n").slice(0, 8000);
}

export function buildCorrectionState(parts: string[]): { user_message: string; last_assistant_context: string } {
	let userMessage = "";
	let assistantContext = "";
	for (let i = parts.length - 1; i >= 0; i--) {
		if (!parts[i]?.startsWith("[USER]")) continue;
		userMessage = parts[i].replace(/^\[USER\]:\s*/, "");
		for (let j = i - 1; j >= 0; j--) {
			if (parts[j]?.startsWith("[ASSISTANT]")) {
				assistantContext = parts[j].replace(/^\[ASSISTANT\]:\s*/, "");
				break;
			}
		}
		break;
	}
	return { user_message: userMessage, last_assistant_context: assistantContext.slice(0, 2000) };
}

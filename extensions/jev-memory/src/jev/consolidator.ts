/** JEVCONSOLIDATE — deterministic typed consolidation planning over Jev pair
 * and stale verdicts. Everything here is pure (dates are injected); the
 * impure runner that calls Jev, audits, and applies the plan lives in
 * handlers/auto-consolidate.ts. */

import { ENTRY_DELIMITER } from "../constants.js";
import { normalizeMemoryLookupText } from "../store/memory-lookup.js";
import type { ChoiceAnswer, JevAnswers } from "./client.js";
import { consolidationDecide, DEFAULT_DECISION_CONFIG, type JevDecisionConfig } from "./scoring.js";

export const CONSOLIDATOR_CHUNK_CHAR_LIMIT = 40_000;
export const CONSOLIDATOR_MAX_PAIRS_PER_CHUNK = 40;
export const CONSOLIDATOR_NEIGHBOR_LIMIT = 10;
export const CONSOLIDATOR_RECENCY_WINDOW_DAYS = 45;
export const CONSOLIDATOR_STICKY_REFERENCE_DAYS = 7;
export const CONSOLIDATOR_STICKY_REDUNDANCY = 0.9;
export const CONSOLIDATOR_STALE_MAX_ENTRIES_PER_CHUNK = 60;
export const CONSOLIDATOR_STALE_THRESHOLD = 0.85;

export const DAY_MS = 86_400_000;

export interface ConsolidatorEntry {
	id: string;
	content: string;
	created: string;
	lastReferenced: string;
}

export interface ConsolidatorPair {
	firstId: string;
	secondId: string;
}

/** Split entries into ≤maxChars chunks at entry boundaries (never mid-entry).
 * The delimiter's length is counted the same way the store counts capacity. */
export function chunkEntries(entries: ConsolidatorEntry[], maxChars = CONSOLIDATOR_CHUNK_CHAR_LIMIT): ConsolidatorEntry[][] {
	const chunks: ConsolidatorEntry[][] = [];
	let current: ConsolidatorEntry[] = [];
	let currentChars = 0;
	for (const entry of entries) {
		if (entry.content.length > maxChars) {
			// An oversized entry rides alone rather than being split.
			if (current.length > 0) chunks.push(current);
			current = [];
			currentChars = 0;
			chunks.push([entry]);
			continue;
		}
		const joined = current.length === 0
			? entry.content.length
			: currentChars + ENTRY_DELIMITER.length + entry.content.length;
		if (current.length > 0 && joined > maxChars) {
			chunks.push(current);
			current = [];
			currentChars = 0;
		}
		current.push(entry);
		currentChars = current.length === 1
			? entry.content.length
			: currentChars + ENTRY_DELIMITER.length + entry.content.length;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

export interface SelectPairsOptions {
	now?: Date;
	recencyWindowDays?: number;
	neighborLimit?: number;
	maxPairs?: number;
}

function lookupTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const token of normalizeMemoryLookupText(text).toLowerCase().split(/[^a-z0-9]+/)) {
		if (token.length > 2) tokens.add(token);
	}
	return tokens;
}

/** Within-window check for YYYY-MM-DD strings; unparseable dates fail open so
 * a data glitch never silently drops consolidation candidates. */
function withinDays(dateText: string, now: Date, ms: number): boolean {
	const parsed = Date.parse(dateText);
	if (!Number.isFinite(parsed)) return true;
	return now.getTime() - parsed <= ms;
}

/** Unparseable dates fail closed here, unlike withinDays' fail-open: a data
 * glitch must never feed an entry to the retire stage. */
function atLeastDaysOld(dateText: string, now: Date, ms: number): boolean {
	const parsed = Date.parse(dateText);
	return Number.isFinite(parsed) && now.getTime() - parsed >= ms;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	const union = a.size + b.size - shared;
	return union > 0 ? shared / union : 0;
}

/** Deterministic candidate pairs: for each entry, the top-10 same-chunk
 * entries by token-set Jaccard (>2-char tokens), intersected with the recency
 * window (created OR last_referenced within windowDays), deduplicated, capped. */
export function selectPairs(chunk: ConsolidatorEntry[], options: SelectPairsOptions = {}): ConsolidatorPair[] {
	const now = options.now ?? new Date();
	const windowMs = (options.recencyWindowDays ?? CONSOLIDATOR_RECENCY_WINDOW_DAYS) * DAY_MS;
	const neighborLimit = options.neighborLimit ?? CONSOLIDATOR_NEIGHBOR_LIMIT;
	const maxPairs = options.maxPairs ?? CONSOLIDATOR_MAX_PAIRS_PER_CHUNK;

	const tokens = chunk.map((entry) => lookupTokens(entry.content));
	const inWindow = chunk.map(
		(entry) => withinDays(entry.created, now, windowMs) || withinDays(entry.lastReferenced, now, windowMs),
	);

	const pairs: ConsolidatorPair[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < chunk.length && pairs.length < maxPairs; i++) {
		if (tokens[i].size === 0) continue;
		const neighbors: Array<{ index: number; overlap: number }> = [];
		for (let j = 0; j < chunk.length; j++) {
			if (j === i || tokens[j].size === 0 || !inWindow[j]) continue;
			const overlap = jaccard(tokens[i], tokens[j]);
			if (overlap > 0) neighbors.push({ index: j, overlap });
		}
		neighbors.sort((a, b) => b.overlap - a.overlap || a.index - b.index);
		for (const neighbor of neighbors.slice(0, neighborLimit)) {
			const key = [chunk[i].id, chunk[neighbor.index].id].sort().join("\u0000");
			if (seen.has(key)) continue;
			seen.add(key);
			pairs.push({ firstId: chunk[i].id, secondId: chunk[neighbor.index].id });
			if (pairs.length >= maxPairs) break;
		}
	}
	return pairs;
}

export interface StaleSelectionConfig {
	ageDays: number;
	referencedDays: number;
	stickyDays?: number;
}

/** Deterministic stale candidates: created at least ageDays ago, unreferenced
 * for at least referencedDays, and outside the 7-day sticky window. Ineligible
 * entries never reach Jev. */
export function selectStaleCandidates(
	entries: ConsolidatorEntry[],
	config: StaleSelectionConfig,
	now: Date = new Date(),
): ConsolidatorEntry[] {
	const ageMs = config.ageDays * DAY_MS;
	const referencedMs = config.referencedDays * DAY_MS;
	const stickyMs = (config.stickyDays ?? CONSOLIDATOR_STICKY_REFERENCE_DAYS) * DAY_MS;
	return entries.filter((entry) =>
		atLeastDaysOld(entry.created, now, ageMs)
		&& atLeastDaysOld(entry.lastReferenced, now, referencedMs)
		&& !withinDays(entry.lastReferenced, now, stickyMs),
	);
}

/** Stale-stage chunking: the same ≤40k-char boundaries as the pair stage,
 * additionally capped at maxEntries per chunk. */
export function chunkStaleCandidates(
	entries: ConsolidatorEntry[],
	maxEntries: number = CONSOLIDATOR_STALE_MAX_ENTRIES_PER_CHUNK,
): ConsolidatorEntry[][] {
	const chunks: ConsolidatorEntry[][] = [];
	for (const charChunk of chunkEntries(entries)) {
		for (let start = 0; start < charChunk.length; start += maxEntries) {
			chunks.push(charChunk.slice(start, start + maxEntries));
		}
	}
	return chunks;
}

export interface ExecutorRetire {
	entryId: string;
	oldText: string;
}

export interface ExecutorPlan {
	/** Remove operations to apply as one atomic plan: the older/shorter entry of each retire pair. */
	retires: ExecutorRetire[];
	/** representation=merge pairs — v1 keeps both entries (no free-text merging). */
	mergeDeferred: ConsolidatorPair[];
	/** Retires blocked by the 7-day last_referenced stickiness rule. */
	stickyBlocked: number;
	/** True when any pair answer was missing or malformed (fail-open: no action for that pair). */
	degraded: boolean;
}

export interface BuildExecutorPlanOptions {
	now?: Date;
	config?: Partial<JevDecisionConfig>;
	stickyDays?: number;
}

function noulValue(answer: unknown): number | undefined {
	if (typeof answer === "number") return answer;
	const noul = (answer as { noul?: unknown } | undefined)?.noul;
	return typeof noul === "number" ? noul : undefined;
}

function pickVictim(
	byId: Map<string, { entry: ConsolidatorEntry; index: number }>,
	pair: ConsolidatorPair,
): ConsolidatorEntry | null {
	const first = byId.get(pair.firstId);
	const second = byId.get(pair.secondId);
	if (!first || !second) return null;
	// The OLDER entry loses; equal created dates go to the shorter entry; full
	// ties keep the earlier file position.
	if (first.entry.created !== second.entry.created) {
		return first.entry.created < second.entry.created ? first.entry : second.entry;
	}
	if (first.entry.content.length !== second.entry.content.length) {
		return first.entry.content.length <= second.entry.content.length ? first.entry : second.entry;
	}
	return first.index <= second.index ? second.entry : first.entry;
}

/** Deterministic executor over the Jev pair answers. `retire` (representation=
 * retire, conf ≥ 0.85, contradiction < 0.85) removes the older/shorter entry;
 * `merge` is deferred to audit only in v1; everything else is no action.
 * Nothing may remove an entry referenced within 7 days unless redundant ≥ 0.9. */
export function buildExecutorPlan(
	chunk: ConsolidatorEntry[],
	pairs: ConsolidatorPair[],
	answers: JevAnswers,
	options: BuildExecutorPlanOptions = {},
): ExecutorPlan {
	const now = options.now ?? new Date();
	const config = options.config ?? DEFAULT_DECISION_CONFIG;
	const stickyMs = (options.stickyDays ?? CONSOLIDATOR_STICKY_REFERENCE_DAYS) * DAY_MS;
	const confidenceThreshold = config.consolidationConfidence ?? DEFAULT_DECISION_CONFIG.consolidationConfidence;
	const contradictionThreshold = config.contradictionThreshold ?? DEFAULT_DECISION_CONFIG.contradictionThreshold;

	const byId = new Map(chunk.map((entry, index) => [entry.id, { entry, index }]));
	const plan: ExecutorPlan = { retires: [], mergeDeferred: [], stickyBlocked: 0, degraded: false };
	for (let p = 0; p < pairs.length; p++) {
		const pair = pairs[p];
		const representation = answers[`pair_${p}_representation`] as ChoiceAnswer | undefined;
		const contradiction = noulValue(answers[`pair_${p}_contradiction`]);
		const redundant = noulValue(answers[`pair_${p}_redundant`]);
		const obsolete = noulValue(answers[`pair_${p}_obsolete`]);
		if (
			typeof representation?.choice !== "string"
			|| typeof representation.confidence !== "number"
			|| contradiction === undefined
			|| redundant === undefined
			|| obsolete === undefined
		) {
			// A non-null response with missing/malformed per-pair answers is a
			// Jev failure — fail open like null: no action for that pair.
			plan.degraded = true;
			continue;
		}

		const decide = consolidationDecide({ representation, contradiction }, config);
		if (decide.action === "retire") {
			const victim = pickVictim(byId, pair);
			if (!victim) {
				plan.degraded = true;
				continue;
			}
			if (withinDays(victim.lastReferenced, now, stickyMs) && redundant < CONSOLIDATOR_STICKY_REDUNDANCY) {
				plan.stickyBlocked++;
				continue;
			}
			plan.retires.push({ entryId: victim.id, oldText: victim.content });
			continue;
		}
		if (
			representation.choice === "merge"
			&& representation.confidence >= confidenceThreshold
			&& decide.contradictionRisk < contradictionThreshold
		) {
			plan.mergeDeferred.push(pair);
		}
	}
	return plan;
}

export interface StalePlan {
	retires: ExecutorRetire[];
	degraded: boolean;
}

/** Stale-stage executor: retire entries whose stale noul clears the threshold
 * (0.85 by default — the same bar as representation-retire). Missing or
 * malformed answers on a non-null response skip that entry, degraded. */
export function buildStalePlan(
	chunk: ConsolidatorEntry[],
	answers: JevAnswers,
	options: { threshold?: number } = {},
): StalePlan {
	const threshold = options.threshold ?? CONSOLIDATOR_STALE_THRESHOLD;
	const plan: StalePlan = { retires: [], degraded: false };
	for (let i = 0; i < chunk.length; i++) {
		const stale = noulValue(answers[`entry_${i}_stale`]);
		if (stale === undefined) {
			plan.degraded = true;
			continue;
		}
		if (stale >= threshold) {
			plan.retires.push({ entryId: chunk[i].id, oldText: chunk[i].content });
		}
	}
	return plan;
}

import type { ChoiceAnswer, NoulAnswer } from "./client.js";

export interface JevDecisionConfig {
	admissionThreshold: number;
	rerankFloor: number;
	consolidationConfidence: number;
	contradictionThreshold: number;
}
export const DEFAULT_DECISION_CONFIG: JevDecisionConfig = { admissionThreshold: 0.6, rerankFloor: 0.35, consolidationConfidence: 0.85, contradictionThreshold: 0.85 };
export type AdmissionValues = { should_store: number; future_utility: number; importance: number; novelty: number; redundancy: number };

function value(a: NoulAnswer | number | undefined): number { return typeof a === "number" ? a : a?.noul ?? 0; }
export function admissionScore(a: Partial<AdmissionValues> | Record<string, NoulAnswer | number>, weights = [0.4, 0.3, 0.3, 0.2]): number {
	const get = (name: keyof AdmissionValues): number => value(a[name] as NoulAnswer | number | undefined);
	return get("should_store") * Math.max(0, (weights[0] * get("future_utility") + weights[1] * get("importance") + weights[2] * get("novelty")) / (weights[0] + weights[1] + weights[2]) - weights[3] * get("redundancy"));
}
export function shouldAdmit(a: Partial<AdmissionValues> | Record<string, NoulAnswer | number>, config: Partial<JevDecisionConfig> = {}): { admit: boolean; score: number } {
	const score = admissionScore(a);
	return { admit: score >= (config.admissionThreshold ?? DEFAULT_DECISION_CONFIG.admissionThreshold), score };
}

export function rerankScore(bm25Rank: number, noulMean: number, config: Partial<JevDecisionConfig> & { maxRank?: number } = {}): number {
	const maxRank = config.maxRank ?? Math.max(1, bm25Rank);
	const rankComponent = maxRank <= 1 ? 1 : 1 - (bm25Rank - 1) / (maxRank - 1);
	return 0.5 * Math.max(0, Math.min(1, rankComponent)) + 0.5 * Math.max(0, Math.min(1, noulMean));
}
export function rerankKeep(score: number, config: Partial<JevDecisionConfig> = {}): boolean { return score >= (config.rerankFloor ?? DEFAULT_DECISION_CONFIG.rerankFloor); }

export type ConsolidationPair = { representation: ChoiceAnswer; contradiction: number | NoulAnswer };
export function consolidationDecide(pair: ConsolidationPair, config: Partial<JevDecisionConfig> = {}): { action: "retire" | "keep"; contradictionRisk: number } {
	const contradictionRisk = value(pair.contradiction);
	const threshold = config.contradictionThreshold ?? DEFAULT_DECISION_CONFIG.contradictionThreshold;
	const confidence = pair.representation.confidence ?? 0;
	const action = pair.representation.choice === "retire" && confidence >= (config.consolidationConfidence ?? DEFAULT_DECISION_CONFIG.consolidationConfidence) && contradictionRisk < threshold ? "retire" : "keep";
	return { action, contradictionRisk };
}

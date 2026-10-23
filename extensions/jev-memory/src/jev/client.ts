import { createHash } from "node:crypto";

import { jevCall as sharedJevCall, type Question } from "../../../../utils/jev-client.ts";
import { mockAnswers } from "./mock.js";

export type JevState = Record<string, unknown>;
export type JevQuestion = { type: "noul" | "choice" | "score"; instructions: string; criteria?: Record<string, string> };
export type JevQuestions = Record<string, JevQuestion>;
export type NoulAnswer = { type?: "noul"; noul: number };
export type ChoiceAnswer = { type?: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type ScoreAnswer = { type?: "score"; score: number; confidence?: number; probabilities?: Record<string, number> };
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type JevAnswers = Record<string, JevAnswer> & { __cached?: boolean };
export type CallOpts = { budget?: CallBudget; mock?: boolean; timeoutMs?: number };

export class CallBudget {
	private calls = 0;
	readonly maxCalls: number;
	readonly deadlineMs: number;
	constructor(maxCalls: number, deadlineMs: number) {
		this.maxCalls = maxCalls;
		this.deadlineMs = deadlineMs;
	}
	tryConsume(): boolean {
		if (this.calls >= this.maxCalls || Date.now() >= this.deadlineMs) return false;
		this.calls++;
		return true;
	}
}

const cache = new Map<string, JevAnswers>();

function cachePut(id: string, answers: JevAnswers): void {
	cache.delete(id);
	cache.set(id, answers);
	const size = Math.max(0, Number(process.env.JEVM_CACHE_SIZE ?? "1024"));
	while (cache.size > size) cache.delete(cache.keys().next().value as string);
}

export async function jevCall(state: JevState, questions: JevQuestions, opts?: CallOpts): Promise<JevAnswers | null> {
	try {
		if (process.env.JEVM_JEV === "0") return null;
		if (opts?.budget && !opts.budget.tryConsume()) return null;
		const model = process.env.JEV_MODEL ?? "jev-latest";
		const id = createHash("sha256").update(JSON.stringify({ model, state, questions })).digest("hex");
		const existing = cache.get(id);
		if (existing) {
			cache.delete(id);
			cache.set(id, existing);
			return { ...existing, __cached: true } as JevAnswers;
		}
		if (opts?.mock || process.env.JEVM_MOCK === "1") {
			const answers = mockAnswers(questions);
			cachePut(id, answers);
			return answers;
		}
		const retries = Math.max(0, Number(process.env.JEVM_MAX_RETRIES ?? "2"));
		const timeoutMs = Math.max(1, opts?.timeoutMs ?? Number(process.env.JEVM_TIMEOUT_MS ?? "10000"));
		const result = await sharedJevCall(state, questions as unknown as Record<string, Question>, {
			timeoutMs,
			retries,
			model,
			key: process.env.JEVM_API_KEY,
		});
		const answers = result.answers as JevAnswers;
		cachePut(id, answers);
		return answers;
	} catch {
		return null;
	}
}

export function clearJevCache(): void {
	cache.clear();
}

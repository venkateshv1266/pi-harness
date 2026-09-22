import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockAnswers } from "./mock.js";

export type JevState = Record<string, unknown>;
export type JevQuestion = { type: "noul" | "choice" | "score"; instructions: string; criteria?: Record<string, string> };
export type JevQuestions = Record<string, JevQuestion>;
export type NoulAnswer = { type?: "noul"; noul: number };
export type ChoiceAnswer = { type?: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type ScoreAnswer = { type?: "score"; score: number; confidence?: number; probabilities?: Record<string, number> };
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type JevAnswers = Record<string, JevAnswer> & { __cached?: boolean };
export type CallOpts = { budget?: CallBudget; mock?: boolean };

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
const secretPattern = /[A-Za-z0-9_-]*(key|token|secret|password|credential)[A-Za-z0-9_-]*\s*[:=]\s*\S+/gi;

function key(): string | null {
	const direct = process.env.JEVM_API_KEY ?? process.env.JEV_API_KEY ?? process.env.OPENROUTER_API_KEY;
	if (direct) return direct;
	try {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		const auth = JSON.parse(readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8")) as { openrouter?: { key?: string } };
		return typeof auth.openrouter?.key === "string" ? auth.openrouter.key : null;
	} catch {
		return null;
	}
}

function retryDelay(attempt: number, response: Response): number {
	const retryAfter = response.headers.get("Retry-After-ms") ?? response.headers.get("Retry-After");
	if (retryAfter) {
		const value = Number(retryAfter);
		if (Number.isFinite(value)) return response.headers.get("Retry-After-ms") ? value : value * 1000;
	}
	return Math.min(5000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.25);
}

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
		const serializedState = JSON.stringify(state).replace(secretPattern, "[redacted]");
		const payload = { model, state, questions };
		const id = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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
		const token = key();
		if (!token) return null;
		const retries = Math.max(0, Number(process.env.JEVM_MAX_RETRIES ?? "2"));
		const timeout = Math.max(1, Number(process.env.JEVM_TIMEOUT_MS ?? "3000"));
		let response: Response | null = null;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				response = await fetch(`${process.env.JEV_BASE_URL ?? "https://openrouter.ai/api"}/v1/systemone`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: JSON.stringify({ ...payload, state: serializedState }),
					signal: AbortSignal.timeout(timeout),
				});
			} catch {
				return null;
			}
			if (response.ok) break;
			const retryable = response.status === 408 || response.status === 429 || (response.status >= 500 && response.status < 600);
			if (!retryable || attempt === retries) return null;
			await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt, response!)));
		}
		if (!response?.ok) return null;
		const body = await response.json() as { answers?: Record<string, JevAnswer> };
		if (!body.answers || typeof body.answers !== "object") return null;
		const answers = body.answers as JevAnswers;
		cachePut(id, answers);
		return answers;
	} catch {
		return null;
	}
}

export function clearJevCache(): void { cache.clear(); }

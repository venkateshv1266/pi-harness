/**
 * Shared System One (Jev) client for pi extensions.
 *
 * One endpoint: POST {JEV_BASE_URL}/v1/systemone with { model, state, questions }.
 * State is a string or a plain object/array; each question is a noul (yes/no
 * probability), choice (one of up to 255 declared options), or score (position
 * on 2-10 described levels). Answers come back typed with confidences in
 * ~300ms for a fraction of a cent. Secrets are scrubbed from every state
 * before it leaves the machine.
 *
 * Key resolution (same chain as the ttsr verifier and jev-ask.mjs):
 * JEV_API_KEY | OPENROUTER_API_KEY | ~/.pi/agent/auth.json (openrouter.key).
 *
 * Env: JEV_BASE_URL (default https://openrouter.ai/api), JEV_MODEL (default
 * jev-latest), JEV_TIMEOUT_MS (default 10000), JEV_RETRIES (default 1, on
 * 429/5xx/network), JEV_CONCURRENCY (default 6, mapPool default).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const JEV_BASE_URL = process.env.JEV_BASE_URL ?? "https://openrouter.ai/api";
export const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest";
export const JEV_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? "10000");
export const JEV_CONCURRENCY = Math.max(1, Number(process.env.JEV_CONCURRENCY ?? "6"));
const RETRIES = Math.max(0, Number(process.env.JEV_RETRIES ?? "1"));

export type NoulQuestion = { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type JevAnswers = Record<string, Record<string, unknown>>;
export type JevResult = { answers: JevAnswers; costUsd: number; model: string };

let keyCache: string | null | undefined;

export function jevKey(): string | null {
	if (keyCache !== undefined) return keyCache;
	keyCache = process.env.JEV_API_KEY ?? process.env.OPENROUTER_API_KEY ?? null;
	if (!keyCache) {
		try {
			const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as {
				openrouter?: { key?: string };
			};
			keyCache = typeof auth.openrouter?.key === "string" ? auth.openrouter.key : null;
		} catch {
			keyCache = null;
		}
	}
	return keyCache;
}

const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\bsk-[A-Za-z0-9_-]{10,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

export function scrubSecrets(s: string): string {
	let out = s;
	for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
	return out;
}

export function deepScrub(value: unknown): unknown {
	if (typeof value === "string") return scrubSecrets(value);
	if (Array.isArray(value)) return value.map(deepScrub);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = deepScrub(v);
		return out;
	}
	return value;
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

export async function jevCall(state: unknown, questions: Record<string, Question>, opts: { timeoutMs?: number } = {}): Promise<JevResult> {
	const key = jevKey();
	if (!key) throw new Error("no Jev key: set JEV_API_KEY or OPENROUTER_API_KEY, or add openrouter.key to ~/.pi/agent/auth.json");
	const body = JSON.stringify({ model: JEV_MODEL, state: deepScrub(state), questions });
	const timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;
	let lastErr: unknown;
	for (let attempt = 0; attempt <= RETRIES; attempt++) {
		let res: Response;
		try {
			res = await fetch(`${JEV_BASE_URL}/v1/systemone`, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			lastErr = err;
			await sleep(600);
			continue;
		}
		if (res.ok) {
			const j = (await res.json()) as { answers?: JevAnswers; usage?: { cost?: number }; model?: string };
			return { answers: j.answers ?? {}, costUsd: j.usage?.cost ?? 0, model: j.model ?? JEV_MODEL };
		}
		lastErr = new Error(`HTTP ${res.status}`);
		if (res.status === 429 || res.status >= 500) {
			await sleep(600);
			continue;
		}
		break;
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Bounded-parallel map; `fn` must not throw (wrap per-item errors yourself). */
export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
	return results;
}

export function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

// Read-only command prefixes shared by ask-jev (strict allowlist for the
// `command` parameter) and jev-guard (fast path that skips the Jev call).
// Deliberately excludes find (find . -delete) and anything that executes
// project code (npm test, node script.js).
export const READONLY_BASH_PREFIXES: RegExp[] = [
	/^git (status|diff|log|show|branch|tag|remote|rev-parse|describe|shortlog|stash list|worktree list)(\s|$)/,
	/^(ls|pwd|cat|head|tail|wc|du|df|file|stat|jq|rg|grep|printenv|date|which|basename|dirname|realpath)(\s|$)/,
	/^sed -n(\s|$)/,
	/^(node|npm|npx|python3?|pi|git|bun|deno|tsc) --version(\s|$)/,
];

export function isReadonlyCommand(command: string): boolean {
	const segments = command.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
	if (segments.length === 0) return false;
	return segments.every((seg) => READONLY_BASH_PREFIXES.some((re) => re.test(seg)));
}

// Typed answer accessors; null when the answer is missing or malformed.

export type NoulAnswer = { noul: number; confidence: number };
export type ChoiceAnswer = { choice: string; confidence: number; probabilities: Record<string, number> };
export type ScoreAnswer = { score: number; confidence: number; legend?: unknown; probabilities: Record<string, number> };

export function noulOf(answers: JevAnswers, id: string): NoulAnswer | null {
	const a = answers[id];
	if (!a || typeof a.noul !== "number") return null;
	return { noul: a.noul, confidence: typeof a.confidence === "number" ? a.confidence : 1 };
}

export function choiceOf(answers: JevAnswers, id: string): ChoiceAnswer | null {
	const a = answers[id];
	if (!a || typeof a.choice !== "string") return null;
	return {
		choice: a.choice,
		confidence: typeof a.confidence === "number" ? a.confidence : 1,
		probabilities: (a.probabilities as Record<string, number>) ?? {},
	};
}

export function scoreOf(answers: JevAnswers, id: string): ScoreAnswer | null {
	const a = answers[id];
	if (!a || typeof a.score !== "number") return null;
	return {
		score: a.score,
		confidence: typeof a.confidence === "number" ? a.confidence : 1,
		legend: a.legend,
		probabilities: (a.probabilities as Record<string, number>) ?? {},
	};
}
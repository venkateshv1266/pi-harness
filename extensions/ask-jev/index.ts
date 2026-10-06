/**
 * ask-jev — System One (Jev) as agent tools, so a judgment never costs a read.
 *
 * Code gathers the state (files, globs, one read-only command) and the model
 * gets typed answers with confidences; the content never enters its context.
 * The "Jev inside the agent" ladder, levels 8-10:
 *
 *   ask_jev_file_bool / ask_jev_file_choice / ask_jev_file_score — one file
 *   ask_jev_files + pick_first_file — many files, then where to start
 *   ask_jev — general: text state + paths + one read-only command
 *   triage_log — line-scored log prefilter (port of the former jev MCP tool)
 *
 * Every call logs to jev-decisions/ask-jev.jsonl; the spend ledger reports at
 * agent_end. A before_agent_start nudge teaches the model when to reach for
 * these instead of read. Disable by removing the extension.
 */

import { exec } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { AgentEndEvent, BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	JEV_CONCURRENCY,
	choiceOf,
	expandHome,
	isReadonlyCommand,
	jevCall,
	mapPool,
	noulOf,
	scoreOf,
	type ChoiceQuestion,
	type JevAnswers,
	type NoulQuestion,
	type Question,
	type ScoreQuestion,
} from "../../utils/jev-client.ts";
import { logEvent } from "../../utils/jev-outcomes.ts";

const MAX_FILE_CHARS = 150_000;
const MAX_GLOB_FILE_CHARS = 100_000;
const MAX_FILES = 255;
const MAX_PATHS = 20;
const MAX_QUESTIONS = 10;
const COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_OUTPUT_CHARS = 200_000;
const CHUNK_LINES = 150;
const CHUNK_CHARS = 48_000;
const EVIDENCE_CHAR_BUDGET = 20_000;
const ERROR_LINE = /\b(ERROR|FATAL|PANIC|Exception|Traceback|FAIL(ED|URES?|ING)?)\b/i;

const SKIP_DIR_SEGMENTS = new Set([
	"node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo", "__pycache__", ".venv", "vendor",
]);
const SKIP_FILE_RE =
	/\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|tar|gz|tgz|bz2|xz|7z|rar|woff2?|ttf|otf|eot|mp[34]|mov|avi|wasm|dylib|so|node|bin|class|jar|pack|idx|lock|map|min\.js)$/i;

const WHEN_TEXT =
	"Use this for a judgment about what a file does or contains, without reading it into your context. " +
	"Write the question against `content`, the file's text (`path` is also in the state). " +
	"Use read when you need the code itself, to edit or quote it; exact-string lookups belong to grep.";

const QUESTION_SCHEMA =
	"questions_json is a JSON object keyed by question id; write every question against `content` (the file's text; `path` is also in the state). " +
	'Three types. noul: {"type":"noul","instructions":"Does `content` ...?","criteria":{"true":"...","false":"..."}} returns the probability of yes, 0 to 1. ' +
	'choice: {"type":"choice","instructions":"Which ... is `content`?","criteria":{"option_a":"when it applies","other":"none of the above"}} returns one of your keys plus confidence, up to 255 options. ' +
	'score: {"type":"score","instructions":"How ... is `content`?","criteria":["lowest situation","...","highest situation"]} returns a position on your levels, 2 to 16 of them. ' +
	"Ask every question you might need in one block — it is one call per file either way.";

const NUDGE_MARKER = "ask-jev-nudge-v1";
const NUDGE =
	`\n\n<!-- ${NUDGE_MARKER} -->\n` +
	"## Cheap file judgments (ask-jev)\n" +
	"You have ask_jev_file_bool, ask_jev_file_choice, ask_jev_file_score, ask_jev_files, pick_first_file, ask_jev, and triage_log. " +
	"When you need a judgment about a file — does it do X, which pattern is it, how risky is it — use these instead of read: " +
	"the answer returns typed with a confidence in under a second and the file never enters your context. " +
	"Give paths, not pasted content. Use ask_jev_files plus pick_first_file to find where to start in an unfamiliar tree, " +
	"triage_log before reading any large log file, and a cheap ask_jev_file_bool to validate an assumption about a file before you act on it. " +
	"Use read when you need the code itself, to edit or quote; grep for exact-string lookups.";

// ─── Helpers ──────────────────────────────────────────────────────────

class AskError extends Error {}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function resolvePath(p: string, cwd: string): string {
	return resolve(cwd, expandHome(p));
}

function isProbablyBinary(text: string): boolean {
	return text.slice(0, 8000).includes("\0");
}

function readText(path: string, maxChars: number): string {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		throw new AskError(`cannot read ${path}: ${(err as Error).message}`);
	}
	if (isProbablyBinary(text)) throw new AskError(`${path} looks like a binary file`);
	if (text.length > maxChars) {
		throw new AskError(
			`${path} is ${text.length} chars, over the ${maxChars} char budget — read a narrower slice yourself, or point ask_jev_files at a directory/glob`,
		);
	}
	return text;
}

function hasGlobChars(s: string): boolean {
	return /[*?]/.test(s);
}

function globToRegExp(pattern: string): RegExp {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				re += ".*";
				i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[\\^$.+(){}[\]|]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

type WalkEntry = { parentPath: string; name: string; isFile(): boolean };

function walkFiles(root: string): string[] {
	const out: string[] = [];
	try {
		const entries = readdirSync(root, { recursive: true, withFileTypes: true }) as unknown as WalkEntry[];
		for (const e of entries) if (e.isFile()) out.push(join(e.parentPath, e.name));
	} catch (err) {
		// unreadable or missing roots yield an empty expansion, never a failed call
		return [`(walk error: ${(err as Error).message})`].slice(0, 0);
	}
	return out;
}

function skipReason(path: string): string | null {
	const segments = path.split(/[\\/]/);
	if (segments.some((s) => SKIP_DIR_SEGMENTS.has(s))) return "inside a skipped directory (node_modules, .git, build output)";
	if (SKIP_FILE_RE.test(path)) return "binary or generated file extension";
	return null;
}

type Candidate = { abs: string; rel: string; explicit: boolean };

function expandPaths(
	inputs: string[],
	cwd: string,
	recursive: boolean,
): { candidates: Candidate[]; skipped: { path: string; reason: string }[]; filtered: number } {
	const skipped: { path: string; reason: string }[] = [];
	const byAbs = new Map<string, Candidate>();
	let filtered = 0;
	const add = (abs: string, explicit: boolean) => {
		if (!byAbs.has(abs)) byAbs.set(abs, { abs, rel: relative(cwd, abs) || abs, explicit });
	};
	const addWalked = (abs: string) => {
		const reason = skipReason(abs);
		if (reason) {
			filtered++;
			return;
		}
		add(abs, false);
	};

	for (const input of inputs) {
		if (hasGlobChars(input)) {
			const parts = input.split(/[/\\]/);
			let baseSegments: string[] = [];
			for (const part of parts) {
				if (hasGlobChars(part)) break;
				baseSegments.push(part);
			}
			const remainder = parts.slice(baseSegments.length);
			const base = baseSegments.length ? resolvePath(baseSegments.join("/"), cwd) : cwd;
			const re = globToRegExp(remainder.join("/"));
			for (const abs of walkFiles(base)) {
				if (re.test(relative(base, abs))) addWalked(abs);
			}
			continue;
		}
		const abs = resolvePath(input, cwd);
		let st;
		try {
			st = statSync(abs);
		} catch {
			skipped.push({ path: input, reason: "not found" });
			continue;
		}
		if (st.isDirectory()) {
			const files = recursive
				? walkFiles(abs)
				: readdirSync(abs, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(abs, d.name));
			for (const f of files) addWalked(f);
		} else {
			add(abs, true);
		}
	}

	const all = [...byAbs.values()];
	const candidates = all.slice(0, MAX_FILES);
	if (all.length > MAX_FILES) {
		skipped.push({ path: `(${all.length - MAX_FILES} matched files)`, reason: `over the ${MAX_FILES} file cap` });
	}
	return { candidates, skipped, filtered };
}

function parseQuestions(json: string): Record<string, Question> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new AskError("questions_json is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new AskError("questions_json must be an object keyed by question id");
	}
	const entries = Object.entries(parsed as Record<string, unknown>);
	if (entries.length === 0) throw new AskError("questions_json has no questions");
	if (entries.length > MAX_QUESTIONS) {
		throw new AskError(`questions_json has ${entries.length} questions, over the cap of ${MAX_QUESTIONS}`);
	}
	const out: Record<string, Question> = {};
	for (const [id, raw] of entries) {
		const q = (raw ?? {}) as Record<string, unknown>;
		const type = q.type;
		const instructions = typeof q.instructions === "string" ? q.instructions.trim() : "";
		if (!instructions) throw new AskError(`question "${id}" needs non-empty "instructions"`);
		if (type === "noul") {
			const crit = q.criteria as { true?: string; false?: string } | undefined;
			const question: NoulQuestion = { type: "noul", instructions };
			if (crit && (crit.true || crit.false)) question.criteria = crit;
			out[id] = question;
		} else if (type === "choice") {
			const crit = q.criteria as Record<string, string> | undefined;
			const n = crit ? Object.keys(crit).length : 0;
			if (!crit || typeof crit !== "object" || n < 2) {
				throw new AskError(`choice question "${id}" needs "criteria": an object of 2-255 option name -> description`);
			}
			if (n > 255) throw new AskError(`choice question "${id}" has ${n} options, over the 255 cap`);
			const question: ChoiceQuestion = { type: "choice", instructions, criteria: crit };
			out[id] = question;
		} else if (type === "score") {
			const crit = q.criteria as unknown[] | undefined;
			if (!Array.isArray(crit) || crit.length < 2 || crit.length > 16) {
				throw new AskError(`score question "${id}" needs "criteria": an array of 2-16 level descriptions, ordered lowest to highest`);
			}
			const question: ScoreQuestion = { type: "score", instructions, criteria: crit.map(String) };
			out[id] = question;
		} else {
			throw new AskError(`question "${id}" has type "${String(type)}" — must be noul, choice, or score`);
		}
	}
	return out;
}

function runCommand(command: string, cwd: string): Promise<{ command: string; exit_code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolveRun) => {
		exec(
			command,
			{ cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_OUTPUT_CHARS * 4, env: { ...process.env, CI: "1" } },
			(err, stdout, stderr) => {
				const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? null : 0;
				resolveRun({
					command,
					exit_code: code,
					stdout: String(stdout).slice(0, COMMAND_OUTPUT_CHARS),
					stderr: String(stderr).slice(0, 10_000),
				});
			},
		);
	});
}

// ─── Telemetry ─────────────────────────────────────────────────────────

let sessionCalls = 0;
let sessionCostUsd = 0;
let runStartCalls = 0;
let runStartCostUsd = 0;

function recordCall(tool: string, costUsd: number, elapsedMs: number, extra: Record<string, unknown> = {}) {
	sessionCalls++;
	sessionCostUsd += costUsd;
	logEvent("ask-jev", "ask-jev.jsonl", { tool, cost_usd: round6(costUsd), elapsed_ms: elapsedMs, ok: true, ...extra });
}

function recordError(tool: string, message: string) {
	logEvent("ask-jev", "ask-jev.jsonl", { tool, ok: false, error: message.slice(0, 200) });
}

function ok(payload: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], details: payload };
}

function fail(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: undefined, isError: true };
}

// ─── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
		runStartCalls = sessionCalls;
		runStartCostUsd = sessionCostUsd;
		if ((event.systemPrompt ?? "").includes(NUDGE_MARKER)) return;
		return { systemPrompt: `${event.systemPrompt ?? ""}${NUDGE}` };
	});

	pi.on("agent_end", (_event: AgentEndEvent, ctx) => {
		const calls = sessionCalls - runStartCalls;
		if (calls <= 0) return;
		const costUsd = sessionCostUsd - runStartCostUsd;
		logEvent("ask-jev", "ask-jev.jsonl", {
			summary: true,
			run_calls: calls,
			run_cost_usd: round6(costUsd),
			session_calls: sessionCalls,
			session_cost_usd: round6(sessionCostUsd),
		});
		if (ctx.hasUI) ctx.ui.notify(`ask-jev: ${calls} Jev ${calls === 1 ? "call" : "calls"} this run, $${costUsd.toFixed(5)}`, "info");
	});

	const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

	pi.registerTool({
		name: "ask_jev_file_bool",
		label: "Ask Jev about a file, yes or no",
		description: `Yes or no about one file, without reading it. Returns { path, answer, noul, confidence, cost_usd, elapsed_ms } where noul is the probability of yes, 0 to 1. ${WHEN_TEXT}`,
		promptSnippet: "ask_jev_file_bool(path, question) — yes/no about a file without reading it",
		parameters: Type.Object({
			path: Type.String({ description: "File path, relative to the working directory (~ works)" }),
			question: Type.String({ description: "A yes or no question about `content`, for example: Does `content` validate authentication tokens?" }),
			yes: Type.Optional(Type.String({ description: "What counts as yes" })),
			no: Type.Optional(Type.String({ description: "What counts as no" })),
		}),
		annotations,
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const t0 = Date.now();
			try {
				const abs = resolvePath(p.path, ctx.cwd);
				const content = readText(abs, MAX_FILE_CHARS);
				const question: NoulQuestion = { type: "noul", instructions: p.question };
				if (p.yes || p.no) question.criteria = { true: p.yes, false: p.no };
				const r = await jevCall({ path: p.path, content }, { q: question });
				const a = noulOf(r.answers, "q");
				if (!a) throw new Error("Jev returned no noul answer");
				const elapsedMs = Date.now() - t0;
				recordCall("ask_jev_file_bool", r.costUsd, elapsedMs, { path: p.path, noul: a.noul });
				return ok({
					path: p.path,
					question: p.question,
					answer: a.noul > 0.5,
					noul: a.noul,
					confidence: a.confidence,
					cost_usd: round6(r.costUsd),
					elapsed_ms: elapsedMs,
				});
			} catch (err) {
				recordError("ask_jev_file_bool", (err as Error).message);
				return fail(err instanceof AskError ? err.message : `ask_jev_file_bool error: ${(err as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "ask_jev_file_choice",
		label: "Ask Jev about a file, pick one",
		description: `Pick one option about one file, without reading it. Returns { path, choice, confidence, probabilities } — the choice is always one of your options, so add an "other" option when your list might not cover everything. ${WHEN_TEXT}`,
		promptSnippet: "ask_jev_file_choice(path, question, options) — classify a file without reading it",
		parameters: Type.Object({
			path: Type.String({ description: "File path, relative to the working directory (~ works)" }),
			question: Type.String({ description: "The question, for example: Which layer is `content`?" }),
			options: Type.Record(Type.String(), Type.String(), {
				description: "Option name -> one line description of when it applies. 2 to 255 options.",
			}),
		}),
		annotations,
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const t0 = Date.now();
			try {
				const abs = resolvePath(p.path, ctx.cwd);
				const content = readText(abs, MAX_FILE_CHARS);
				const r = await jevCall({ path: p.path, content }, { q: { type: "choice", instructions: p.question, criteria: p.options } });
				const a = choiceOf(r.answers, "q");
				if (!a) throw new Error("Jev returned no choice answer");
				const elapsedMs = Date.now() - t0;
				recordCall("ask_jev_file_choice", r.costUsd, elapsedMs, { path: p.path, choice: a.choice });
				return ok({
					path: p.path,
					question: p.question,
					choice: a.choice,
					confidence: a.confidence,
					probabilities: a.probabilities,
					cost_usd: round6(r.costUsd),
					elapsed_ms: elapsedMs,
				});
			} catch (err) {
				recordError("ask_jev_file_choice", (err as Error).message);
				return fail(err instanceof AskError ? err.message : `ask_jev_file_choice error: ${(err as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "ask_jev_file_score",
		label: "Ask Jev about a file, on a scale",
		description: `A position on a scale you define, about one file, without reading it. Returns { path, score, normalized, legend, confidence } — score is the index into your levels (it can land between them); normalized maps it to 0-1. ${WHEN_TEXT}`,
		promptSnippet: "ask_jev_file_score(path, question, levels) — score a file on a scale without reading it",
		parameters: Type.Object({
			path: Type.String({ description: "File path, relative to the working directory (~ works)" }),
			question: Type.String({ description: "The question, for example: How risky is a refactor of `content`?" }),
			levels: Type.Array(Type.String(), {
				description: "Ordered low to high, each level a situation, for example: [\"isolated, well tested\", \"touches one module\", \"cross-cuts the codebase\"]. 2 to 16 levels.",
			}),
		}),
		annotations,
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const t0 = Date.now();
			try {
				if (p.levels.length < 2 || p.levels.length > 16) throw new AskError("levels must have 2 to 16 entries, lowest first");
				const abs = resolvePath(p.path, ctx.cwd);
				const content = readText(abs, MAX_FILE_CHARS);
				const r = await jevCall({ path: p.path, content }, { q: { type: "score", instructions: p.question, criteria: p.levels } });
				const a = scoreOf(r.answers, "q");
				if (!a) throw new Error("Jev returned no score answer");
				const elapsedMs = Date.now() - t0;
				recordCall("ask_jev_file_score", r.costUsd, elapsedMs, { path: p.path, score: a.score });
				return ok({
					path: p.path,
					question: p.question,
					score: a.score,
					normalized: a.score / (p.levels.length - 1),
					legend: a.legend,
					confidence: a.confidence,
					cost_usd: round6(r.costUsd),
					elapsed_ms: elapsedMs,
				});
			} catch (err) {
				recordError("ask_jev_file_score", (err as Error).message);
				return fail(err instanceof AskError ? err.message : `ask_jev_file_score error: ${(err as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "ask_jev_files",
		label: "Ask Jev about many files",
		description:
			"Ask the same typed questions of many files at once without reading any of them. Code expands files, directories, and globs, " +
			`silently drops node_modules/.git/build output and binary/generated files, caps at ${MAX_FILES} files, then makes one Jev call per file in parallel. ` +
			`Returns { results: [{ path, answers }], skipped, filtered, calls, cost_usd, elapsed_ms }. ${QUESTION_SCHEMA} ` +
			"Use read when you need a file's code; grep for exact strings.",
		promptSnippet: "ask_jev_files(paths_or_globs, questions_json) — one Jev call per file, in parallel",
		parameters: Type.Object({
			paths_or_globs: Type.Array(Type.String(), {
				description: 'Files, directories, or globs relative to the working directory, for example ["src/**/*.ts"] or ["src/http"]',
			}),
			questions_json: Type.String({ description: "The question block as a JSON string" }),
			recursive: Type.Optional(Type.Boolean({ description: "For directories: include every file below them. Default false." })),
		}),
		annotations,
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const t0 = Date.now();
			try {
				const questions = parseQuestions(p.questions_json);
				const { candidates, skipped, filtered } = expandPaths(p.paths_or_globs, ctx.cwd, p.recursive ?? false);
				if (candidates.length === 0) {
					throw new AskError(`no readable files matched ${JSON.stringify(p.paths_or_globs)}${skipped.length ? ` (${skipped.map((s) => s.path).join(", ")})` : ""}`);
				}
				const perFile = await mapPool(candidates, JEV_CONCURRENCY, async (cand) => {
					try {
						const content = readText(cand.abs, MAX_GLOB_FILE_CHARS);
						const r = await jevCall({ path: cand.rel, content }, questions);
						return { ok: true as const, path: cand.rel, answers: r.answers, costUsd: r.costUsd };
					} catch (err) {
						return { ok: false as const, path: cand.rel, error: (err as Error).message };
					}
				});
				const results: { path: string; answers: JevAnswers }[] = [];
				let costUsd = 0;
				for (const r of perFile) {
					if (r.ok) {
						results.push({ path: r.path, answers: r.answers });
						costUsd += r.costUsd;
					} else {
						skipped.push({ path: r.path, reason: r.error });
					}
				}
				const elapsedMs = Date.now() - t0;
				recordCall("ask_jev_files", costUsd, elapsedMs, { files: results.length, questions: Object.keys(questions).length });
				return ok({
					results,
					skipped,
					filtered,
					calls: results.length,
					cost_usd: round6(costUsd),
					elapsed_ms: elapsedMs,
				});
			} catch (err) {
				recordError("ask_jev_files", (err as Error).message);
				return fail(err instanceof AskError ? err.message : `ask_jev_files error: ${(err as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "pick_first_file",
		label: "Pick the file to open first",
		description:
			"After ask_jev_files, choose which of a list of files to open first for a goal. One Choice keyed by path, so the pick is always a real file. " +
			"Returns { path, confidence, probabilities } — path is null when nothing fits. Pass a short note per path, for example the answers you already got.",
		promptSnippet: "pick_first_file(question, candidates) — which file to open first",
		parameters: Type.Object({
			question: Type.String({ description: "The goal, for example: Which file should I open first to fix the proration bug?" }),
			candidates: Type.Array(
				Type.Object({
					path: Type.String({ description: "Candidate file path" }),
					note: Type.Optional(Type.String({ description: "One line note, for example the answers ask_jev_files gave" })),
				}),
				{ description: "The candidates, 2 to 50", minItems: 2, maxItems: 50 },
			),
		}),
		annotations,
		async execute(_id, p, _signal, _onUpdate, _ctx) {
			const t0 = Date.now();
			try {
				if (p.candidates.length < 2 || p.candidates.length > 50) throw new AskError("candidates must have 2 to 50 entries");
				const criteria: Record<string, string> = {};
				for (const c of p.candidates) criteria[c.path] = c.note || "candidate file";
				criteria.none_of_these = "no candidate fits the goal";
				const r = await jevCall(
					{ goal: p.question, candidates: p.candidates.map((c) => ({ path: c.path, note: c.note ?? null })) },
					{ pick: { type: "choice", instructions: "Which file should be opened first to serve the goal?", criteria } },
				);
				const a = choiceOf(r.answers, "pick");
				if (!a) throw new Error("Jev returned no choice answer");
				const path = a.choice === "none_of_these" ? null : a.choice;
				const elapsedMs = Date.now() - t0;
				recordCall("pick_first_file", r.costUsd, elapsedMs, { picked: path ?? "(none)" });
				return ok({ path, confidence: a.confidence, probabilities: a.probabilities, cost_usd: round6(r.costUsd), elapsed_ms: elapsedMs });
			} catch (err) {
				recordError("pick_first_file", (err as Error).message);
				return fail(err instanceof AskError ? err.message : `pick_first_file error: ${(err as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "ask_jev",
		label: "Ask Jev",
		description:
			"One Jev call over state you assemble: your own short text, paths for code to read into files[\"<path>\"], and one read-only command " +
			"(git diff/log/show/status, ls, cat, head, tail, rg, grep, wc, du, df, stat, jq, sed -n — anything else is refused) whose output goes into output. " +
			"Write the question block yourself; questions see the assembled state. Returns { answers, state_summary, cost_usd, elapsed_ms }. " +
			"Give paths instead of pasting content; keep state short.",
		promptSnippet: "ask_jev(state, paths, command, questions_json) — one typed-decision call over assembled state",
		parameters: Type.Object({
			questions_json: Type.String({ description: "The question block, a JSON object keyed by question id, written against the assembled state" }),
			state: Type.Optional(Type.String({ description: "Your own state: plain text or a JSON object as a string. Short. Not for pasting files or output." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: `Files for code to read into files["<path>"] — up to ${MAX_PATHS}.` })),
			command: Type.Optional(Type.String({ description: "A read-only command for code to run in the working directory; its result goes into output" })),
		}),
		annotations,
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const t0 = Date.now();
			try {
				const questions = parseQuestions(p.questions_json);
				const assembled: Record<string, unknown> = {};
				const summaryParts: string[] = [];
				if (p.state !== undefined && p.state !== "") {
					assembled.state = p.state;
					summaryParts.push(`state: ${p.state.length} chars`);
				}
				if (p.paths !== undefined && p.paths.length > 0) {
					if (p.paths.length > MAX_PATHS) throw new AskError(`paths is over the cap of ${MAX_PATHS}`);
					const files: Record<string, string> = {};
					for (const input of p.paths) {
						files[input] = readText(resolvePath(input, ctx.cwd), MAX_FILE_CHARS);
					}
					assembled.files = files;
					summaryParts.push(`files: ${Object.keys(files).join(", ")}`);
				}
				if (p.command !== undefined && p.command !== "") {
					if (!isReadonlyCommand(p.command)) {
						throw new AskError(
							`the command is not on the read-only allowlist (git diff/log/show/status, ls, cat, head, tail, rg, grep, wc, du, df, stat, jq, sed -n). ` +
								"ask_jev only reads; run the command with bash yourself if you need its output in context",
						);
					}
					const output = await runCommand(p.command, ctx.cwd);
					assembled.output = output;
					summaryParts.push(`command: ${output.command} (exit ${output.exit_code}, ${output.stdout.length} chars stdout)`);
				}
				if (summaryParts.length === 0) throw new AskError("provide at least one of state, paths, or command");
				const r = await jevCall(assembled, questions);
				const elapsedMs = Date.now() - t0;
				recordCall("ask_jev", r.costUsd, elapsedMs, { questions: Object.keys(questions).length });
				return ok({
					answers: r.answers,
					state_summary: summaryParts.join("; "),
					cost_usd: round6(r.costUsd),
					elapsed_ms: elapsedMs,
					model: r.model,
				});
			} catch (err) {
				recordError("ask_jev", (err as Error).message);
				return fail(err instanceof AskError ? err.message : `ask_jev error: ${(err as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "triage_log",
		label: "Triage a log with Jev",
		description:
			"Log-triage prefilter: scores every line for relevance to a question and returns ONLY the top-k lines with ±2 context lines, " +
			"plus optional failure-type classification. Use BEFORE pasting or reading large log outputs (CI logs, kubectl dumps, query results) — " +
			"save the raw output to a file, triage, then reason over the returned evidence. Deterministically keeps ERROR/FATAL/traceback lines " +
			"even if scored low. Jev narrows the haystack; it does not conclude — still read the evidence and root-cause yourself.",
		promptSnippet: "triage_log(file|text, question) — top-k relevant log lines before reading",
		parameters: Type.Object({
			file: Type.Optional(Type.String({ description: "Path to the log file (use this for big logs; fetch raw logs to a file first)" })),
			text: Type.Optional(Type.String({ description: "Inline log text (alternative to file; keep small)" })),
			question: Type.String({ description: "The investigation question, e.g. 'why did wallet-connect signing fail?'" }),
			top_k: Type.Optional(Type.Number({ description: "Max relevant lines returned (default 40, max 200)" })),
			min_score: Type.Optional(Type.Number({ description: "Relevance cutoff 0-1 (default 0.5). ERROR/FATAL/traceback lines pass through regardless." })),
			classes: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: 'Optional failure-type classification over the whole log, e.g. {"lint":"...","test-failure":"...","timeout":"...","infra-flake":"...","dependency":"..."}. Omit for pure relevance triage.',
				}),
			),
			max_lines: Type.Optional(Type.Number({ description: "Cap on lines read (default 6000)" })),
			chunk_lines: Type.Optional(Type.Number({ description: "Lines per internal scoring batch (default 150)" })),
		}),
		annotations,
		async execute(_id, p, _signal, _onUpdate, ctx) {
			const t0 = Date.now();
			try {
				if (p.question.trim() === "") throw new AskError("question is required");
				let text: string;
				if (p.file !== undefined && p.file !== "") {
					text = readText(resolvePath(p.file, ctx.cwd), 8_000_000);
				} else if (p.text !== undefined && p.text !== "") {
					text = p.text;
				} else {
					throw new AskError("provide either file or text");
				}

				const maxLines = Math.max(50, p.max_lines ?? 6000);
				const topK = Math.min(200, Math.max(1, p.top_k ?? 40));
				const minScore = Math.min(1, Math.max(0, p.min_score ?? 0.5));
				const chunkSize = Math.min(400, Math.max(10, p.chunk_lines ?? CHUNK_LINES));

				const warnings: string[] = [];
				let costUsd = 0;

				const allLines = text.split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t }));
				const totalInFile = allLines.length;
				const lines = allLines.slice(0, maxLines);
				if (totalInFile > maxLines) warnings.push(`log truncated to first ${maxLines} of ${totalInFile} lines`);

				let failureType: { choice: string; confidence: number } | undefined;
				if (p.classes && Object.keys(p.classes).length >= 2) {
					try {
						const r = await jevCall(buildSample(lines), {
							overall: { type: "choice", instructions: `Classify the overall failure type of this log. Investigation context: ${p.question}`, criteria: p.classes },
						});
						const a = choiceOf(r.answers, "overall");
						if (a) failureType = { choice: a.choice, confidence: a.confidence };
						costUsd += r.costUsd;
					} catch (err) {
						warnings.push(`classification failed: ${(err as Error).message}`);
					}
				}

				const chunks: { n: number; text: string }[][] = [];
				let current: { n: number; text: string }[] = [];
				let currentChars = 0;
				for (const l of lines) {
					if (current.length >= chunkSize || (current.length > 0 && currentChars + l.text.length > CHUNK_CHARS)) {
						chunks.push(current);
						current = [];
						currentChars = 0;
					}
					current.push(l);
					currentChars += l.text.length;
				}
				if (current.length > 0) chunks.push(current);

				const chunkResults = await mapPool(chunks, JEV_CONCURRENCY, async (chunk) => {
					try {
						const state =
							`Investigation question: ${p.question}\n\nLOG excerpt (numbers on the left are line numbers):\n` +
							chunk.map((l) => `${l.n}| ${l.text}`).join("\n");
						const questions: Record<string, Question> = {};
						for (const l of chunk) {
							if (l.text.trim()) questions[`L${l.n}`] = { type: "noul", instructions: `Is log line ${l.n} relevant to the investigation question?` };
						}
						const r = await jevCall(state, questions);
						const scored: { n: number; score: number; text: string }[] = [];
						for (const l of chunk) {
							if (!l.text.trim()) continue;
							const a = noulOf(r.answers, `L${l.n}`);
							if (a) scored.push({ n: l.n, score: a.noul, text: l.text });
						}
						return { ok: true as const, scored, costUsd: r.costUsd };
					} catch (err) {
						return { ok: false as const, error: (err as Error).message };
					}
				});

				const scored: { n: number; score: number; text: string }[] = [];
				for (const r of chunkResults) {
					if (r.ok) {
						scored.push(...r.scored);
						costUsd += r.costUsd;
					} else {
						warnings.push(`chunk scoring failed: ${r.error}`);
					}
				}

				scored.sort((a, b) => b.score - a.score || a.n - b.n);
				const topLines: { n: number; score: number | null; text: string; deterministic?: boolean }[] = scored
					.filter((l) => l.score >= minScore)
					.slice(0, topK);
				const chosen = new Set(topLines.map((l) => l.n));

				const deterministicBudget = Math.min(topK, 100);
				let deterministicAdded = 0;
				for (const l of lines) {
					if (deterministicAdded >= deterministicBudget) break;
					if (chosen.has(l.n) || !l.text.trim()) continue;
					if (ERROR_LINE.test(l.text)) {
						topLines.push({ n: l.n, score: scored.find((s) => s.n === l.n)?.score ?? null, text: l.text, deterministic: true });
						chosen.add(l.n);
						deterministicAdded++;
					}
				}
				topLines.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.n - b.n);

				const evidence = buildEvidence(topLines, allLines);
				const elapsedMs = Date.now() - t0;
				recordCall("triage_log", costUsd, elapsedMs, { total_lines: totalInFile, scored_lines: scored.length, chunks: chunks.length });
				return ok({
					question: p.question,
					...(failureType ? { failure_type: failureType } : {}),
					total_lines: totalInFile,
					scored_lines: scored.length,
					chunks: chunks.length,
					top_lines: topLines,
					evidence,
					warnings,
					cost_usd: round6(costUsd),
					elapsed_ms: elapsedMs,
				});
			} catch (err) {
				recordError("triage_log", (err as Error).message);
				return fail(err instanceof AskError ? err.message : `triage_log error: ${(err as Error).message}`);
			}
		},
	});
}

function buildSample(lines: { n: number; text: string }[]): string {
	const parts: string[] = [];
	let chars = 0;
	const add = (s: string) => {
		if (chars >= 16000) return;
		parts.push(s);
		chars += s.length;
	};
	const errors = lines.filter((l) => l.text && ERROR_LINE.test(l.text)).slice(0, 60);
	for (const l of lines.slice(0, 80)) add(`${l.n}| ${l.text}`);
	for (const l of errors) add(`${l.n}| ${l.text}`);
	for (const l of lines.slice(-80)) add(`${l.n}| ${l.text}`);
	return `LOG excerpt (numbers are line numbers):\n${parts.join("\n")}`;
}

function buildEvidence(
	topLines: { n: number; score: number | null; text: string; deterministic?: boolean }[],
	allLines: { n: number; text: string }[],
	budget = EVIDENCE_CHAR_BUDGET,
): { lines?: string; text?: string; note?: string }[] {
	const byN = new Map(allLines.map((l) => [l.n, l.text]));
	const ranges: { lo: number; hi: number }[] = [];
	for (const l of [...topLines].sort((a, b) => a.n - b.n)) {
		const lo = Math.max(1, l.n - 2);
		const hi = Math.min(allLines.length, l.n + 2);
		const last = ranges[ranges.length - 1];
		if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi);
		else ranges.push({ lo, hi });
	}
	const blocks = ranges.map((r) => {
		const text: string[] = [];
		for (let n = r.lo; n <= r.hi; n++) text.push(`${n}| ${byN.get(n) ?? ""}`);
		return { lines: `${r.lo}-${r.hi}`, text: text.join("\n") };
	});
	const kept: { lines?: string; text?: string; note?: string }[] = [];
	let used = 0;
	for (const b of blocks) {
		if (used + b.text.length > budget) break;
		kept.push(b);
		used += b.text.length;
	}
	if (kept.length < blocks.length) {
		kept.push({ note: `${blocks.length - kept.length} lower-ranked evidence blocks omitted to keep output small` });
	}
	return kept;
}
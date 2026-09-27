/**
 * TTSR rules for stock pi.
 *
 * A pi-native port of omp's TTSR (Time-Traveling Stream Rules): rules sit
 * dormant until the model's live output stream matches a regex or ast-grep
 * pattern, then abort+remind (text/thinking) or block/prepend (tool).
 * Zero tokens until a match fires.
 *
 * TTSR is the only bucket that justifies a rule file. The engine still
 * classifies rulebook and always-apply for legacy compatibility, but the
 * validator rejects them (always-apply) or warns (rulebook). They belong in
 * CLAUDE.md / AGENTS.md, not the rules system.
 *
 * Rule files (first-wins by `name`):
 *   .pi/rules/ , .omp/rules/                    (project, trusted)
 *   ~/.pi/agent/rules/ , ~/.omp/agent/rules/    (user)
 *
 * Frontmatter:
 *   name: my-rule
 *   condition: ["regex1", "regex2"]            # TTSR regex, OR'd
 *   astCondition: ["if ($X) clearTimeout($X)"] # TTSR ast-grep (tool scope only)
 *   scope: [text, thinking, tool]              # default: all three
 *   globs: [path patterns]                     # optional path gate (tool only)
 *   interrupt: true                            # default: true(text/thinking), false(tool)
 *   repeat: once                               # "once" or "after-gap:N"
 *   flags: i                                   # optional regex flags
 *
 * astCondition: evaluated on write/edit introduced text; lang from file ext.
 * Repeated metavariables ($X ... $X) bind equal. Falls back to regex-only if
 * the native module is unavailable.
 *
 * Honest limitations vs omp (see README):
 *   - No mid-stream retry-from-same-point; abort+follow-up is the pi analog.
 *   - AST matching covers introduced text, not the full file snapshot.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logDecision, logOutcome, looksLikeUserCorrection, type Verdict as OutcomeVerdict } from "../../utils/jev-outcomes.ts";
import { globToRegex } from "./glob.ts";
import { noveltySatisfied, cacheKey, type ReadReceipt } from "./ledger.ts";
import { contextStats, entryStatLine, pruneCandidates, statsFor } from "./telemetry.ts";
import { buildContextRules, contextListText, readContextDocs, writeContextIndex, DEFAULT_DIGEST, type LoadedEntry, type RegistryDigestConfig } from "./registry.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── ast-grep (optional native dep, loaded lazily inside the factory) ─────

let astGrep: typeof import("@ast-grep/napi") | null = null;
type SgLang = import("@ast-grep/napi").Lang;
const EXT_TO_LANG: Record<string, SgLang> = {};

function langFromPath(filePath: string): SgLang | null {
	if (!astGrep) return null;
	const ext = path.extname(filePath).toLowerCase();
	return EXT_TO_LANG[ext] ?? null;
}

function matchAst(source: string, patterns: string[], lang: SgLang): boolean {
	if (!astGrep) return false;
	try {
		const root = astGrep.parse(lang, source).root();
		return patterns.some((p) => root.find(p) !== null);
	} catch {
		return false;
	}
}

// ─── Types ───────────────────────────────────────────────────────────────

type Scope = "text" | "thinking" | "tool";
type Bucket = "ttsr" | "rulebook" | "always";

interface Rule {
	name: string;
	bucket: Bucket;
	conditions: RegExp[];
	astConditions: string[];
	scope: Scope[];
	globs: RegExp[] | null;
	interrupt: boolean;
	repeat: "once" | { afterGap: number };
	description: string | null;
	verify: VerifySpec | null;
	body: string;
	file: string;
	flags: string;
	context?: { id: string; reads: string[]; tier: string; kind: "trigger" | "delegate" };
}

interface PersistedInjection {
	rules: string[];
}

interface VerifySpec {
	type: "noul" | "choice" | "score";
	instructions: string;
	criteria?: unknown;
	threshold: number;
	minConfidence: number;
	onFail: "fire" | "degrade" | "suppress";
}

interface Verdict {
	confirmed: boolean;
	degraded: boolean;
}

interface JevAnswer {
	type?: string;
	noul?: number;
	choice?: string;
	score?: number;
	confidence?: number;
	probabilities?: Record<string, number>;
}

const INJECTION_TYPE = "ttsr-injection";

// ─── Extension ───────────────────────────────────────────────────────────

export default async function ttsrExtension(pi: ExtensionAPI) {
	// Load ast-grep native module; degrade to regex-only if unavailable.
	try {
		astGrep = await import("@ast-grep/napi");
		const L = astGrep.Lang;
		Object.assign(EXT_TO_LANG, {
			".ts": L.TypeScript, ".tsx": L.Tsx, ".mts": L.TypeScript, ".cts": L.TypeScript,
			".js": L.JavaScript, ".mjs": L.JavaScript, ".cjs": L.JavaScript, ".jsx": L.JavaScript,
			".css": L.Css, ".html": L.Html, ".htm": L.Html,
		});
	} catch {
		astGrep = null;
	}

	let allRules: Rule[] = [];
	let ttsrRules: Rule[] = [];
	let rulebookRules: Rule[] = [];
	let alwaysRules: Rule[] = [];

	let injectedNames = new Set<string>();
	let registryEntries: LoadedEntry[] = [];
	let registryDigest: RegistryDigestConfig = { ...DEFAULT_DIGEST };
	let readReceipts = new Map<string, ReadReceipt>();
	let compliance = new Map<string, { pushes: number; escalated: boolean; reads: string[]; tier: string }>();
	let pushesThisTurn = 0;
	let verifyCache = new Map<string, Verdict>();
	let digestCache: { turn: number; text: string; source: string } | null = null;
	let gapCounters = new Map<string, number>();
	let turnCount = 0;

	let textBuf = "";
	let thinkingBuf = "";
	let toolBufs = new Map<number, string>();

	let abortArmed = false;
	let pendingToolReminders = new Map<string, string>();
	let pendingVerify = new Set<string>();
	let suppressCache = new Map<string, { turn: number; len: number }>();

	// ─── Discovery ──────────────────────────────────────────────────────

	function ruleDirs(ctxCwd: string, trusted: boolean): string[] {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		const dirs = [
			path.join(home, ".pi", "agent", "rules"),
			path.join(home, ".omp", "agent", "rules"),
		];
		if (trusted) {
			dirs.unshift(
				path.join(ctxCwd, ".pi", "rules"),
				path.join(ctxCwd, ".omp", "rules"),
			);
		}
		return dirs;
	}

	function loadRules(ctxCwd: string, trusted: boolean): Rule[] {
		const seen = new Set<string>();
		const out: Rule[] = [];
		for (const dir of ruleDirs(ctxCwd, trusted)) {
			if (!fs.existsSync(dir)) continue;
			for (const file of listMarkdownFiles(dir)) {
				const rule = parseRule(file);
				if (!rule || seen.has(rule.name)) continue;
				seen.add(rule.name);
				out.push(rule);
			}
		}
		return out;
	}

	// Rules = hand-written files + registry-synthesized context rules. The
	// registry is best-effort: a load failure never breaks rule loading.
	function loadAllRules(cwd: string, trusted: boolean, notify?: (msg: string) => void): Rule[] {
		const rules = loadRules(cwd, trusted);
		registryEntries = [];
		if (process.env.TTSR_CONTEXT_REGISTRY === "0") return rules;
		try {
			const reg = buildContextRules(cwd, trusted);
			registryEntries = reg.entries;
			registryDigest = reg.digest;
			const seen = new Set(rules.map((r) => r.name));
			for (const s of reg.rules) {
				if (seen.has(s.name)) continue;
				const parsed = parseRuleSource(s.source, `<context-registry:${s.id}>`);
				if (!parsed) {
					notify?.(`ttsr contexts: synthesized rule failed to parse: ${s.name}`);
					continue;
				}
				parsed.context = { id: s.id, reads: s.reads, tier: s.tier, kind: s.kind };
				seen.add(parsed.name);
				rules.push(parsed);
			}
			for (const w of reg.warnings) notify?.(`ttsr contexts: ${w}`);
			writeContextIndex(cwd, trusted);
		} catch (e) {
			notify?.(`ttsr contexts: registry load failed: ${(e as Error).message}`);
		}
		return rules;
	}

	function listMarkdownFiles(dir: string): string[] {
		const acc: string[] = [];
		(function walk(d: string) {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) walk(p);
				else if (e.isFile() && e.name.endsWith(".md")) acc.push(p);
			}
		})(dir);
		return acc;
	}

	function parseRule(file: string): Rule | null {
		return parseRuleSource(fs.readFileSync(file, "utf8"), file);
	}

	function parseRuleSource(raw: string, file: string): Rule | null {
		const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
		if (!m) return null;
		const fm = parseFrontmatter(m[1]);
		const body = m[2].trim();
		const name = String(fm.name ?? path.basename(file, ".md"));

		const condRaw = fm.condition ?? fm.ttsrTrigger ?? fm.ttsr_trigger;
		const conditions = toConditionList(condRaw)
			.map((s) => safeRegex(s, fm.flags ? String(fm.flags) : ""))
			.filter((r): r is RegExp => r !== null);
		const astConditions = toConditionList(fm.astCondition ?? fm.ast_condition)
			.map((s) => String(s))
			.filter((s) => s.length > 0);

		const alwaysApply = Boolean(fm.alwaysApply ?? fm.always_apply);
		const hasTTSR = conditions.length > 0 || astConditions.length > 0;
		const description = fm.description != null ? String(fm.description) : null;
		const verify = fm.verify !== undefined ? parseVerify(fm.verify) : null;

		let bucket: Bucket;
		if (alwaysApply) bucket = "always";
		else if (hasTTSR) bucket = "ttsr";
		else if (description) bucket = "rulebook";
		else return null;

		const scope = toScopeList(fm.scope) ?? ["text", "thinking", "tool"];
		const globs = toGlobList(fm.globs)?.map(globToRegex) ?? null;
		const interruptDefault = scope.includes("tool") ? false : true;
		const interrupt = fm.interrupt === undefined ? interruptDefault : Boolean(fm.interrupt);
		const repeat = parseRepeat(fm.repeat);
		const flags = typeof fm.flags === "string" ? fm.flags : "";

		return { name, bucket, conditions, astConditions, scope, globs, interrupt, repeat, description, verify, body, file, flags };
	}

	// ─── Frontmatter parsing ────────────────────────────────────────────

	function parseFrontmatter(text: string): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const line of text.split("\n")) {
			const mm = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
			if (!mm) continue;
			out[mm[1]] = parseScalar(mm[2]);
		}
		return out;
	}

	function parseScalar(v: string): unknown {
		v = v.trim();
		if (v === "") return "";
		if (v === "true" || v === "yes") return true;
		if (v === "false" || v === "no") return false;
		if (v.startsWith("{") && v.endsWith("}")) {
			try { return JSON.parse(v) as unknown; } catch { /* fall through to raw string */ }
		}
		if (v.startsWith("[") && v.endsWith("]")) {
			const inner = v.slice(1, -1).trim();
			if (inner === "") return [];
			return parseList(inner);
		}
		return stripQuotes(v);
	}

	// Parse a YAML-ish inline list, respecting single/double quotes so commas inside
	// quoted strings (e.g. regex quantifiers `{0,4}`) are not split on. Handles
	// YAML single-quote doubling (`''` -> `'`) and double-quote backslash escapes.
	function parseList(inner: string): string[] {
		const out: string[] = [];
		let cur = "";
		let q: string | null = null;
		let i = 0;
		while (i < inner.length) {
			const c = inner[i];
			if (q === "'") {
				if (c === "'") {
					if (inner[i + 1] === "'") { cur += "''"; i += 2; continue; }
					cur += "'"; q = null; i++; continue;
				}
				cur += c; i++;
			} else if (q === '"') {
				if (c === "\\" && i + 1 < inner.length) { cur += c + inner[i + 1]; i += 2; continue; }
				cur += c;
				if (c === '"') q = null;
				i++;
			} else {
				if (c === '"' || c === "'") { q = c; cur += c; i++; continue; }
				if (c === ",") { out.push(stripQuotes(cur.trim())); cur = ""; i++; continue; }
				cur += c; i++;
			}
		}
		if (cur.trim()) out.push(stripQuotes(cur.trim()));
		return out;
	}

	function stripQuotes(s: string): string {
		if (s.startsWith('"') && s.endsWith('"')) {
			return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
		if (s.startsWith("'") && s.endsWith("'")) {
			return s.slice(1, -1).replace(/''/g, "'");
		}
		return s;
	}

	function toConditionList(v: unknown): string[] {
		if (Array.isArray(v)) return v.map((s) => String(s));
		if (typeof v === "string" && v) return [v];
		return [];
	}

	function toScopeList(v: unknown): Scope[] | null {
		if (!Array.isArray(v)) return null;
		const out: Scope[] = [];
		for (const s of v) {
			const t = String(s).toLowerCase();
			if (t === "text" || t === "thinking" || t === "tool") out.push(t);
		}
		return out.length ? out : null;
	}

	function toGlobList(v: unknown): string[] | null {
		if (!Array.isArray(v)) return null;
		const out = v.map((s) => String(s));
		return out.length ? out : null;
	}

	function safeRegex(src: string, flags = ""): RegExp | null {
		try { return new RegExp(src, flags); } catch { return null; }
	}

	function parseRepeat(v: unknown): Rule["repeat"] {
		if (typeof v !== "string") return "once";
		const m = v.match(/^after-gap:?(\d+)$/i);
		if (m) return { afterGap: Math.max(1, parseInt(m[1], 10)) };
		return "once";
	}

	function parseVerify(raw: unknown): VerifySpec | null {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const v = raw as Record<string, unknown>;
		const type = v.type === "choice" || v.type === "score" ? v.type : "noul";
		const instructions = String(v.instructions ?? "").trim();
		if (!instructions) return null;
		const criteria = v.criteria;
		if (type === "choice" && !(criteria && typeof criteria === "object" && !Array.isArray(criteria))) return null;
		if (type === "score" && !Array.isArray(criteria)) return null;
		const onFail = v.onFail === "fire" || v.onFail === "suppress" ? v.onFail : "degrade";
		return {
			type,
			instructions,
			criteria,
			threshold: typeof v.threshold === "number" ? v.threshold : 0.8,
			minConfidence: typeof v.minConfidence === "number" ? v.minConfidence : 0,
			onFail,
		};
	}

	// ─── Repeat / suppression ───────────────────────────────────────────────

	function recordRead(p: string) {
		try {
			readReceipts.set(p, { turn: turnCount, mtimeMs: fs.statSync(p).mtimeMs });
		} catch { /* non-file read target */ }
	}

	function canFire(rule: Rule): boolean {
		if (rule.repeat === "once") {
			if (injectedNames.has(rule.name)) return false;
			// Already read and unchanged: satisfied without a push. Re-arms when the
			// doc's mtime moves (see refreshContextCompliance).
			if (rule.context && rule.context.kind === "trigger" && noveltySatisfied(rule.context.reads, readReceipts)) {
				injectedNames.add(rule.name);
				return false;
			}
			return true;
		}
		const last = gapCounters.get(rule.name) ?? -Infinity;
		return turnCount - last >= rule.repeat.afterGap;
	}

	// Advisory: one re-push if ignored. Gated: re-push once, then arm a block
	// for the next matching action. A read receipt clears the entry.
	function refreshContextCompliance() {
		for (const r of ttsrRules) {
			if (!r.context || r.context.kind !== "trigger") continue;
			if (!injectedNames.has(r.name)) continue;
			if (noveltySatisfied(r.context.reads, readReceipts)) {
				compliance.delete(r.name);
				continue;
			}
			const c = compliance.get(r.name);
			if (!c) {
				compliance.set(r.name, { pushes: 1, escalated: false, reads: r.context.reads, tier: r.context.tier });
				injectedNames.delete(r.name);
				continue;
			}
			if (c.pushes < 2) {
				c.pushes++;
				injectedNames.delete(r.name);
				continue;
			}
			if (r.context.tier === "gated" && !c.escalated) {
				c.escalated = true;
				injectedNames.delete(r.name);
			}
		}
	}

	function noteContextFires(rules: Rule[]) {
		for (const r of rules) {
			if (!r.context || r.context.kind !== "trigger") continue;
			if (!compliance.has(r.name)) compliance.set(r.name, { pushes: 1, escalated: false, reads: r.context.reads, tier: r.context.tier });
		}
	}

	function markInjected(names: string[]) {
		for (const n of names) {
			injectedNames.add(n);
			gapCounters.set(n, turnCount);
		}
		pi.appendEntry(INJECTION_TYPE, { rules: names } satisfies PersistedInjection);
	}

	function restoreInjected(entries: { type: string; customType?: string; data?: unknown }[]) {
		const names = new Set<string>();
		for (const e of entries) {
			if (e.type === "custom" && e.customType === INJECTION_TYPE && e.data && Array.isArray((e.data as PersistedInjection).rules)) {
				for (const n of (e.data as PersistedInjection).rules) names.add(String(n));
			}
		}
		injectedNames = names;
	}

	// ─── Outcome telemetry ──────────────────────────────────────────────

	const OUTCOME_WINDOW_TURNS = 5;
	const OUTCOME_FILE = "ttsr-jev.jsonl";
	const OUTCOME_VERDICTS: Record<string, OutcomeVerdict> = {
		survived: "good",
		retried: "bad",
		repeated: "bad",
		user_corrected: "bad",
		unresolved: "unknown",
	};

	interface PendingFire {
		fireId: string;
		rule: string;
		scope: Scope;
		turn: number;
		session: string;
		delivered: boolean;
		blocked: boolean;
		haystack: string | null;
		userInputSince: boolean;
	}

	let pendingFires: PendingFire[] = [];

	function sessionIdOf(ctx: ExtensionContextLike): string {
		try {
			return ctx.sessionManager?.getSessionId() ?? "";
		} catch {
			return "";
		}
	}

	function resolveFire(fire: PendingFire, outcome: string, detail: Record<string, unknown> = {}) {
		pendingFires = pendingFires.filter((p) => p !== fire);
		logOutcome("ttsr", OUTCOME_FILE, fire.fireId, outcome, {
			verdict: OUTCOME_VERDICTS[outcome] ?? "unknown",
			detail: {
				rule: fire.rule,
				scope: fire.scope,
				session: fire.session,
				delivered: fire.delivered,
				turnsAfter: Math.max(0, turnCount - fire.turn),
				...detail,
			},
		});
	}

	interface FireOptions {
		delivered: boolean;
		modeOf?: (r: Rule) => string;
		tool?: string;
		blocked?: boolean;
		haystack?: string;
	}

	function recordFires(rules: Rule[], scope: Scope, ctx: ExtensionContextLike, opts: FireOptions) {
		if (rules.length === 0) return;
		const session = sessionIdOf(ctx);
		for (const r of rules) {
			for (const prior of pendingFires.filter((p) => p.rule === r.name && p.session === session && p.turn < turnCount)) {
				resolveFire(prior, "repeated");
			}
			const fireId = logDecision("ttsr", OUTCOME_FILE, {
				rule: r.name,
				scope,
				session,
				turn: turnCount,
				delivered: opts.delivered,
				mode: opts.modeOf ? opts.modeOf(r) : "plain",
				...(opts.tool ? { tool: opts.tool } : {}),
				...(opts.blocked !== undefined ? { blocked: opts.blocked } : {}),
			});
			pendingFires.push({
				fireId,
				rule: r.name,
				scope,
				turn: turnCount,
				session,
				delivered: opts.delivered,
				blocked: opts.blocked ?? false,
				haystack: opts.haystack ?? null,
				userInputSince: false,
			});
		}
	}

	function expireFires() {
		for (const p of pendingFires.filter((f) => turnCount - f.turn >= OUTCOME_WINDOW_TURNS)) {
			resolveFire(p, "survived");
		}
	}

	// ─── Matching ───────────────────────────────────────────────────────

	function matchRegex(buffer: string, scope: Scope, toolPath?: string): Rule[] {
		const hits: Rule[] = [];
		for (const rule of ttsrRules) {
			if (!rule.scope.includes(scope)) continue;
			if (!canFire(rule)) continue;
			if (scope === "tool" && rule.globs) {
				if (!toolPath || !rule.globs.some((g) => g.test(toolPath))) continue;
			}
			if (rule.conditions.length && rule.conditions.some((re) => re.test(buffer))) hits.push(rule);
		}
		return hits;
	}
	function matchAstRules(source: string, toolPath: string): Rule[] {
		const lang = langFromPath(toolPath);
		if (!lang) return [];
		const hits: Rule[] = [];
		for (const rule of ttsrRules) {
			if (!rule.scope.includes("tool")) continue;
			if (!rule.astConditions.length) continue;
			if (!canFire(rule)) continue;
			if (rule.globs && !rule.globs.some((g) => g.test(toolPath))) continue;
			if (matchAst(source, rule.astConditions, lang)) hits.push(rule);
		}
		return hits;
	}

	function renderReminder(rule: Rule, p?: string): string {
		const where = p ? `\n\nMatched in: ${p}` : "";
		return `<system-interrupt reason="rule_violation" rule="${rule.name}">\n${rule.body}${where}\n</system-interrupt>`;
	}

	function dedupRules(rules: Rule[]): Rule[] {
		const seen = new Set<string>();
		const out: Rule[] = [];
		for (const r of rules) { if (!seen.has(r.name)) { seen.add(r.name); out.push(r); } }
		return out;
	}

	// ─── Jev verification (second-stage intent arbiter) ─────────────────

	const JEV_BASE_URL = process.env.JEV_BASE_URL ?? "https://openrouter.ai/api";
	const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest";
	const JEV_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? "2000");
	const JEV_KILL = process.env.TTSR_JEV === "0";

	let jevKeyCache: string | null | undefined;

	function homeDir(): string {
		return process.env.HOME ?? process.env.USERPROFILE ?? "";
	}

	function jevKey(): string | null {
		if (jevKeyCache !== undefined) return jevKeyCache;
		jevKeyCache = process.env.JEV_API_KEY ?? process.env.OPENROUTER_API_KEY ?? null;
		if (!jevKeyCache) {
			try {
				const auth = JSON.parse(fs.readFileSync(path.join(homeDir(), ".pi", "agent", "auth.json"), "utf8")) as { openrouter?: { key?: string } };
				jevKeyCache = typeof auth.openrouter?.key === "string" ? auth.openrouter.key : null;
			} catch { jevKeyCache = null; }
		}
		return jevKeyCache;
	}

	const SECRET_PATTERNS: RegExp[] = [
		/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		/\bsk-[A-Za-z0-9_-]{10,}/g,
		/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
		/\bAKIA[0-9A-Z]{16}\b/g,
		/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	];

	function scrubSecrets(s: string): string {
		let out = s;
		for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
		return out;
	}

	async function jevCall(state: string, questions: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		const key = jevKey();
		if (!key) return null;
		let res: { ok: boolean; status?: number; json(): Promise<unknown> };
		try {
			res = await fetch(`${JEV_BASE_URL}/v1/systemone`, {
				method: "POST",
				headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: JEV_MODEL, state, questions }),
				signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
			});
		} catch {
			return null;
		}
		if (!res.ok) return null;
		try {
			const j = await res.json() as { answers?: Record<string, unknown> };
			return j.answers ?? null;
		} catch {
			return null;
		}
	}

	function answerProb(spec: VerifySpec, raw: unknown): { prob: number; confidence: number } | null {
		const a = raw as JevAnswer | null;
		if (!a || typeof a !== "object") return null;
		if (spec.type === "noul") {
			if (typeof a.noul !== "number") return null;
			return { prob: a.noul, confidence: a.confidence ?? 1 };
		}
		const probs = a.probabilities ?? {};
		if (spec.type === "choice") {
			if (typeof a.choice !== "string") return null;
			return { prob: probs[a.choice] ?? 0, confidence: a.confidence ?? 1 };
		}
		if (typeof a.score !== "number") return null;
		return { prob: probs[String(a.score)] ?? 0, confidence: a.confidence ?? 1 };
	}

	function logAdjudication(rule: Rule, scope: Scope, confirmed: boolean, degraded: boolean, prob: number | null, confidence: number | null, latencyMs: number, err: string | null, digestSource?: string) {
		try {
			const dir = path.join(homeDir(), ".pi", "agent", "jev-decisions");
			fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(
				path.join(dir, "ttsr-jev.jsonl"),
				JSON.stringify({ ts: new Date().toISOString(), rule: rule.name, scope, decision: confirmed ? "fired" : "suppressed", mode: degraded ? "degraded" : "verified", prob, confidence, latencyMs, err, ...(digestSource ? { digestSource } : {}) }) + "\n",
			);
		} catch { /* logging must never break rule evaluation */ }
	}

	// Batch-verifies all rules with a verify spec against one shared state; rules
	// without a spec pass through as confirmed. Unavailable/malformed answers
	// resolve through the rule's onFail policy.
	async function runVerify(hits: Rule[], state: string, scope: Scope, digestSource?: string): Promise<Map<string, Verdict>> {
		const out = new Map<string, Verdict>();
		for (const r of hits) if (!r.verify) out.set(r.name, { confirmed: true, degraded: false });
		const misses: Rule[] = [];
		for (const r of hits) {
			if (!r.verify) continue;
			const cached = verifyCache.get(cacheKey(r.name, state));
			if (cached) out.set(r.name, cached);
			else misses.push(r);
		}
		if (misses.length === 0) return out;

		const unavailable = JEV_KILL || !jevKey();
		const t0 = Date.now();
		const questions = Object.fromEntries(misses.map((r) => {
			const v = r.verify!;
			return [r.name, v.type === "noul"
				? { type: "noul", instructions: v.instructions }
				: { type: v.type, instructions: v.instructions, criteria: v.criteria }];
		}));
		const answers = unavailable ? null : await jevCall(scrubSecrets(state), questions);
		const latencyMs = Date.now() - t0;

		for (const r of misses) {
			const spec = r.verify!;
			const parsed = answers && answers[r.name] ? answerProb(spec, answers[r.name]) : null;
			if (answers && parsed) {
				const confirmed = parsed.prob >= spec.threshold && parsed.confidence >= spec.minConfidence;
				const verdict = { confirmed, degraded: false };
				out.set(r.name, verdict);
				verifyCache.set(cacheKey(r.name, state), verdict);
				if (verifyCache.size > 200) {
					const oldest = verifyCache.keys().next().value;
					if (oldest !== undefined) verifyCache.delete(oldest);
				}
				logAdjudication(r, scope, confirmed, false, parsed.prob, parsed.confidence, latencyMs, null, digestSource);
			} else {
				const fired = spec.onFail === "fire";
				out.set(r.name, { confirmed: fired, degraded: true });
				logAdjudication(r, scope, fired, true, null, null, latencyMs, unavailable ? "unavailable" : answers ? "malformed-answer" : "call-failed", digestSource);
			}
		}
		return out;
	}

	// ─── Session digest (GoalSpec-first) ────────────────────────────────

	function clip(s: string, n: number): string {
		return s.length > n ? s.slice(0, n) + "…" : s;
	}

	interface SessionEntryLike {
		type: string;
		customType?: string;
		data?: unknown;
		message?: { role?: string; content?: unknown };
	}

	function readSessionEntries(ctx: ExtensionContextLike): SessionEntryLike[] {
		try {
			const sm = ctx.sessionManager as unknown as { getEntries?(): SessionEntryLike[]; getBranch?(): SessionEntryLike[] } | undefined;
			return sm?.getEntries?.() ?? sm?.getBranch?.() ?? [];
		} catch {
			return [];
		}
	}

	function messageTextOf(msg: { content?: unknown }): string {
		if (typeof msg.content === "string") return msg.content;
		if (!Array.isArray(msg.content)) return "";
		return msg.content
			.map((b) => (b && typeof b === "object" && (b as { type?: string; text?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
			.filter(Boolean)
			.join("\n");
	}

	function goalspecText(data: unknown): string | null {
		if (!data || typeof data !== "object") return null;
		const d = data as Record<string, unknown>;
		if (typeof d.userObjective !== "string") return null;
		const lines: string[] = [`USER OBJECTIVE: ${clip(d.userObjective, 400)}`];
		const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
		const push = (label: string, items: string[], cap = 4, itemClip = 180): void => {
			if (items.length === 0) return;
			lines.push(`${label}:`);
			for (const it of items.slice(0, cap)) lines.push(`  - ${clip(it, itemClip)}`);
		};
		push("Success criteria", strs(d.successCriteria));
		push("Constraints", strs(d.constraints));
		push("Current plan", strs(d.currentPlan));
		push("Open questions", strs(d.openQuestions));
		const facts = Array.isArray(d.knownFacts)
			? d.knownFacts.map((f) => (f && typeof f === "object" ? String((f as { fact?: unknown }).fact ?? "") : "")).filter(Boolean)
			: [];
		push("Known facts", facts, 5, 140);
		return clip(lines.join("\n"), 1800);
	}

	function lastUserText(entries: SessionEntryLike[]): string | null {
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "message" && e.message?.role === "user") {
				const t = messageTextOf(e.message).trim();
				if (t) return clip(t, 500);
			}
		}
		return null;
	}

	function sessionDigest(ctx: ExtensionContextLike): { turn: number; text: string; source: string } {
		if (digestCache && digestCache.turn === turnCount) return digestCache;
		const entries = readSessionEntries(ctx);
		const pins: string[] = [];
		let goalspec: string | null = null;
		let goalspecVersion = 0;
		for (const e of entries) {
			if (e.type !== "custom") continue;
			if (registryDigest.goalEntryType && e.customType === registryDigest.goalEntryType && e.data && typeof (e.data as { goal?: unknown }).goal === "string") {
				pins.push(clip(String((e.data as { goal: string }).goal), 200));
			}
			if (registryDigest.goalspecEntryType && e.customType === registryDigest.goalspecEntryType) {
				const t = goalspecText(e.data);
				if (t) {
					goalspec = t;
					const v = (e.data as { version?: unknown }).version;
					if (typeof v === "number") goalspecVersion = v;
				}
			}
		}
		let text: string;
		let source: string;
		if (goalspec) {
			text = goalspec;
			if (pins.length) text += `\nRefinement pins: ${pins.slice(-3).join(" | ")}`;
			source = `goalspec:v${goalspecVersion || 1}`;
		} else if (pins.length) {
			text = `PINNED GOAL: ${clip(pins[pins.length - 1], 400)}`;
			source = "fallback:goal-pin";
		} else {
			const u = lastUserText(entries);
			text = u ? `LAST USER MESSAGE: ${u}` : "";
			source = u ? "fallback:user-msg" : "none";
		}
		digestCache = { turn: turnCount, text: clip(text, 2000), source };
		return digestCache;
	}

	function withDigest(ctx: ExtensionContextLike, eventText: string): { text: string; source: string } {
		const d = sessionDigest(ctx);
		return {
			text: d.text ? `SESSION DIGEST (${d.source}):\n${d.text}\n\n${eventText}` : eventText,
			source: d.source,
		};
	}

	// ─── System prompt injection (always-apply + rulebook) ──────────────

	pi.on("before_agent_start", async (event) => {
		const parts: string[] = [];

		if (registryEntries.length) {
			parts.push(
				`## Context library\n\n${registryEntries.filter((e) => e.status !== "retired").length} context docs available; call \`context_list\` (or read ~/.pi/contexts/INDEX.md) when you need domain context that no rule has pushed.`,
			);
		}

		if (alwaysRules.length) {
			parts.push("## Always-on rules\n\n" + alwaysRules.map((r) => `### ${r.name}\n\n${r.body}`).join("\n\n"));
		}

		if (rulebookRules.length) {
			const list = rulebookRules.map((r) => `- **${r.name}** — ${r.description}`).join("\n");
			parts.push(
				`## Project rulebook\n\nThe following rules are available. When working on something relevant, call the \`read_rule\` tool with the rule name to load its full guidance before proceeding.\n\n${list}`,
			);
		}

		if (parts.length === 0) return;
		return { systemPrompt: event.systemPrompt + "\n\n" + parts.join("\n\n") };
	});

	// read_rule tool: omp's rule:// equivalent.
	pi.registerTool({
		name: "read_rule",
		label: "Read Rule",
		description:
			"Load the full body of a rulebook rule by name. Use this when a listed Project rulebook entry looks relevant to your current task. Returns the rule body as text.",
		parameters: Type.Object({
			name: Type.String({ description: "Rule name from the Project rulebook list" }),
		}),
		async execute(_id, params): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
			const rule = rulebookRules.find((r) => r.name === params.name) ?? allRules.find((r) => r.name === params.name);
			if (!rule) {
				return { content: [{ type: "text", text: `No rule named "${params.name}".` }], details: {} };
			}
			return {
				content: [{ type: "text", text: `# ${rule.name}\n\n${rule.body}` }],
				details: { rule: rule.name, bucket: rule.bucket },
			};
		},
	});

	// Context registry tools: pull-based discovery for docs without a trigger.
	pi.registerTool({
		name: "context_list",
		label: "List Context Docs",
		description:
			"List the context registry: available context doc ids, when to use each, tier, and resolved file paths. Use when you need domain context that no rule has pushed (unknown API endpoints, request tracing, etc.).",
		parameters: Type.Object({}),
		async execute(): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
			return { content: [{ type: "text", text: contextListText(registryEntries) }], details: { count: registryEntries.length } };
		},
	});

	pi.registerTool({
		name: "read_context",
		label: "Read Context Doc",
		description:
			"Read one or more context docs by registry id (comma-separated), e.g. \"kubernetes\" or \"grafana,redash\". Prefer this over reading context files by path.",
		parameters: Type.Object({ id: Type.String({ description: "Registry id(s), comma-separated" }) }),
		async execute(_id, params): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
			const text = readContextDocs(registryEntries, params.id);
			for (const id of String(params.id).split(",").map((s) => s.trim()).filter(Boolean)) {
				const e = registryEntries.find((x) => x.id === id);
				if (e) for (const p of e.resolvedReads) recordRead(p);
			}
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	// ─── Session lifecycle ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const trusted = ctx.isProjectTrusted();
		allRules = loadAllRules(ctx.cwd, trusted, (m) => { if (ctx.hasUI) ctx.ui.notify(m, "warning"); });
		ttsrRules = allRules.filter((r) => r.bucket === "ttsr");
		rulebookRules = allRules.filter((r) => r.bucket === "rulebook");
		alwaysRules = allRules.filter((r) => r.bucket === "always");
		injectedNames = new Set();
		gapCounters = new Map();
		turnCount = 0;
		pendingFires = [];
		restoreInjected(ctx.sessionManager.getBranch() as unknown as { type: string; customType?: string; data?: unknown }[]);

		if (ctx.hasUI) {
			const counts = `${allRules.length} rule(s) [ttsr=${ttsrRules.length} ctx=${registryEntries.length} rulebook=${rulebookRules.length} always=${alwaysRules.length}]`;
			ctx.ui.setStatus("ttsr", allRules.length ? `ttsr: ${counts}` : undefined);
			if (astGrep === null && allRules.some((r) => r.astConditions.length)) {
				ctx.ui.notify("ttsr: @ast-grep/napi not loaded — astCondition rules will be ignored", "warning");
			}
			if (ttsrRules.some((r) => r.verify) && (JEV_KILL || !jevKey())) {
				ctx.ui.notify("ttsr: verify rule(s) present but Jev unavailable — onFail policy applies", "warning");
			}
		}
	});

	// ─── Turn / streaming ───────────────────────────────────────────────

	pi.on("turn_start", () => {
		abortArmed = false;
		pendingToolReminders = new Map();
		pendingVerify = new Set();
		suppressCache = new Map();
		textBuf = "";
		thinkingBuf = "";
		toolBufs = new Map();
		pushesThisTurn = 0;
		digestCache = null;
		refreshContextCompliance();
	});

	pi.on("turn_end", () => {
		turnCount++;
		expireFires();
	});

	pi.on("message_update", async (event, ctx) => {
		if (ttsrRules.length === 0) return;
		const e = event.assistantMessageEvent;

		if (e.type === "text_delta") {
			textBuf += e.delta;
			const hits = matchRegex(textBuf, "text");
			if (hits.length) handleStreamHits(hits, textBuf, "text", ctx);
		} else if (e.type === "thinking_delta") {
			thinkingBuf += e.delta;
			const hits = matchRegex(thinkingBuf, "thinking");
			if (hits.length) handleStreamHits(hits, thinkingBuf, "thinking", ctx);
		} else if (e.type === "toolcall_delta") {
			const prev = toolBufs.get(e.contentIndex) ?? "";
			toolBufs.set(e.contentIndex, prev + e.delta);
		}
	});

	function handleStreamHits(hits: Rule[], buffer: string, scope: Scope, ctx: ExtensionContextLike) {
		const immediate = hits.filter((r) => !r.verify);
		if (immediate.length) handleTextOrThinking(immediate, ctx, scope);

		const batch = hits.filter((r) => {
			if (!r.verify || pendingVerify.has(r.name)) return false;
			const c = suppressCache.get(r.name);
			if (c && c.turn === turnCount && buffer.length - c.len < 2000) return false;
			return true;
		});
		if (!batch.length) return;
		for (const r of batch) pendingVerify.add(r.name);

		let minIdx = buffer.length;
		for (const r of batch) {
			for (const re of r.conditions) {
				const m = re.exec(buffer);
				if (m && m.index < minIdx) minIdx = m.index;
			}
		}
		const window = buffer.slice(Math.max(0, minIdx - 400), minIdx + 2400);
		const digest = withDigest(ctx, `EVENT (${scope}):\n${window}`);

		// Fire-and-forget: the stream keeps flowing while Jev adjudicates; the
		// abort fires on resolution if the turn is still live.
		void (async () => {
			const verdicts = await runVerify(batch, digest.text, scope, digest.source);
			for (const r of batch) pendingVerify.delete(r.name);

			const verdict = (r: Rule) => verdicts.get(r.name);
			const modeOf = (r: Rule) => (verdict(r)?.degraded ? "degraded" : "verified");
			const abortSet = batch.filter((r) => {
				if (!r.interrupt) return false;
				const v = verdict(r);
				return v?.confirmed || (v?.degraded && r.verify?.onFail === "fire");
			});
			const remindSet = batch.filter((r) => {
				if (!r.interrupt) return false;
				const v = verdict(r);
				return v?.degraded && r.verify?.onFail === "degrade";
			});
			// Soft-scope confirmed rules disarm silently (unchanged engine semantics).
			const softSet = batch.filter((r) => {
				if (r.interrupt) return false;
				const v = verdict(r);
				return v?.confirmed || v?.degraded;
			});
			const suppressed = batch.filter((r) => {
				const v = verdict(r);
				if (!v || v.confirmed) return false;
				return v.degraded ? r.verify?.onFail === "suppress" : true;
			});

			if (abortSet.length && !abortArmed) {
				abortArmed = true;
				if (ctx.hasUI) ctx.ui.notify(`ttsr: ${abortSet.map((r) => r.name).join(", ")} — aborting (verified)`, "warning");
				try { ctx.abort(); } catch { /* noop */ }
				void deliverAfterAbort(abortSet.map((r) => renderReminder(r)).join("\n\n"), ctx);
				recordFires(abortSet, scope, ctx, { delivered: true, modeOf });
				markInjected(abortSet.map((r) => r.name));
			}
			if (remindSet.length) {
				pi.sendUserMessage(remindSet.map((r) => renderReminder(r)).join("\n\n"), { deliverAs: "followUp" });
				recordFires(remindSet, scope, ctx, { delivered: true, modeOf });
				markInjected(remindSet.map((r) => r.name));
			}
			if (softSet.length) {
				recordFires(softSet, scope, ctx, { delivered: false, modeOf });
				markInjected(softSet.map((r) => r.name));
			}
			noteContextFires([...abortSet, ...remindSet, ...softSet]);
			for (const r of suppressed) suppressCache.set(r.name, { turn: turnCount, len: buffer.length });
		})();
	}

	// A follow-up queued while the aborted run is still settling is stranded: the
	// loop exits early on stopReason "aborted" without draining the queue, and the
	// session skips continuation because it recorded the abort. Wait for settle,
	// then re-prompt — an idle prompt starts the fresh turn (or defers cleanly if
	// agent_settled is still emitting).
	async function deliverAfterAbort(reminder: string, ctx: ExtensionContextLike) {
		try {
			const deadline = Date.now() + 15000;
			while (!ctx.isIdle() && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 25));
			}
			if (ctx.isIdle()) pi.sendUserMessage(reminder);
			else pi.sendUserMessage(reminder, { deliverAs: "followUp" });
		} catch { /* delivery is best-effort; never reject from a detached promise */ }
	}

	function handleTextOrThinking(hits: Rule[], ctx: ExtensionContextLike, scope: Scope) {
		const armed = hits.filter((r) => r.interrupt);
		const soft = hits.filter((r) => !r.interrupt);
		if (armed.length && !abortArmed) {
			abortArmed = true;
			if (ctx.hasUI) ctx.ui.notify(`ttsr: ${armed.map((r) => r.name).join(", ")} — aborting`, "warning");
			try { ctx.abort(); } catch { /* noop */ }
			const reminder = armed.map((r) => renderReminder(r)).join("\n\n");
			void deliverAfterAbort(reminder, ctx);
			recordFires(armed, scope, ctx, { delivered: true, modeOf: () => "plain" });
			markInjected(armed.map((r) => r.name));
		}
		if (soft.length) {
			recordFires(soft, scope, ctx, { delivered: false, modeOf: () => "plain" });
			markInjected(soft.map((r) => r.name));
		}
	}

	// ─── Tool-scope rules (regex + AST, reliable block) ─────────────────

	pi.on("tool_call", async (event, ctx) => {
		if (ttsrRules.length === 0) return;

		const input = event.input as { command?: string; path?: string; oldText?: string; newText?: string; content?: string; task?: string; query?: string; prompt?: string };
		const toolPath = input.path ?? "";
		if (event.toolName === "read" && toolPath) recordRead(path.resolve(ctx.cwd ?? process.cwd(), toolPath));
		// Regex haystack includes the tool name so rules can target MCP tools by name
		// (e.g. condition: ["postgres"] matches mcp__postgres__query).
		const regexHay = event.toolName + "\n" + serializeToolInput(event.toolName, input);

		for (const p of pendingFires.filter((f) => f.blocked && f.haystack !== null && !f.userInputSince && f.haystack === regexHay)) {
			resolveFire(p, "retried", { tool: event.toolName });
		}

		const regexHits = matchRegex(regexHay, "tool", toolPath);

		// AST matching only for write/edit (needs file content + a language).
		let astHits: Rule[] = [];
		if (event.toolName === "write") {
			const src = input.content ?? input.newText ?? "";
			if (src) astHits = matchAstRules(src, toolPath);
		} else if (event.toolName === "edit") {
			const src = input.newText ?? "";
			if (src) astHits = matchAstRules(src, toolPath);
		}

		const hits = dedupRules([...regexHits, ...astHits]);
		if (hits.length === 0) return;

		const digest = withDigest(ctx, `TOOL CALL (${event.toolName}):\n${scrubSecrets(serializeToolInput(event.toolName, input)).slice(0, 24000)}`);
		const verdicts = hits.some((r) => r.verify)
			? await runVerify(hits, digest.text, "tool", digest.source)
			: null;
		let fired = hits.filter((r) => {
			const v = verdicts?.get(r.name);
			return !v || v.confirmed || (v.degraded && r.verify?.onFail !== "suppress");
		});
		if (fired.length === 0) return undefined;

		// Per-turn context-push budget (gated first); non-context rules unaffected.
		if (fired.some((r) => r.context && r.context.kind === "trigger")) {
			const allowed = Math.max(0, 2 - pushesThisTurn);
			const ctxFired = fired.filter((r) => r.context && r.context.kind === "trigger");
			if (ctxFired.length > allowed) {
				const sorted = [...ctxFired].sort((a, b) => (a.context!.tier === "gated" ? 0 : 1) - (b.context!.tier === "gated" ? 0 : 1));
				const kept = new Set(sorted.slice(0, allowed).map((r) => r.name));
				fired = fired.filter((r) => !r.context || r.context.kind !== "trigger" || kept.has(r.name));
			}
			pushesThisTurn += fired.filter((r) => r.context && r.context.kind === "trigger").length;
			noteContextFires(fired);
		}
		if (fired.length === 0) return undefined;
		const noBlock = new Set(fired.filter((r) => verdicts?.get(r.name)?.degraded && r.verify?.onFail === "degrade").map((r) => r.name));

		const escalatedBlock = fired.some((r) => r.context && r.context.kind === "trigger" && compliance.get(r.name)?.escalated);
		const willBlock = escalatedBlock || fired.some((r) => r.interrupt && !noBlock.has(r.name));
		recordFires(fired, "tool", ctx, {
			delivered: true,
			modeOf: (r) => (r.verify ? (verdicts?.get(r.name)?.degraded ? "degraded" : "verified") : "plain"),
			tool: event.toolName,
			blocked: willBlock,
			haystack: regexHay,
		});
		markInjected(fired.map((r) => r.name));
		const reminder = fired.map((r) => renderReminder(r, toolPath || undefined)).join("\n\n");

		if (willBlock) {
			if (ctx.hasUI) {
				const tag = fired.map((r) => r.name).join(",");
				ctx.ui.notify(`ttsr: blocked ${event.toolName} (${tag})`, "warning");
			}
			return { block: true, reason: reminder };
		}
		pendingToolReminders.set(event.toolCallId, reminder);
		return undefined;
	});

	pi.on("tool_result", async (event, _ctx) => {
		const pending = pendingToolReminders.get(event.toolCallId);
		if (!pending) return undefined;
		pendingToolReminders.delete(event.toolCallId);
		return { content: [{ type: "text", text: pending }, ...event.content] };
	});

	pi.on("input", async (event) => {
		if (event.source !== "interactive" || pendingFires.length === 0) return;
		if (looksLikeUserCorrection(event.text)) {
			for (const p of [...pendingFires]) resolveFire(p, "user_corrected");
			return;
		}
		for (const p of pendingFires) p.userInputSince = true;
	});

	pi.on("session_shutdown", () => {
		for (const p of [...pendingFires]) resolveFire(p, "unresolved");
	});

	function serializeToolInput(tool: string, input: { command?: string; path?: string; oldText?: string; newText?: string; content?: string; task?: string; query?: string; prompt?: string }): string {
		if (tool === "bash") return input.command ?? "";
		// Include common MCP/tool argument fields so rules can match on them.
		return [input.path ?? "", input.oldText ?? "", input.newText ?? "", input.content ?? "", input.task ?? "", input.query ?? "", input.prompt ?? ""].join("\n");
	}

	// ─── Commands ───────────────────────────────────────────────────────

	pi.registerCommand("ttsr", {
		description: "List loaded rules across all buckets",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (allRules.length === 0) { ctx.ui.notify("No rules loaded.", "info"); return; }
			const lines: string[] = [];
			for (const r of ttsrRules) {
				const fired = injectedNames.has(r.name) ? "fired" : "armed";
				const sc = r.scope.join(",");
				const kinds = [r.conditions.length ? "re" : null, r.astConditions.length ? "ast" : null, r.verify ? "jev" : null].filter(Boolean).join("+") || "re";
				lines.push(`  [ttsr]   ${fired.padEnd(5)} ${r.name.padEnd(26)} ${kinds.padEnd(6)} scope=${sc}`);
			}
			for (const r of rulebookRules) lines.push(`  [book]   loaded ${r.name.padEnd(26)} ${r.description ?? ""}`);
			for (const r of alwaysRules) lines.push(`  [always] loaded ${r.name.padEnd(26)} (${r.body.length} chars)`);
			ctx.ui.notify(`TTSR rules (${allRules.length}, ast=${astGrep ? "on" : "off"}):\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("ttsr-reload", {
		description: "Reload rules from disk without restarting",
		handler: async (_args, ctx) => {
			const trusted = ctx.isProjectTrusted();
			allRules = loadAllRules(ctx.cwd, trusted, (m) => { if (ctx.hasUI) ctx.ui.notify(m, "warning"); });
			ttsrRules = allRules.filter((r) => r.bucket === "ttsr");
			rulebookRules = allRules.filter((r) => r.bucket === "rulebook");
			alwaysRules = allRules.filter((r) => r.bucket === "always");
			ctx.ui.notify(
				`ttsr: ${allRules.length} rule(s) [ttsr=${ttsrRules.length} ctx=${registryEntries.length} rulebook=${rulebookRules.length} always=${alwaysRules.length}]`,
				"info",
			);
		},
	});

	pi.registerCommand("contexts", {
		description: "Context registry status; '/contexts prune' adds prune candidates",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (registryEntries.length === 0) { ctx.ui.notify("No context registry loaded.", "info"); return; }
			const wantPrune = (args ?? "").trim() === "prune";
			const stats = contextStats();
			const lines: string[] = [];
			let firedTotal = 0;
			let suppressedTotal = 0;
			for (const e of registryEntries) {
				const t = statsFor(e, stats);
				firedTotal += t.fired;
				suppressedTotal += t.suppressed;
				lines.push(entryStatLine(e, t));
			}
			if (wantPrune) {
				const cands = pruneCandidates(registryEntries, stats);
				lines.push("", cands.length ? `Prune candidates: ${cands.map((c) => c.entry.id).join(", ")}` : "Prune candidates: none");
			}
			ctx.ui.notify(`Context registry (${registryEntries.length} entries, fired=${firedTotal} suppressed=${suppressedTotal}):\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("rules", {
		description: "Alias for /ttsr",
		handler: async (_args, _ctx) => {
			pi.sendUserMessage("/ttsr", { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("omfg", {
		description: "Draft a TTSR rule from a complaint. Usage: /omfg <what went wrong>",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) { ctx.ui.notify("omfg needs a TUI", "warning"); return; }
			const complaint = (args ?? "").trim();
			if (!complaint) { ctx.ui.notify("Usage: /omfg <describe what the model did wrong>", "warning"); return; }
			const trigger = await ctx.ui.input("Regex that matches the model's bad output", "");
			if (!trigger) { ctx.ui.notify("Cancelled.", "info"); return; }
			const name = await ctx.ui.input("Rule name (kebab-case)", "new-rule");
			if (!name) return;
			const file = path.join(ctx.cwd, ".pi", "rules", `${name}.md`);
			const body =
				`---\nname: ${name}\ncondition: ["${trigger.replace(/"/g, '\\"')}"]\nscope: [text, tool]\ninterrupt: true\nrepeat: once\n---\n\n# ${complaint}\n\n${complaint}\n`;
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
			ctx.ui.notify(`Drafted: ${file}\nEdit it, then /ttsr-reload`, "info");
		},
	});

	// ─── Type shim ──────────────────────────────────────────────────────
	type ExtensionContextLike = {
		hasUI: boolean;
		cwd?: string;
		ui: { notify(msg: string, level: "info" | "warning" | "error"): void };
		abort(): void;
		isIdle(): boolean;
		sessionManager?: { getSessionId(): string; getEntries?(): unknown[]; getBranch?(): unknown[] };
	};
}

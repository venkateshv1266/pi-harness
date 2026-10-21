/**
 * The TTSR matching core, extracted from the extension factory so other
 * modules can evaluate a rule against a piece of text without booting pi.
 *
 * refine's probe engine is the first consumer: it measures a staged rule over
 * a fixture corpus with exactly the same frontmatter parsing, scope/glob
 * gating and regex/AST semantics the live engine uses. Nothing here owns
 * runtime state (turn counters, repeat suppression, read receipts) — that
 * stays in index.ts, so "would this pattern match" is a pure function.
 *
 * Dependency-light on purpose: node:path + glob.ts only. ast-grep is an
 * optional native dependency, initialized through `initAstGrep()`; when it is
 * unavailable AST matching returns no hits and callers can record the gap.
 */

import * as path from "node:path";

import { globToRegex } from "./glob.ts";

// ─── ast-grep (optional native dep, initialized lazily) ──────────────────

let astGrep: typeof import("@ast-grep/napi") | null = null;
type SgLang = import("@ast-grep/napi").Lang;
const EXT_TO_LANG: Record<string, SgLang> = {};

/** Load the optional native matcher. Safe to call repeatedly; returns availability. */
export async function initAstGrep(): Promise<boolean> {
	if (astGrep) return true;
	try {
		astGrep = await import("@ast-grep/napi");
		const L = astGrep.Lang;
		Object.assign(EXT_TO_LANG, {
			".ts": L.TypeScript, ".tsx": L.Tsx, ".mts": L.TypeScript, ".cts": L.TypeScript,
			".js": L.JavaScript, ".mjs": L.JavaScript, ".cjs": L.JavaScript, ".jsx": L.JavaScript,
			".css": L.Css, ".html": L.Html, ".htm": L.Html,
		});
		return true;
	} catch {
		// expected: @ast-grep/napi is an optional native dep; degrade to regex-only
		astGrep = null;
		return false;
	}
}

export const astGrepAvailable = (): boolean => astGrep !== null;

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
		// expected: an unparsable snippet never matches an AST condition
		return false;
	}
}

// ─── Types ───────────────────────────────────────────────────────────────

export type Scope = "text" | "thinking" | "tool";
export type Bucket = "ttsr" | "rulebook" | "always";

export interface VerifySpec {
	type: "noul" | "choice" | "score";
	instructions: string;
	criteria?: unknown;
	threshold: number;
	minConfidence: number;
	onFail: "fire" | "degrade" | "suppress";
}

export interface Rule {
	name: string;
	bucket: Bucket;
	conditions: RegExp[];
	astConditions: string[];
	scope: Scope[];
	globs: RegExp[] | null;
	/** Docs whose read already covers this rule: no reminder while one is fresh. */
	coveredBy: RegExp[];
	interrupt: boolean;
	repeat: "once" | { afterGap: number };
	description: string | null;
	verify: VerifySpec | null;
	body: string;
	file: string;
	flags: string;
	context?: { id: string; reads: string[]; tier: string; kind: "trigger" | "delegate" };
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────

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
		try { return JSON.parse(v) as unknown; } catch { /* expected: non-JSON scalar falls through as raw string */ }
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

/** Parse a rule file's source. Returns null for files that are not TTSR rules. */
export function parseRuleSource(raw: string, file: string): Rule | null {
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
	const coveredBy = toGlobList(fm.coveredBy ?? fm.covered_by)?.map(globToRegex) ?? [];
	const interruptDefault = scope.includes("tool") ? false : true;
	const interrupt = fm.interrupt === undefined ? interruptDefault : Boolean(fm.interrupt);
	const repeat = parseRepeat(fm.repeat);
	const flags = typeof fm.flags === "string" ? fm.flags : "";

	return { name, bucket, conditions, astConditions, scope, globs, coveredBy, interrupt, repeat, description, verify, body, file, flags };
}

// ─── Matching ────────────────────────────────────────────────────────────

/**
 * Regex hits for one haystack. Pure: repeat suppression, read receipts and
 * turn state are the live engine's concern, not the matcher's.
 */
export function matchRules(rules: readonly Rule[], buffer: string, scope: Scope, toolPath?: string): Rule[] {
	const hits: Rule[] = [];
	for (const rule of rules) {
		if (!rule.scope.includes(scope)) continue;
		if (scope === "tool" && rule.globs) {
			if (!toolPath || !rule.globs.some((g) => g.test(toolPath))) continue;
		}
		if (rule.conditions.length && rule.conditions.some((re) => re.test(buffer))) hits.push(rule);
	}
	return hits;
}

/** AST hits for one source snippet (tool scope only, language from the path). */
export function matchAstRules(rules: readonly Rule[], source: string, toolPath: string): Rule[] {
	const lang = langFromPath(toolPath);
	if (!lang) return [];
	const hits: Rule[] = [];
	for (const rule of rules) {
		if (!rule.scope.includes("tool")) continue;
		if (!rule.astConditions.length) continue;
		if (rule.globs && !rule.globs.some((g) => g.test(toolPath))) continue;
		if (matchAst(source, rule.astConditions, lang)) hits.push(rule);
	}
	return hits;
}

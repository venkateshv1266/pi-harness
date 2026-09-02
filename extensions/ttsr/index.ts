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
	body: string;
	file: string;
	flags: string;
}

interface PersistedInjection {
	rules: string[];
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
	let gapCounters = new Map<string, number>();
	let turnCount = 0;

	let textBuf = "";
	let thinkingBuf = "";
	let toolBufs = new Map<number, string>();

	let abortArmed = false;
	let pendingToolReminders = new Map<string, string>();

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
		const raw = fs.readFileSync(file, "utf8");
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

		return { name, bucket, conditions, astConditions, scope, globs, interrupt, repeat, description, body, file, flags };
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

	function globToRegex(glob: string): RegExp {
		let re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		re = re.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
		return new RegExp(re.endsWith("$") ? `^${re}` : `^${re}$`);
	}

	function parseRepeat(v: unknown): Rule["repeat"] {
		if (typeof v !== "string") return "once";
		const m = v.match(/^after-gap:?(\d+)$/i);
		if (m) return { afterGap: Math.max(1, parseInt(m[1], 10)) };
		return "once";
	}

	// ─── Repeat / suppression ───────────────────────────────────────────────

	function canFire(rule: Rule): boolean {
		if (rule.repeat === "once") return !injectedNames.has(rule.name);
		const last = gapCounters.get(rule.name) ?? -Infinity;
		return turnCount - last >= rule.repeat.afterGap;
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

	// ─── System prompt injection (always-apply + rulebook) ──────────────

	pi.on("before_agent_start", async (event) => {
		const parts: string[] = [];

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

	// ─── Session lifecycle ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const trusted = ctx.isProjectTrusted();
		allRules = loadRules(ctx.cwd, trusted);
		ttsrRules = allRules.filter((r) => r.bucket === "ttsr");
		rulebookRules = allRules.filter((r) => r.bucket === "rulebook");
		alwaysRules = allRules.filter((r) => r.bucket === "always");
		injectedNames = new Set();
		gapCounters = new Map();
		turnCount = 0;
		restoreInjected(ctx.sessionManager.getBranch() as unknown as { type: string; customType?: string; data?: unknown }[]);

		if (ctx.hasUI) {
			const counts = `${allRules.length} rule(s) [ttsr=${ttsrRules.length} rulebook=${rulebookRules.length} always=${alwaysRules.length}]`;
			ctx.ui.setStatus("ttsr", allRules.length ? `ttsr: ${counts}` : undefined);
			if (astGrep === null && allRules.some((r) => r.astConditions.length)) {
				ctx.ui.notify("ttsr: @ast-grep/napi not loaded — astCondition rules will be ignored", "warning");
			}
		}
	});

	// ─── Turn / streaming ───────────────────────────────────────────────

	pi.on("turn_start", () => {
		abortArmed = false;
		pendingToolReminders = new Map();
		textBuf = "";
		thinkingBuf = "";
		toolBufs = new Map();
	});

	pi.on("turn_end", () => { turnCount++; });

	pi.on("message_update", async (event, ctx) => {
		if (ttsrRules.length === 0) return;
		const e = event.assistantMessageEvent;

		if (e.type === "text_delta") {
			textBuf += e.delta;
			const hits = matchRegex(textBuf, "text");
			if (hits.length) handleTextOrThinking(hits, ctx);
		} else if (e.type === "thinking_delta") {
			thinkingBuf += e.delta;
			const hits = matchRegex(thinkingBuf, "thinking");
			if (hits.length) handleTextOrThinking(hits, ctx);
		} else if (e.type === "toolcall_delta") {
			const prev = toolBufs.get(e.contentIndex) ?? "";
			toolBufs.set(e.contentIndex, prev + e.delta);
		}
	});

	function handleTextOrThinking(hits: Rule[], ctx: ExtensionContextLike) {
		const armed = hits.filter((r) => r.interrupt);
		const soft = hits.filter((r) => !r.interrupt);
		if (armed.length && !abortArmed) {
			abortArmed = true;
			if (ctx.hasUI) ctx.ui.notify(`ttsr: ${armed.map((r) => r.name).join(", ")} — aborting`, "warning");
			try { ctx.abort(); } catch { /* noop */ }
			const reminder = armed.map((r) => renderReminder(r)).join("\n\n");
			pi.sendUserMessage(reminder, { deliverAs: "followUp" });
			markInjected(armed.map((r) => r.name));
		}
		if (soft.length) markInjected(soft.map((r) => r.name));
	}

	// ─── Tool-scope rules (regex + AST, reliable block) ─────────────────

	pi.on("tool_call", async (event, ctx) => {
		if (ttsrRules.length === 0) return;

		const input = event.input as { command?: string; path?: string; oldText?: string; newText?: string; content?: string; task?: string; query?: string; prompt?: string };
		const toolPath = input.path ?? "";
		// Regex haystack includes the tool name so rules can target MCP tools by name
		// (e.g. condition: ["postgres"] matches mcp__postgres__query).
		const regexHay = event.toolName + "\n" + serializeToolInput(event.toolName, input);

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

		markInjected(hits.map((r) => r.name));
		const reminder = hits.map((r) => renderReminder(r, toolPath || undefined)).join("\n\n");

		if (hits.some((r) => r.interrupt)) {
			if (ctx.hasUI) {
				const tag = hits.map((r) => r.name).join(",");
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
				const kinds = [r.conditions.length ? "re" : null, r.astConditions.length ? "ast" : null].filter(Boolean).join("+") || "re";
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
			allRules = loadRules(ctx.cwd, trusted);
			ttsrRules = allRules.filter((r) => r.bucket === "ttsr");
			rulebookRules = allRules.filter((r) => r.bucket === "rulebook");
			alwaysRules = allRules.filter((r) => r.bucket === "always");
			ctx.ui.notify(
				`ttsr: ${allRules.length} rule(s) [ttsr=${ttsrRules.length} rulebook=${rulebookRules.length} always=${alwaysRules.length}]`,
				"info",
			);
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
		ui: { notify(msg: string, level: "info" | "warning" | "error"): void };
		abort(): void;
	};
}

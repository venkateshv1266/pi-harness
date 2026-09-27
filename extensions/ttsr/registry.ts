/**
 * Context registry → synthesized TTSR rules.
 *
 * Single source of truth:
 *   ~/.pi/contexts/registry.yaml        (user contexts)
 *   <dir>/contexts/registry.yaml        (project contexts, trusted only)
 *
 * The project registry is the nearest ancestor of cwd carrying
 * `contexts/registry.yaml` (up to $HOME), so repo-local docs registered at a
 * workspace root also apply inside its sub-repos. Project entries win by id.
 *
 * Each active entry with `triggers` compiles to one synthesized TTSR rule per
 * trigger group (groups share the same `globs` gate). The engine parses the
 * generated source with its normal rule parser, so semantics stay identical to
 * hand-written rules. Also powers the context_list / read_context tools and the
 * generated ~/.pi/contexts/INDEX.md.
 *
 * Tiers: advisory | gated | index-only (index-only entries synthesize nothing;
 * they are pull-only via context_list/read_context). Retired entries are
 * skipped. Compliance escalation for gated entries is a later phase — all
 * synthesized rules currently prepend a reminder (interrupt: false).
 *
 * Trigger model: `tool` is matched against the tool-name prefix of the engine's
 * haystack (`toolName + "\n" + args`); a trailing `$` is treated as the tool
 * name boundary; `match`, when present, must also match somewhere after the
 * tool name. One globs-less and one globs-bearing trigger of the same entry
 * produce two rules (`ctx-<id>`, `ctx-<id>-2`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export interface RegistryTrigger {
	tool?: string;
	match?: string;
	globs?: string[];
}

export interface RegistryGate {
	mode?: "necessity" | "none";
	threshold?: number;
	criteria?: Record<string, string>;
}

export interface RegistryEntry {
	id: string;
	root?: "user" | "project";
	file?: string;
	when?: string;
	tier?: "advisory" | "gated" | "index-only";
	onFail?: "fire" | "degrade" | "suppress";
	rearm?: string;
	status?: string;
	subagents?: boolean;
	reads?: string[];
	triggers?: RegistryTrigger[];
	gate?: RegistryGate;
}

export interface LoadedEntry extends RegistryEntry {
	origin: "user" | "project";
	registryFile: string;
	tier: "advisory" | "gated" | "index-only";
	onFail: "fire" | "degrade" | "suppress";
	gateMode: "necessity" | "none";
	threshold: number;
	criteria: Record<string, string>;
	resolvedReads: string[];
}

export interface RegistryDigestConfig {
	goalspecEntryType: string;
	goalEntryType: string;
}

export interface SynthesizedRule {
	name: string;
	id: string;
	source: string;
	reads: string[];
	tier: LoadedEntry["tier"];
	kind: "trigger" | "delegate";
}

interface RegistryDefaults {
	root?: "user" | "project";
	tier?: "advisory" | "gated" | "index-only";
	onFail?: "fire" | "degrade" | "suppress";
	rearm?: string;
	gate?: RegistryGate;
}

// Wired via registry.yaml (`digest:`); empty = GoalSpec lookup disabled and the
// digest falls back to the last user message. Keeps the mirrored extension free
// of local wiring.
export const DEFAULT_DIGEST: RegistryDigestConfig = {
	goalspecEntryType: "",
	goalEntryType: "",
};

const DEFAULT_CRITERIA: Record<string, string> = {
	already_covered: "the doc, or equivalent content, was already read this session and the file has not changed since",
	not_needed: "the match is a mention, grep pattern, filename, path segment, or doc/code text — not an execution of the tool or command",
};

function homeDir(): string {
	return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

function userContextDirs(home: string): string[] {
	return [path.join(home, ".pi", "contexts"), path.join(home, ".claude", "contexts")];
}

/** Resolve a registry-relative doc path against the entry's origin roots. */
function resolveDoc(origin: "user" | "project", rel: string, projectBase: string, home: string): string | null {
	const roots = origin === "project" ? [projectBase] : userContextDirs(home);
	for (const root of roots) {
		const p = path.join(root, rel);
		if (fs.existsSync(p)) return p;
	}
	return null;
}

interface RegistryDoc {
	defaults?: RegistryDefaults;
	contexts?: RegistryEntry[];
	digest?: Partial<RegistryDigestConfig>;
}

function readRegistryDoc(file: string, warnings: string[]): RegistryDoc | null {
	if (!fs.existsSync(file)) return null;
	try {
		return (parseYaml(fs.readFileSync(file, "utf8")) ?? {}) as RegistryDoc;
	} catch (e) {
		warnings.push(`${file}: ${(e as Error).message}`);
		return null;
	}
}

function loadOne(doc: RegistryDoc | null, file: string, origin: "user" | "project", projectBase: string, home: string, warnings: string[]): LoadedEntry[] {
	if (!doc) return [];
	const d = doc.defaults ?? {};
	const out: LoadedEntry[] = [];
	for (const c of doc.contexts ?? []) {
		if (!c || typeof c.id !== "string" || !c.id) {
			warnings.push(`${file}: entry without id`);
			continue;
		}
		const resolvedReads: string[] = [];
		const wanted = [c.file, ...(c.reads ?? [])].filter((r): r is string => typeof r === "string" && r.length > 0);
		for (const w of wanted) {
			const p = resolveDoc(origin, w, projectBase, home);
			if (p) {
				if (!resolvedReads.includes(p)) resolvedReads.push(p);
			} else {
				warnings.push(`${c.id}: doc not found: ${w}`);
			}
		}
		const gate: RegistryGate = { ...(d.gate ?? {}), ...(c.gate ?? {}) };
		out.push({
			...c,
			origin,
			registryFile: file,
			tier: c.tier ?? d.tier ?? "advisory",
			onFail: c.onFail ?? d.onFail ?? "suppress",
			gateMode: gate.mode ?? "necessity",
			threshold: gate.threshold ?? 0.8,
			criteria: { ...DEFAULT_CRITERIA, ...(d.gate?.criteria ?? {}), ...(c.gate?.criteria ?? {}) },
			resolvedReads,
		});
	}
	return out;
}

/** Nearest ancestor `<dir>/contexts/registry.yaml` from cwd up to $HOME. */
function findProjectRegistry(cwd: string): string | null {
	const home = path.resolve(homeDir());
	const userRegistry = path.resolve(path.join(home, ".pi", "contexts", "registry.yaml"));
	let dir = path.resolve(cwd);
	for (let i = 0; i < 8; i++) {
		const candidate = path.join(dir, "contexts", "registry.yaml");
		if (path.resolve(candidate) === userRegistry) return null; // already loaded as the user registry
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir || dir === home) break;
		dir = parent;
	}
	return null;
}

export function loadContextRegistry(cwd: string, trusted: boolean): { entries: LoadedEntry[]; warnings: string[]; digest: RegistryDigestConfig } {
	const home = homeDir();
	const warnings: string[] = [];
	const byId = new Map<string, LoadedEntry>();
	const userFile = path.join(home, ".pi", "contexts", "registry.yaml");
	const userDoc = readRegistryDoc(userFile, warnings);
	let digest = mergeDigest(DEFAULT_DIGEST, userDoc?.digest);
	for (const e of loadOne(userDoc, userFile, "user", path.join(home, ".pi", "contexts"), home, warnings)) byId.set(e.id, e);
	if (trusted) {
		const projFile = findProjectRegistry(cwd);
		if (projFile) {
			const projDoc = readRegistryDoc(projFile, warnings);
			digest = mergeDigest(digest, projDoc?.digest);
			for (const e of loadOne(projDoc, projFile, "project", path.dirname(projFile), home, warnings)) byId.set(e.id, e);
		}
	}
	return { entries: [...byId.values()], warnings, digest };
}

function mergeDigest(base: RegistryDigestConfig, override?: Partial<RegistryDigestConfig>): RegistryDigestConfig {
	const out = { ...base };
	if (override && typeof override.goalspecEntryType === "string" && override.goalspecEntryType) out.goalspecEntryType = override.goalspecEntryType;
	if (override && typeof override.goalEntryType === "string" && override.goalEntryType) out.goalEntryType = override.goalEntryType;
	return out;
}

/**
 * `tool` prefix regex for the engine haystack. A trailing `$` becomes the
 * tool-name boundary (`\n`); a missing leading `^` is anchored.
 */
/**
 * `tool` prefix regex for the engine haystack. A trailing `$` becomes a
 * non-consuming tool-name boundary (`(?=\n)`) so following `match` patterns
 * can still see the command-position newline; a missing leading `^` is
 * anchored. Tool regexes without `$` match the tool-name prefix (e.g.
 * `^mcp__grafana` covers `mcp__grafana-prod__...`).
 */
function toolPrefix(tool: string): string {
	let t = tool.trim();
	if (!t) return "";
	if (t.endsWith("$")) t = t.slice(0, -1) + "(?=\\n)";
	if (!t.startsWith("^")) t = "^" + t;
	return t;
}

function triggerCondition(t: RegistryTrigger): string | null {
	if (typeof t.tool !== "string" || !t.tool.trim()) return null;
	const core = toolPrefix(t.tool);
	if (!core) return null;
	return t.match ? `${core}[\\s\\S]*?(?:${t.match})` : core;
}

function verifyJson(e: LoadedEntry): string | null {
	if (e.gateMode === "none") return null;
	const readNow = e.criteria.read_now || e.when || "the event requires reading this context doc now";
	const already = e.criteria.already_covered || DEFAULT_CRITERIA.already_covered;
	const notNeeded = e.criteria.not_needed || DEFAULT_CRITERIA.not_needed;
	const instructions = `Fire ONLY if: ${readNow}. Do not fire if: ${already}; or ${notNeeded}.`;
	return JSON.stringify({ type: "noul", instructions, threshold: e.threshold, onFail: e.onFail });
}

function delegateVerifyJson(e: LoadedEntry, paths: string[]): string {
	const need = e.criteria.read_now || e.when || `the delegated task requires the ${e.id} context`;
	const instructions = `Would the child agent need the ${e.id} context to do this delegated task correctly? Fire ONLY if: ${need}. Do not fire if the task is unrelated, or if the task text already tells the child to read ${paths.length === 1 ? "this doc" : "these docs"}. Firing blocks the spawn so the parent can add the required reads.`;
	return JSON.stringify({ type: "noul", instructions, threshold: Math.max(0.85, e.threshold), onFail: "suppress" });
}

export function synthesizeRules(e: LoadedEntry): SynthesizedRule[] {
	if (e.status === "retired" || e.tier === "index-only") return [];
	const triggers = (e.triggers ?? []).filter((t) => typeof t?.tool === "string" && t.tool.trim().length > 0);
	if (triggers.length === 0) return [];

	const groups = new Map<string, RegistryTrigger[]>();
	for (const t of triggers) {
		const key = JSON.stringify(t.globs ?? []);
		const arr = groups.get(key) ?? [];
		arr.push(t);
		groups.set(key, arr);
	}

	const readPaths = e.resolvedReads.length ? e.resolvedReads : [];
	const body = [
		`# Context: ${e.id}`,
		"",
		e.when ?? "Read this context doc before proceeding.",
		"",
		"Read before proceeding:",
		...readPaths.map((p) => `- ${p}`),
	].join("\n");

	const out: SynthesizedRule[] = [];
	let i = 0;
	for (const trigs of groups.values()) {
		const conditions = trigs.map(triggerCondition).filter((c): c is string => c !== null);
		if (conditions.length === 0) continue;
		const name = i === 0 ? `ctx-${e.id}` : `ctx-${e.id}-${i + 1}`;
		i++;
		const fm: string[] = [`name: ${name}`, `condition: ${JSON.stringify(conditions)}`];
		const globs = trigs[0]?.globs ?? [];
		if (globs.length) fm.push(`globs: ${JSON.stringify(globs)}`);
		fm.push("scope: [tool]", "interrupt: false", "repeat: once");
		const v = verifyJson(e);
		if (v) fm.push(`verify: ${v}`);
		out.push({ name, id: e.id, source: `---\n${fm.join("\n")}\n---\n\n${body}\n`, reads: readPaths, tier: e.tier, kind: "trigger" });
	}

	// Delegation seeding: block the spawn so the parent adds the reads to the
	// child task; the child session starts empty and does not see parent reads.
	if (e.subagents === true && readPaths.length > 0) {
		const name = `ctxdelegate-${e.id}`;
		const body = [
			`# Seed the child with context: ${e.id}`,
			"",
			"Re-issue this delegation with the following added to the task:",
			...readPaths.map((p) => `- "Read ${p} before starting."`),
			"",
			`Why: ${e.when ?? e.id}`,
		].join("\n");
		const fm: string[] = [
			`name: ${name}`,
			`condition: ${JSON.stringify(["^(delegate|subagent_spawn)(?=\\n)"])}`,
			"scope: [tool]",
			"interrupt: true",
			"repeat: once",
			`verify: ${delegateVerifyJson(e, readPaths)}`,
		];
		out.push({ name, id: e.id, source: `---\n${fm.join("\n")}\n---\n\n${body}\n`, reads: readPaths, tier: e.tier, kind: "delegate" });
	}
	return out;
}

export function buildContextRules(cwd: string, trusted: boolean): { rules: SynthesizedRule[]; entries: LoadedEntry[]; warnings: string[]; digest: RegistryDigestConfig } {
	const { entries, warnings, digest } = loadContextRegistry(cwd, trusted);
	const rules = entries.flatMap(synthesizeRules);
	return { rules, entries, warnings, digest };
}

export function contextListText(entries: LoadedEntry[]): string {
	if (entries.length === 0) return "Context registry is empty.";
	const rows = entries.map((e) => {
		const status = e.status && e.status !== "active" ? ` [${e.status}]` : "";
		const docs = e.resolvedReads.length ? `\n    docs: ${e.resolvedReads.join(", ")}` : "";
		return `- ${e.id}${status} (tier=${e.tier}${e.gateMode === "none" ? ", no-gate" : ""})${e.when ? `: ${e.when}` : ""}${docs}`;
	});
	return `Context registry (${entries.length}):\n${rows.join("\n")}`;
}

export function readContextDocs(entries: LoadedEntry[], idList: string): string {
	const ids = idList.split(",").map((s) => s.trim()).filter(Boolean);
	const parts: string[] = [];
	for (const id of ids) {
		const e = entries.find((x) => x.id === id);
		if (!e) {
			parts.push(`No context "${id}". Use context_list to see available ids.`);
			continue;
		}
		if (e.resolvedReads.length === 0) {
			parts.push(`Context "${id}" has no resolvable docs.`);
			continue;
		}
		for (const p of e.resolvedReads) {
			try {
				parts.push(`# ${path.basename(p)}\n\n${fs.readFileSync(p, "utf8")}`);
			} catch {
				parts.push(`Failed to read ${p}`);
			}
		}
	}
	return parts.join("\n\n---\n\n") || "Nothing to read.";
}

export function writeContextIndex(cwd: string, trusted: boolean): string | null {
	const { entries } = loadContextRegistry(cwd, trusted);
	const home = homeDir();
	const file = path.join(home, ".pi", "contexts", "INDEX.md");
	const active = entries.filter((e) => e.status !== "retired");
	const section = (title: string, list: LoadedEntry[]): string =>
		list.length === 0
			? ""
			: [`## ${title}`, "", ...list.map((e) => `- **${e.id}** — ${e.when ?? "(no description)"}${e.resolvedReads.length ? `\n  - ${e.resolvedReads.join("\n  - ")}` : ""}`), ""].join("\n");
	const text = [
		"# Context index (generated — do not hand-edit)",
		"",
		`Generated from registry.yaml at session start (cwd=${cwd}, ${active.length}/${entries.length} active).`,
		"",
		section("Index-only — pull with context_list / read_context", active.filter((e) => e.tier === "index-only")),
		section("Gated — pre-flight before risky actions", active.filter((e) => e.tier === "gated")),
		section("Advisory", active.filter((e) => e.tier === "advisory")),
	].filter(Boolean).join("\n");
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
		return file;
	} catch {
		return null;
	}
}

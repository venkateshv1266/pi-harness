/**
 * The editable harness surface.
 *
 * One declarative registry for every kind of harness edit refine can propose,
 * so validation, staging, arming and the daily digest agree on what the harness
 * is. Dependency-free by design: pure data + pure functions, with the agent root
 * supplied by the caller.
 *
 * All eight kinds are enabled. `extension` bundles carry `index.ts` +
 * `README.md` plus a pairing artifact (a TTSR rule or a context entry) that
 * lands atomically with the source; the compile + fake-pi smoke + safety gate
 * lives in extensions/refine/extension-gate.ts and runs before arming.
 *
 * Frontmatter is parsed strictly here (missing frontmatter is an error), which
 * is why this does not reuse jev-memory's tolerant parseFrontmatter.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export const HARNESS_KINDS = ["rule", "note", "memory", "context", "agent", "skill", "settings", "extension"] as const;

export type HarnessKind = (typeof HARNESS_KINDS)[number];

export type ProposalFiles = Record<string, string>;

export type JevPart = "evidence" | "trigger" | "novelty";

export interface KindSpec {
	kind: HarnessKind;
	label: string;
	/** Whether the background loop may propose this kind without a user asking. */
	autoProposable: boolean;
	/** Whether arming changes live behavior (vs. a passive record). */
	behavioral: boolean;
	/** Jev parts scored for this kind; `trigger` carries the kind-specific question. */
	parts: readonly JevPart[];
	/** Default per-part floors for the auto loop. */
	floors: Partial<Record<JevPart, number>>;
	/** The file shown in review and used for dedupe. */
	primaryFile: (name: string, files: ProposalFiles) => string;
	/** Static validation; returns one actionable sentence, or null when valid. */
	validate: (name: string, files: ProposalFiles) => string | null;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const isSlug = (name: string): boolean => SLUG.test(name);

function frontmatter(content: string): { head: string; body: string } | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (!match) return null;
	return { head: match[1], body: match[2] };
}

function hasKey(head: string, key: string): boolean {
	return new RegExp(`^${key}\\s*:`, "m").test(head);
}

function keyValue(head: string, key: string): string | null {
	const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(head);
	if (!match) return null;
	return match[1].trim().replace(/^["']|["']$/g, "");
}

function validateRule(name: string, files: ProposalFiles): string | null {
	if (Object.keys(files).length !== 1) return "a rule bundle is exactly one file";
	const primary = `${name}.md`;
	const content = files[primary];
	if (typeof content !== "string") return `rule bundle must contain ${primary}`;
	const fm = frontmatter(content);
	if (!fm) return `${primary} is missing YAML frontmatter`;
	if (!hasKey(fm.head, "name")) return `${primary} frontmatter is missing \`name\``;
	if (keyValue(fm.head, "name") !== name) return `${primary} frontmatter name must equal "${name}"`;
	if (!/^(condition|astCondition)\s*:/m.test(fm.head)) return `${primary} needs a \`condition\` or \`astCondition\` trigger`;
	if (!fm.body.trim()) return `${primary} has no reminder body`;
	return null;
}

function validateNote(name: string, files: ProposalFiles): string | null {
	if (Object.keys(files).length !== 1) return "a note bundle is exactly one file";
	const content = files[`${name}.md`];
	if (typeof content !== "string") return `note bundle must contain ${name}.md`;
	if (!content.trim()) return `${name}.md is empty`;
	return null;
}

const MEMORY_TARGETS = new Set(["memory", "user", "failure"]);
const MEMORY_CATEGORIES = new Set(["failure", "correction", "insight", "preference", "convention", "tool-quirk"]);

function validateMemory(_name: string, files: ProposalFiles): string | null {
	if (Object.keys(files).length !== 1) return "a memory bundle is exactly one file";
	const content = files["entry.md"];
	if (typeof content !== "string") return "memory bundle must contain entry.md";
	const fm = frontmatter(content);
	if (!fm) return "entry.md is missing YAML frontmatter";
	const target = keyValue(fm.head, "target");
	if (!target || !MEMORY_TARGETS.has(target)) return "entry.md frontmatter needs target: memory | user | failure";
	const category = keyValue(fm.head, "category");
	if (category && !MEMORY_CATEGORIES.has(category)) return `entry.md category must be one of ${[...MEMORY_CATEGORIES].join(", ")}`;
	const body = fm.body.trim();
	if (!body) return "entry.md has no body";
	if (body.length > 1200) return "entry.md body exceeds 1200 characters — memory entries stay compact";
	return null;
}

function validateContext(name: string, files: ProposalFiles): string | null {
	const doc = files[`${name}.md`];
	const entry = files["entry.yaml"];
	if (typeof doc !== "string" || !doc.trim()) return `context bundle must contain ${name}.md with doc content`;
	if (typeof entry !== "string" || !entry.trim()) return "context bundle must contain entry.yaml (the registry fragment)";
	if (!new RegExp(`^\\s*id\\s*:\\s*["']?${name}["']?\\s*$`, "m").test(entry)) return `entry.yaml must declare id: ${name}`;
	if (!/^\s*file\s*:/m.test(entry)) return "entry.yaml must declare the doc via `file:`";
	if (!/^\s*tier\s*:/m.test(entry) && !/^\s*triggers\s*:/m.test(entry)) return "entry.yaml needs a tier or at least one trigger";
	return null;
}

function requireFrontmatter(name: string, files: ProposalFiles, required: string[]): string | null {
	const primary = Object.keys(files).find((f) => f.endsWith(".md"));
	if (!primary) return "bundle has no markdown file";
	const fm = frontmatter(files[primary]);
	if (!fm) return `${primary} is missing YAML frontmatter`;
	if (!hasKey(fm.head, "name")) return `${primary} frontmatter is missing \`name\``;
	if (keyValue(fm.head, "name") !== name) return `${primary} frontmatter name must equal "${name}"`;
	for (const key of required) {
		if (!hasKey(fm.head, key)) return `${primary} frontmatter is missing \`${key}\``;
	}
	if (!fm.body.trim()) return `${primary} has no body`;
	return null;
}

function validateAgent(name: string, files: ProposalFiles): string | null {
	if (Object.keys(files).length !== 1) return "an agent bundle is exactly one file";
	return requireFrontmatter(name, files, ["description"]);
}

function validateSkill(name: string, files: ProposalFiles): string | null {
	if (Object.keys(files).length !== 1) return "a skill bundle is exactly SKILL.md";
	if (!files["SKILL.md"]) return "skill bundle must contain SKILL.md";
	return requireFrontmatter(name, files, ["description"]);
}

/**
 * Settings changes are deliberately narrow: primitives only, and only in
 * namespaces where a bad value degrades gracefully. Credentials never live here.
 */
export const SETTINGS_ALLOWED_PREFIXES = [
	"modelRouter.",
	"courseCheck.",
	"decisionTuner.",
	"refine.",
] as const;

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function validateSettingsPatch(patch: unknown): string | null {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "settings patch must be a JSON object of key -> value";
	const entries = Object.entries(patch as Record<string, unknown>);
	if (entries.length === 0) return "settings patch is empty";
	if (entries.length > 12) return "settings patch touches more than 12 keys — split it";
	for (const [key, value] of entries) {
		const segments = key.split(".");
		if (segments.some((s) => !s || FORBIDDEN_KEYS.has(s))) return `settings key "${key}" is not allowed`;
		if (!SETTINGS_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			return `settings key "${key}" is outside the allowlist (${SETTINGS_ALLOWED_PREFIXES.join(", ")})`;
		}
		if (value === null) continue;
		if (!["string", "number", "boolean"].includes(typeof value)) return `settings key "${key}" must be a string, number, boolean or null`;
		if (typeof value === "string" && value.length > 200) return `settings key "${key}" value is too long`;
	}
	return null;
}

/**
 * An extension is only adopted when the trigger that makes it relevant lands
 * with it: either a TTSR rule (pairing.md) or a context doc + registry fragment
 * (pairing.md + pairing.yaml). Tool without trigger rots unused.
 */
export type ExtensionPairing =
	| { kind: "rule"; name: string; content: string }
	| { kind: "context"; name: string; doc: string; entry: string };

export function extensionPairing(files: ProposalFiles): { ok: true; pairing: ExtensionPairing } | { ok: false; error: string } {
	const doc = files["pairing.md"];
	const entry = files["pairing.yaml"];
	if (typeof doc !== "string" || !doc.trim()) {
		return { ok: false, error: "extension bundle needs pairing.md — a TTSR rule or a context doc that fires when the tool is relevant" };
	}

	if (entry !== undefined) {
		if (typeof entry !== "string" || !entry.trim()) return { ok: false, error: "pairing.yaml is empty" };
		const id = /^\s*id\s*:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(entry)?.[1];
		if (!id || !isSlug(id)) return { ok: false, error: "pairing.yaml must declare a kebab-case id" };
		if (!new RegExp(`^\\s*file\\s*:\\s*["']?${id}\\.md["']?\\s*$`, "m").test(entry)) {
			return { ok: false, error: `pairing.yaml must declare file: ${id}.md` };
		}
		if (!/^\s*tier\s*:/m.test(entry) && !/^\s*triggers\s*:/m.test(entry)) {
			return { ok: false, error: "pairing.yaml needs a tier or at least one trigger" };
		}
		return { ok: true, pairing: { kind: "context", name: id, doc, entry } };
	}

	const fm = frontmatter(doc);
	if (!fm) return { ok: false, error: "pairing.md (TTSR rule) is missing YAML frontmatter" };
	const ruleName = keyValue(fm.head, "name");
	if (!ruleName || !isSlug(ruleName)) return { ok: false, error: "pairing.md frontmatter needs a kebab-case `name`" };
	if (!/^(condition|astCondition)\s*:/m.test(fm.head)) return { ok: false, error: "pairing.md needs a `condition` or `astCondition` trigger" };
	if (!fm.body.trim()) return { ok: false, error: "pairing.md has no reminder body" };
	return { ok: true, pairing: { kind: "rule", name: ruleName, content: doc } };
}

/** Machine-checkable usage signal, e.g. `tool:json_diff` — read by the tuner later. */
export function validateExpectation(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return "extension proposals need an expectation (tool:<name> or command:<name>)";
	if (!/^(tool|command):[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.trim())) return "expectation must be tool:<name> or command:<name>";
	return null;
}

function validateExtension(_name: string, files: ProposalFiles): string | null {
	const index = files["index.ts"];
	if (typeof index !== "string" || !index.trim()) return "extension bundle must contain index.ts";
	if (!/export\s+default\s+(?:async\s+)?(?:function|\()/.test(index)) return "index.ts must default-export a pi extension factory";
	const readme = files["README.md"];
	if (typeof readme !== "string" || !readme.trim()) return "extension bundle must contain README.md";
	const pairing = extensionPairing(files);
	return pairing.ok ? null : pairing.error;
}

function validateSettings(_name: string, files: ProposalFiles): string | null {
	if (Object.keys(files).length !== 1) return "a settings bundle is exactly one file";
	const raw = files["patch.json"];
	if (typeof raw !== "string") return "settings bundle must contain patch.json";
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return "patch.json is not valid JSON";
	}
	return validateSettingsPatch(parsed);
}

export const KIND_SPECS: Record<HarnessKind, KindSpec> = {
	rule: {
		kind: "rule",
		label: "TTSR rule",
		autoProposable: true,
		behavioral: true,
		parts: ["evidence", "trigger", "novelty"],
		floors: { evidence: 0.6, trigger: 0.5, novelty: 0.6 },
		primaryFile: (name) => `${name}.md`,
		validate: validateRule,
	},
	note: {
		kind: "note",
		label: "note",
		autoProposable: true,
		behavioral: false,
		parts: ["evidence", "novelty"],
		floors: { evidence: 0.6, novelty: 0.6 },
		primaryFile: (name) => `${name}.md`,
		validate: validateNote,
	},
	memory: {
		kind: "memory",
		label: "memory entry",
		autoProposable: true,
		behavioral: true,
		parts: ["evidence", "trigger", "novelty"],
		floors: { evidence: 0.6, trigger: 0.55, novelty: 0.6 },
		primaryFile: () => "entry.md",
		validate: validateMemory,
	},
	context: {
		kind: "context",
		label: "context entry",
		autoProposable: true,
		behavioral: true,
		parts: ["evidence", "trigger", "novelty"],
		floors: { evidence: 0.6, trigger: 0.6, novelty: 0.6 },
		primaryFile: (name) => `${name}.md`,
		validate: validateContext,
	},
	agent: {
		kind: "agent",
		label: "subagent definition",
		autoProposable: true,
		behavioral: true,
		parts: ["evidence", "trigger", "novelty"],
		floors: { evidence: 0.6, trigger: 0.55, novelty: 0.6 },
		primaryFile: (name) => `${name}.md`,
		validate: validateAgent,
	},
	skill: {
		kind: "skill",
		label: "skill",
		autoProposable: true,
		behavioral: true,
		parts: ["evidence", "trigger", "novelty"],
		floors: { evidence: 0.6, trigger: 0.55, novelty: 0.6 },
		primaryFile: () => "SKILL.md",
		validate: validateSkill,
	},
	settings: {
		kind: "settings",
		label: "settings patch",
		autoProposable: true,
		behavioral: true,
		parts: ["evidence", "trigger", "novelty"],
		floors: { evidence: 0.7, trigger: 0.7, novelty: 0.5 },
		primaryFile: () => "patch.json",
		validate: validateSettings,
	},
	extension: {
		kind: "extension",
		label: "pi extension",
		autoProposable: true,
		behavioral: true,
		parts: ["evidence", "trigger", "novelty"],
		floors: { evidence: 0.7, trigger: 0.7, novelty: 0.6 },
		primaryFile: () => "index.ts",
		validate: validateExtension,
	},
};

export const PROPOSABLE_KINDS = HARNESS_KINDS.filter((kind) => KIND_SPECS[kind].autoProposable);

export type BundleValidation = { ok: true } | { ok: false; error: string };

export function validateBundle(kind: HarnessKind, name: string, files: ProposalFiles): BundleValidation {
	if (!isSlug(name)) return { ok: false, error: `name "${name}" must be kebab-case` };
	const spec = KIND_SPECS[kind];
	if (!spec) return { ok: false, error: `unknown kind "${kind}"` };
	if (!spec.autoProposable) {
		return { ok: false, error: `${kind} proposals are gated until wave 2 (compile + fake-pi smoke + safety scan)` };
	}
	const entries = Object.entries(files);
	if (entries.length === 0) return { ok: false, error: "bundle has no files" };
	if (entries.length > 24) return { ok: false, error: "bundle has more than 24 files" };
	for (const [rel, content] of entries) {
		if (!rel || rel.startsWith("/") || rel.includes("..") || rel.includes("\\")) {
			return { ok: false, error: `bundle path "${rel}" must be relative and stay inside the bundle` };
		}
		if (typeof content !== "string") return { ok: false, error: `bundle file "${rel}" has no string content` };
		if (content.length > 120_000) return { ok: false, error: `bundle file "${rel}" exceeds 120k characters` };
	}
	const error = spec.validate(name, files);
	return error ? { ok: false, error } : { ok: true };
}

export function primaryContent(kind: HarnessKind, name: string, files: ProposalFiles): string {
	const preferred = KIND_SPECS[kind].primaryFile(name, files);
	if (typeof files[preferred] === "string") return files[preferred];
	const first = Object.keys(files).sort()[0];
	return first ? files[first] : "";
}

/** Stable bundle hash for dedupe: order-independent over paths, whitespace-normalized. */
export function bundleHash(kind: HarnessKind, name: string, files: ProposalFiles): string {
	const normalized = Object.keys(files)
		.sort()
		.map((rel) => `${rel}\u0000${files[rel].replace(/\s+/g, " ").trim()}`)
		.join("\u0001");
	return createHash("sha256").update(`${kind}\u0001${name}\u0001${normalized}`).digest("hex");
}

/** Legacy single-content hash, kept for rejected entries written before bundles. */
export function contentHash(content: string): string {
	return createHash("sha256").update(content.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex");
}

export const stagingDir = (refineRoot: string, kind: HarnessKind, name: string): string =>
	join(refineRoot, "staging", kind, name);

export const stagingFilesDir = (refineRoot: string, kind: HarnessKind, name: string): string =>
	join(stagingDir(refineRoot, kind, name), "files");

export interface StagedManifest {
	kind: HarnessKind;
	name: string;
	title: string;
	evidence: string;
	score: number;
	parts: Record<string, number>;
	session: string;
	stagedAt: string;
	trigger: string;
	tier?: "ready" | "near-miss";
	files: ProposalFiles;
	/** Extension usage signal (`tool:<name>` / `command:<name>`), read by the daily snapshot. */
	expectation?: string;
	probe?: Record<string, unknown>;
}

const DIGEST_EXCLUDES = new Set([
	"node_modules",
	".git",
	"package-lock.json",
	"index.js",
	"index.d.ts",
	"tsconfig.tsbuildinfo",
]);

function walk(root: string, rel: string, out: string[], depth: number): void {
	if (depth > 6) return;
	let entries: string[];
	try {
		entries = readdirSync(join(root, rel));
	} catch (error) {
		// expected: surface directory is absent (e.g. no agents yet) — nothing to digest
		void error;
		return;
	}
	for (const entry of entries.sort()) {
		if (DIGEST_EXCLUDES.has(entry) || entry.startsWith(".")) continue;
		const next = rel ? posix.join(rel, entry) : entry;
		const abs = join(root, next);
		let info: ReturnType<typeof statSync>;
		try {
			info = statSync(abs);
		} catch (error) {
			// expected: entry vanished between readdir and stat — skip it
			void error;
			continue;
		}
		if (info.isDirectory()) {
			walk(root, next, out, depth + 1);
		} else if (info.size <= 512 * 1024) {
			out.push(next);
		}
	}
}

function hashFile(abs: string): string {
	try {
		return createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 16);
	} catch (error) {
		// expected: unreadable file — mark it so the digest still changes deterministically
		void error;
		return "unreadable";
	}
}

/**
 * Digest of the armed harness: rules, agents, skills, contexts, extensions,
 * settings and memory. Disabled files are not armed and are excluded. This is
 * what makes "the harness changed today" provable and what probe/adoption
 * records key on.
 */
export function harnessDigest(agentRoot: string): string {
	const files: string[] = [];
	const include = (rel: string): void => {
		const abs = join(agentRoot, rel);
		if (!existsSync(abs)) return;
		try {
			if (statSync(abs).isFile()) files.push(rel.replaceAll("\\", "/"));
		} catch (error) {
			// expected: unreadable settings file — leave it out rather than fail
			void error;
		}
	};

	for (const rel of ["rules", "agents", "skills", "contexts", "extensions", "jev-memory"]) {
		walk(agentRoot, rel, files, 0);
	}
	include("settings.json");

	const armed = files.filter((rel) => {
		if (rel.endsWith(".disabled")) return false;
		if (rel.startsWith("contexts/INDEX.md")) return false;
		return true;
	});

	const lines = armed
		.sort()
		.map((rel) => `${rel}\u0000${hashFile(join(agentRoot, rel))}`)
		.join("\n");
	return createHash("sha256").update(lines).digest("hex").slice(0, 16);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const segments = path.split(".");
	let cursor = target;
	for (const segment of segments.slice(0, -1)) {
		const next = cursor[segment];
		if (!next || typeof next !== "object" || Array.isArray(next)) cursor[segment] = {};
		cursor = cursor[segment] as Record<string, unknown>;
	}
	cursor[segments[segments.length - 1]] = value;
}

/** Apply a validated settings patch to a settings object (pure; returns a copy). */
export function applySettingsPatch(
	settings: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const next = structuredClone(settings);
	for (const [key, value] of Object.entries(patch)) setPath(next, key, value);
	return next;
}

/** Human-readable diff lines for review display. */
export function describeSettingsPatch(
	settings: Record<string, unknown>,
	patch: Record<string, unknown>,
): string[] {
	const read = (obj: Record<string, unknown>, path: string): unknown => {
		let cursor: unknown = obj;
		for (const segment of path.split(".")) {
			if (!cursor || typeof cursor !== "object") return undefined;
			cursor = (cursor as Record<string, unknown>)[segment];
		}
		return cursor;
	};
	return Object.entries(patch).map(([key, value]) => {
		const current = read(settings, key);
		const from = current === undefined ? "(unset)" : JSON.stringify(current);
		return `${key}: ${from} → ${JSON.stringify(value)}`;
	});
}

/**
 * Harness lessons library — the compounding half of the self-improvement loop.
 *
 * An experience pass distils at most ONE lesson from a window of outcomes
 * (armed → rolled back, gate-blocked, probe false-positive, pruned). Lessons
 * are grouped by router-class domain so the planner can recall the relevant
 * class instead of one flat blob:
 *
 *   ~/.pi/agent/harness-library/<domain>/INDEX.md
 *   ~/.pi/agent/harness-library/<domain>/entries/<slug>.md
 *
 * Every pass is deterministic and structural: a lesson exists only when the
 * record shows a concrete contrast (something was proposed and then rejected,
 * blocked, pruned, or measured wrong). A no-op window produces NO_ENTRY — no
 * file, no placeholder — which is the feature, not a failure.
 *
 * Recall is domain-matched and recency-ranked, bounded in characters so the
 * planner prompt cannot grow without limit. Entries carry the audit ids they
 * rest on and the harness digest at adoption.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { logDecision, logEvent } from "../../utils/jev-outcomes.ts";
import type { HarnessKind } from "../../utils/harness-surface.ts";

export const LIBRARY_DOMAINS = ["rule-triggers", "extension-adoption", "settings-tiers", "context-precision", "general"] as const;
export type LibraryDomain = (typeof LIBRARY_DOMAINS)[number];

export type Lesson = {
	domain: LibraryDomain;
	/** Shape of the situation — not this session's facts. */
	cue: string;
	/** The operation to apply next time, naming kind + target. */
	lesson: string;
	/** Audit/history ids the lesson rests on. */
	evidence: string[];
	confidence: number;
	created?: string;
	/** Armed-harness digest when the lesson was adopted. */
	digest?: string;
};

export type LibraryEntry = Lesson & { id: string; path: string; created: string };

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;

export function domainForKind(kind: HarnessKind): LibraryDomain {
	if (kind === "rule") return "rule-triggers";
	if (kind === "extension") return "extension-adoption";
	if (kind === "settings") return "settings-tiers";
	if (kind === "context") return "context-precision";
	return "general";
}

const domainDir = (root: string, domain: LibraryDomain): string => join(root, domain);
const entriesDir = (root: string, domain: LibraryDomain): string => join(domainDir(root, domain), "entries");
const indexFile = (root: string, domain: LibraryDomain): string => join(domainDir(root, domain), "INDEX.md");

const slugify = (text: string): string => {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return slug || "lesson";
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

/** Jaccard similarity over normalized token sets; used for cue dedupe. */
export function cueSimilarity(a: string, b: string): number {
	const tokens = (text: string): Set<string> => new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean));
	const left = tokens(a);
	const right = tokens(b);
	if (left.size === 0 || right.size === 0) return left.size === right.size ? 1 : 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared++;
	return shared / (left.size + right.size - shared);
}

type ParsedLesson = { head: Record<string, string>; body: string };

function parseLesson(raw: string): ParsedLesson | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!match) return null;
	const head: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!kv) continue;
		head[kv[1]] = kv[2].trim();
	}
	return { head, body: match[2].trim() };
}

const unquote = (value: string): string =>
	value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : value;

const parseEvidence = (value: string | undefined): string[] => {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		// expected: an older entry may carry a plain comma list
		return value.split(",").map((item) => item.trim()).filter(Boolean);
	}
};

async function readDomainEntries(root: string, domain: LibraryDomain): Promise<LibraryEntry[]> {
	let files: string[];
	try {
		files = (await readdir(entriesDir(root, domain))).filter((file) => file.endsWith(".md")).sort();
	} catch (error) {
		// expected: the domain has no entries yet
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const entries: LibraryEntry[] = [];
	for (const file of files) {
		const path = join(entriesDir(root, domain), file);
		let parsed: ParsedLesson | null;
		try {
			parsed = parseLesson(await readFile(path, "utf8"));
		} catch (error) {
			// expected: an entry removed between readdir and read
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!parsed) continue;
		const cue = unquote(parsed.head.cue ?? "");
		if (!cue || !parsed.body) continue;
		entries.push({
			id: unquote(parsed.head.id ?? file.replace(/\.md$/, "")),
			domain,
			cue,
			lesson: parsed.body,
			evidence: parseEvidence(parsed.head.evidence),
			confidence: Number(parsed.head.confidence ?? "0.6") || 0.6,
			created: unquote(parsed.head.created ?? ""),
			digest: parsed.head.digest ? unquote(parsed.head.digest) : undefined,
			path,
		});
	}
	return entries;
}

/** All entries across (optionally) the given domains, newest first. */
export async function readLibraryEntries(root: string, domains: readonly LibraryDomain[] = LIBRARY_DOMAINS): Promise<LibraryEntry[]> {
	const all: LibraryEntry[] = [];
	for (const domain of domains) all.push(...(await readDomainEntries(root, domain)));
	return all.sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
}

export type LessonWrite =
	| { written: true; entry: LibraryEntry }
	| { written: false; reason: "no-entry" | "duplicate"; duplicateOf?: string };

/** Write one lesson. NO_ENTRY and cue-dedupe are enforced here, not by callers. */
export async function writeLesson(root: string, lesson: Lesson, opts: { now?: Date; digest?: string } = {}): Promise<LessonWrite> {
	const cue = lesson.cue.trim();
	const body = lesson.lesson.trim();
	if (!cue || !body) return { written: false, reason: "no-entry" };
	const domain = LIBRARY_DOMAINS.includes(lesson.domain) ? lesson.domain : "general";
	const created = typeof lesson.created === "string" ? lesson.created : (opts.now ?? new Date()).toISOString();

	const existing = await readDomainEntries(root, domain);
	const duplicate = existing.find((entry) => cueSimilarity(entry.cue, cue) >= 0.8);
	if (duplicate) return { written: false, reason: "duplicate", duplicateOf: duplicate.id };

	let base = slugify(cue);
	let id = base;
	let suffix = 2;
	while (existing.some((entry) => entry.id === id)) {
		id = `${base}-${suffix}`;
		suffix++;
	}

	const dir = entriesDir(root, domain);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${id}.md`);
	const head = [
		"---",
		`id: ${id}`,
		`domain: ${domain}`,
		`cue: ${JSON.stringify(cue)}`,
		`confidence: ${clamp01(lesson.confidence).toFixed(2)}`,
		`created: ${created}`,
		`evidence: ${JSON.stringify(lesson.evidence)}`,
		...(lesson.digest ?? opts.digest ? [`digest: ${lesson.digest ?? opts.digest}`] : []),
		"---",
		"",
		body,
		"",
	].join("\n");
	await writeFile(path, head, "utf8");

	const index = indexFile(root, domain);
	let current = "";
	try {
		current = await readFile(index, "utf8");
	} catch (error) {
		// expected: first lesson in this domain
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		current = `# Lessons — ${domain}\n`;
	}
	const line = `- [${id}](entries/${id}.md) — ${cue} → ${body.replace(/\s+/g, " ").slice(0, 140)}\n`;
	const marker = current.indexOf("\n\n");
	const next = marker === -1 ? `${current.trimEnd()}\n\n${line}` : `${current.slice(0, marker + 2)}${line}${current.slice(marker + 2)}`;
	await writeFile(index, next.endsWith("\n") ? next : `${next}\n`, "utf8");

	return {
		written: true,
		entry: { ...lesson, domain, cue, lesson: body, created, id, path },
	};
}

const renderEntry = (entry: LibraryEntry): string => `- [${entry.domain}] ${entry.cue} → ${entry.lesson.replace(/\s+/g, " ").slice(0, 240)}`;

/** Render entries for the planner prompt, bounded by characters. */
export function renderLibrary(entries: LibraryEntry[], maxChars = 4000): string[] {
	const lines: string[] = [];
	let used = 0;
	for (const entry of entries) {
		const line = renderEntry(entry);
		if (used + line.length + 1 > maxChars) break;
		lines.push(line);
		used += line.length + 1;
	}
	return lines;
}

export type RecallOptions = {
	/** Free text used to rank cues (usually the trajectory tail or the focus hint). */
	text?: string;
	domains?: readonly LibraryDomain[];
	limit?: number;
	maxChars?: number;
};

/** Domain-matched, recency-ranked recall; cue similarity ranks first when text is given. */
export async function recallLessons(root: string, opts: RecallOptions = {}): Promise<LibraryEntry[]> {
	const entries = await readLibraryEntries(root, opts.domains);
	const text = opts.text?.trim();
	const ranked = text
		? entries
			.map((entry) => ({ entry, score: cueSimilarity(entry.cue, text) }))
			.sort((a, b) => b.score - a.score || b.entry.created.localeCompare(a.entry.created))
			.map((item) => item.entry)
		: entries;
	return ranked.slice(0, opts.limit ?? 12);
}

/** Convenience: recall + render in one call. */
export async function recallLibraryText(root: string, opts: RecallOptions = {}): Promise<{ entries: LibraryEntry[]; lines: string[] }> {
	const entries = await recallLessons(root, opts);
	return { entries, lines: renderLibrary(entries, opts.maxChars ?? 4000) };
}

// ─── Experience pass ─────────────────────────────────────────────────────

export type ExperienceSources = {
	history: JsonRecord[];
	audit: JsonRecord[];
	tuner: JsonRecord[];
	probe: JsonRecord[];
};

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

type Candidate = { lesson: Lesson; at: number };

function historyKey(record: JsonRecord): string | null {
	return str(record.id) ?? str(record.name);
}

/**
 * Distil at most ONE lesson from a window of outcomes. Returns null when the
 * record shows no concrete contrast (NO_ENTRY) — the common, correct outcome.
 */
export function distillLesson(sources: ExperienceSources, now = new Date()): Lesson | null {
	const candidates: Candidate[] = [];
	const push = (lesson: Lesson, at: unknown): void => {
		const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
		candidates.push({ lesson: { ...lesson, created: now.toISOString() }, at: Number.isFinite(ms) ? ms : 0 });
	};

	const rolledBack = sources.history.filter((entry) => entry.rolledBack === true);
	const armedById = new Map<string, JsonRecord>();
	for (const entry of sources.history) {
		const key = historyKey(entry);
		if (key && entry.rolledBack !== true) armedById.set(key, entry);
	}
	for (const rollback of rolledBack) {
		const key = historyKey(rollback);
		const armed = key ? armedById.get(key) ?? rollback : rollback;
		const kind = (str(armed.kind) ?? "rule") as HarnessKind;
		const name = str(armed.name) ?? "unknown";
		const tier = str((asRecord(armed.meta) ?? {}).tier) ?? str(armed.tier);
		push({
			domain: domainForKind(kind),
			cue: `${kind} proposal${tier ? ` staged as ${tier}` : ""} was rolled back after arming`,
			lesson: `Do not arm ${kind} proposals of this shape without a measured probe; "${name}" was rolled back. Require a probe pass or a narrower trigger before arming.`,
			evidence: [key ?? name].filter(Boolean),
			confidence: 0.7,
		}, rollback.timestamp);
	}

	for (const entry of sources.audit) {
		const decision = str(entry.decision);
		const kind = str(entry.kind);
		const name = str(entry.name) ?? "unknown";
		const probe = asRecord(entry.probe);
		if (decision === "gate-blocked" && kind === "extension") {
			const gate = asRecord(entry.gate);
			const reasons = Array.isArray(gate?.reasons) ? gate.reasons.filter((reason): reason is string => typeof reason === "string") : [];
			push({
				domain: "extension-adoption",
				cue: "extension proposal failed the validation gate",
				lesson: `Extension proposals need compile + fake-pi smoke + a precise pairing trigger before arming; "${name}" was blocked${reasons.length ? ` (${reasons.slice(0, 2).join("; ")})` : ""}.`,
				evidence: [str(entry.session) ?? name],
				confidence: 0.8,
			}, entry.ts);
		}
		if (probe && probe.verdict === "false-positive" && (kind === "rule" || kind === "context")) {
			const falseOn = Array.isArray(probe.falseOn) ? probe.falseOn.filter((id): id is string => typeof id === "string") : [];
			push({
				domain: domainForKind(kind as HarnessKind),
				cue: `${kind} trigger measured false positives on the probe corpus`,
				lesson: `Narrow ${kind} triggers of this shape; "${name}" fired on benign fixtures${falseOn.length ? ` (${falseOn.slice(0, 2).join(", ")})` : ""}. Prefer a more specific condition or an intent gate.`,
				evidence: [name],
				confidence: 0.75,
			}, entry.ts);
		}
	}

	for (const proposal of sources.tuner) {
		if (str(proposal.kind) !== "prune" || str(proposal.status) !== "applied") continue;
		const target = str(proposal.target) ?? "unknown";
		push({
			domain: "rule-triggers",
			cue: "rule trigger went many evaluations without a delivered fire and was pruned",
			lesson: `Do not propose "${target}"-shaped triggers; it was pruned (${str(proposal.evidence) ?? "silent for the evaluation window"}). Prefer triggers with a measured corpus hit.`,
			evidence: [target],
			confidence: 0.8,
		}, proposal.decidedAt ?? proposal.createdAt);
	}

	if (candidates.length === 0) return null;
	candidates.sort((a, b) => b.lesson.confidence - a.lesson.confidence || b.at - a.at);
	return candidates[0].lesson;
}

const readJsonl = async (file: string): Promise<JsonRecord[]> => {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		// expected: a subsystem has not written its log yet
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: JsonRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = asRecord(JSON.parse(line));
			if (parsed) records.push(parsed);
		} catch {
			// expected: a truncated final line from a concurrent writer
			continue;
		}
	}
	return records;
};

export type ExperienceResult =
	| { written: true; entry: LibraryEntry }
	| { written: false; reason: "no-entry" | "duplicate"; duplicateOf?: string };

/**
 * Read the outcome window, distil at most one lesson, and (unless disabled)
 * record the pass in the lesson decision stream. Never throws for missing logs.
 */
export async function runExperiencePass(input: {
	refineRoot: string;
	libraryRoot: string;
	decisionsRoot: string;
	trigger: "arm" | "rollback" | "nightly" | "manual";
	now?: Date;
	record?: boolean;
	digest?: string;
}): Promise<ExperienceResult> {
	const sources: ExperienceSources = {
		history: await readJsonl(join(input.refineRoot, "history.jsonl")),
		audit: await readJsonl(join(input.refineRoot, "auto-refine.jsonl")),
		tuner: await readJsonl(join(input.decisionsRoot, "decision-tuner", "proposals.jsonl")),
		probe: await readJsonl(join(input.decisionsRoot, "probe.jsonl")),
	};
	const lesson = distillLesson(sources, input.now);
	const result: ExperienceResult = lesson
		? await writeLesson(input.libraryRoot, lesson, { now: input.now, digest: input.digest })
		: { written: false, reason: "no-entry" };

	if (input.record !== false) {
		const payload = {
			trigger: input.trigger,
			decision: result.written ? "written" : result.reason,
			...(result.written ? { lessonId: result.entry.id, domain: result.entry.domain, cue: result.entry.cue } : {}),
			...(result.written ? {} : { duplicateOf: result.duplicateOf }),
		};
		if (result.written) logDecision("refine-lessons", "lessons.jsonl", payload);
		else logEvent("refine-lessons", "lessons.jsonl", payload);
	}
	return result;
}

/** Entry count per domain, used by snapshots and diagnostics. */
export async function libraryStats(root: string, since: number, until: number): Promise<{ added: number; total: number }> {
	const entries = await readLibraryEntries(root);
	let added = 0;
	for (const entry of entries) {
		const ms = Date.parse(entry.created);
		if (Number.isFinite(ms) && ms >= since && ms < until) added++;
	}
	return { added: entries.length ? added : 0, total: entries.length };
}

export const libraryExists = (root: string): boolean => existsSync(root);

/**
 * Daily improvement snapshots — the materialized view behind the Improvements
 * page. Raw JSONL stays the source of truth: every snapshot is recomputable
 * from `jev-decisions/`, refine's audit/history, the tuner's proposal log, and
 * session files. A snapshot is written at most once per day.
 *
 * This module is deliberately free of `bun:sqlite`: the server and refine's
 * turn-end guard both import it, and the unit tests run it over fixture dirs.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { harnessDigest } from "../../../utils/harness-surface.ts";
import { agentDir, decisionsDir, observatoryDir, refineDir, sessionsRoot } from "./config.ts";

export const SNAPSHOT_VERSION = 1;

export type RuleOutcomeMix = {
	survived: number;
	retried: number;
	user_corrected: number;
	repeated: number;
	unresolved: number;
	total: number;
	survivalRate: number | null;
};

export type ExtensionUsage = {
	name: string;
	expectation: string | null;
	armedAt: string;
	used: boolean;
};

export type Snapshot = {
	version: number;
	date: string;
	generatedAt: string;
	digest: string | null;
	digestFrom: string | null;
	digestChanged: boolean;
	armed: Record<string, string[]>;
	armedCount: number;
	rolledBack: string[];
	pruned: string[];
	staged: { total: number; byKind: Record<string, number>; gatePass: number; gateFail: number };
	rejected: number;
	probe: {
		evaluated: number;
		passed: number;
		rate: number | null;
		note: string;
		rules: { runs: number; evaluated: number; expected: number; hits: number; misses: number; falsePositives: number; unmeasured: number; passRate: number | null };
	};
	ruleOutcomes: RuleOutcomeMix;
	extensions: { armed: number; used: string[]; silent: string[]; unknown: string[]; detail: ExtensionUsage[] };
	lessons: { added: number; recalled: number; libraryPresent: boolean };
	ledger: string[];
	counts: { armed: number; rolledBack: number; pruned: number; rejected: number };
};

export type SnapshotSources = {
	agentRoot: string;
	decisionsRoot: string;
	refineRoot: string;
	sessionsRoot: string;
	snapshotsDir: string;
	libraryRoot: string;
};

export function defaultSources(): SnapshotSources {
	return {
		agentRoot: agentDir(),
		decisionsRoot: decisionsDir(),
		refineRoot: refineDir(),
		sessionsRoot: sessionsRoot(),
		snapshotsDir: join(observatoryDir(), "snapshots"),
		libraryRoot: join(agentDir(), "harness-library"),
	};
}

type JsonRecord = Record<string, unknown>;

const DAY_MS = 86_400_000;

export const todayUtc = (now = new Date()): string => now.toISOString().slice(0, 10);

const startOfDay = (date: string): number => Date.parse(`${date}T00:00:00.000Z`);

function inWindow(ts: unknown, start: number, end: number): boolean {
	if (typeof ts !== "string") return false;
	const ms = Date.parse(ts);
	return Number.isFinite(ms) && ms >= start && ms < end;
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonl(file: string): JsonRecord[] {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line): unknown => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(isRecord);
	} catch (error) {
		// expected: a subsystem has not written its log yet
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function readJsonFile(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as unknown;
	} catch {
		return null;
	}
}

/** Count library lessons whose frontmatter `created` date falls in the window. */
function countLessonsAdded(root: string, start: number, end: number): number {
	let domains: string[];
	try {
		domains = readdirSync(root);
	} catch (error) {
		// expected: the library has not been created yet
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
	let count = 0;
	for (const domain of domains) {
		let files: string[];
		try {
			files = readdirSync(join(root, domain, "entries"));
		} catch (error) {
			// expected: a domain directory without an entries/ subdirectory
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			let raw: string;
			try {
				raw = readFileSync(join(root, domain, "entries", file), "utf8").slice(0, 400);
			} catch (error) {
				// expected: an entry removed between readdir and read
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			const created = /^created:\s*(\S+)/m.exec(raw)?.[1];
			const ms = created ? Date.parse(created) : Number.NaN;
			if (Number.isFinite(ms) && ms >= start && ms < end) count++;
		}
	}
	return count;
}

/** Runtime guard for snapshot files: a truncated or hand-edited file is ignored, not cast. */
function isSnapshot(value: unknown): value is Snapshot {
	if (value === null || typeof value !== "object") return false;
	if (!isRecord(value)) return false;
	const record = value;
	return (
		typeof record.date === "string" &&
		typeof record.version === "number" &&
		typeof record.armed === "object" &&
		record.armed !== null &&
		typeof record.counts === "object" &&
		record.counts !== null
	);
}

function sessionFiles(root: string, modifiedAfter: number): string[] {
	const files: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 6) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith(".")) continue;
			const abs = join(dir, entry);
			let info: ReturnType<typeof statSync>;
			try {
				info = statSync(abs);
			} catch {
				continue;
			}
			if (info.isDirectory()) walk(abs, depth + 1);
			else if (entry.endsWith(".jsonl") && info.mtimeMs >= modifiedAfter && info.size <= 80 * 1024 * 1024) files.push(abs);
		}
	};
	walk(root, 0);
	return files;
}

type ObservedUsage = { toolCalls: Map<string, number>; commandMentions: Map<string, number>; byDay: Map<string, number> };

function scanSessions(root: string, since: number, until: number): ObservedUsage {
	const observed: ObservedUsage = { toolCalls: new Map(), commandMentions: new Map(), byDay: new Map() };
	for (const file of sessionFiles(root, since - DAY_MS)) {
		for (const record of readJsonl(file)) {
			const message = record.message as { role?: unknown; content?: unknown } | undefined;
			if (!message || (message.role !== "assistant" && message.role !== "user")) continue;
			const content = message.content;
			if (!Array.isArray(content)) {
				if (typeof content === "string") count(commandMentionsOf(content), observed, record.ts);
				continue;
			}
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const typed = block as { type?: unknown; name?: unknown; text?: unknown };
				if (typed.type === "toolCall" && typeof typed.name === "string") {
					observed.toolCalls.set(typed.name, (observed.toolCalls.get(typed.name) ?? 0) + 1);
					const day = typeof record.ts === "string" ? record.ts.slice(0, 10) : "";
					if (day) observed.byDay.set(day, (observed.byDay.get(day) ?? 0) + 1);
				}
				if (typed.type === "text" && typeof typed.text === "string") count(commandMentionsOf(typed.text), observed, record.ts);
			}
		}
	}
	return observed;
}

function commandMentionsOf(text: string): string[] {
	return [...text.matchAll(/(?:^|\s)\/([a-z][a-z0-9-]+)/g)].map((match) => match[1]);
}

function count(names: string[], observed: ObservedUsage, _ts: unknown): void {
	for (const name of names) observed.commandMentions.set(name, (observed.commandMentions.get(name) ?? 0) + 1);
}

function extensionUsed(expectation: string | null, observed: ObservedUsage, armDay: string, untilDay: string): boolean {
	if (!expectation) return false;
	const [kind, name] = expectation.split(":") as [string, string];
	if (!name) return false;
	if (kind === "tool") return (observed.toolCalls.get(name) ?? 0) > 0;
	if (kind === "command") {
		// Commands leave no dedicated record; a session mentioning /name is the observable signal.
		if ((observed.commandMentions.get(name) ?? 0) > 0) return true;
		for (const [day] of observed.byDay) if (day >= armDay && day <= untilDay) return true;
	}
	return false;
}

function previousSnapshotFile(sources: SnapshotSources, date: string): string | null {
	let dates: string[];
	try {
		dates = readdirSync(sources.snapshotsDir)
			.filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
			.map((file) => file.replace(/\.json$/, ""))
			.sort();
	} catch {
		return null;
	}
	const earlier = dates.filter((entry) => entry < date);
	return earlier.length > 0 ? join(sources.snapshotsDir, `${earlier[earlier.length - 1]}.json`) : null;
}

function tallyByKind(entries: JsonRecord[], field = "kind"): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const entry of entries) {
		const kind = typeof entry[field] === "string" ? entry[field] : "other";
		const name = typeof entry.name === "string" ? entry.name : "?";
		out[kind] = out[kind] ?? [];
		if (!out[kind].includes(name)) out[kind].push(name);
	}
	return out;
}

/** Compute one day's snapshot from raw streams. Pure over its inputs. */
export function computeSnapshot(date: string, sources: SnapshotSources): Snapshot {
	const start = startOfDay(date);
	const end = start + DAY_MS;
	if (!Number.isFinite(start)) throw new Error(`invalid snapshot date "${date}"`);

	const history = readJsonl(join(sources.refineRoot, "history.jsonl"));
	const audit = readJsonl(join(sources.refineRoot, "auto-refine.jsonl"));
	const ttsr = readJsonl(join(sources.decisionsRoot, "ttsr-jev.jsonl"));
	const tuner = readJsonl(join(sources.decisionsRoot, "decision-tuner", "proposals.jsonl"));
	const probeLog = readJsonl(join(sources.decisionsRoot, "probe.jsonl"));

	const armedEntries = history.filter((entry) => inWindow(entry.timestamp, start, end) && entry.rolledBack !== true);
	const armed = tallyByKind(armedEntries);
	const rolledBack = history
		.filter((entry) => inWindow(entry.timestamp, start, end) && entry.rolledBack === true)
		.map((entry) => `${typeof entry.kind === "string" ? entry.kind : "?"} ${typeof entry.name === "string" ? entry.name : "?"}`);
	const pruned = tuner
		.filter((entry) => entry.kind === "prune" && entry.status === "applied" && inWindow(entry.decidedAt, start, end))
		.map((entry) => `${typeof entry.system === "string" ? entry.system : "?"} ${typeof entry.target === "string" ? entry.target : "?"}`);

	const dayAudit = audit.filter((entry) => inWindow(entry.ts, start, end));
	const stagedEntries = dayAudit.filter((entry) => entry.decision === "staged");
	const stagedByKind: Record<string, number> = {};
	let gatePass = 0;
	let gateFail = 0;
	for (const entry of stagedEntries) {
		const kind = typeof entry.kind === "string" ? entry.kind : "other";
		stagedByKind[kind] = (stagedByKind[kind] ?? 0) + 1;
		const gate = entry.gate as { ok?: unknown } | undefined;
		if (gate && typeof gate.ok === "boolean") {
			if (gate.ok) gatePass += 1;
			else gateFail += 1;
		}
	}

	const gateAudit = dayAudit.filter((entry) => entry.gate && typeof (entry.gate as { ok?: unknown }).ok === "boolean");
	const probeRecords = probeLog.filter((entry) => entry.kind === "decision" && entry.system === "probe" && inWindow(entry.ts, start, end));
	const probeTotals = { runs: probeRecords.length, evaluated: 0, expected: 0, hits: 0, misses: 0, falsePositives: 0, unmeasured: 0, passRate: null as number | null };
	for (const record of probeRecords) {
		const rules = Array.isArray(record.rules) ? record.rules.filter(isRecord) : [];
		probeTotals.evaluated += rules.length;
		for (const rule of rules) {
			if (typeof rule.expected === "number") probeTotals.expected += rule.expected;
			if (typeof rule.hits === "number") probeTotals.hits += rule.hits;
			if (typeof rule.misses === "number") probeTotals.misses += rule.misses;
			if (typeof rule.falsePositives === "number") probeTotals.falsePositives += rule.falsePositives;
			if (rule.verdict === "unmeasured") probeTotals.unmeasured += 1;
		}
	}
	probeTotals.passRate = probeTotals.expected > 0 ? probeTotals.hits / probeTotals.expected : null;
	const rejected = dayAudit.filter((entry) => entry.decision === "discarded" || entry.decision === "gate-blocked").length;

	const outcomes = ttsr.filter((entry) => entry.kind === "outcome" && inWindow(entry.ts, start, end));
	const mix: RuleOutcomeMix = { survived: 0, retried: 0, user_corrected: 0, repeated: 0, unresolved: 0, total: 0, survivalRate: null };
	for (const entry of outcomes) {
		const outcome = typeof entry.outcome === "string" ? entry.outcome : "unresolved";
		if (outcome in mix && outcome !== "total" && outcome !== "survivalRate") mix[outcome as keyof Omit<RuleOutcomeMix, "total" | "survivalRate">] += 1;
		mix.total += 1;
	}
	mix.survivalRate = mix.total > 0 ? mix.survived / mix.total : null;

	const armedExtensions = history.filter(
		(entry) => entry.kind === "extension" && entry.rolledBack !== true && typeof entry.timestamp === "string" && Date.parse(entry.timestamp) < end,
	);
	const since = start - 8 * DAY_MS;
	const observed = scanSessions(sources.sessionsRoot, since, end);
	const extensionDetail: ExtensionUsage[] = armedExtensions.map((entry) => {
		const armedAt = String(entry.timestamp);
		const expectation = typeof entry.expectation === "string" ? entry.expectation : null;
		return {
			name: typeof entry.name === "string" ? entry.name : "?",
			expectation,
			armedAt,
			used: extensionUsed(expectation, observed, armedAt.slice(0, 10), date),
		};
	});
	const used = extensionDetail.filter((entry) => entry.used).map((entry) => entry.name);
	const silent = extensionDetail.filter((entry) => !entry.used && entry.expectation).map((entry) => entry.name);
	const unknown = extensionDetail.filter((entry) => !entry.expectation).map((entry) => entry.name);

	const digest = safeDigest(sources.agentRoot);
	const previousFile = previousSnapshotFile(sources, date);
	const previousRaw = previousFile ? readJsonFile(previousFile) : null;
	const previous = isSnapshot(previousRaw) ? previousRaw : null;
	const digestFrom = typeof previous?.digest === "string" ? previous.digest : null;

	const ledger: string[] = [];
	const armedList = Object.entries(armed).flatMap(([kind, names]) => names.map((name) => `${kind} ${name}`));
	if (armedList.length > 0) ledger.push(`Armed ${armedList.length}: ${armedList.join(", ")}`);
	if (rolledBack.length > 0) ledger.push(`Rolled back ${rolledBack.length}: ${rolledBack.join(", ")}`);
	if (pruned.length > 0) ledger.push(`Pruned ${pruned.length}: ${pruned.join(", ")}`);
	if (stagedEntries.length > 0) ledger.push(`Staged ${stagedEntries.length} (gate ${gatePass} pass / ${gateFail} fail)`);
	if (probeTotals.expected > 0) ledger.push(`Probes: ${probeTotals.hits}/${probeTotals.expected} hit, ${probeTotals.falsePositives} false-pos`);
	if (rejected > 0) ledger.push(`Rejected ${rejected}`);
	if (mix.total > 0) {
		ledger.push(`Rules: ${mix.survived} survived, ${mix.retried} retried, ${mix.user_corrected} corrected, ${mix.repeated} repeated, ${mix.unresolved} unresolved`);
	}
	if (used.length > 0 || silent.length > 0) ledger.push(`Extensions: ${used.length} used${used.length ? ` (${used.join(", ")})` : ""}, ${silent.length} silent${silent.length ? ` (${silent.join(", ")})` : ""}`);
	if (digest && digestFrom) ledger.push(digest === digestFrom ? `Harness unchanged (${digest})` : `Harness changed: ${digestFrom} → ${digest}`);
	else if (digest) ledger.push(`Harness digest ${digest} (no earlier snapshot)`);

	const libraryPresent = existsSync(sources.libraryRoot);
	const lessonsAdded = countLessonsAdded(sources.libraryRoot, start, end);
	const recalledIds = new Set<string>();
	for (const entry of [...history, ...audit]) {
		const ts = typeof entry.timestamp === "string" ? entry.timestamp : entry.ts;
		if (!inWindow(ts, start, end) || !Array.isArray(entry.recalled)) continue;
		for (const id of entry.recalled) if (typeof id === "string") recalledIds.add(id);
	}
	if (lessonsAdded > 0 || recalledIds.size > 0) ledger.push(`Lessons: ${lessonsAdded} added, ${recalledIds.size} recalled`);

	if (ledger.length === 0) ledger.push("No harness changes and no rule outcomes recorded");

	return {
		version: SNAPSHOT_VERSION,
		date,
		generatedAt: new Date().toISOString(),
		digest,
		digestFrom,
		digestChanged: Boolean(digest && digestFrom && digest !== digestFrom),
		armed,
		armedCount: armedList.length,
		rolledBack,
		pruned,
		staged: { total: stagedEntries.length, byKind: stagedByKind, gatePass, gateFail },
		rejected,
		probe: {
			evaluated: gateAudit.length,
			passed: gateAudit.filter((entry) => (entry.gate as { ok?: unknown }).ok === true).length,
			rate: gateAudit.length > 0 ? gateAudit.filter((entry) => (entry.gate as { ok?: unknown }).ok === true).length / gateAudit.length : null,
			note: "extension gate pass rate; rule probes measured over the fixture corpus",
			rules: probeTotals,
		},
		ruleOutcomes: mix,
		extensions: { armed: extensionDetail.length, used, silent, unknown, detail: extensionDetail },
		lessons: { added: lessonsAdded, recalled: recalledIds.size, libraryPresent },
		ledger,
		counts: { armed: armedList.length, rolledBack: rolledBack.length, pruned: pruned.length, rejected },
	};
}

function safeDigest(agentRoot: string): string | null {
	try {
		return harnessDigest(agentRoot);
	} catch {
		return null;
	}
}

export function snapshotPath(sources: SnapshotSources, date: string): string {
	return join(sources.snapshotsDir, `${date}.json`);
}

/** Materialize one day's snapshot; an existing file is never rewritten. */
export function ensureSnapshot(date = todayUtc(), sources = defaultSources()): { date: string; path: string; created: boolean; snapshot: Snapshot } {
	const path = snapshotPath(sources, date);
	if (existsSync(path)) {
		const existing = readJsonFile(path);
		if (isSnapshot(existing)) return { date, path, created: false, snapshot: existing };
	}
	const snapshot = computeSnapshot(date, sources);
	mkdirSync(sources.snapshotsDir, { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
	renameSync(temp, path);
	return { date, path, created: true, snapshot };
}

export function readSnapshots(sources = defaultSources()): Snapshot[] {
	let files: string[];
	try {
		files = readdirSync(sources.snapshotsDir).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort();
	} catch {
		return [];
	}
	return files.map((file) => readJsonFile(join(sources.snapshotsDir, file))).filter(isSnapshot);
}

export type ImprovementMetric = { key: string; label: string; from: number | null; to: number | null; delta: number | null; unit: "count" | "pp" | "rate" };

export type ImprovementsView = {
	days: Snapshot[];
	latest: Snapshot | null;
	previous: Snapshot | null;
	compare: { from: string | null; to: string | null; metrics: ImprovementMetric[]; digestChanged: boolean };
};

const rateOf = (snapshot: Snapshot): number | null => snapshot.ruleOutcomes.survivalRate;
const pp = (from: number | null, to: number | null): number | null => (from === null || to === null ? null : (to - from) * 100);
const deltaCount = (from: number | null, to: number | null): number | null => (from === null || to === null ? null : to - from);

/** Day strip + N vs N−1 comparison for the Improvements page. */
export function improvementsView(options: { date?: string; sources?: SnapshotSources } = {}): ImprovementsView {
	const sources = options.sources ?? defaultSources();
	const days = readSnapshots(sources);
	const latest = options.date ? (days.find((snapshot) => snapshot.date === options.date) ?? null) : (days[days.length - 1] ?? null);
	const previous = latest ? (days.filter((snapshot) => snapshot.date < latest.date).slice(-1)[0] ?? null) : null;
	const metrics: ImprovementMetric[] = [
		{ key: "armed", label: "Armed", from: previous?.counts.armed ?? null, to: latest?.counts.armed ?? null, delta: deltaCount(previous?.counts.armed ?? null, latest?.counts.armed ?? null), unit: "count" },
		{ key: "rolledBack", label: "Rolled back", from: previous?.counts.rolledBack ?? null, to: latest?.counts.rolledBack ?? null, delta: deltaCount(previous?.counts.rolledBack ?? null, latest?.counts.rolledBack ?? null), unit: "count" },
		{ key: "pruned", label: "Pruned", from: previous?.counts.pruned ?? null, to: latest?.counts.pruned ?? null, delta: deltaCount(previous?.counts.pruned ?? null, latest?.counts.pruned ?? null), unit: "count" },
		{ key: "staged", label: "Staged", from: previous?.staged.total ?? null, to: latest?.staged.total ?? null, delta: deltaCount(previous?.staged.total ?? null, latest?.staged.total ?? null), unit: "count" },
		{ key: "probeRate", label: "Gate pass rate", from: previous?.probe.rate ?? null, to: latest?.probe.rate ?? null, delta: pp(previous?.probe.rate ?? null, latest?.probe.rate ?? null), unit: "pp" },
		{ key: "ruleProbeRate", label: "Rule probe hit rate", from: previous?.probe.rules?.passRate ?? null, to: latest?.probe.rules?.passRate ?? null, delta: pp(previous?.probe.rules?.passRate ?? null, latest?.probe.rules?.passRate ?? null), unit: "pp" },
		{ key: "ruleSurvival", label: "Rule survival", from: previous ? rateOf(previous) : null, to: latest ? rateOf(latest) : null, delta: pp(previous ? rateOf(previous) : null, latest ? rateOf(latest) : null), unit: "pp" },
		{ key: "extensionsUsed", label: "Extensions used", from: previous?.extensions.used.length ?? null, to: latest?.extensions.used.length ?? null, delta: deltaCount(previous?.extensions.used.length ?? null, latest?.extensions.used.length ?? null), unit: "count" },
		{ key: "extensionsSilent", label: "Extensions silent", from: previous?.extensions.silent.length ?? null, to: latest?.extensions.silent.length ?? null, delta: deltaCount(previous?.extensions.silent.length ?? null, latest?.extensions.silent.length ?? null), unit: "count" },
		{ key: "lessonsAdded", label: "Lessons added", from: previous?.lessons.added ?? null, to: latest?.lessons.added ?? null, delta: deltaCount(previous?.lessons.added ?? null, latest?.lessons.added ?? null), unit: "count" },
		{ key: "lessonsRecalled", label: "Lessons recalled", from: previous?.lessons.recalled ?? null, to: latest?.lessons.recalled ?? null, delta: deltaCount(previous?.lessons.recalled ?? null, latest?.lessons.recalled ?? null), unit: "count" },
	];
	return {
		days,
		latest,
		previous,
		compare: { from: previous?.date ?? null, to: latest?.date ?? null, metrics, digestChanged: latest?.digestChanged ?? false },
	};
}

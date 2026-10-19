/**
 * Rule probes — measure a staged trigger against a fixture corpus before the
 * user arms it. The paper score (Jev) says "this trigger looks precise"; the
 * probe says what it actually does on known-bad and known-good snippets.
 *
 * The matcher is ttsr's own (`../ttsr/matcher.ts`), so frontmatter parsing,
 * scope/glob gating and regex/AST semantics are identical to the live engine.
 * Nothing here arms anything: results land in `manifest.probe.rules` and the
 * probe decision stream.
 *
 * Two measurement paths, both deterministic:
 *   - explicit: fixtures name the rule in `expect` / `mustNot` (seeded generic
 *     rules), giving hits / misses / false-positives directly;
 *   - paired topics: each topic has a positive and a negative fixture, so a
 *     staged rule with a new name is still measured — a rule "targets" a topic
 *     when it fires on the positive fixture, and earns a false positive when it
 *     also fires on the negative one.
 * A rule the corpus cannot speak to is reported `unmeasured` rather than given
 * a fake rate.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logDecision } from "../../utils/jev-outcomes.ts";
import { astGrepAvailable, initAstGrep, matchAstRules, matchRules, parseRuleSource, type Rule } from "../ttsr/matcher.ts";
import { synthesizeFragmentRules } from "../ttsr/registry.ts";
import { listStaged, updateStagedProbe, type StagedItem } from "./harness.ts";
import type { HarnessKind } from "../../utils/harness-surface.ts";

export type FixtureKind = "text" | "thinking" | "tool";

export type Fixture = {
	id: string;
	kind: FixtureKind;
	content: string;
	/** Tool name prefixed to the haystack, mirroring the live engine. */
	toolName?: string;
	/** Path used for glob gating and language selection. */
	toolPath?: string;
	expect: string[];
	mustNot: string[];
	/** Paired-topic measurement: positive and negative fixtures share a topic. */
	topic?: string;
	/** Substrings that mark a rule as speaking to this topic (name or trigger source). */
	topicMembers?: string[];
	polarity?: "positive" | "negative";
	note?: string;
};

export type ProbeTarget = { kind: "rule" | "context"; name: string; source: string };

export type ProbeVerdict = "pass" | "weak" | "false-positive" | "unmeasured" | "invalid";

export type RuleProbe = {
	name: string;
	kind: ProbeTarget["kind"];
	/** Explicit expectations (fixtures that name this rule). */
	expected: number;
	hits: number;
	misses: number;
	traps: number;
	explicitFalsePositives: number;
	/** Paired-topic measurement (works for rules the corpus never named). */
	topicsTargeted: number;
	topicFalsePositives: number;
	falsePositives: number;
	passRate: number | null;
	astSkipped: boolean;
	verdict: ProbeVerdict;
	firedOn: string[];
	missedOn: string[];
	falseOn: string[];
};

export type ProbeReport = {
	version: 1;
	at: string;
	corpusSize: number;
	rules: RuleProbe[];
	summary: {
		evaluated: number;
		expected: number;
		hits: number;
		misses: number;
		falsePositives: number;
		topicsTargeted: number;
		passRate: number | null;
		unmeasured: number;
	};
};

const FIXTURE_KINDS: ReadonlySet<string> = new Set(["text", "thinking", "tool"]);

function fixtureOf(raw: unknown, file: string): Fixture {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: fixture must be an object`);
	const rec = raw as Record<string, unknown>;
	const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : null;
	if (!id) throw new Error(`${file}: fixture needs a non-empty id`);
	const kind = typeof rec.kind === "string" && FIXTURE_KINDS.has(rec.kind) ? (rec.kind as FixtureKind) : null;
	if (!kind) throw new Error(`${file}:${id}: kind must be text, thinking or tool`);
	if (typeof rec.content !== "string" || !rec.content) throw new Error(`${file}:${id}: content must be a non-empty string`);
	const list = (value: unknown, field: string): string[] => {
		if (value === undefined) return [];
		if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error(`${file}:${id}: ${field} must be a string array`);
		return value as string[];
	};
	const polarity = rec.polarity === undefined ? undefined : rec.polarity === "positive" || rec.polarity === "negative" ? rec.polarity : null;
	if (polarity === null) throw new Error(`${file}:${id}: polarity must be positive or negative`);
	const topic = typeof rec.topic === "string" && rec.topic.trim() ? rec.topic.trim() : undefined;
	if (topic && !polarity) throw new Error(`${file}:${id}: a topic fixture needs polarity`);
	if (polarity && !topic) throw new Error(`${file}:${id}: a polarity fixture needs a topic`);
	const topicMembers = list(rec.topicMembers, "topicMembers");
	return {
		id,
		kind,
		content: rec.content,
		toolName: typeof rec.toolName === "string" ? rec.toolName : undefined,
		toolPath: typeof rec.toolPath === "string" ? rec.toolPath : undefined,
		expect: list(rec.expect, "expect"),
		mustNot: list(rec.mustNot, "mustNot"),
		topic,
		topicMembers: topicMembers.length > 0 ? topicMembers : undefined,
		polarity: polarity ?? undefined,
		note: typeof rec.note === "string" ? rec.note : undefined,
	};
}

export const corpusDir = (): string => join(dirname(fileURLToPath(import.meta.url)), "probe-corpus");

/** Load every `*.json` fixture in the corpus directory, in stable file order. */
export async function loadCorpus(dir = corpusDir()): Promise<Fixture[]> {
	const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
	const fixtures: Fixture[] = [];
	for (const file of files) {
		const raw = JSON.parse(await readFile(join(dir, file), "utf8")) as unknown;
		for (const entry of Array.isArray(raw) ? raw : [raw]) fixtures.push(fixtureOf(entry, file));
	}
	const ids = new Set<string>();
	for (const fixture of fixtures) {
		if (ids.has(fixture.id)) throw new Error(`duplicate fixture id: ${fixture.id}`);
		ids.add(fixture.id);
	}
	if (fixtures.length === 0) throw new Error(`probe corpus is empty: ${dir}`);
	return fixtures;
}

const haystackOf = (fixture: Fixture): string => (fixture.kind === "tool" ? `${fixture.toolName ?? "bash"}\n${fixture.content}` : fixture.content);

function fired(rule: Rule, fixture: Fixture): boolean {
	if (rule.conditions.length > 0 && matchRules([rule], haystackOf(fixture), fixture.kind, fixture.toolPath).length > 0) return true;
	if (rule.astConditions.length > 0 && fixture.kind === "tool" && fixture.toolPath) {
		return matchAstRules([rule], fixture.content, fixture.toolPath).length > 0;
	}
	return false;
}

type TopicPair = { positive: Fixture; negative: Fixture; members: string[] };

function topicPairs(corpus: Fixture[]): TopicPair[] {
	const byTopic = new Map<string, { positive?: Fixture; negative?: Fixture }>();
	for (const fixture of corpus) {
		if (!fixture.topic || !fixture.polarity) continue;
		const pair = byTopic.get(fixture.topic) ?? {};
		if (fixture.polarity === "positive") pair.positive = fixture;
		else pair.negative = fixture;
		byTopic.set(fixture.topic, pair);
	}
	const pairs: TopicPair[] = [];
	for (const [topic, pair] of [...byTopic.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		if (!pair.positive || !pair.negative) continue;
		const members = [...(pair.positive.topicMembers ?? [topic]), ...(pair.negative.topicMembers ?? [])];
		pairs.push({ positive: pair.positive, negative: pair.negative, members });
	}
	return pairs;
}

function measure(target: ProbeTarget, rule: Rule | null, corpus: Fixture[], pairs: TopicPair[], ast: boolean): RuleProbe {
	const probe: RuleProbe = {
		name: target.name,
		kind: target.kind,
		expected: 0,
		hits: 0,
		misses: 0,
		traps: 0,
		explicitFalsePositives: 0,
		topicsTargeted: 0,
		topicFalsePositives: 0,
		falsePositives: 0,
		passRate: null,
		astSkipped: false,
		verdict: "invalid",
		firedOn: [],
		missedOn: [],
		falseOn: [],
	};
	if (!rule) return probe;

	probe.astSkipped = rule.astConditions.length > 0 && !ast;
	for (const fixture of corpus) {
		const hit = fired(rule, fixture);
		if (hit) probe.firedOn.push(fixture.id);
		if (fixture.expect.includes(target.name)) {
			probe.expected++;
			if (hit) probe.hits++;
			else {
				probe.misses++;
				probe.missedOn.push(fixture.id);
			}
		} else if (fixture.mustNot.includes(target.name)) {
			probe.traps++;
			if (hit) {
				probe.explicitFalsePositives++;
				probe.falseOn.push(fixture.id);
			}
		}
	}

	const signature = `${target.name}\n${target.source}`.toLowerCase();
	for (const pair of pairs) {
		if (!pair.members.some((member) => signature.includes(member.toLowerCase()))) continue;
		if (!fired(rule, pair.positive)) continue;
		probe.topicsTargeted++;
		if (fired(rule, pair.negative)) {
			probe.topicFalsePositives++;
			probe.falseOn.push(pair.negative.id);
		}
	}

	probe.falsePositives = probe.explicitFalsePositives + probe.topicFalsePositives;
	if (probe.expected > 0) probe.passRate = probe.hits / probe.expected;
	else if (probe.topicsTargeted > 0) probe.passRate = (probe.topicsTargeted - probe.topicFalsePositives) / probe.topicsTargeted;

	if (probe.astSkipped && rule.conditions.length === 0) probe.verdict = "unmeasured";
	else if (probe.falsePositives > 0) probe.verdict = "false-positive";
	else if (probe.expected > 0) probe.verdict = probe.hits === probe.expected ? "pass" : "weak";
	else if (probe.topicsTargeted > 0) probe.verdict = "pass";
	else probe.verdict = "unmeasured";
	return probe;
}

/** Probe every target over the corpus. Pure apart from the optional ast-grep init. */
export async function probeRules(targets: ProbeTarget[], corpus: Fixture[], opts: { ast?: boolean } = {}): Promise<ProbeReport> {
	const parsed = targets.map((target) => ({ target, rule: parseRuleSource(target.source, `${target.name}.md`) }));
	const needsAst = parsed.some((entry) => (entry.rule?.astConditions.length ?? 0) > 0);
	const ast = opts.ast === false ? false : needsAst ? await initAstGrep() : astGrepAvailable();
	const pairs = topicPairs(corpus);
	const rules = parsed.map((entry) => measure(entry.target, entry.rule, corpus, pairs, ast));
	const measured = rules.filter((rule) => rule.expected > 0);
	const targeted = rules.filter((rule) => rule.expected === 0 && rule.topicsTargeted > 0);
	const expected = measured.reduce((sum, rule) => sum + rule.expected, 0);
	const hits = measured.reduce((sum, rule) => sum + rule.hits, 0);
	const topicTotal = targeted.reduce((sum, rule) => sum + rule.topicsTargeted, 0);
	const topicClean = targeted.reduce((sum, rule) => sum + rule.topicsTargeted - rule.topicFalsePositives, 0);
	const passRate = expected > 0 ? hits / expected : topicTotal > 0 ? topicClean / topicTotal : null;
	return {
		version: 1,
		at: new Date().toISOString(),
		corpusSize: corpus.length,
		rules,
		summary: {
			evaluated: rules.length,
			expected,
			hits,
			misses: measured.reduce((sum, rule) => sum + rule.misses, 0),
			falsePositives: rules.reduce((sum, rule) => sum + rule.falsePositives, 0),
			topicsTargeted: topicTotal,
			passRate,
			unmeasured: rules.filter((rule) => rule.verdict === "unmeasured").length,
		},
	};
}

const pct = (rate: number | null): string => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

/** One-line measurement for the review overlay. */
export function probeLine(probe: RuleProbe): string {
	if (probe.verdict === "invalid") return "probe: unparsable trigger (no condition/astCondition)";
	if (probe.expected > 0) {
		return `probe: ${probe.hits}/${probe.expected} hit, ${probe.falsePositives} false-pos${probe.astSkipped ? " (ast skipped)" : ""} · ${pct(probe.passRate)}`;
	}
	if (probe.topicsTargeted > 0) {
		return `probe: ${probe.topicsTargeted - probe.topicFalsePositives}/${probe.topicsTargeted} clean topics, ${probe.falsePositives} false-pos`;
	}
	return `probe: unmeasured — corpus has no fixture for this trigger${probe.astSkipped ? " (ast skipped)" : ""}`;
}

function aggregate(probes: RuleProbe[], name: string, kind: ProbeTarget["kind"]): RuleProbe {
	const base: RuleProbe = {
		name,
		kind,
		expected: 0,
		hits: 0,
		misses: 0,
		traps: 0,
		explicitFalsePositives: 0,
		topicsTargeted: 0,
		topicFalsePositives: 0,
		falsePositives: 0,
		passRate: null,
		astSkipped: false,
		verdict: "unmeasured",
		firedOn: [],
		missedOn: [],
		falseOn: [],
	};
	if (probes.length === 0) return base;
	for (const probe of probes) {
		base.expected += probe.expected;
		base.hits += probe.hits;
		base.misses += probe.misses;
		base.traps += probe.traps;
		base.explicitFalsePositives += probe.explicitFalsePositives;
		base.topicsTargeted += probe.topicsTargeted;
		base.topicFalsePositives += probe.topicFalsePositives;
		base.falsePositives += probe.falsePositives;
		base.astSkipped = base.astSkipped || probe.astSkipped;
		base.firedOn.push(...probe.firedOn);
		base.missedOn.push(...probe.missedOn);
		base.falseOn.push(...probe.falseOn);
	}
	if (base.expected > 0) base.passRate = base.hits / base.expected;
	else if (base.topicsTargeted > 0) base.passRate = (base.topicsTargeted - base.topicFalsePositives) / base.topicsTargeted;
	if (probes.every((probe) => probe.verdict === "invalid")) base.verdict = "invalid";
	else if (base.falsePositives > 0) base.verdict = "false-positive";
	else if (base.expected > 0) base.verdict = base.hits === base.expected ? "pass" : "weak";
	else if (base.topicsTargeted > 0) base.verdict = "pass";
	return base;
}

export type StagedProbe = { kind: HarnessKind; name: string; probe: RuleProbe };

/** Probe every staged rule/context, persisting per-item results into manifests. */
export async function probeStaged(
	refineRoot: string,
	opts: { corpus?: Fixture[]; ast?: boolean; persist?: boolean } = {},
): Promise<{ report: ProbeReport; items: StagedProbe[] }> {
	const corpus = opts.corpus ?? (await loadCorpus());
	const staged: StagedItem[] = await listStaged(refineRoot);
	const targets: ProbeTarget[] = [];
	const owners: { item: StagedItem; names: string[] }[] = [];

	for (const item of staged) {
		if (item.kind === "rule") {
			targets.push({ kind: "rule", name: item.name, source: item.content });
			owners.push({ item, names: [item.name] });
		} else if (item.kind === "context") {
			const fragment = item.files["entry.yaml"];
			if (typeof fragment !== "string") continue;
			const synthesized = synthesizeFragmentRules(fragment, item.name, `${item.name}.md`);
			for (const rule of synthesized) targets.push({ kind: "context", name: rule.name, source: rule.source });
			owners.push({ item, names: synthesized.map((rule) => rule.name) });
		}
	}

	const report = await probeRules(targets, corpus, { ast: opts.ast });
	const items: StagedProbe[] = owners.map(({ item, names }) => ({
		kind: item.kind,
		name: item.name,
		probe: aggregate(
			names.map((name) => report.rules.find((rule) => rule.name === name)).filter((probe): probe is RuleProbe => probe !== undefined),
			item.name,
			item.kind === "context" ? "context" : "rule",
		),
	}));

	if (opts.persist !== false) {
		for (const item of items) await updateStagedProbe(refineRoot, item.kind, item.name, { rules: item.probe });
	}
	return { report, items };
}

/** Write one probe decision record so the sweep is auditable and reportable. */
export function logProbe(report: ProbeReport, source: "stage" | "sweep" | "command"): void {
	logDecision("probe", "probe.jsonl", {
		source,
		corpusSize: report.corpusSize,
		summary: report.summary,
		rules: report.rules.map((rule) => ({
			name: rule.name,
			kind: rule.kind,
			verdict: rule.verdict,
			hits: rule.hits,
			misses: rule.misses,
			falsePositives: rule.falsePositives,
			passRate: rule.passRate,
			astSkipped: rule.astSkipped,
		})),
	});
}

const SWEEP_FILE = "probe/last-sweep.json";

/** Date guard for the nightly sweep: at most one sweep per UTC day. */
export async function probeSweepDue(refineRoot: string, day: string): Promise<boolean> {
	try {
		const raw = JSON.parse(await readFile(join(refineRoot, SWEEP_FILE), "utf8")) as { day?: unknown };
		return raw.day !== day;
	} catch (error) {
		// expected: first sweep, or a truncated marker written by an older build
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		return true;
	}
}

export async function markProbeSweep(refineRoot: string, day: string): Promise<void> {
	await writeFile(join(refineRoot, SWEEP_FILE), `${JSON.stringify({ day, at: new Date().toISOString() })}\n`, "utf8").catch(() => {
		// expected: the sweep already ran; a failed marker only causes a retry next turn
	});
}

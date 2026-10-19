/**
 * Probe engine tests: deterministic over the bundled corpus, matcher parity
 * with ttsr, false-positive detection, and stage-write recording.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { matchRules, parseRuleSource } from "../ttsr/matcher.ts";
import { stageProposal, type Proposal } from "./harness.ts";
import { loadCorpus, probeLine, probeRules, probeStaged, type Fixture, type ProbeTarget } from "./probe.ts";
import type { StagedManifest } from "../../utils/harness-surface.ts";

const source = (name: string, condition: string[], scope = "tool", extra = ""): string =>
	`---\nname: ${name}\ncondition: ${JSON.stringify(condition)}\nscope: [${scope}]\n${extra}---\n\nBody.\n`;

const haystack = (fixture: Fixture): string => (fixture.kind === "tool" ? `${fixture.toolName ?? "bash"}\n${fixture.content}` : fixture.content);

test("corpus ships paired, unique fixtures", async () => {
	const corpus = await loadCorpus();
	assert.ok(corpus.length >= 12, `expected at least 12 fixtures, got ${corpus.length}`);
	const ids = new Set(corpus.map((fixture) => fixture.id));
	assert.equal(ids.size, corpus.length);
	const topics = new Map<string, Set<string>>();
	for (const fixture of corpus) {
		if (!fixture.topic || !fixture.polarity) continue;
		const set = topics.get(fixture.topic) ?? new Set<string>();
		set.add(fixture.polarity);
		topics.set(fixture.topic, set);
	}
	assert.ok(topics.size >= 6, `expected at least 6 topics, got ${topics.size}`);
	for (const [topic, polarities] of topics) {
		assert.deepEqual([...polarities].sort(), ["negative", "positive"], `${topic} must have one fixture of each polarity`);
	}
});

test("explicit expectations measure hits and respect traps", async () => {
	const corpus = await loadCorpus();
	const targets: ProbeTarget[] = [
		{ kind: "rule", name: "no-force-without-lease", source: source("no-force-without-lease", ["git push --force(?!.{0,20}with-lease)"]) },
	];
	const report = await probeRules(targets, corpus);
	const probe = report.rules[0];
	assert.equal(probe.expected, 1);
	assert.equal(probe.hits, 1);
	assert.equal(probe.misses, 0);
	assert.equal(probe.falsePositives, 0);
	assert.equal(probe.passRate, 1);
	assert.equal(probe.verdict, "pass");
	assert.ok(probe.firedOn.includes("force-push-positive"));
	assert.ok(!probe.firedOn.includes("force-push-negative"));
	assert.equal(report.summary.passRate, 1);
});

test("paired topics measure a staged rule the corpus never named", async () => {
	const corpus = await loadCorpus();
	const good: ProbeTarget[] = [{ kind: "rule", name: "custom-force-guard", source: source("custom-force-guard", ["--force(?!.{0,20}with-lease)"]) }];
	const goodReport = await probeRules(good, corpus);
	assert.equal(goodReport.rules[0].expected, 0);
	assert.equal(goodReport.rules[0].topicsTargeted, 1);
	assert.equal(goodReport.rules[0].falsePositives, 0);
	assert.equal(goodReport.rules[0].verdict, "pass");

	const broad: ProbeTarget[] = [{ kind: "rule", name: "force-anywhere", source: source("force-anywhere", ["force"]) }];
	const broadReport = await probeRules(broad, corpus);
	assert.equal(broadReport.rules[0].topicsTargeted, 1);
	assert.equal(broadReport.rules[0].falsePositives, 1);
	assert.equal(broadReport.rules[0].verdict, "false-positive");
	assert.deepEqual(broadReport.rules[0].falseOn, ["force-push-negative"]);
});

test("unrelated rules are not scored on a topic they do not claim", async () => {
	const corpus = await loadCorpus();
	const targets: ProbeTarget[] = [
		{ kind: "rule", name: "require-git-approval", source: source("require-git-approval", ["\\bgit\\s+(?:commit|push)\\b"]) },
	];
	const report = await probeRules(targets, corpus);
	assert.equal(report.rules[0].topicsTargeted, 0);
	assert.equal(report.rules[0].falsePositives, 0);
	assert.equal(report.rules[0].verdict, "unmeasured");
});

test("a rule the corpus cannot speak to stays unmeasured", async () => {
	const corpus = await loadCorpus();
	const targets: ProbeTarget[] = [{ kind: "rule", name: "never-matches", source: source("never-matches", ["zzz-no-such-pattern"]) }];
	const report = await probeRules(targets, corpus);
	assert.equal(report.rules[0].verdict, "unmeasured");
	assert.equal(report.rules[0].passRate, null);
	assert.match(probeLine(report.rules[0]), /unmeasured/);
});

test("results are deterministic across runs", async () => {
	const corpus = await loadCorpus();
	const targets: ProbeTarget[] = [
		{ kind: "rule", name: "no-ts-any", source: source("no-ts-any", [":\\s*any\\b", "\\bas\\s+any\\b"], "tool", "globs: [\"**/*.ts\"]\n") },
		{ kind: "rule", name: "no-raw-log-dumps", source: source("no-raw-log-dumps", ["\\b(cat|bat|less)\\b[^\\n]{0,80}\\.log"]) },
	];
	const a = await probeRules(targets, corpus);
	const b = await probeRules(targets, corpus);
	assert.deepEqual({ ...a, at: "" }, { ...b, at: "" });
});

test("probe matching is the ttsr matcher, not a reimplementation", async () => {
	const corpus = await loadCorpus();
	const ruleSource = source("no-ts-any", [":\\s*any\\b", "\\bas\\s+any\\b"], "tool", "globs: [\"**/*.ts\"]\n");
	const parsed = parseRuleSource(ruleSource, "no-ts-any.md");
	assert.ok(parsed);
	const expected = corpus
		.filter((fixture) => matchRules([parsed], haystack(fixture), fixture.kind, fixture.toolPath).length > 0)
		.map((fixture) => fixture.id)
		.sort();
	const report = await probeRules([{ kind: "rule", name: "no-ts-any", source: ruleSource }], corpus);
	assert.deepEqual([...report.rules[0].firedOn].sort(), expected);
});

test("ast-only rules report the gap instead of a fabricated rate", async () => {
	const corpus = await loadCorpus();
	const targets: ProbeTarget[] = [{ kind: "rule", name: "no-empty-catch", source: `---\nname: no-empty-catch\nastCondition: ["try { $$$ } catch ($E) {}"]\nscope: [tool]\n---\n\nBody.\n` }];
	const report = await probeRules(targets, corpus, { ast: false });
	assert.equal(report.rules[0].astSkipped, true);
	assert.equal(report.rules[0].verdict, "unmeasured");
	assert.equal(report.rules[0].passRate, null);
});

test("stage-write records probe results in the manifest", async () => {
	const refineRoot = mkdtempSync(join(tmpdir(), "probe-stage-"));
	const proposal: Proposal = {
		kind: "rule",
		name: "no-force-without-lease",
		title: "Force-push needs a lease",
		evidence: "user corrected a blind force-push",
		files: { "no-force-without-lease.md": source("no-force-without-lease", ["git push --force(?!.{0,20}with-lease)"]) },
	};
	const manifest: StagedManifest = {
		kind: "rule",
		name: proposal.name,
		title: proposal.title,
		evidence: proposal.evidence,
		files: proposal.files,
		score: 0.7,
		parts: { evidence: 0.7, trigger: 0.7, novelty: 0.7 },
		session: "test",
		stagedAt: new Date().toISOString(),
		trigger: "test",
		tier: "ready",
	};
	assert.equal(await stageProposal(refineRoot, proposal, manifest), true);
	const { items } = await probeStaged(refineRoot);
	assert.equal(items.length, 1);
	assert.equal(items[0].probe.name, "no-force-without-lease");
	assert.equal(items[0].probe.hits, 1);
	const written = JSON.parse(readFileSync(join(refineRoot, "staging", "rule", proposal.name, "manifest.json"), "utf8")) as StagedManifest;
	const rules = written.probe?.rules as { name: string; hits: number; verdict: string } | undefined;
	assert.ok(rules, "manifest.probe.rules must be written");
	assert.equal(rules.name, "no-force-without-lease");
	assert.equal(rules.hits, 1);
	assert.equal(rules.verdict, "pass");
});

test("context bundles probe their synthesized triggers", async () => {
	const refineRoot = mkdtempSync(join(tmpdir(), "probe-context-"));
	const files = {
		"raw-log-reader.md": "# Raw log reader\n\nRead the doc before dumping logs.\n",
		"entry.yaml": "id: raw-log-reader\ntier: advisory\ntriggers:\n  - tool: bash\n    match: \"\\\\.log\"\n",
	};
	const proposal: Proposal = {
		kind: "context",
		name: "raw-log-reader",
		title: "Prefilter logs",
		evidence: "repeated unbounded log reads",
		files,
	};
	const manifest: StagedManifest = {
		kind: "context",
		name: proposal.name,
		title: proposal.title,
		evidence: proposal.evidence,
		files,
		score: 0.7,
		parts: { evidence: 0.7, trigger: 0.7, novelty: 0.7 },
		session: "test",
		stagedAt: new Date().toISOString(),
		trigger: "test",
		tier: "ready",
	};
	assert.equal(await stageProposal(refineRoot, proposal, manifest), true);
	const { items } = await probeStaged(refineRoot);
	assert.equal(items.length, 1);
	assert.equal(items[0].kind, "context");
	assert.equal(items[0].probe.name, "raw-log-reader");
	assert.ok(items[0].probe.falsePositives > 0, "a bare .log trigger should trip the bounded-peek trap");
});

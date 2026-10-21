import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { computeSnapshot, ensureSnapshot, extensionUsageWindow, improvementsView, snapshotPath, type SnapshotSources } from "../server/snapshots.ts";

type Json = Record<string, unknown>;

const jsonl = (records: Json[]): string => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

const fixture = (): { root: string; sources: SnapshotSources; cleanup: () => void } => {
	const root = mkdtempSync(join(tmpdir(), "observatory-snapshots-"));
	const sources: SnapshotSources = {
		agentRoot: join(root, "agent"),
		decisionsRoot: join(root, "decisions"),
		refineRoot: join(root, "refine"),
		sessionsRoot: join(root, "sessions"),
		snapshotsDir: join(root, "observatory", "snapshots"),
		libraryRoot: join(root, "agent", "harness-library"),
	};
	mkdirSync(join(sources.agentRoot, "rules"), { recursive: true });
	mkdirSync(join(sources.agentRoot, "harness-library", "rule-triggers", "entries"), { recursive: true });
	mkdirSync(join(sources.decisionsRoot, "decision-tuner"), { recursive: true });
	mkdirSync(sources.refineRoot, { recursive: true });
	mkdirSync(join(sources.sessionsRoot, "2026-10-19"), { recursive: true });
	mkdirSync(sources.snapshotsDir, { recursive: true });

	writeFileSync(join(sources.agentRoot, "rules", "no-x.md"), "---\nname: no-x\ncondition: [x]\n---\nbody\n");
	writeFileSync(
		join(sources.agentRoot, "harness-library", "rule-triggers", "entries", "lesson-1.md"),
		"---\nid: lesson-1\ndomain: rule-triggers\ncue: \"rule staged as ready was rolled back\"\nconfidence: 0.70\ncreated: 2026-10-19T09:30:00.000Z\nevidence: [\"h1\"]\n---\n\nRequire a probe pass before arming.\n",
	);
	writeFileSync(join(sources.agentRoot, "settings.json"), '{"modelRouter":{"threshold":0.8}}\n');

	writeFileSync(
		join(sources.refineRoot, "history.jsonl"),
		jsonl([
			{ id: "h1", timestamp: "2026-10-19T10:00:00.000Z", kind: "rule", name: "no-x", path: "/x", evidence: "e", source: "auto", digest: "aaaa", recalled: ["lesson-1"] },
			{ id: "h2", timestamp: "2026-10-18T09:00:00.000Z", kind: "extension", name: "json-diff", path: "/x", evidence: "e", source: "auto", expectation: "tool:json_diff", digest: "aaaa" },
			{ id: "h3", timestamp: "2026-10-19T11:00:00.000Z", kind: "agent", name: "explorer", path: "/x", evidence: "e", source: "auto", digest: "aaaa" },
			{ id: "h4", timestamp: "2026-10-19T12:00:00.000Z", kind: "rule", name: "old-rule", path: "/x", evidence: "e", source: "auto", rolledBack: true, digest: "aaaa" },
		]),
	);
	writeFileSync(
		join(sources.refineRoot, "auto-refine.jsonl"),
		jsonl([
			{ ts: "2026-10-19T10:05:00.000Z", stage: "apply", kind: "extension", name: "json-diff", decision: "staged", gate: { ok: true } },
			{ ts: "2026-10-19T10:06:00.000Z", stage: "apply", kind: "extension", name: "bad-tool", decision: "staged", gate: { ok: false, reasons: ["compile: boom"] } },
			{ ts: "2026-10-19T10:07:00.000Z", stage: "apply", kind: "rule", name: "no-x", decision: "staged" },
			{ ts: "2026-10-19T10:08:00.000Z", stage: "review", kind: "note", name: "n", decision: "discarded" },
			{ ts: "2026-10-19T10:09:00.000Z", stage: "review", kind: "extension", name: "bad-tool", decision: "gate-blocked", gate: { ok: false } },
		]),
	);
	writeFileSync(
		join(sources.decisionsRoot, "ttsr-jev.jsonl"),
		jsonl([
			{ ts: "2026-10-19T10:10:00.000Z", kind: "outcome", outcome: "survived", rule: "a" },
			{ ts: "2026-10-19T10:11:00.000Z", kind: "outcome", outcome: "survived", rule: "b" },
			{ ts: "2026-10-19T10:12:00.000Z", kind: "outcome", outcome: "retried", rule: "c" },
			{ ts: "2026-10-19T10:13:00.000Z", kind: "outcome", outcome: "repeated", rule: "d" },
			{ ts: "2026-10-18T10:13:00.000Z", kind: "outcome", outcome: "survived", rule: "e" },
		]),
	);
	writeFileSync(
		join(sources.decisionsRoot, "decision-tuner", "proposals.jsonl"),
		jsonl([{ id: "p1", kind: "prune", system: "ttsr", target: "no-y", status: "applied", createdAt: "2026-10-18T09:00:00.000Z", decidedAt: "2026-10-19T09:00:00.000Z" }]),
	);
	writeFileSync(
		join(sources.decisionsRoot, "probe.jsonl"),
		jsonl([
			{
				ts: "2026-10-19T10:15:00.000Z",
				kind: "decision",
				system: "probe",
				source: "sweep",
				corpusSize: 15,
				rules: [
					{ name: "no-x", kind: "rule", verdict: "pass", expected: 2, hits: 2, misses: 0, falsePositives: 0, passRate: 1 },
					{ name: "ctx-y", kind: "context", verdict: "false-positive", expected: 0, hits: 0, misses: 0, falsePositives: 1, passRate: 0 },
				],
			},
		]),
	);
	writeFileSync(
		join(sources.sessionsRoot, "2026-10-19", "s1.jsonl"),
		jsonl([
			{ ts: "2026-10-19T10:20:00.000Z", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "json_diff", arguments: { a: 1 } }] } },
			{ ts: "2026-10-19T10:21:00.000Z", type: "message", message: { role: "assistant", content: [{ type: "text", text: "I will not call the other tool." }] } },
		]),
	);
	return { root, sources, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test("extensionUsageWindow measures adoption and last use", () => {
	const { sources, cleanup } = fixture();
	try {
		const usage = extensionUsageWindow(new Date("2026-10-19T23:59:59.000Z"), sources, 30);
		const jsonDiff = usage.find((entry) => entry.name === "json-diff");
		assert.ok(jsonDiff);
		assert.equal(jsonDiff?.used, true);
		assert.equal(jsonDiff?.lastUsedDay, "2026-10-19");
	} finally {
		cleanup();
	}
});

test("computeSnapshot derives the day strip fields from raw streams", () => {
	const { sources, cleanup } = fixture();
	try {
		const snapshot = computeSnapshot("2026-10-19", sources);
		assert.equal(snapshot.date, "2026-10-19");
		assert.deepEqual(snapshot.armed, { rule: ["no-x"], agent: ["explorer"] });
		assert.deepEqual(snapshot.rolledBack, ["rule old-rule"]);
		assert.deepEqual(snapshot.pruned, ["ttsr no-y"]);
		assert.equal(snapshot.staged.total, 3);
		assert.deepEqual(snapshot.staged.byKind, { extension: 2, rule: 1 });
		assert.equal(snapshot.staged.gatePass, 1);
		assert.equal(snapshot.staged.gateFail, 1);
		assert.equal(snapshot.rejected, 2);
		assert.equal(snapshot.probe.evaluated, 3);
		assert.equal(snapshot.probe.passed, 1);
		assert.equal(snapshot.probe.rate, 1 / 3);
		assert.equal(snapshot.probe.rules.runs, 1);
		assert.equal(snapshot.probe.rules.expected, 2);
		assert.equal(snapshot.probe.rules.hits, 2);
		assert.equal(snapshot.probe.rules.falsePositives, 1);
		assert.equal(snapshot.probe.rules.passRate, 1);
		assert.equal(snapshot.ruleOutcomes.survived, 2);
		assert.equal(snapshot.ruleOutcomes.retried, 1);
		assert.equal(snapshot.ruleOutcomes.repeated, 1);
		assert.equal(snapshot.ruleOutcomes.total, 4);
		assert.equal(snapshot.ruleOutcomes.survivalRate, 0.5);
		assert.equal(snapshot.extensions.armed, 1);
		assert.deepEqual(snapshot.extensions.used, ["json-diff"]);
		assert.deepEqual(snapshot.extensions.silent, []);
		assert.equal(snapshot.lessons.libraryPresent, true);
		assert.equal(snapshot.lessons.added, 1);
		assert.equal(snapshot.lessons.recalled, 1);
		assert.match(snapshot.digest ?? "", /^[0-9a-f]{16}$/);
		assert.deepEqual(snapshot.ledger.length > 0, true);
		assert.match(snapshot.ledger.join("\n"), /Armed 2: rule no-x, agent explorer/);
		assert.match(snapshot.ledger.join("\n"), /Probes: 2\/2 hit, 1 false-pos/);
		assert.match(snapshot.ledger.join("\n"), /Lessons: 1 added, 1 recalled/);
	} finally {
		cleanup();
	}
});

test("ensureSnapshot reuses a day whose inputs have not moved", () => {
	const { sources, cleanup } = fixture();
	try {
		const first = ensureSnapshot("2026-10-19", sources);
		assert.equal(first.created, true);
		const raw = readFileSync(snapshotPath(sources, "2026-10-19"), "utf8");

		const second = ensureSnapshot("2026-10-19", sources);
		assert.equal(second.created, false);
		assert.equal(readFileSync(snapshotPath(sources, "2026-10-19"), "utf8"), raw);
	} finally {
		cleanup();
	}
});

test("ensureSnapshot recomputes once an input stream is newer than the day", () => {
	const { sources, cleanup } = fixture();
	try {
		const first = ensureSnapshot("2026-10-19", sources);
		assert.equal(first.snapshot.counts.armed, 2);

		const history = join(sources.refineRoot, "history.jsonl");
		writeFileSync(
			history,
			jsonl([
				{ id: "h1", timestamp: "2026-10-19T10:00:00.000Z", kind: "rule", name: "no-x", path: "/x", evidence: "e", source: "auto", digest: "aaaa" },
				{ id: "h3", timestamp: "2026-10-19T11:00:00.000Z", kind: "agent", name: "explorer", path: "/x", evidence: "e", source: "auto", digest: "aaaa" },
				{ id: "h5", timestamp: "2026-10-19T13:00:00.000Z", kind: "rule", name: "armed-later", path: "/y", evidence: "e", source: "manual", digest: "bbbb" },
			]),
		);
		// pin the write ahead of the snapshot stamp: same-millisecond writes are not
		// reliably newer than generatedAt on coarse-mtime filesystems
		const ahead = new Date(Date.now() + 60_000);
		utimesSync(history, ahead, ahead);

		const second = ensureSnapshot("2026-10-19", sources);
		assert.equal(second.created, false);
		assert.equal(second.snapshot.counts.armed, 3);
		assert.equal(JSON.parse(readFileSync(snapshotPath(sources, "2026-10-19"), "utf8")).counts.armed, 3);
	} finally {
		cleanup();
	}
});

test("ensureSnapshot force rewrites a day that looks fresh", () => {
	const { sources, cleanup } = fixture();
	try {
		const first = ensureSnapshot("2026-10-19", sources);
		const forced = ensureSnapshot("2026-10-19", sources, { force: true });
		assert.equal(forced.created, false);
		assert.notEqual(forced.snapshot.generatedAt, first.snapshot.generatedAt);
		assert.equal(forced.snapshot.counts.armed, first.snapshot.counts.armed);
	} finally {
		cleanup();
	}
});

test("improvementsView compares N against N-1 with percentage-point deltas", () => {
	const { sources, cleanup } = fixture();
	try {
		ensureSnapshot("2026-10-18", sources);
		writeFileSync(join(sources.agentRoot, "rules", "later.md"), "---\nname: later\ncondition: [y]\n---\nbody\n");
		ensureSnapshot("2026-10-19", sources);

		const view = improvementsView({ sources });
		assert.equal(view.days.length, 2);
		assert.equal(view.latest?.date, "2026-10-19");
		assert.equal(view.previous?.date, "2026-10-18");
		assert.equal(view.compare.to, "2026-10-19");
		assert.equal(view.compare.from, "2026-10-18");
		assert.equal(view.compare.digestChanged, true);

		const survival = view.compare.metrics.find((metric) => metric.key === "ruleSurvival");
		assert.ok(survival);
		assert.equal(survival?.unit, "pp");
		assert.equal(survival?.from, 1);
		assert.equal(survival?.to, 0.5);
		assert.equal(survival?.delta, -50);
		const ruleProbeRate = view.compare.metrics.find((metric) => metric.key === "ruleProbeRate");
		assert.ok(ruleProbeRate);
		assert.equal(ruleProbeRate?.from, null);
		assert.equal(ruleProbeRate?.to, 1);
		const lessonsAdded = view.compare.metrics.find((metric) => metric.key === "lessonsAdded");
		const lessonsRecalled = view.compare.metrics.find((metric) => metric.key === "lessonsRecalled");
		assert.ok(lessonsAdded);
		assert.ok(lessonsRecalled);

		const armed = view.compare.metrics.find((metric) => metric.key === "armed");
		assert.equal(armed?.from, 1);
		assert.equal(armed?.to, 2);
		assert.equal(armed?.delta, 1);
	} finally {
		cleanup();
	}
});

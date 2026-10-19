import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { computeSnapshot, ensureSnapshot, improvementsView, snapshotPath, type SnapshotSources } from "../server/snapshots.ts";

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
	mkdirSync(join(sources.decisionsRoot, "decision-tuner"), { recursive: true });
	mkdirSync(sources.refineRoot, { recursive: true });
	mkdirSync(join(sources.sessionsRoot, "2026-10-19"), { recursive: true });
	mkdirSync(sources.snapshotsDir, { recursive: true });

	writeFileSync(join(sources.agentRoot, "rules", "no-x.md"), "---\nname: no-x\ncondition: [x]\n---\nbody\n");
	writeFileSync(join(sources.agentRoot, "settings.json"), '{"modelRouter":{"threshold":0.8}}\n');

	writeFileSync(
		join(sources.refineRoot, "history.jsonl"),
		jsonl([
			{ id: "h1", timestamp: "2026-10-19T10:00:00.000Z", kind: "rule", name: "no-x", path: "/x", evidence: "e", source: "auto", digest: "aaaa" },
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
		join(sources.sessionsRoot, "2026-10-19", "s1.jsonl"),
		jsonl([
			{ ts: "2026-10-19T10:20:00.000Z", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "json_diff", arguments: { a: 1 } }] } },
			{ ts: "2026-10-19T10:21:00.000Z", type: "message", message: { role: "assistant", content: [{ type: "text", text: "I will not call the other tool." }] } },
		]),
	);
	return { root, sources, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

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
		assert.equal(snapshot.ruleOutcomes.survived, 2);
		assert.equal(snapshot.ruleOutcomes.retried, 1);
		assert.equal(snapshot.ruleOutcomes.repeated, 1);
		assert.equal(snapshot.ruleOutcomes.total, 4);
		assert.equal(snapshot.ruleOutcomes.survivalRate, 0.5);
		assert.equal(snapshot.extensions.armed, 1);
		assert.deepEqual(snapshot.extensions.used, ["json-diff"]);
		assert.deepEqual(snapshot.extensions.silent, []);
		assert.equal(snapshot.lessons.libraryPresent, false);
		assert.match(snapshot.digest ?? "", /^[0-9a-f]{16}$/);
		assert.deepEqual(snapshot.ledger.length > 0, true);
		assert.match(snapshot.ledger.join("\n"), /Armed 2: rule no-x, agent explorer/);
	} finally {
		cleanup();
	}
});

test("ensureSnapshot writes once and never recomputes an existing day", () => {
	const { sources, cleanup } = fixture();
	try {
		const first = ensureSnapshot("2026-10-19", sources);
		assert.equal(first.created, true);
		const raw = readFileSync(snapshotPath(sources, "2026-10-19"), "utf8");

		writeFileSync(join(sources.refineRoot, "history.jsonl"), jsonl([]));
		const second = ensureSnapshot("2026-10-19", sources);
		assert.equal(second.created, false);
		assert.equal(readFileSync(snapshotPath(sources, "2026-10-19"), "utf8"), raw);
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

		const armed = view.compare.metrics.find((metric) => metric.key === "armed");
		assert.equal(armed?.from, 1);
		assert.equal(armed?.to, 2);
		assert.equal(armed?.delta, 1);
	} finally {
		cleanup();
	}
});

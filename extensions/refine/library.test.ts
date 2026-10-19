/**
 * Lessons library tests: NO_ENTRY discipline, contrast distillation, cue
 * dedupe, domain recall, bounded injection, and lineage persistence.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	cueSimilarity,
	distillLesson,
	domainForKind,
	readLibraryEntries,
	recallLessons,
	recallLibraryText,
	renderLibrary,
	runExperiencePass,
	writeLesson,
	type ExperienceSources,
} from "./library.ts";
import { listStaged, stageProposal, type Proposal } from "./harness.ts";
import type { StagedManifest } from "../../utils/harness-surface.ts";

const roots = (): { root: string; refineRoot: string; libraryRoot: string; decisionsRoot: string } => {
	const root = mkdtempSync(join(tmpdir(), "refine-library-"));
	return {
		root,
		refineRoot: join(root, "refine"),
		libraryRoot: join(root, "library"),
		decisionsRoot: join(root, "decisions"),
	};
};

const emptySources = (): ExperienceSources => ({ history: [], audit: [], tuner: [], probe: [] });

test("NO_ENTRY: a window with no contrast produces nothing", () => {
	const plainArm = [{ id: "h1", timestamp: "2026-10-19T10:00:00.000Z", kind: "rule", name: "no-x", rolledBack: false }];
	assert.equal(distillLesson({ ...emptySources(), history: plainArm }), null);
	assert.equal(distillLesson(emptySources()), null);
});

test("NO_ENTRY: the experience pass writes no file and records the pass", async () => {
	const { refineRoot, libraryRoot, decisionsRoot } = roots();
	const result = await runExperiencePass({ refineRoot, libraryRoot, decisionsRoot, trigger: "nightly", record: false });
	assert.equal(result.written, false);
	assert.equal(result.written === false ? result.reason : "", "no-entry");
	assert.equal(existsSync(join(libraryRoot, "rule-triggers", "entries")), false);
});

test("a rollback distils one rule-trigger lesson with its evidence", () => {
	const sources: ExperienceSources = {
		...emptySources(),
		history: [{ id: "h1", timestamp: "2026-10-19T10:00:00.000Z", kind: "rule", name: "no-force", rolledBack: true }],
	};
	const lesson = distillLesson(sources);
	assert.ok(lesson);
	assert.equal(lesson.domain, "rule-triggers");
	assert.match(lesson.cue, /rolled back/);
	assert.match(lesson.lesson, /no-force/);
	assert.deepEqual(lesson.evidence, ["h1"]);
});

test("a gate-blocked extension outranks a rollback", () => {
	const sources: ExperienceSources = {
		...emptySources(),
		history: [{ id: "h1", timestamp: "2026-10-19T10:00:00.000Z", kind: "rule", name: "no-force", rolledBack: true }],
		audit: [{ ts: "2026-10-19T11:00:00.000Z", kind: "extension", name: "bad-tool", decision: "gate-blocked", gate: { ok: false, reasons: ["compile: boom"] } }],
	};
	const lesson = distillLesson(sources);
	assert.ok(lesson);
	assert.equal(lesson.domain, "extension-adoption");
	assert.match(lesson.lesson, /bad-tool/);
	assert.equal(lesson.confidence, 0.8);
});

test("a probe false-positive distils a trigger-narrowing lesson", () => {
	const sources: ExperienceSources = {
		...emptySources(),
		audit: [{ ts: "2026-10-19T11:00:00.000Z", kind: "context", name: "log-reader", decision: "staged", probe: { verdict: "false-positive", falseOn: ["raw-log-dump-negative"] } }],
	};
	const lesson = distillLesson(sources);
	assert.ok(lesson);
	assert.equal(lesson.domain, "context-precision");
	assert.match(lesson.lesson, /Narrow context triggers/);
	assert.match(lesson.lesson, /raw-log-dump-negative/);
});

test("an applied prune distils a do-not-repropose lesson", () => {
	const sources: ExperienceSources = {
		...emptySources(),
		tuner: [{ kind: "prune", status: "applied", target: "silent-rule", evidence: "40 evaluations, 0 delivered fires", decidedAt: "2026-10-19T12:00:00.000Z" }],
	};
	const lesson = distillLesson(sources);
	assert.ok(lesson);
	assert.equal(lesson.domain, "rule-triggers");
	assert.match(lesson.lesson, /silent-rule/);
	assert.match(lesson.lesson, /pruned/);
});

test("cue dedupe collapses near-identical situations", async () => {
	const { libraryRoot } = roots();
	const first = await writeLesson(libraryRoot, {
		domain: "rule-triggers",
		cue: "rule proposal staged as ready was rolled back after arming",
		lesson: "Require a probe pass before arming ready rules of this shape.",
		evidence: ["h1"],
		confidence: 0.7,
	});
	assert.equal(first.written, true);
	const second = await writeLesson(libraryRoot, {
		domain: "rule-triggers",
		cue: "rule proposal staged as ready was rolled back after arming",
		lesson: "A rephrased operation with the same cue.",
		evidence: ["h2"],
		confidence: 0.7,
	});
	assert.equal(second.written, false);
	assert.equal(second.written === false ? second.reason : "", "duplicate");
	assert.equal(readdirSync(join(libraryRoot, "rule-triggers", "entries")).length, 1);
	assert.ok(cueSimilarity("a b c", "a b c") === 1);
});

test("lessons recall by domain and render within a character budget", async () => {
	const { libraryRoot } = roots();
	await writeLesson(libraryRoot, { domain: "settings-tiers", cue: "router tier change", lesson: "Keep router floor near 0.8.", evidence: ["s1"], confidence: 0.6 });
	await writeLesson(libraryRoot, { domain: "rule-triggers", cue: "force push trigger", lesson: "Require a corpus hit for force-push rules.", evidence: ["r1"], confidence: 0.7 });

	const settings = await recallLessons(libraryRoot, { domains: ["settings-tiers"] });
	assert.deepEqual(settings.map((entry) => entry.domain), ["settings-tiers"]);

	const all = await readLibraryEntries(libraryRoot);
	assert.equal(all.length, 2);
	const bounded = renderLibrary(all, 40);
	assert.ok(bounded.join("\n").length <= 40, `expected <=40 chars, got ${bounded.join("\n").length}`);

	const recalled = await recallLibraryText(libraryRoot, { text: "force push", maxChars: 400 });
	assert.ok(recalled.entries.length > 0);
	assert.match(recalled.lines[0], /force-push/, "cue-similarity ranking should put the force-push lesson first");
});

test("lineage lands on the staged manifest", async () => {
	const { refineRoot } = roots();
	const name = "no-force-without-lease";
	const proposal: Proposal = {
		kind: "rule",
		name,
		title: "Force-push needs a lease",
		evidence: "user corrected a blind force-push",
		files: { [`${name}.md`]: `---\nname: ${name}\ncondition: ["git push --force"]\nscope: [tool]\n---\n\nUse a lease.\n` },
	};
	const manifest: StagedManifest = {
		kind: "rule",
		name,
		title: proposal.title,
		evidence: proposal.evidence,
		files: proposal.files,
		score: 0.7,
		parts: { evidence: 0.7, trigger: 0.7, novelty: 0.7 },
		session: "test",
		stagedAt: new Date().toISOString(),
		trigger: "test",
		tier: "ready",
		recalled: ["lesson-a", "lesson-b"],
	};
	assert.equal(await stageProposal(refineRoot, proposal, manifest), true);
	const staged = await listStaged(refineRoot);
	assert.deepEqual(staged[0].meta.recalled, ["lesson-a", "lesson-b"]);
	const raw = JSON.parse(readFileSync(join(refineRoot, "staging", "rule", name, "manifest.json"), "utf8")) as StagedManifest;
	assert.deepEqual(raw.recalled, ["lesson-a", "lesson-b"]);
});

test("kind-to-domain mapping covers every proposable class", () => {
	assert.equal(domainForKind("rule"), "rule-triggers");
	assert.equal(domainForKind("context"), "context-precision");
	assert.equal(domainForKind("extension"), "extension-adoption");
	assert.equal(domainForKind("settings"), "settings-tiers");
	assert.equal(domainForKind("note"), "general");
	assert.equal(domainForKind("memory"), "general");
});

/**
 * Harness-gate tuner tests: floor proposals only when measurement disagrees
 * with the paper score, and extension prunes only after measured silence.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	collectExtensionPrunes,
	collectRefineProposals,
	disableExtension,
	type Proposal,
} from "./index.ts";
import type { ExtensionUsageWindow } from "../observatory/server/snapshots.ts";

const floors = { trigger: 0.5, nearMiss: 0.4 };

const staged = (name: string, trigger: number, verdict: string, tier = "ready"): Record<string, unknown> => ({
	kind: "rule",
	name,
	decision: "staged",
	tier,
	parts: { evidence: 0.7, trigger, novelty: 0.7 },
	probe: { verdict },
});

const daysAgo = (n: number): string => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

test("two high-trigger false positives propose raising the trigger floor", () => {
	const out = collectRefineProposals([staged("a", 0.7, "false-positive"), staged("b", 0.6, "false-positive")], [], floors);
	assert.equal(out.length, 1);
	assert.equal(out[0].kind, "config");
	assert.equal(out[0].system, "refine");
	assert.equal(out[0].target, "rule-trigger-floor-up");
	assert.match(out[0].evidence, /raise REFINE_AUTO_RULE_TRIGGER_FLOOR/);
});

test("one false positive is not enough to move a floor", () => {
	assert.deepEqual(collectRefineProposals([staged("a", 0.7, "false-positive")], [], floors), []);
});

test("three clean near-misses below the floor propose lowering it", () => {
	const audit = [staged("a", 0.3, "pass", "near-miss"), staged("b", 0.35, "pass", "near-miss"), staged("c", 0.4, "pass", "near-miss")];
	const out = collectRefineProposals(audit, [], floors);
	assert.equal(out.length, 1);
	assert.equal(out[0].target, "rule-trigger-floor-down");
	assert.match(out[0].evidence, /lowering REFINE_AUTO_RULE_TRIGGER_FLOOR/);
});

test("an open floor proposal suppresses a duplicate", () => {
	const existing: Proposal[] = [
		{ id: "p1", kind: "config", system: "refine", target: "rule-trigger-floor-up", evidence: "prior", createdAt: new Date().toISOString(), status: "open" },
	];
	const out = collectRefineProposals([staged("a", 0.7, "false-positive"), staged("b", 0.6, "false-positive")], existing, floors);
	assert.deepEqual(out, []);
});

test("an extension silent for 14d earns a prune proposal with its measurement", () => {
	const usage: ExtensionUsageWindow[] = [{ name: "silent-tool", expectation: "tool:silent_tool", armedAt: daysAgo(20), used: false, lastUsedDay: null }];
	const out = collectExtensionPrunes(usage, [], "/tmp/extensions", new Date());
	assert.equal(out.length, 1);
	assert.equal(out[0].kind, "prune");
	assert.equal(out[0].system, "extensions");
	assert.equal(out[0].target, "silent-tool");
	assert.equal(out[0].silentDays, 20);
	assert.match(out[0].file ?? "", /extensions[/\\]silent-tool$/);
	assert.match(out[0].evidence, /no tool:silent_tool call/);
});

test("a used extension or one younger than 14d is not proposed", () => {
	const used: ExtensionUsageWindow[] = [{ name: "used-tool", expectation: "tool:used_tool", armedAt: daysAgo(40), used: true, lastUsedDay: daysAgo(2).slice(0, 10) }];
	assert.deepEqual(collectExtensionPrunes(used, [], "/tmp/extensions", new Date()), []);
	const young: ExtensionUsageWindow[] = [{ name: "young-tool", expectation: "tool:young_tool", armedAt: daysAgo(5), used: false, lastUsedDay: null }];
	assert.deepEqual(collectExtensionPrunes(young, [], "/tmp/extensions", new Date()), []);
});

test("disableExtension renames the directory reversibly", () => {
	const root = mkdtempSync(join(tmpdir(), "tuner-ext-"));
	try {
		const dir = join(root, "demo-tool");
		mkdirSync(dir);
		assert.equal(disableExtension(dir), null);
		assert.equal(existsSync(dir), false);
		assert.equal(existsSync(`${dir}.disabled`), true);
		assert.match(disableExtension(dir) ?? "", /missing/);

		const both = join(root, "both-tool");
		mkdirSync(both);
		mkdirSync(`${both}.disabled`);
		assert.match(disableExtension(both) ?? "", /Already disabled/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

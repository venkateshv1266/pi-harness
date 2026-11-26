import assert from "node:assert/strict";
import { test } from "node:test";
import { planEmissions, representationAfterEmission, type EmissionCandidate, type EmissionPolicy } from "./cache-policy.ts";

const defaults: EmissionPolicy = { percent: 18, softFloorPct: 50, batchFloor: 5000, maxHoldTurns: 12, turnIndex: 5 };
function candidate(over: Partial<EmissionCandidate> = {}): EmissionCandidate {
	return { entryId: "source", currentChars: 10000, replacementChars: 2000, fresh: false, turn: 1, ...over };
}
function action(c: Partial<EmissionCandidate> = {}, p: Partial<EmissionPolicy> = {}) {
	return planEmissions([candidate(c)], { ...defaults, ...p })[0].action;
}

test("historical edits wait below the pressure floor even with large savings", () => {
	assert.equal(action(), "defer-pressure");
	assert.equal(action({ currentChars: 100000 }), "defer-pressure");
});

test("age and zero batch floor cannot bypass the pressure guard", () => {
	assert.equal(action({}, { turnIndex: 1000, batchFloor: 0 }), "defer-pressure");
});

test("unknown or invalid context pressure does not rewrite cached history", () => {
	for (const percent of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(action({}, { percent, softFloorPct: 0, batchFloor: 0 }), "defer-pressure");
	}
});

test("fresh results can be reduced before first exposure without a batch", () => {
	assert.equal(action({ fresh: true }, { percent: undefined, batchFloor: 100000 }), "emit");
});

test("pressure boundary permits sufficiently large historical reductions", () => {
	assert.equal(action({}, { percent: 50 }), "emit");
	assert.equal(action({}, { percent: 49.9 }), "defer-pressure");
});

test("small historical reductions wait for a batch while context is available", () => {
	assert.equal(action({ replacementChars: 7000 }, { percent: 50 }), "defer-batch");
	const plans = planEmissions([candidate({ entryId: "a", replacementChars: 7000 }), candidate({ entryId: "b", replacementChars: 7000 })], { ...defaults, percent: 50 });
	assert.deepEqual(plans.map(p => p.action), ["emit", "emit"]);
});

test("fresh savings do not pay for a historical cache reset", () => {
	const plans = planEmissions([candidate({ entryId: "fresh", fresh: true }), candidate({ entryId: "old", replacementChars: 7000 })], { ...defaults, percent: 50 });
	assert.deepEqual(plans.map(p => p.action), ["emit", "defer-batch"]);
});

test("aged and critical-pressure edits can clear the batch floor", () => {
	assert.equal(action({ replacementChars: 7000 }, { percent: 50, turnIndex: 13 }), "emit");
	assert.equal(action({ replacementChars: 7000 }, { percent: 80, batchFloor: 0 }), "emit");
});

test("omitted and compacted-out sources are not automatically restored", () => {
	assert.equal(action({ currentChars: undefined }, { percent: 90 }), "not-visible");
	assert.equal(action({ currentChars: 0 }, { percent: 90 }), "not-smaller");
});

test("a large raw source does not justify expanding its active capped representation", () => {
	assert.equal(action({ currentChars: 280, replacementChars: 16966 }, { percent: 90 }), "not-smaller");
});

test("meaningful savings use the effective representation", () => {
	assert.equal(action({ currentChars: 20000, replacementChars: 19000, fresh: true }), "not-smaller");
	assert.equal(action({ currentChars: 800, replacementChars: 400, fresh: true }), "not-smaller");
	assert.equal(action({ currentChars: 1000, replacementChars: 500, fresh: true }), "emit");
});

test("unusable measurements fail open without changing context", () => {
	assert.equal(action({ currentChars: Number.NaN, fresh: true }), "not-visible");
	assert.equal(action({ replacementChars: Number.NaN, fresh: true }), "not-smaller");
	assert.equal(action({ replacementChars: -1, fresh: true }), "not-smaller");
});

test("planning is deterministic and does not mutate input candidates", () => {
	const c = Object.freeze(candidate());
	const p = Object.freeze({ ...defaults });
	assert.deepEqual(planEmissions([c], p), [{ entryId: "source", action: "defer-pressure", saved: 8000 }]);
});

test("deferred proposals do not masquerade as applied extracts", () => {
	assert.equal(representationAfterEmission(null, "useExtract", false, false), "retainFull");
	assert.equal(representationAfterEmission("retainFull", "indexOnly", false, false), "retainFull");
	assert.equal(representationAfterEmission("cap", "useExtract", false, false), "cap");
});

test("only applied edits advance representation metadata", () => {
	assert.equal(representationAfterEmission("retainFull", "useExtract", true, false), "useExtract");
	assert.equal(representationAfterEmission("retainFull", "indexOnly", true, false), "indexOnly");
	assert.equal(representationAfterEmission(null, "useExtract", false, true), "cap");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { autoCompactDecision, pushPctSample, resolveGates } from "./tiering.ts";

const THRESHOLDS = {
	stubProb: 0.85,
	truncProb: 0.6,
	minBatchSaved: 3000,
	softFloorPct: 50,
	contextFloorPct: 70,
	criticalPct: 85,
};

const COMPACT = { autoCompactPct: 90, autoCompactRiseTurns: 3, criticalPct: 85 };

test("resolveGates: normal tier below soft floor keeps defaults", () => {
	const g = resolveGates(49.9, THRESHOLDS);
	assert.equal(g.tier, "normal");
	assert.equal(g.stub, 0.85);
	assert.equal(g.trunc, 0.6);
	assert.equal(g.floor, 3000);
});

test("resolveGates: soft tier lowers truncate gate and floor to a third", () => {
	const g = resolveGates(50, THRESHOLDS);
	assert.equal(g.tier, "soft");
	assert.equal(g.stub, 0.85);
	assert.equal(g.trunc, 0.5);
	assert.equal(g.floor, 1000);
	assert.equal(resolveGates(69.9, THRESHOLDS).tier, "soft");
});

test("resolveGates: floor tier lowers truncate gate, keeps batch floor", () => {
	const g = resolveGates(70, THRESHOLDS);
	assert.equal(g.tier, "floor");
	assert.equal(g.trunc, 0.5);
	assert.equal(g.floor, 3000);
	assert.equal(resolveGates(84.9, THRESHOLDS).tier, "floor");
});

test("resolveGates: critical tier zeroes the floor and drops both gates", () => {
	const g = resolveGates(85, THRESHOLDS);
	assert.equal(g.tier, "critical");
	assert.equal(g.stub, 0.7);
	assert.equal(g.trunc, 0.5);
	assert.equal(g.floor, 0);
});

test("autoCompactDecision: disabled (autoCompactPct=0) never triggers", () => {
	assert.equal(autoCompactDecision(95, [], { inFlight: false, cooldownUntilTurn: 0, turnIndex: 1 }, { ...COMPACT, autoCompactPct: 0 }), null);
});

test("autoCompactDecision: in-flight compaction blocks the trigger", () => {
	assert.equal(
		autoCompactDecision(95, [], { inFlight: true, cooldownUntilTurn: 0, turnIndex: 1 }, COMPACT),
		null,
	);
});

test("autoCompactDecision: cooldown blocks until it expires, then re-fires", () => {
	const blocked = { inFlight: false, cooldownUntilTurn: 8, turnIndex: 5 };
	assert.equal(autoCompactDecision(95, [], blocked, COMPACT), null);
	const expired = { inFlight: false, cooldownUntilTurn: 8, turnIndex: 8 };
	assert.equal(autoCompactDecision(95, [], expired, COMPACT), "level");
});

test("autoCompactDecision: level fires at or above autoCompactPct", () => {
	const ok = { inFlight: false, cooldownUntilTurn: 0, turnIndex: 1 };
	assert.equal(autoCompactDecision(90, [], ok, COMPACT), "level");
	assert.equal(autoCompactDecision(93.4, [], ok, COMPACT), "level");
});

test("autoCompactDecision: slope requires rising history in the critical tier", () => {
	const ok = { inFlight: false, cooldownUntilTurn: 0, turnIndex: 10 };
	// below critical tier — pruning may still keep pace
	assert.equal(autoCompactDecision(84.9, [82, 83, 84, 84.9], ok, COMPACT), null);
	// rising fast enough over 3 consecutive transitions
	assert.equal(autoCompactDecision(86.8, [85, 85.6, 86.2, 86.8], ok, COMPACT), "slope");
});

test("autoCompactDecision: slope rejects flat, dipping, and short histories", () => {
	const ok = { inFlight: false, cooldownUntilTurn: 0, turnIndex: 10 };
	assert.equal(autoCompactDecision(85, [85, 85, 85, 85], ok, COMPACT), null);
	assert.equal(autoCompactDecision(86.8, [85, 85.6, 85.9, 86.8], ok, COMPACT), null);
	assert.equal(autoCompactDecision(86.8, [85.6, 86.2, 86.8], ok, COMPACT), null);
	// a plateau then resume does not count as continuous climbing
	assert.equal(autoCompactDecision(86.8, [84, 85.6, 85.6, 86.8], ok, COMPACT), null);
});

test("autoCompactDecision: slope fires at exactly criticalPct on a clean rise", () => {
	const ok = { inFlight: false, cooldownUntilTurn: 0, turnIndex: 10 };
	assert.equal(autoCompactDecision(85, [83.5, 84, 84.5, 85], ok, COMPACT), "slope");
});

test("pushPctSample appends and trims to the cap", () => {
	assert.deepEqual(pushPctSample([], 50, 4), [50]);
	assert.deepEqual(pushPctSample([50, 51, 52, 53], 54, 4), [51, 52, 53, 54]);
});

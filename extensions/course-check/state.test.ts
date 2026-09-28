import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildNudgeDrafts,
	composeState,
	COURSE_CHECK_TYPE,
	digest,
	hasUserCorrection,
	lastNudge,
	NUDGE_MARKER,
	nudgeText,
	parseVerdict,
	readGoal,
	resolveConfig,
	shouldCheck,
	type CourseConfig,
	type SessionGoal,
} from "./state.ts";

// ─── entry mocks ─────────────────────────────────────────────────────

let seq = 0;
const nextId = () => `e${seq++}`;

function msgEntry(role: string, content: string | unknown[]): SessionEntry {
	return { id: nextId(), type: "message", message: { role, content } } as unknown as SessionEntry;
}

function assistantEntry(text: string, calls: { toolName: string; input?: unknown }[] = []): SessionEntry {
	const content = [
		...(text ? [{ type: "text", text }] : []),
		...calls.map((c) => ({ type: "toolCall", toolCallId: `c${seq}`, toolName: c.toolName, input: c.input })),
	];
	return msgEntry("assistant", content);
}

function toolResultEntry(toolName: string, text: string, isError = false): SessionEntry {
	return { id: nextId(), type: "message", message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }], toolCallId: "c0" } } as unknown as SessionEntry;
}

function goalEntry(goal: string): SessionEntry {
	return { id: nextId(), type: "custom", customType: "jev-curator-goal", data: { goal } } as unknown as SessionEntry;
}

function goalspecEntry(data: Record<string, unknown>): SessionEntry {
	return { id: nextId(), type: "custom", customType: "jev-curator-goalspec", data } as unknown as SessionEntry;
}

function nudgeEntry(content = `${NUDGE_MARKER} off track`): SessionEntry {
	return { id: nextId(), type: "custom_message", customType: COURSE_CHECK_TYPE, content, display: true } as unknown as SessionEntry;
}

const CFG: CourseConfig = { enabled: true, intervalTurns: 10, threshold: 0.7, timeoutMs: 6000, digestEntries: 60, digestCapChars: 6000 };

// ─── resolveConfig ────────────────────────────────────────────────────

test("resolveConfig defaults", () => {
	const cfg = resolveConfig({}, undefined);
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.intervalTurns, 10);
	assert.equal(cfg.threshold, 0.7);
	assert.equal(cfg.timeoutMs, 6000);
});

test("resolveConfig settings.json and env layering", () => {
	const fromSettings = resolveConfig({}, { enabled: false, intervalTurns: 5, threshold: 0.8 });
	assert.equal(fromSettings.enabled, false);
	assert.equal(fromSettings.intervalTurns, 5);
	assert.equal(fromSettings.threshold, 0.8);

	const envWins = resolveConfig({ COURSE_CHECK_INTERVAL: "3", COURSE_CHECK_THRESHOLD: "0.6" }, { intervalTurns: 5, threshold: 0.8 });
	assert.equal(envWins.intervalTurns, 3);
	assert.equal(envWins.threshold, 0.6);
});

test("resolveConfig kill switch and clamps", () => {
	assert.equal(resolveConfig({ COURSE_CHECK: "0" }, { enabled: true }).enabled, false);
	assert.equal(resolveConfig({ COURSE_CHECK: "1" }, { enabled: false }).enabled, true);
	const clamped = resolveConfig({ COURSE_CHECK_INTERVAL: "0", COURSE_CHECK_THRESHOLD: "1.5", COURSE_CHECK_TIMEOUT_MS: "10" }, undefined);
	assert.equal(clamped.intervalTurns, 1);
	assert.equal(clamped.threshold, 0.95);
	assert.equal(clamped.timeoutMs, 1000);
});

// ─── readGoal ─────────────────────────────────────────────────────────

test("readGoal: pinned goal wins over goalspec and first prompt", () => {
	const entries = [
		msgEntry("user", "build the thing"),
		goalspecEntry({ userObjective: "spec objective", successCriteria: ["c1"], currentPlan: ["p1"] }),
		goalEntry("pinned goal"),
	];
	assert.deepEqual(readGoal(entries), { objective: "pinned goal", criteria: [], plan: [] });
});

test("readGoal: goalspec fallback with criteria and plan", () => {
	const entries = [
		msgEntry("user", "first prompt"),
		goalspecEntry({ userObjective: "spec objective", successCriteria: ["c1", "c2"], currentPlan: ["p1"] }),
	];
	const goal = readGoal(entries);
	assert.equal(goal?.objective, "spec objective");
	assert.deepEqual(goal?.criteria, ["c1", "c2"]);
	assert.deepEqual(goal?.plan, ["p1"]);
});

test("readGoal: first user prompt fallback, latest pin wins, null when empty", () => {
	assert.equal(readGoal([msgEntry("user", "  ")]), null);
	assert.equal(readGoal([]), null);

	const fallback = readGoal([msgEntry("assistant", "hi"), msgEntry("user", "do the task")]);
	assert.equal(fallback?.objective, "do the task");

	const latestPin = readGoal([goalEntry("old"), goalEntry("new")]);
	assert.equal(latestPin?.objective, "new");
});

// ─── digest ───────────────────────────────────────────────────────────

test("digest: one line per message kind, tool calls and results included", () => {
	const entries = [
		msgEntry("user", "add a test"),
		assistantEntry("I will add it now", [{ toolName: "edit", input: { path: "a.ts" } }]),
		toolResultEntry("edit", "ok applied"),
	];
	const d = digest(entries, CFG);
	assert.match(d, /user: add a test/);
	assert.match(d, /assistant: I will add it now/);
	assert.match(d, /call: edit\(/);
	assert.match(d, /tool edit ok: ok applied/);
});

test("digest: own nudges and marker lines are excluded from agent activity", () => {
	const entries = [
		nudgeEntry(),
		msgEntry("user", `${NUDGE_MARKER} off track (p=0.90) — rethink`),
		msgEntry("user", "real message"),
	];
	const d = digest(entries, CFG);
	assert.equal(d, "user: real message");
});

test("digest: line and char caps keep the tail", () => {
	const many: SessionEntry[] = [];
	for (let i = 0; i < 30; i++) many.push(msgEntry("user", `message ${i}`));
	const capped = digest(many, { ...CFG, digestEntries: 5 });
	assert.match(capped, /message 29/);
	assert.ok(!capped.includes("message 0\n"));
	assert.equal(capped.split("\n").length, 5);

	const long: SessionEntry[] = [];
	for (let i = 0; i < 10; i++) long.push(msgEntry("assistant", "x".repeat(500)));
	const charCapped = digest(long, { ...CFG, digestEntries: 60, digestCapChars: 1000 });
	assert.ok(charCapped.startsWith("…[earlier activity omitted]"));
	assert.ok(charCapped.length < 1200);
	assert.match(charCapped, /x{50}/); // tail content survives, not the head
});

// ─── shouldCheck ──────────────────────────────────────────────────────

test("shouldCheck: interval multiples, dedup, kill conditions", () => {
	assert.equal(shouldCheck(10, 0, CFG), true);
	assert.equal(shouldCheck(11, 0, CFG), false);
	assert.equal(shouldCheck(10, 10, CFG), false); // same turn twice
	assert.equal(shouldCheck(0, 0, CFG), false);
	assert.equal(shouldCheck(10, 0, { ...CFG, enabled: false }), false);
	assert.equal(shouldCheck(7, 0, { ...CFG, intervalTurns: 7 }), true);
});

// ─── parseVerdict ─────────────────────────────────────────────────────

test("parseVerdict: nudge gate honors threshold and probabilities", () => {
	const off = parseVerdict(
		{ course: { choice: "off_track", probabilities: { off_track: 0.82, on_track: 0.18 }, confidence: 0.9 }, failure: { choice: "rabbit_hole" } },
		0.7,
	);
	assert.equal(off?.verdict, "off_track");
	assert.equal(off?.p, 0.82);
	assert.equal(off?.why, "rabbit_hole");
	assert.equal(off?.nudge, true);

	const below = parseVerdict(
		{ course: { choice: "off_track", probabilities: { off_track: 0.6, on_track: 0.4 } } },
		0.7,
	);
	assert.equal(below?.nudge, false);

	const onTrack = parseVerdict(
		{ course: { choice: "on_track", probabilities: { on_track: 0.95 } } },
		0.7,
	);
	assert.equal(onTrack?.nudge, false);
});

test("parseVerdict: degraded and malformed answers", () => {
	assert.equal(parseVerdict(null, 0.7), null);
	assert.equal(parseVerdict({}, 0.7), null);
	assert.equal(parseVerdict({ course: "garbage" }, 0.7), null);

	const noProbs = parseVerdict({ course: { choice: "off_track" } }, 0.7);
	assert.equal(noProbs?.p, 0);
	assert.equal(noProbs?.nudge, false);

	const topFallback = parseVerdict(
		{ course: { probabilities: { on_track: 0.3, blocked: 0.7 } } },
		0.7,
	);
	assert.equal(topFallback?.verdict, "blocked");
	assert.equal(topFallback?.p, 0.7);
	assert.equal(topFallback?.why, "none");
});

// ─── nudge text and drafts ────────────────────────────────────────────

const GOAL: SessionGoal = { objective: "ship the login fix", criteria: [], plan: [] };

test("nudgeText: off-track rethink carries marker, goal, and instructions", () => {
	const v: Verdict = { verdict: "off_track", p: 0.78, confidence: 0.9, why: "rabbit_hole", nudge: true };
	const text = nudgeText(v, GOAL, 1);
	assert.ok(text.startsWith(NUDGE_MARKER));
	assert.match(text, /off track \(p=0\.78 · mode: rabbit_hole — the same failing approach keeps repeating\)/);
	assert.match(text, /SESSION GOAL: ship the login fix/);
	assert.match(text, /Rethink the approach before continuing/);
});

test("nudgeText: escalation on consecutive verdicts", () => {
	const v: Verdict = { verdict: "off_track", p: 0.8, confidence: 0.9, why: "scope_drift", nudge: true };
	const escalated = nudgeText(v, GOAL, 2);
	assert.match(escalated, /SECOND CONSECUTIVE off-track verdict/);
	assert.match(escalated, /3-line reassessment/);
});

test("nudgeText: goal_unclear asks the user, goal_met stops", () => {
	const unclear = nudgeText({ verdict: "goal_unclear", p: 0.71, confidence: 0.8, why: "none", nudge: true }, GOAL, 1);
	assert.match(unclear, /clarifying questions/);

	const met = nudgeText({ verdict: "goal_met", p: 0.82, confidence: 0.9, why: "goal_met_overrun", nudge: true }, GOAL, 1);
	assert.match(met, /appears already achieved/);
	assert.match(met, /report completion to the user/);
});

test("buildNudgeDrafts: retires the previous nudge, appends exactly one new", () => {
	const withPrevious = [msgEntry("user", "hi"), nudgeEntry()];
	const v: Verdict = { verdict: "off_track", p: 0.9, confidence: 0.9, why: "tangents", nudge: true };
	const drafts = buildNudgeDrafts(withPrevious, v, GOAL, 1);
	assert.equal(drafts.length, 2);
	assert.equal(drafts[0].type, "context_edit");
	assert.equal((drafts[0] as { targetId: string }).targetId, withPrevious[1].id);
	const appended = drafts[1];
	assert.equal(appended.type, "custom_message");
	assert.equal((appended as { customType: string }).customType, COURSE_CHECK_TYPE);
	assert.ok(((appended as { content: string }).content).startsWith(NUDGE_MARKER));

	const fresh = buildNudgeDrafts([msgEntry("user", "hi")], v, GOAL, 1);
	assert.equal(fresh.length, 1);
	assert.equal(fresh[0].type, "custom_message");
});

test("lastNudge finds only live course-check messages", () => {
	assert.equal(lastNudge([]), null);
	const mine = nudgeEntry();
	const other = { id: nextId(), type: "custom_message", customType: "recite", content: "block" } as unknown as SessionEntry;
	assert.equal(lastNudge([other, mine])?.id, mine.id);
});

// ─── composeState and user corrections ────────────────────────────────

test("composeState: goal blocks plus digest", () => {
	const goal: SessionGoal = { objective: "fix the bug", criteria: ["tests pass"], plan: ["find root cause"] };
	const state = composeState(goal, [msgEntry("user", "start")], CFG);
	assert.match(state, /SESSION GOAL:\nfix the bug/);
	assert.match(state, /SUCCESS CRITERIA:\n- tests pass/);
	assert.match(state, /CURRENT PLAN:\n- find root cause/);
	assert.match(state, /RECENT ACTIVITY \(oldest first\):\nuser: start/);
});

test("hasUserCorrection: predicate over the recent window", () => {
	const entries = [msgEntry("user", "not like that, use the other file")];
	assert.equal(hasUserCorrection(entries, (t) => t.startsWith("not")), true);
	assert.equal(hasUserCorrection(entries, (t) => t.startsWith("zzz")), false);
	assert.equal(hasUserCorrection([msgEntry("user", "all good")], () => true), true);
});

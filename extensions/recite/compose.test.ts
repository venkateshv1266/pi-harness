import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { clip, composeRecitation, DEFAULT_BUDGET_CHARS, RECITE_HEADER, type ReciteSpec } from "./compose.ts";
import { buildRecitationDrafts, lastRecitation, lastUserText, readGoalSpec, readTodos } from "./state.ts";

const HEADER_COST = RECITE_HEADER.length + 1;

function spec(over: Partial<ReciteSpec> = {}): ReciteSpec {
	return {
		userObjective: "Fix the sendq dedupe key regression.",
		objectiveRefinements: [],
		successCriteria: [],
		constraints: [],
		currentPlan: [],
		openQuestions: [],
		...over,
	};
}

function entry(over: Record<string, unknown>): SessionEntry {
	return { id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", ...over } as unknown as SessionEntry;
}

function userEntry(id: string, text: string): SessionEntry {
	return entry({ id, type: "message", message: { role: "user", content: [{ type: "text", text }] } });
}

function todoEntry(id: string, todos: { id: number; text: string; done: boolean }[]): SessionEntry {
	return entry({
		id,
		type: "message",
		message: { role: "toolResult", toolName: "todo", toolCallId: "tc1", content: [], details: { todos, nextId: 9 } },
	});
}

function goalspecEntry(id: string, data: unknown): SessionEntry {
	return entry({ id, type: "custom", customType: "jev-curator-goalspec", data });
}

function reciteEntry(id: string, content: string): SessionEntry {
	return entry({ id, type: "custom_message", customType: "recite", content, display: false });
}

test("clip collapses whitespace and truncates with an ellipsis", () => {
	assert.equal(clip("  a\n\n b\tc  ", 40), "a b c");
	assert.equal(clip("abcdefghij", 5), "abcd…");
	assert.equal(clip("abcdefghij", 10), "abcdefghij");
});

test("composeRecitation returns null without state", () => {
	assert.equal(composeRecitation({ spec: null, fallbackObjective: "", todos: [] }), null);
	assert.equal(composeRecitation({ spec: null, fallbackObjective: "   ", todos: [] }), null);
});

test("composeRecitation carries objective, plan, open questions and todo", () => {
	const block = composeRecitation({
		spec: spec({
			currentPlan: ["reproduce the bug", "patch dedupeKey", "run the suite"],
			openQuestions: ["does legacy replay stay idempotent?"],
			successCriteria: ["dedupe.spec.ts unchanged and green"],
			constraints: ["no public API changes"],
		}),
		fallbackObjective: "",
		todos: [
			{ id: 2, text: "patch dedupeKey", done: true },
			{ id: 3, text: "run the suite", done: false },
		],
	});
	assert.ok(block);
	const lines = block.split("\n");
	assert.equal(lines[0], RECITE_HEADER);
	assert.equal(lines[1], "OBJECTIVE: Fix the sendq dedupe key regression.");
	assert.equal(lines[2], "PLAN: p1. reproduce the bug; p2. patch dedupeKey; p3. run the suite");
	assert.equal(lines[3], "OPEN: q1. does legacy replay stay idempotent?");
	assert.equal(lines[4], "TODO: 1/2 done; #3 run the suite");
	assert.equal(lines[5], "CRITERIA: c1. dedupe.spec.ts unchanged and green");
	assert.equal(lines[6], "CONSTRAINTS: k1. no public API changes");
});

test("composeRecitation keeps the objective when later sections cannot fit", () => {
	const long = "x".repeat(300);
	const block = composeRecitation(
		{
			spec: spec({ userObjective: "o".repeat(300), constraints: Array.from({ length: 20 }, () => long) }),
			fallbackObjective: "",
			todos: [],
		},
		450,
	);
	assert.ok(block);
	assert.ok(block.length <= 450);
	assert.ok(block.startsWith(RECITE_HEADER));
	assert.match(block, /OBJECTIVE: o+/);
	assert.doesNotMatch(block, /CONSTRAINTS: /);
});

test("composeRecitation stays within the default budget for maximal state", () => {
	const block = composeRecitation({
		spec: spec({
			userObjective: "y".repeat(500),
			objectiveRefinements: ["r1".repeat(200), "r2".repeat(200)],
			currentPlan: Array.from({ length: 10 }, (_, i) => `step ${i} ${"z".repeat(120)}`),
			openQuestions: Array.from({ length: 6 }, (_, i) => `question ${i} ${"z".repeat(120)}`),
			successCriteria: Array.from({ length: 6 }, (_, i) => `criterion ${i} ${"z".repeat(120)}`),
			constraints: Array.from({ length: 6 }, (_, i) => `constraint ${i} ${"z".repeat(120)}`),
		}),
		fallbackObjective: "",
		todos: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, text: "t".repeat(90), done: i % 3 === 0 })),
	});
	assert.ok(block);
	assert.ok(block.length <= DEFAULT_BUDGET_CHARS, `block is ${block.length} chars`);
});

test("composeRecitation marks capped lists", () => {
	const block = composeRecitation(
		{
			spec: spec({ currentPlan: Array.from({ length: 9 }, (_, i) => `step ${i}`) }),
			fallbackObjective: "",
			todos: [],
		},
		DEFAULT_BUDGET_CHARS,
	);
	assert.ok(block);
	assert.match(block, /PLAN: .*\(\+3 more\)/);
});

test("composeRecitation reports an all-done todo list", () => {
	const block = composeRecitation({
		spec: null,
		fallbackObjective: "objective",
		todos: [{ id: 1, text: "done thing", done: true }],
	});
	assert.ok(block);
	assert.match(block, /TODO: 1\/1 done; all items complete/);
});

test("composeRecitation falls back to the latest user request without a GoalSpec", () => {
	const block = composeRecitation({ spec: null, fallbackObjective: "do the thing", todos: [] });
	assert.ok(block);
	assert.match(block, /OBJECTIVE: do the thing/);
});

test("readGoalSpec keeps the latest goalspec and ignores malformed entries", () => {
	const entries = [
		goalspecEntry("g1", { userObjective: "first" }),
		goalspecEntry("g2", { userObjective: "second", successCriteria: ["c"], constraints: "nope" }),
		goalspecEntry("g3", { userObjective: 42 }),
	];
	const found = readGoalSpec(entries);
	assert.ok(found);
	assert.equal(found.userObjective, "second");
	assert.deepEqual(found.successCriteria, ["c"]);
	assert.deepEqual(found.constraints, []);
});

test("readTodos keeps the latest todo tool result", () => {
	const entries = [
		todoEntry("t1", [{ id: 1, text: "old", done: false }]),
		userEntry("u1", "next"),
		todoEntry("t2", [{ id: 1, text: "old", done: true }, { id: 2, text: "new", done: false }]),
	];
	assert.deepEqual(readTodos(entries), [
		{ id: 1, text: "old", done: true },
		{ id: 2, text: "new", done: false },
	]);
});

test("lastUserText keeps the latest non-empty user message", () => {
	const entries = [userEntry("u1", "first ask"), userEntry("u2", "second ask"), userEntry("u3", "  ")];
	assert.equal(lastUserText(entries), "second ask");
});

test("buildRecitationDrafts appends a hidden custom message on first emission", () => {
	const drafts = buildRecitationDrafts([userEntry("u1", "do the thing")], DEFAULT_BUDGET_CHARS);
	assert.equal(drafts.length, 1);
	assert.equal(drafts[0].type, "custom_message");
	const draft = drafts[0] as { customType: string; content: string; display: boolean };
	assert.equal(draft.customType, "recite");
	assert.equal(draft.display, false);
	assert.match(draft.content, /OBJECTIVE: do the thing/);
});

test("buildRecitationDrafts omits the previous block before appending the new one", () => {
	const entries: SessionEntry[] = [
		userEntry("u1", "do the thing"),
		reciteEntry("r1", "stale block"),
		todoEntry("t1", [{ id: 1, text: "step one", done: false }]),
	];
	const drafts = buildRecitationDrafts(entries, DEFAULT_BUDGET_CHARS);
	assert.equal(drafts.length, 2);
	assert.deepEqual(drafts[0], { type: "context_edit", targetId: "r1", replacement: null });
	assert.equal(drafts[1].type, "custom_message");
	assert.match((drafts[1] as { content: string }).content, /#1 step one/);
	assert.equal(lastRecitation(entries)?.id, "r1");
});

test("buildRecitationDrafts returns nothing when there is no state", () => {
	assert.deepEqual(buildRecitationDrafts([entry({ id: "x", type: "custom", customType: "other", data: {} })], DEFAULT_BUDGET_CHARS), []);
});

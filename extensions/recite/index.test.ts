import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionContext,
	SessionBoundaryDraft,
	SessionEntry,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";

process.env.RECITE = "1";
delete process.env.RECITE_CHARS;

const installRecite = (await import("./index.ts")).default;

interface FakeEvent {
	entries: SessionBoundaryDraft[];
	outcome: "completed" | "aborted" | "error";
}

interface FakeCtx {
	mode: ExtensionContext["mode"];
	sessionManager: { getBranch(): readonly SessionEntry[] };
}

type Handler = (event: FakeEvent, ctx: FakeCtx) => TurnEndEventResult | undefined;

interface FakePi {
	on(event: string, handler: Handler): void;
	registerCommand(name: string, definition: unknown): void;
}

function makeFakePi(): { handler: Handler; commands: string[] } {
	const handlers: Record<string, Handler[]> = {};
	const commands: string[] = [];
	const pi: FakePi = {
		on: (event, handler) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: (name) => {
			commands.push(name);
		},
	};
	installRecite(pi as unknown as Parameters<typeof installRecite>[0]);
	const handler = handlers["turn_end"]?.[0];
	assert.ok(handler);
	return { handler, commands };
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

function makeCtx(entries: readonly SessionEntry[], mode: ExtensionContext["mode"] = "tui"): FakeCtx {
	return { mode, sessionManager: { getBranch: () => entries } };
}

function textOf(draft: SessionBoundaryDraft): string {
	if (draft.type !== "custom_message") assert.fail("expected a custom message draft");
	if (typeof draft.content !== "string") assert.fail("expected text content");
	return draft.content;
}

test("turn_end appends one reminder and preserves earlier drafts", () => {
	const { handler, commands } = makeFakePi();
	const earlier: SessionBoundaryDraft = { type: "custom", customType: "earlier", data: { n: 1 } };
	const result = handler({ entries: [earlier], outcome: "completed" }, makeCtx([userEntry("u1", "do the thing")]));
	assert.ok(result?.entries);
	assert.equal(result.entries[0], earlier);
	assert.equal(result.entries.length, 2);
	assert.equal(result.entries.filter((draft) => draft.type === "custom_message").length, 1);
	assert.equal(result.entries.filter((draft) => draft.type === "context_edit").length, 0);
	assert.deepEqual(commands, ["recite"]);
});

test("turn_end composes the newest GoalSpec from a pending boundary draft", () => {
	const { handler } = makeFakePi();
	const pending: SessionBoundaryDraft = {
		type: "custom",
		customType: "jev-curator-goalspec",
		data: { userObjective: "boundary objective" },
	};
	const branch = [userEntry("u1", "old request"), goalspecEntry("g1", { userObjective: "committed objective" })];
	const result = handler({ entries: [pending], outcome: "completed" }, makeCtx(branch));
	assert.ok(result?.entries);
	const recitation = result.entries.filter((draft) => draft.type === "custom_message");
	assert.equal(recitation.length, 1);
	assert.match(textOf(recitation[0]), /OBJECTIVE: boundary objective/);
});

test("repeated turns keep the earlier projected prefix", () => {
	const { handler } = makeFakePi();
	let branch: SessionEntry[] = [userEntry("u1", "anchor")];
	const projected: string[] = ["anchor"];
	const objectives = ["first objective", "second objective", "third objective"];
	for (let i = 0; i < objectives.length; i++) {
		branch = [
			...branch,
			goalspecEntry(`g${i + 1}`, { userObjective: objectives[i] }),
			todoEntry(`t${i + 1}`, [{ id: i + 1, text: `step ${i + 1}`, done: i === 0 }]),
		];
		const result = handler({ entries: [], outcome: "completed" }, makeCtx(branch));
		assert.ok(result?.entries);
		const before = projected.slice();
		for (const draft of result.entries) projected.push(textOf(draft));
		assert.deepEqual(projected.slice(0, before.length), before);
		branch = [...branch, reciteEntry(`r${i + 1}`, projected[projected.length - 1])];
	}
	assert.equal(projected.length, objectives.length + 1);
	assert.match(projected[1], /OBJECTIVE: first objective/);
	assert.match(projected[3], /OBJECTIVE: third objective/);
});

test("turn_end skips failed, aborted, and print-mode turns", () => {
	const { handler } = makeFakePi();
	const branch = [userEntry("u1", "do the thing")];
	assert.equal(handler({ entries: [], outcome: "error" }, makeCtx(branch)), undefined);
	assert.equal(handler({ entries: [], outcome: "aborted" }, makeCtx(branch)), undefined);
	assert.equal(handler({ entries: [], outcome: "completed" }, makeCtx(branch, "print")), undefined);
});

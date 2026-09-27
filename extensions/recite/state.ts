/**
 * Pure session-state readers for tail recitation.
 *
 * Everything here is a deterministic function over a session branch, so the
 * reciter works standalone — it depends on persisted contracts (the curator's
 * GoalSpec entries and the todo tool's result details), not on other
 * extensions being loaded or enabled.
 */

import type { ContextEditEntryDraft, CustomMessageEntryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ReciteSpec, ReciteTodo } from "./compose.js";
// .ts specifier: this module is also exercised directly by node --test (no jiti there).
import { composeRecitation } from "./compose.ts";

export const RECITE_TYPE = "recite";
const GOALSPEC_TYPE = "jev-curator-goalspec";

function strArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function isTodo(value: unknown): value is ReciteTodo {
	if (typeof value !== "object" || value === null) return false;
	const t = value as Record<string, unknown>;
	return typeof t.id === "number" && typeof t.text === "string" && typeof t.done === "boolean";
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			if (typeof part !== "object" || part === null) return false;
			const p = part as Record<string, unknown>;
			return p.type === "text" && typeof p.text === "string";
		})
		.map((part) => part.text)
		.join("\n");
}

/** Latest GoalSpec flushed by the curator, or null when none exists on the branch. */
export function readGoalSpec(entries: readonly SessionEntry[]): ReciteSpec | null {
	let latest: ReciteSpec | null = null;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== GOALSPEC_TYPE) continue;
		const data = entry.data as Record<string, unknown> | undefined;
		if (!data || typeof data.userObjective !== "string") continue;
		latest = {
			userObjective: data.userObjective,
			objectiveRefinements: strArray(data.objectiveRefinements),
			successCriteria: strArray(data.successCriteria),
			constraints: strArray(data.constraints),
			currentPlan: strArray(data.currentPlan),
			openQuestions: strArray(data.openQuestions),
		};
	}
	return latest;
}

/** Current todo list, reconstructed from the latest todo tool result on the branch. */
export function readTodos(entries: readonly SessionEntry[]): ReciteTodo[] {
	let todos: ReciteTodo[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
		const details = msg.details as { todos?: unknown } | undefined;
		if (!details || !Array.isArray(details.todos)) continue;
		todos = details.todos.filter(isTodo);
	}
	return todos;
}

/** Last non-empty user message on the branch: the fallback objective without a GoalSpec. */
export function lastUserText(entries: readonly SessionEntry[]): string {
	let text = "";
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const candidate = messageText(entry.message.content).trim();
		if (candidate) text = candidate;
	}
	return text;
}

/** Most recent recitation entry, if any. */
export function lastRecitation(entries: readonly SessionEntry[]): { id: string; content: string } | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom_message" && entry.customType === RECITE_TYPE) {
			return { id: entry.id, content: messageText(entry.content) };
		}
	}
	return null;
}

/** Boundary drafts: omit the stale block, then append the fresh one. */
export function buildRecitationDrafts(
	entries: readonly SessionEntry[],
	budget: number,
): (ContextEditEntryDraft | CustomMessageEntryDraft)[] {
	const spec = readGoalSpec(entries);
	const block = composeRecitation({ spec, fallbackObjective: lastUserText(entries), todos: readTodos(entries) }, budget);
	if (!block) return [];

	const drafts: (ContextEditEntryDraft | CustomMessageEntryDraft)[] = [];
	const previous = lastRecitation(entries);
	if (previous) drafts.push({ type: "context_edit", targetId: previous.id, replacement: null });
	drafts.push({
		type: "custom_message",
		customType: RECITE_TYPE,
		content: block,
		display: false,
		details: { v: 1, chars: block.length, budget },
	});
	return drafts;
}

/**
 * Deterministic composition of the tail-recitation block.
 *
 * Pure functions only so the budget behavior is unit-testable without a live
 * pi session. The block is capped at DEFAULT_BUDGET_CHARS (~300 tokens): whole
 * items are added in priority order until the budget is spent, so a long
 * constraints list can never crowd out the objective.
 */

export interface ReciteSpec {
	userObjective: string;
	objectiveRefinements: string[];
	successCriteria: string[];
	constraints: string[];
	currentPlan: string[];
	openQuestions: string[];
}

export interface ReciteTodo {
	id: number;
	text: string;
	done: boolean;
}

export interface ReciteInput {
	spec: ReciteSpec | null;
	/** Latest user request, used when no GoalSpec exists (e.g. curator disabled). */
	fallbackObjective: string;
	todos: ReciteTodo[];
}

export const RECITE_HEADER = "SESSION STATE (reference only — continue the task; do not restate this block)";
export const DEFAULT_BUDGET_CHARS = 1200;

interface Section {
	label: string;
	items: string[];
	/** Full item count before capping; drives the "(+N more)" marker. */
	total: number;
	perItem: number;
}

/** Collapse whitespace and cut to `max` chars, appending an ellipsis when cut. */
export function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function numbered(prefix: string, items: string[], cap: number): string[] {
	return items.slice(0, cap).map((item, i) => `${prefix}${i + 1}. ${item}`);
}

function todoItems(todos: ReciteTodo[]): { items: string[]; total: number } {
	if (todos.length === 0) return { items: [], total: 0 };
	const done = todos.filter((t) => t.done).length;
	const head = `${done}/${todos.length} done`;
	const pending = todos.filter((t) => !t.done);
	if (pending.length === 0) return { items: [head, "all items complete"], total: 2 };
	const shown = pending.slice(0, 6).map((t) => `#${t.id} ${clip(t.text, 100)}`);
	return { items: [head, ...shown], total: pending.length + 1 };
}

function buildSections(input: ReciteInput): Section[] {
	const { spec } = input;
	const sections: Section[] = [];
	const objective = clip(spec?.userObjective?.trim() || input.fallbackObjective, 320);
	if (objective) sections.push({ label: "OBJECTIVE", items: [objective], total: 1, perItem: 320 });
	if (spec && spec.objectiveRefinements.length > 0) {
		sections.push({ label: "GOAL", items: spec.objectiveRefinements.slice(-2), total: spec.objectiveRefinements.length, perItem: 200 });
	}
	if (spec && spec.currentPlan.length > 0) {
		sections.push({ label: "PLAN", items: numbered("p", spec.currentPlan, 6), total: spec.currentPlan.length, perItem: 140 });
	}
	if (spec && spec.openQuestions.length > 0) {
		sections.push({ label: "OPEN", items: numbered("q", spec.openQuestions, 4), total: spec.openQuestions.length, perItem: 140 });
	}
	const todos = todoItems(input.todos);
	if (todos.items.length > 0) sections.push({ label: "TODO", items: todos.items, total: todos.total, perItem: 120 });
	if (spec && spec.successCriteria.length > 0) {
		sections.push({ label: "CRITERIA", items: numbered("c", spec.successCriteria, 4), total: spec.successCriteria.length, perItem: 140 });
	}
	if (spec && spec.constraints.length > 0) {
		sections.push({ label: "CONSTRAINTS", items: numbered("k", spec.constraints, 4), total: spec.constraints.length, perItem: 140 });
	}
	return sections;
}

export function composeRecitation(input: ReciteInput, budget = DEFAULT_BUDGET_CHARS): string | null {
	const sections = buildSections(input);
	const lines: string[] = [RECITE_HEADER];
	let used = RECITE_HEADER.length + 1;

	for (const section of sections) {
		let body = "";
		let taken = 0;
		for (const raw of section.items) {
			const item = clip(raw, section.perItem);
			if (!item) continue;
			const next = taken === 0 ? item : `${body}; ${item}`;
			const cost = section.label.length + 2 + next.length + 1;
			if (used + cost > budget) break;
			body = next;
			taken += 1;
		}
		if (taken === 0) continue;

		let line = `${section.label}: ${body}`;
		const remaining = section.total - taken;
		if (remaining > 0) {
			const marker = ` (+${remaining} more)`;
			if (used + line.length + marker.length + 1 <= budget) line += marker;
		}
		lines.push(line);
		used += line.length + 1;
	}

	return lines.length > 1 ? lines.join("\n") : null;
}

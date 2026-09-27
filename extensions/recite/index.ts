/**
 * Tail recitation — keep the session's goal state at the tail of every turn.
 *
 * After each turn (assistant message + tool results appended), emit a compact,
 * deterministic state block as a context-only custom message: GoalSpec fields
 * plus the live todo list. The block is re-emitted every turn so it always sits
 * at the most-attended position, and the previous copy is omitted from model
 * context so exactly one is ever live.
 *
 * Runs independently of the curator: state comes from session entries, so with
 * JEVCURATOR=0 the objective falls back to the latest user request and the todo
 * list still recites.
 *
 * Env: RECITE=0 disables; RECITE_CHARS overrides the char budget (default 1200,
 * roughly 300 tokens).
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { composeRecitation, DEFAULT_BUDGET_CHARS } from "./compose.js";
import { buildRecitationDrafts, lastRecitation, lastUserText, readGoalSpec, readTodos } from "./state.js";

const ENABLED = process.env.RECITE !== "0";
const BUDGET = parseBudget(process.env.RECITE_CHARS);

function parseBudget(raw: string | undefined): number {
	const n = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(n) && n >= 400 && n <= 8000 ? n : DEFAULT_BUDGET_CHARS;
}

function readBranch(ctx: ExtensionContext): readonly SessionEntry[] | null {
	try {
		return ctx.sessionManager.getBranch();
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("turn_end", (event, ctx): TurnEndEventResult | undefined => {
		if (!ENABLED || event.outcome !== "completed") return;
		const entries = readBranch(ctx);
		if (!entries) return;
		const drafts = buildRecitationDrafts(entries, BUDGET);
		if (drafts.length === 0) return;
		// Boundary entries compose by replacement, so keep earlier handlers' drafts.
		return { entries: [...event.entries, ...drafts] };
	});

	pi.registerCommand("recite", {
		description: "Show the tail-recitation block for the current session state",
		handler: async (_args, ctx) => {
			if (!ENABLED) {
				ctx.ui.notify("Tail recitation is disabled (RECITE=0).", "info");
				return;
			}
			const entries = readBranch(ctx);
			if (!entries) {
				ctx.ui.notify("Session branch unreadable.", "error");
				return;
			}
			const live = lastRecitation(entries);
			const block = composeRecitation(
				{ spec: readGoalSpec(entries), fallbackObjective: lastUserText(entries), todos: readTodos(entries) },
				BUDGET,
			);
			ctx.ui.notify(
				[
					`tail recitation: on · budget ${BUDGET} chars · last block ${live ? `${live.content.length} chars` : "none"}`,
					block ? `\nnext block (${block.length} chars):\n\n${block}` : "\nnext block: none (no goal or todo state yet)",
				].join("\n"),
				"info",
			);
		},
	});
}

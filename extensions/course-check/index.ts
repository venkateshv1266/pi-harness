/**
 * Course check — periodic Jev supervision of the main agent's trajectory.
 *
 * Every `intervalTurns` turn ends (default 10) the extension hands Jev the
 * session goal (the curator's goal pin / GoalSpec, falling back to the user's
 * first prompt) plus a one-line-per-message digest of recent activity, and asks
 * one question: is the agent on a path that plausibly reaches the goal?
 * Nudge verdicts (off_track / goal_unclear / goal_moved / goal_met, p ≥ threshold) inject a
 * visible course-correction message telling the agent to rethink its approach;
 * on_track and blocked verdicts stay silent. At most one nudge is ever live in
 * context: each new check retires the previous message with a context_edit,
 * and a recovering trajectory retires the stale one.
 *
 * A focused goal_moved check also runs at every user prompt (`before_agent_start`):
 * Jev judges the incoming prompt against the recorded goal, and when the prompt
 * redefines the objective a nudge lands before the run starts — so the agent
 * re-pins the goal immediately instead of working a few turns with the stale
 * goal that recite's session-state block still carries.
 *
 * Scope and safety:
 *   - Print-mode sessions are skipped (an appended entry displaces pi -p
 *     output), so subagent children are never supervised — only the main
 *     session is.
 *   - A Jev failure never breaks the turn: three consecutive failures open a
 *     30-minute breaker so turn boundaries stop stalling on a dead endpoint.
 *   - Every nudge is a `decision` in the shared telemetry (jev-decisions/
 *     course-check.jsonl); the next check resolves it — recovered (good) /
 *     still_off_track (bad) / blocked (unknown), with a user-correction flag
 *     for ambiguous attribution. Non-nudging checks log as events.
 *
 * Config lives in settings.json `courseCheck` (see setup.ts for /setup), env
 * vars override for one-off runs, and COURSE_CHECK=0 is a hard kill switch.
 */

import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, SessionBoundaryDraft, SessionEntry, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { jevCall as sharedJevCall, scrubSecrets, type Question } from "../../utils/jev-client.ts";
import { looksLikeUserCorrection, logDecision, logEvent, logOutcome, type Verdict as OutcomeVerdict } from "../../utils/jev-outcomes.ts";
import {
	buildNudgeDrafts,
	composePromptState,
	composeState,
	COURSE_CHECK_TYPE,
	hasUserCorrection,
	lastNudge,
	MIN_PROMPT_CHARS,
	nudgeIsPromptMoved,
	parseMoved,
	parseVerdict,
	promptMovedText,
	readGoal,
	shouldCheck,
	type SessionGoal,
	type Verdict,
} from "./state.ts";
import { resolveLiveConfig, updateCourseSettings } from "./settings.ts";

const SYSTEM = "course-check";
const LOG_FILE = "course-check.jsonl";
const MAX_FAILS = 3;
const COOLDOWN_MS = 30 * 60_000;

const QUESTIONS = {
	course: {
		type: "choice",
		instructions:
			"A supervisor periodically reviews an AI coding agent mid-session. Judging the RECENT ACTIVITY against the SESSION GOAL, is the agent on a path that plausibly reaches the goal? Judge direction, not effort or volume: a productive dead end that was abandoned is on track; repeating variations of a failing approach, working outside the goal's scope, polishing tangents while the goal's core is untouched, or continuing after the goal appears met are off track. Use blocked only when progress is impossible without the user (waiting on input, broken environment), goal_unclear only when the stated goal is too vague to judge direction, and goal_moved only when the user's recent messages redefine the objective so the SESSION GOAL no longer describes their current ask (a stale goal — not agent drift).",
		criteria: {
			on_track: "Recent actions map to the goal, plan, or success criteria — the trajectory plausibly reaches it",
			off_track: "Recent actions do not progress the goal — wrong scope, repeated failing attempts, tangents, or busywork while the goal's core is untouched",
			goal_unclear: "The stated goal is too ambiguous to judge direction; the agent should clarify with the user rather than guess",
			goal_moved: "The user has redefined the objective — recent user messages ask for something the SESSION GOAL no longer describes; the goal state is stale, not the agent's path",
			goal_met: "The goal appears already achieved; further activity is unnecessary",
			blocked: "Progress is impossible without the user — waiting on input or a broken environment; not the agent's own drift",
		},
	},
	failure: {
		type: "choice",
		instructions: "If course is off_track or goal_met, pick the dominant failure mode; otherwise answer none.",
		criteria: {
			none: "Course is not off track",
			scope_drift: "Working on something other than what was asked — a different feature, file set, or problem than the goal names",
			rabbit_hole: "Fixating on one sub-problem, repeating variations of the same failing approach while the goal stalls",
			tangents: "Polishing, refactoring, or beautifying work the goal does not require",
			wrong_solution: "Active work toward the goal, but the chosen approach cannot plausibly satisfy the success criteria",
			goal_met_overrun: "The goal is already achieved; activity continues anyway",
		},
	},
} as const;

// Focused per-prompt question: only "did this prompt redefine the objective",
// never the trajectory verdicts — those stay with the periodic turn-end check.
const PROMPT_QUESTIONS = {
	goal_moved: {
		type: "noul",
		instructions:
			"A supervisor watches an AI coding session. A NEW USER PROMPT just arrived. Judged against the SESSION GOAL, does this prompt redefine the objective so the goal state is stale?",
		criteria: {
			true: "The prompt names a different target or outcome, materially changes scope, or adds or changes a requirement the SESSION GOAL does not describe — the goal state should be rewritten to match the new ask",
			false: "The prompt is a follow-up, refinement, clarification, bug report, or new detail within the existing objective; the SESSION GOAL still describes the current ask",
		},
	},
} as const;



async function jevCall(
	state: string,
	timeoutMs: number,
	questions: Record<string, unknown> = QUESTIONS,
): Promise<Record<string, unknown> | null> {
	try {
		const result = await sharedJevCall(state, questions as unknown as Record<string, Question>, { timeoutMs, retries: 0 });
		return result.answers;
	} catch {
		return null;
	}
}
function sessionId(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return "";
	}
}

function branchEntries(ctx: ExtensionContext): readonly SessionEntry[] | null {
	try {
		return ctx.sessionManager.getBranch();
	} catch {
		return null;
	}
}

function round2(n: number): number {
	return Number(n.toFixed(2));
}

export default function courseCheck(pi: ExtensionAPI) {
	let lastCheckedTurn = 0;
	let consecutiveNudges = 0;
	let pending: { id: string; turn: number } | null = null;
	let armed = false;
	let fails = 0;
	let cooldownUntil = 0;
	let promptSeq = 0;
	let promptPending: { id: string; objective: string } | null = null;
	let promptFired: { previousNudgeId: string | null; objectiveBefore: string } | null = null;

	function resolvePending(turn: number, v: Verdict, entries: readonly SessionEntry[], session: string): void {
		if (!pending) return;
		const recovered = v.verdict === "on_track" || v.verdict === "goal_met";
		const outcome = recovered ? "recovered" : v.verdict === "blocked" ? "blocked" : "still_off_track";
		const outcomeVerdict: OutcomeVerdict = recovered ? "good" : v.verdict === "blocked" ? "unknown" : "bad";
		logOutcome(SYSTEM, LOG_FILE, pending.id, outcome, {
			verdict: outcomeVerdict,
			detail: {
				session,
				turnsAfter: Math.max(0, turn - pending.turn),
				userSteered: hasUserCorrection(entries, looksLikeUserCorrection),
			},
		});
		pending = null;
	}

	// Per-prompt goal_moved check: the user's latest prompt may redefine the
	// objective while the goal state (pinned goal / GoalSpec, echoed by
	// recite) still describes the old one. The focused Jev call runs before
	// the agent loop starts, so a re-pin happens in the same turn.
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
		if (event.messageType !== "user" || ctx.mode === "print") return;
		const cfg = resolveLiveConfig();
		if (!cfg.enabled || !cfg.promptCheck || Date.now() < cooldownUntil) return;
		const prompt = event.prompt.trim();
		if (prompt.startsWith("/") || prompt.length < MIN_PROMPT_CHARS) return;
		const entries = branchEntries(ctx);
		if (!entries) return;
		const goal = readGoal(entries);
		if (!goal || goal.objective === prompt) return; // no goal material yet, or identical resend

		promptSeq++;
		const answers = await jevCall(scrubSecrets(composePromptState(goal, prompt)), cfg.timeoutMs, PROMPT_QUESTIONS);
		if (!answers) {
			fails++;
			logEvent(SYSTEM, LOG_FILE, { event: "prompt_jev_unreachable", consecutive: fails, prompt: promptSeq, session: sessionId(ctx) });
			if (fails >= MAX_FAILS) {
				cooldownUntil = Date.now() + COOLDOWN_MS;
				logEvent(SYSTEM, LOG_FILE, { event: "breaker_open", cooldownMs: COOLDOWN_MS, prompt: promptSeq, session: sessionId(ctx) });
			}
			return;
		}
		fails = 0;
		const m = parseMoved(answers, cfg.threshold);
		if (!m) {
			logEvent(SYSTEM, LOG_FILE, { event: "prompt_malformed_answer", prompt: promptSeq, session: sessionId(ctx) });
			return;
		}

		// A pending prompt nudge resolves against the goal state as it stands
		// now: changed → the agent acted on it; unchanged → it did not.
		if (promptPending) {
			const now = readGoal(entries)?.objective;
			const recovered = now !== undefined && now !== promptPending.objective;
			logOutcome(SYSTEM, LOG_FILE, promptPending.id, recovered ? "recovered" : "still_stale", {
				verdict: recovered ? "good" : "bad",
				detail: { session: sessionId(ctx), source: "prompt" },
			});
			promptPending = null;
		}

		if (!m.moved) {
			logEvent(SYSTEM, LOG_FILE, { event: "prompt_check", verdict: "unchanged", p: round2(m.p), prompt: promptSeq, session: sessionId(ctx) });
			return;
		}

		const live = lastNudge(entries);
		const id = logDecision(SYSTEM, LOG_FILE, { prompt: promptSeq, source: "prompt", verdict: "goal_moved", p: round2(m.p), session: sessionId(ctx) });
		promptPending = { id, objective: goal.objective };
		// A prompt-time nudge already live says the same thing; don't stack a
		// second copy — housekeeping still gets a chance to retire it.
		const duplicate = live !== null && nudgeIsPromptMoved(live.details);
		promptFired = { previousNudgeId: duplicate ? null : live?.id ?? null, objectiveBefore: goal.objective };
		if (duplicate) return;
		return {
			message: {
				customType: COURSE_CHECK_TYPE,
				content: promptMovedText(goal, m.p),
				display: true,
				details: { source: "prompt", verdict: "goal_moved", p: round2(m.p) },
			},
		};
	});

	pi.on("turn_end", async (event: TurnEndEvent, ctx): Promise<{ entries: SessionBoundaryDraft[] } | void> => {
		if (ctx.mode === "print" || event.outcome !== "completed") return;
		const cfg = resolveLiveConfig();
		const entries = branchEntries(ctx);
		if (!entries) return;

		// Prompt-time nudge housekeeping: once the goal moved, any previous
		// nudge is obsolete; and a prompt nudge the agent acted on (goal state
		// changed during the run) is consumed and can leave the context.
		const drafts: SessionBoundaryDraft[] = [];
		if (promptFired) {
			const fired = promptFired;
			promptFired = null;
			if (fired.previousNudgeId) drafts.push({ type: "context_edit", targetId: fired.previousNudgeId, replacement: null });
			const goalNow = readGoal(entries);
			if (goalNow && goalNow.objective !== fired.objectiveBefore) {
				const live = lastNudge(entries);
				if (live && nudgeIsPromptMoved(live.details)) drafts.push({ type: "context_edit", targetId: live.id, replacement: null });
			}
		}
		const withDrafts = (extra: SessionBoundaryDraft[] = []): { entries: SessionBoundaryDraft[] } | undefined => {
			const seen = new Set<string>();
			const all = [...drafts, ...extra].filter((d) => {
				if (d.type !== "context_edit") return true;
				if (seen.has(d.targetId)) return false;
				seen.add(d.targetId);
				return true;
			});
			return all.length ? { entries: [...event.entries, ...all] } : undefined;
		};

		const due = armed || shouldCheck(event.turnIndex, lastCheckedTurn, cfg);
		if (!due) return withDrafts();
		armed = false;
		if (!cfg.enabled) return withDrafts();
		if (Date.now() < cooldownUntil) return withDrafts();
		lastCheckedTurn = event.turnIndex;

		const goal = readGoal(entries);
		if (!goal) return withDrafts(); // no user prompt yet: nothing to judge

		const state = scrubSecrets(composeState(goal, entries, cfg));
		const answers = await jevCall(state, cfg.timeoutMs);
		if (!answers) {
			fails++;
			logEvent(SYSTEM, LOG_FILE, { turn: event.turnIndex, event: "jev_unreachable", consecutive: fails, session: sessionId(ctx) });
			if (fails >= MAX_FAILS) {
				cooldownUntil = Date.now() + COOLDOWN_MS;
				logEvent(SYSTEM, LOG_FILE, { turn: event.turnIndex, event: "breaker_open", cooldownMs: COOLDOWN_MS, session: sessionId(ctx) });
			}
			return withDrafts();
		}
		fails = 0;
		const v = parseVerdict(answers, cfg.threshold);
		if (!v) {
			logEvent(SYSTEM, LOG_FILE, { turn: event.turnIndex, event: "malformed_answer", session: sessionId(ctx) });
			return withDrafts();
		}

		resolvePending(event.turnIndex, v, entries, sessionId(ctx));

		if (v.nudge) {
			consecutiveNudges++;
			const id = logDecision(SYSTEM, LOG_FILE, {
				turn: event.turnIndex,
				verdict: v.verdict,
				p: round2(v.p),
				why: v.why,
				consecutive: consecutiveNudges,
				session: sessionId(ctx),
			});
			pending = { id, turn: event.turnIndex };
			// boundary entries compose by replacement: keep earlier handlers' drafts
			return withDrafts(buildNudgeDrafts(entries, v, goal, consecutiveNudges));
		}

		consecutiveNudges = 0;
		logEvent(SYSTEM, LOG_FILE, { turn: event.turnIndex, verdict: v.verdict, p: round2(v.p), session: sessionId(ctx) });
		// on_track/blocked: retire a now-obsolete correction so stale "off-track" text never lingers
		const previous = lastNudge(entries);
		return withDrafts(previous ? [{ type: "context_edit", targetId: previous.id, replacement: null }] : []);
	});

	pi.registerCommand("course-check", {
		description: "Jev course supervision: status, on/off, or 'now' to check at the next turn end",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				updateCourseSettings((s) => {
					s.enabled = arg === "on";
				});
				ctx.ui.notify(`Course check ${arg === "on" ? "enabled" : "disabled"} — applies from the next check.`, "info");
				return;
			}
			if (arg === "now") {
				armed = true;
				ctx.ui.notify("Armed — the next turn end runs a course check.", "info");
				return;
			}
			const cfg = resolveLiveConfig();
			const lines = [
				`course check: ${cfg.enabled ? "on" : "off"} · every ${cfg.intervalTurns} turns · prompt goal check ${cfg.promptCheck ? "on" : "off"} · threshold ${cfg.threshold} · timeout ${cfg.timeoutMs} ms`,
				`last check: turn ${lastCheckedTurn || "none"} · consecutive nudges: ${consecutiveNudges}${pending ? " · outcome pending" : ""}${promptPending ? " · prompt outcome pending" : ""}`,
			];
			if (Date.now() < cooldownUntil) lines.push(`Jev breaker open until ${new Date(cooldownUntil).toLocaleTimeString()}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

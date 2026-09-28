/**
 * Course check — periodic Jev supervision of the main agent's trajectory.
 *
 * Every `intervalTurns` turn ends (default 10) the extension hands Jev the
 * session goal (the curator's goal pin / GoalSpec, falling back to the user's
 * first prompt) plus a one-line-per-message digest of recent activity, and asks
 * one question: is the agent on a path that plausibly reaches the goal?
 * Nudge verdicts (off_track / goal_unclear / goal_met, p ≥ threshold) inject a
 * visible course-correction message telling the agent to rethink its approach;
 * on_track and blocked verdicts stay silent. At most one nudge is ever live in
 * context: each new check retires the previous message with a context_edit,
 * and a recovering trajectory retires the stale one.
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

import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft, SessionEntry, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { looksLikeUserCorrection, logDecision, logEvent, logOutcome, type Verdict as OutcomeVerdict } from "../../utils/jev-outcomes.ts";
import {
	buildNudgeDrafts,
	composeState,
	hasUserCorrection,
	lastNudge,
	parseVerdict,
	readGoal,
	shouldCheck,
	type SessionGoal,
	type Verdict,
} from "./state.ts";
import { resolveLiveConfig, updateCourseSettings } from "./settings.ts";

const SYSTEM = "course-check";
const LOG_FILE = "course-check.jsonl";
const JEV_BASE_URL = process.env.JEV_BASE_URL ?? "https://openrouter.ai/api";
const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest";
const MAX_FAILS = 3;
const COOLDOWN_MS = 30 * 60_000;

const QUESTIONS = {
	course: {
		type: "choice",
		instructions:
			"A supervisor periodically reviews an AI coding agent mid-session. Judging the RECENT ACTIVITY against the SESSION GOAL, is the agent on a path that plausibly reaches the goal? Judge direction, not effort or volume: a productive dead end that was abandoned is on track; repeating variations of a failing approach, working outside the goal's scope, polishing tangents while the goal's core is untouched, or continuing after the goal appears met are off track. Use blocked only when progress is impossible without the user (waiting on input, broken environment), and goal_unclear only when the stated goal is too vague to judge direction.",
		criteria: {
			on_track: "Recent actions map to the goal, plan, or success criteria — the trajectory plausibly reaches it",
			off_track: "Recent actions do not progress the goal — wrong scope, repeated failing attempts, tangents, or busywork while the goal's core is untouched",
			goal_unclear: "The stated goal is too ambiguous to judge direction; the agent should clarify with the user rather than guess",
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

let jevKeyCache: string | null | undefined;

function jevKey(): string | null {
	if (jevKeyCache !== undefined) return jevKeyCache;
	jevKeyCache = process.env.JEV_API_KEY ?? process.env.OPENROUTER_API_KEY ?? null;
	if (!jevKeyCache) {
		try {
			const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as { openrouter?: { key?: string } };
			jevKeyCache = typeof auth.openrouter?.key === "string" ? auth.openrouter.key : null;
		} catch {
			jevKeyCache = null;
		}
	}
	return jevKeyCache;
}

const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\bsk-[A-Za-z0-9_-]{10,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

function scrubSecrets(s: string): string {
	let out = s;
	for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
	return out;
}

async function jevCall(state: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
	const key = jevKey();
	if (!key) return null;
	let res: { ok: boolean; json(): Promise<unknown> };
	try {
		res = await fetch(`${JEV_BASE_URL}/v1/systemone`, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model: JEV_MODEL, state, questions: QUESTIONS }),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch {
		return null;
	}
	if (!res.ok) return null;
	try {
		const j = (await res.json()) as { answers?: Record<string, unknown> };
		return j.answers ?? null;
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

	pi.on("turn_end", async (event: TurnEndEvent, ctx): Promise<{ entries: SessionBoundaryDraft[] } | void> => {
		if (ctx.mode === "print" || event.outcome !== "completed") return;
		const cfg = resolveLiveConfig();
		const due = armed || shouldCheck(event.turnIndex, lastCheckedTurn, cfg);
		if (!due) return;
		armed = false;
		if (!cfg.enabled) return;
		if (Date.now() < cooldownUntil) return;
		lastCheckedTurn = event.turnIndex;

		const entries = branchEntries(ctx);
		if (!entries) return;
		const goal = readGoal(entries);
		if (!goal) return; // no user prompt yet: nothing to judge

		const state = scrubSecrets(composeState(goal, entries, cfg));
		const answers = await jevCall(state, cfg.timeoutMs);
		if (!answers) {
			fails++;
			logEvent(SYSTEM, LOG_FILE, { turn: event.turnIndex, event: "jev_unreachable", consecutive: fails, session: sessionId(ctx) });
			if (fails >= MAX_FAILS) {
				cooldownUntil = Date.now() + COOLDOWN_MS;
				logEvent(SYSTEM, LOG_FILE, { turn: event.turnIndex, event: "breaker_open", cooldownMs: COOLDOWN_MS, session: sessionId(ctx) });
			}
			return;
		}
		fails = 0;
		const v = parseVerdict(answers, cfg.threshold);
		if (!v) {
			logEvent(SYSTEM, LOG_FILE, { turn: event.turnIndex, event: "malformed_answer", session: sessionId(ctx) });
			return;
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
			return { entries: [...event.entries, ...buildNudgeDrafts(entries, v, goal, consecutiveNudges)] };
		}

		consecutiveNudges = 0;
		logEvent(SYSTEM, LOG_FILE, { turn: event.turnIndex, verdict: v.verdict, p: round2(v.p), session: sessionId(ctx) });
		// on_track/blocked: retire a now-obsolete correction so stale "off-track" text never lingers
		const previous = lastNudge(entries);
		if (previous) {
			return { entries: [...event.entries, { type: "context_edit", targetId: previous.id, replacement: null }] };
		}
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
				`course check: ${cfg.enabled ? "on" : "off"} · every ${cfg.intervalTurns} turns · threshold ${cfg.threshold} · timeout ${cfg.timeoutMs} ms`,
				`last check: turn ${lastCheckedTurn || "none"} · consecutive nudges: ${consecutiveNudges}${pending ? " · outcome pending" : ""}`,
			];
			if (Date.now() < cooldownUntil) lines.push(`Jev breaker open until ${new Date(cooldownUntil).toLocaleTimeString()}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

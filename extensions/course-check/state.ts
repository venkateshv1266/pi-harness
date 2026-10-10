/**
 * Pure state functions for the periodic course check.
 *
 * Everything here is deterministic over a session branch and the raw Jev
 * answer object, so the wiring in index.ts stays thin and this module runs
 * under plain `node --test`. It depends on persisted contracts only — the
 * curator's goal/GoalSpec entries and pi's entry shapes — never on other
 * extensions being loaded.
 */

import type { ContextEditEntryDraft, CustomMessageEntryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";

export const COURSE_CHECK_TYPE = "course-check";
export const NUDGE_MARKER = "[course-check]";
const GOAL_TYPE = "jev-curator-goal";
const GOALSPEC_TYPE = "jev-curator-goalspec";

export interface CourseConfig {
	enabled: boolean;
	intervalTurns: number;
	threshold: number;
	timeoutMs: number;
	digestEntries: number;
	digestCapChars: number;
}

export interface SessionGoal {
	objective: string;
	criteria: string[];
	plan: string[];
}

export type CourseVerdict = "on_track" | "off_track" | "goal_unclear" | "goal_moved" | "goal_met" | "blocked";
export type FailureMode = "none" | "scope_drift" | "rabbit_hole" | "tangents" | "wrong_solution" | "goal_met_overrun";

export interface Verdict {
	verdict: CourseVerdict;
	p: number;
	confidence: number;
	why: FailureMode;
	/** True when the check should inject a course-correction message. */
	nudge: boolean;
}

// ─── helpers ───────────────────────────────────────────────────────────

export function clip(text: string, max: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function strArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
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

function entryMessage(entry: SessionEntry): { role: string; content: unknown; toolName?: unknown; isError?: unknown } | null {
	if (entry.type !== "message") return null;
	const msg = (entry as unknown as { message?: { role?: unknown; content?: unknown; toolName?: unknown; isError?: unknown } }).message;
	if (!msg || typeof (msg as { role?: unknown }).role !== "string") return null;
	return msg as { role: string; content: unknown; toolName?: unknown; isError?: unknown };
}

// ─── config ────────────────────────────────────────────────────────────

const DEFAULTS: CourseConfig = {
	enabled: true,
	intervalTurns: 10,
	threshold: 0.7,
	timeoutMs: 6000,
	digestEntries: 60,
	digestCapChars: 6000,
};

function num(env: Record<string, string | undefined>, key: string): number | null {
	const raw = env[key];
	if (raw === undefined) return null;
	const v = Number(raw);
	return Number.isFinite(v) ? v : null;
}

/** settings.json `courseCheck` block → config; env vars override for one-off runs, COURSE_CHECK=0 is a hard kill. */
export function resolveConfig(env: Record<string, string | undefined>, stored: unknown): CourseConfig {
	const cfg = { ...DEFAULTS };
	if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
		const s = stored as Record<string, unknown>;
		if (typeof s.enabled === "boolean") cfg.enabled = s.enabled;
		if (typeof s.intervalTurns === "number") cfg.intervalTurns = s.intervalTurns;
		if (typeof s.threshold === "number") cfg.threshold = s.threshold;
		if (typeof s.timeoutMs === "number") cfg.timeoutMs = s.timeoutMs;
		if (typeof s.digestEntries === "number") cfg.digestEntries = s.digestEntries;
		if (typeof s.digestCapChars === "number") cfg.digestCapChars = s.digestCapChars;
	}
	const interval = num(env, "COURSE_CHECK_INTERVAL");
	if (interval !== null) cfg.intervalTurns = interval;
	const threshold = num(env, "COURSE_CHECK_THRESHOLD");
	if (threshold !== null) cfg.threshold = threshold;
	const timeout = num(env, "COURSE_CHECK_TIMEOUT_MS");
	if (timeout !== null) cfg.timeoutMs = timeout;
	const digestEntries = num(env, "COURSE_CHECK_DIGEST_ENTRIES");
	if (digestEntries !== null) cfg.digestEntries = digestEntries;
	const cap = num(env, "COURSE_CHECK_CAP");
	if (cap !== null) cfg.digestCapChars = cap;

	cfg.intervalTurns = Math.max(1, Math.round(cfg.intervalTurns));
	cfg.threshold = Math.min(0.95, Math.max(0.5, cfg.threshold));
	cfg.timeoutMs = Math.min(60_000, Math.max(1000, Math.round(cfg.timeoutMs)));
	cfg.digestEntries = Math.min(400, Math.max(10, Math.round(cfg.digestEntries)));
	cfg.digestCapChars = Math.min(60_000, Math.max(1000, Math.round(cfg.digestCapChars)));

	if (env.COURSE_CHECK === "0") cfg.enabled = false;
	else if (env.COURSE_CHECK === "1") cfg.enabled = true;
	return cfg;
}

// ─── goal ──────────────────────────────────────────────────────────────

/** Latest pinned goal, else the GoalSpec objective, else the user's first prompt. */
export function readGoal(entries: readonly SessionEntry[]): SessionGoal | null {
	let goalPin: string | null = null;
	let spec: { objective: string; criteria: string[]; plan: string[] } | null = null;
	let firstUser: string | null = null;

	for (const entry of entries) {
		if (entry.type === "custom" && (entry as { customType?: unknown }).customType === GOAL_TYPE) {
			const data = (entry as { data?: unknown }).data as { goal?: unknown } | undefined;
			if (data && typeof data.goal === "string" && data.goal.trim()) goalPin = data.goal.trim();
		} else if (entry.type === "custom" && (entry as { customType?: unknown }).customType === GOALSPEC_TYPE) {
			const data = (entry as { data?: unknown }).data as Record<string, unknown> | undefined;
			if (data && typeof data.userObjective === "string" && data.userObjective.trim()) {
				spec = {
					objective: data.userObjective.trim(),
					criteria: strArray(data.successCriteria),
					plan: strArray(data.currentPlan),
				};
			}
		} else if (firstUser === null) {
			const msg = entryMessage(entry);
			if (msg && msg.role === "user") {
				const text = messageText(msg.content).trim();
				if (text) firstUser = text;
			}
		}
	}

	if (goalPin) return { objective: goalPin, criteria: [], plan: [] };
	if (spec) return spec;
	if (firstUser) return { objective: firstUser, criteria: [], plan: [] };
	return null;
}

// ─── digest ────────────────────────────────────────────────────────────

function toolCallLines(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as Record<string, unknown>;
		if (b.type !== "toolCall" || typeof b.toolName !== "string") continue;
		const input = b.input ?? b.arguments ?? b.params;
		let shape = "";
		if (input !== undefined) {
			try {
				shape = JSON.stringify(input) ?? "";
			} catch {
				shape = String(input);
			}
		}
		out.push(`call: ${b.toolName}(${clip(shape, 120)})`);
	}
	return out;
}

/** One line per message, newest last; the check's own nudges are excluded so Jev never judges its own messages as agent activity. */
export function digest(entries: readonly SessionEntry[], cfg: Pick<CourseConfig, "digestEntries" | "digestCapChars">): string {
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry.type === "custom_message" && (entry as { customType?: unknown }).customType === COURSE_CHECK_TYPE) continue;
		const msg = entryMessage(entry);
		if (!msg) continue;
		if (msg.role === "user") {
			const text = messageText(msg.content).trim();
			if (text.startsWith(NUDGE_MARKER)) continue;
			if (text) lines.push(`user: ${clip(text, 200)}`);
		} else if (msg.role === "assistant") {
			const text = messageText(msg.content).trim();
			if (text) lines.push(`assistant: ${clip(text, 400)}`);
			lines.push(...toolCallLines(msg.content));
		} else if (msg.role === "toolResult") {
			const m = msg as unknown as { toolName?: unknown; isError?: unknown };
			const name = typeof m.toolName === "string" ? m.toolName : "tool";
			const status = m.isError ? "err" : "ok";
			const text = messageText(msg.content).trim();
			lines.push(`tool ${name} ${status}: ${clip(text, 120)}`);
		}
	}
	let kept = lines.slice(-cfg.digestEntries);
	if (kept.length === 0) return "";
	let joined = kept.join("\n");
	if (joined.length > cfg.digestCapChars) {
		joined = `…[earlier activity omitted]\n${joined.slice(-cfg.digestCapChars)}`;
	}
	return joined;
}

/** The full state handed to Jev: what the agent is supposed to do, then what it just did. */
export function composeState(goal: SessionGoal, entries: readonly SessionEntry[], cfg: CourseConfig): string {
	const parts: string[] = [`SESSION GOAL:\n${goal.objective}`];
	if (goal.criteria.length) parts.push(`SUCCESS CRITERIA:\n${goal.criteria.slice(0, 6).map((c) => `- ${clip(c, 150)}`).join("\n")}`);
	if (goal.plan.length) parts.push(`CURRENT PLAN:\n${goal.plan.slice(0, 6).map((p) => `- ${clip(p, 150)}`).join("\n")}`);
	const d = digest(entries, cfg);
	if (d) parts.push(`RECENT ACTIVITY (oldest first):\n${d}`);
	return parts.join("\n\n");
}

// ─── scheduling ────────────────────────────────────────────────────────

/** True when any recent user message reads like a correction — makes nudge-outcome attribution ambiguous. */
export function hasUserCorrection(
	entries: readonly SessionEntry[],
	isCorrection: (text: string) => boolean,
	window = 40,
): boolean {
	for (const entry of entries.slice(-window)) {
		const msg = entryMessage(entry);
		if (!msg || msg.role !== "user") continue;
		if (isCorrection(messageText(msg.content))) return true;
	}
	return false;
}

export function shouldCheck(turnIndex: number, lastCheckedTurn: number, cfg: CourseConfig): boolean {
	if (!cfg.enabled) return false;
	if (turnIndex <= 0) return false;
	if (turnIndex % cfg.intervalTurns !== 0) return false;
	return turnIndex !== lastCheckedTurn;
}

// ─── verdict ──────────────────────────────────────────────────────────

const NUDGEABLE: ReadonlySet<CourseVerdict> = new Set(["off_track", "goal_unclear", "goal_moved", "goal_met"]);

interface JevAnswer {
	choice?: string;
	probabilities?: Record<string, number>;
	confidence?: number;
}

function topProb(a: JevAnswer): { choice: string; p: number } | null {
	const probs = a.probabilities;
	if (!probs) return null;
	let best: { choice: string; p: number } | null = null;
	for (const [choice, p] of Object.entries(probs)) {
		if (typeof p === "number" && (!best || p > best.p)) best = { choice, p };
	}
	return best;
}

/** Raw Jev answers → verdict; null when the course answer is missing or malformed. */
export function parseVerdict(answers: Record<string, unknown> | null, threshold: number): Verdict | null {
	if (!answers) return null;
	const raw = answers["course"];
	if (typeof raw !== "object" || raw === null) return null;
	const a = raw as JevAnswer;
	const top = topProb(a);
	const choice = typeof a.choice === "string" && a.choice ? a.choice : top?.choice;
	if (!choice) return null;
	const probs = a.probabilities ?? {};
	const p = typeof probs[choice] === "number" ? probs[choice] : (top?.p ?? 0);
	const confidence = typeof a.confidence === "number" ? a.confidence : 1;

	const verdict = choice as CourseVerdict;
	const fRaw = answers["failure"];
	const why =
		typeof fRaw === "object" && fRaw !== null && typeof (fRaw as JevAnswer).choice === "string"
			? ((fRaw as JevAnswer).choice as FailureMode)
			: "none";

	return {
		verdict,
		p,
		confidence,
		why,
		nudge: NUDGEABLE.has(verdict) && p >= threshold,
	};
}

// ─── nudges ────────────────────────────────────────────────────────────

const MODE_TEXT: Record<FailureMode, string> = {
	none: "",
	scope_drift: "mode: scope_drift — the work has left the goal's scope",
	rabbit_hole: "mode: rabbit_hole — the same failing approach keeps repeating",
	tangents: "mode: tangents — polish unrelated to the goal's core",
	wrong_solution: "mode: wrong_solution — the approach cannot plausibly meet the goal",
	goal_met_overrun: "mode: goal_met_overrun — activity continues past completion",
};

/** The course-correction message injected into the session. Starts with NUDGE_MARKER so later scans can find and retire it. */
export function nudgeText(v: Verdict, goal: SessionGoal, consecutive: number): string {
	const mode = v.why !== "none" && v.verdict === "off_track" ? ` · ${MODE_TEXT[v.why]}` : "";
	const head = `${NUDGE_MARKER} ${v.verdict.replace("_", " ")} (p=${v.p.toFixed(2)}${mode}) — a periodic Jev review of recent activity against the session goal:`;

	if (v.verdict === "goal_unclear") {
		return [
			head,
			``,
			`SESSION GOAL: ${goal.objective}`,
			``,
			`The goal is too ambiguous to judge direction against. Stop guessing: sharpen the goal state first — refine it via pin_goal or amend_goalspec (criteria/constraints/plan), or ask the user 1-3 sharp clarifying questions about the intended outcome before doing further work.`,
		].join("\n");
	}
	if (v.verdict === "goal_moved") {
		return [
			head,
			``,
			`SESSION GOAL: ${goal.objective}`,
			``,
			`The user's recent messages redefine what they want — the session goal no longer matches their current ask. Update the goal state instead of steering back toward the old objective: call pin_goal with the refined objective, or amend_goalspec for new criteria/constraints/plan; ask the user to /goal if the replacement should come from them.`,
		].join("\n");
	}
	if (v.verdict === "goal_met") {
		return [
			head,
			``,
			`SESSION GOAL: ${goal.objective}`,
			``,
			`The goal appears already achieved. Verify it against the success criteria, report completion to the user, and stop — do not start further work unless the user asks for it.`,
		].join("\n");
	}

	const escalate = consecutive >= 2
		? `SECOND CONSECUTIVE off-track verdict — the previous course correction did not change the trajectory. Before ANY further action, write a 3-line reassessment: (a) what the goal requires, (b) what you have been doing instead, (c) the one action that most directly serves the goal. Proceed with that action only.`
		: `Rethink the approach before continuing: (1) restate what the goal requires in one sentence; (2) name where the current line of work diverged from it; (3) pick the single next action closest to the goal — drop tangents, stop repeating failing attempts, revert unrelated edits. If the goal itself is ambiguous, ask the user instead of guessing.`;
	return [
		head,
		``,
		`SESSION GOAL: ${goal.objective}`,
		``,
		escalate,
	].join("\n");
}

/** Most recent live course-check message on the branch, if any. */
export function lastNudge(entries: readonly SessionEntry[]): { id: string } | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry.type === "custom_message" &&
			(entry as unknown as { customType?: unknown }).customType === COURSE_CHECK_TYPE
		) {
			return { id: (entry as { id: string }).id };
		}
	}
	return null;
}

/** Boundary drafts: retire the previous nudge (at most one live copy), then append the fresh one. */
export function buildNudgeDrafts(
	entries: readonly SessionEntry[],
	v: Verdict,
	goal: SessionGoal,
	consecutive: number,
): (ContextEditEntryDraft | CustomMessageEntryDraft)[] {
	const drafts: (ContextEditEntryDraft | CustomMessageEntryDraft)[] = [];
	const previous = lastNudge(entries);
	if (previous) drafts.push({ type: "context_edit", targetId: previous.id, replacement: null });
	const text = nudgeText(v, goal, consecutive);
	drafts.push({
		type: "custom_message",
		customType: COURSE_CHECK_TYPE,
		content: text,
		display: true,
		details: { verdict: v.verdict, p: v.p, why: v.why, consecutive },
	});
	return drafts;
}

/**
 * /setup → "Course check": the knobs of the periodic Jev supervision,
 * persisted to settings.json `courseCheck` and applied from the next check on.
 */
import type { SetupItem, SetupSection } from "../setup/types.ts";
import { resolveLiveConfig, updateCourseSettings } from "./settings.ts";

export default function courseCheckSetup(): SetupSection {
	const items: SetupItem[] = [
		{
			id: "coursecheck:enabled",
			label: "Enabled",
			detail: "Master switch for the periodic Jev course check. COURSE_CHECK=0 in the environment still forces it off.",
			effect: "next check",
			owner: "course-check · /course-check",
			kind: "toggle",
			get: () => (resolveLiveConfig().enabled ? "on" : "off"),
			apply: (_c, value) => {
				updateCourseSettings((s) => {
					s.enabled = value === "on";
				});
				return `course check ${value === "on" ? "enabled" : "disabled"}`;
			},
		},
		{
			id: "coursecheck:interval",
			label: "Check interval (turns)",
			detail: "Run the Jev course review at every Nth completed turn (default 10).",
			effect: "next check",
			owner: "course-check · /course-check now",
			kind: "number",
			min: 2,
			max: 100,
			get: () => String(resolveLiveConfig().intervalTurns),
			apply: (_c, value) => {
				const n = Math.round(Number(value));
				if (!Number.isFinite(n)) return "invalid number";
				const clamped = Math.min(100, Math.max(2, n));
				updateCourseSettings((s) => {
					s.intervalTurns = clamped;
				});
				return `check interval → every ${clamped} turns`;
			},
		},
		{
			id: "coursecheck:threshold",
			label: "Nudge threshold",
			detail: "Minimum probability for a nudge verdict (off_track / goal_unclear / goal_met) to inject the course-correction message (default 0.7).",
			effect: "next check",
			owner: "course-check · /course-check",
			kind: "number",
			min: 0.5,
			max: 0.95,
			get: () => String(resolveLiveConfig().threshold),
			apply: (_c, value) => {
				const p = Number(value);
				if (!Number.isFinite(p)) return "invalid number";
				const clamped = Math.min(0.95, Math.max(0.5, p));
				updateCourseSettings((s) => {
					s.threshold = clamped;
				});
				return `nudge threshold → ${clamped}`;
			},
		},
		{
			id: "coursecheck:timeout",
			label: "Jev timeout (ms)",
			detail: "How long the turn boundary waits for Jev's verdict before giving up and logging jev_unreachable (default 6000).",
			effect: "next check",
			owner: "course-check · /course-check",
			kind: "number",
			min: 1000,
			max: 30000,
			get: () => `${resolveLiveConfig().timeoutMs} ms`,
			apply: (_c, value) => {
				const n = Math.round(Number(value));
				if (!Number.isFinite(n)) return "invalid number";
				const clamped = Math.min(30_000, Math.max(1000, n));
				updateCourseSettings((s) => {
					s.timeoutMs = clamped;
				});
				return `Jev timeout → ${clamped} ms`;
			},
		},
	];
	return {
		id: "course-check",
		title: "Course check",
		detail: "Periodic Jev supervision: every N turns, judge the agent's trajectory against the session goal and inject a rethink nudge when off track.",
		items,
	};
}

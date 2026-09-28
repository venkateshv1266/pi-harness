/**
 * Course-check settings layer. /setup → "Course check" persists the knobs to
 * settings.json `courseCheck`; env vars override for one-off runs, and
 * COURSE_CHECK=0 stays a hard kill switch.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { resolveConfig, type CourseConfig } from "./state.ts";

const SETTINGS_PATH = path.join(getAgentDir(), "settings.json");

export function readCourseSettings(): Record<string, unknown> {
	try {
		const all = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
		const raw = all.courseCheck;
		return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Read-merge-write settings.json so concurrent writers never clobber. */
export function updateCourseSettings(mutate: (settings: Record<string, unknown>) => void): void {
	let all: Record<string, unknown> = {};
	try {
		if (fs.existsSync(SETTINGS_PATH)) all = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
	} catch {
		all = {};
	}
	const current = readCourseSettings();
	mutate(current);
	all.courseCheck = current;
	fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
	fs.writeFileSync(SETTINGS_PATH, JSON.stringify(all, null, 2) + "\n");
}

/** Config for this check: settings.json merged with env overrides. Re-read per check so /setup edits apply without reload. */
export function resolveLiveConfig(): CourseConfig {
	return resolveConfig(process.env, readCourseSettings());
}

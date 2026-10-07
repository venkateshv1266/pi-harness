/**
 * /setup → Memory Review / Memory Stores / Memory Capture — every
 * jev-memory-config.json knob editable from the shared setup window instead of
 * hand-editing the file. Contributed via the directory convention
 * (jev-memory/setup.ts); /setup auto-discovers it on each invocation.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./src/config.js";
import { resolveJevConfig } from "./src/jev/config.js";
import type { EnumOption, SetupItem, SetupSection } from "../setup/types.ts";

const CLEAR = "__remove";
const OWNER = "jev-memory · jev-memory-config.json";
const EFFECT = "new sessions";

type RawConfig = Record<string, unknown>;

type RawFile = { ok: true; raw: RawConfig } | { ok: false; error: string };

function readRawFile(configPath: string): RawFile {
	if (!existsSync(configPath)) return { ok: true, raw: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { ok: false, error: "top level is not a JSON object" };
		}
		return { ok: true, raw: parsed as RawConfig };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Read-merge-write so /setup edits never clobber unrelated config keys.
 * Returns a "✗" message instead of writing when the file is unreadable. */
function updateConfig(mutate: (raw: RawConfig) => void, configPath: string): string {
	const file = readRawFile(configPath);
	if (!file.ok) return `✗ jev-memory-config.json unreadable (${file.error}) — not writing`;
	mutate(file.raw);
	writeFileSync(configPath, JSON.stringify(file.raw, null, 2) + "\n");
	return "";
}

function effective(configPath: string, key: string): unknown {
	return (loadConfig(configPath) as unknown as Record<string, unknown>)[key];
}

function toggleItem(configPath: string, id: string, label: string, detail: string, key: string): SetupItem {
	return {
		id,
		label,
		detail,
		effect: EFFECT,
		owner: OWNER,
		kind: "toggle",
		get: () => (effective(configPath, key) === true ? "on" : "off"),
		apply: async (_c, value) => {
			const on = value === "on";
			const err = updateConfig((raw) => {
				raw[key] = on;
			}, configPath);
			if (err) return err;
			return `${label} ${on ? "enabled" : "disabled"}`;
		},
	};
}

function numberItem(
	configPath: string,
	id: string,
	label: string,
	detail: string,
	key: string,
	min: number,
	max: number,
): SetupItem {
	return {
		id,
		label,
		detail,
		effect: EFFECT,
		owner: OWNER,
		kind: "number",
		min,
		max,
		get: () => {
			const raw = readRawFile(configPath);
			const rawValue = raw.ok ? raw.raw[key] : undefined;
			return typeof rawValue === "number" ? String(rawValue) : `${String(effective(configPath, key))} (default)`;
		},
		apply: async (_c, value) => {
			const n = Number(value);
			if (!Number.isFinite(n) || n < min || n > max) return `✗ expected a number between ${min} and ${max}`;
			const err = updateConfig((raw) => {
				raw[key] = n;
			}, configPath);
			if (err) return err;
			return `${label} → ${n}`;
		},
	};
}

function enumItem(
	configPath: string,
	id: string,
	label: string,
	detail: string,
	key: string,
	options: EnumOption[],
): SetupItem {
	return {
		id,
		label,
		detail,
		effect: EFFECT,
		owner: OWNER,
		kind: "enum",
		options,
		get: () => String(effective(configPath, key) ?? ""),
		apply: async (_c, value) => {
			if (!options.some((option) => option.value === value)) return `✗ unknown choice: ${value}`;
			const err = updateConfig((raw) => {
				raw[key] = value;
			}, configPath);
			if (err) return err;
			return `${label} → ${value}`;
		},
	};
}

function jevToggleItem(
	configPath: string,
	id: string,
	label: string,
	detail: string,
	group: "pregate" | "admission" | "audit",
): SetupItem {
	return {
		id,
		label,
		detail,
		effect: EFFECT,
		owner: "jev-memory · jev gates",
		kind: "toggle",
		get: () => (resolveJevConfig(configPath)[group].enabled ? "on" : "off"),
		apply: async (_c, value) => {
			const on = value === "on";
			const err = updateConfig((raw) => {
				const jev = typeof raw.jev === "object" && raw.jev !== null && !Array.isArray(raw.jev)
					? (raw.jev as RawConfig)
					: {};
				const section = typeof jev[group] === "object" && jev[group] !== null && !Array.isArray(jev[group])
					? (jev[group] as RawConfig)
					: {};
				section.enabled = on;
				jev[group] = section;
				raw.jev = jev;
			}, configPath);
			if (err) return err;
			return `${label} ${on ? "enabled" : "disabled"}`;
		},
	};
}

function reviewModelItem(configPath: string): SetupItem {
	return {
		id: "review-model",
		label: "Review model",
		detail:
			"Model used by the background memory auto-review (direct in-process call and the pi -p fallback child). "
			+ "Pick a thinking level to pin it, e.g. \"deepseek/deepseek-v4.1-flash:max\". "
			+ "Delete (⌫) to fall back to the active session model.",
		effect: EFFECT,
		owner: OWNER,
		kind: "model",
		withThinking: true,
		removable: true,
		get: () => {
			const file = readRawFile(configPath);
			const value = file.ok ? file.raw.llmModelOverride : undefined;
			return typeof value === "string" && value.trim() ? value : "(unset — active session model)";
		},
		apply: async (_c, value) => {
			if (value === CLEAR) {
				const err = updateConfig((raw) => {
					delete raw.llmModelOverride;
				}, configPath);
				if (err) return err;
				return "review model → session default";
			}
			const trimmed = value.trim();
			if (!trimmed) return "✗ empty model reference";
			const err = updateConfig((raw) => {
				raw.llmModelOverride = trimmed;
			}, configPath);
			if (err) return err;
			return `review model → ${trimmed}`;
		},
	};
}

export function buildMemorySections(configPath: string = DEFAULT_CONFIG_PATH): SetupSection[] {
	return [
		{
			id: "memory-review",
			title: "Memory Review",
			detail: "Background auto-review that extracts durable memories from conversations.",
			items: [
				reviewModelItem(configPath),
				enumItem(
					configPath,
					"review-transport",
					"Review transport",
					"direct runs the review in-process (fast, reuses provider auth); subprocess spawns an isolated pi -p child (slower startup, isolated).",
					"reviewTransport",
					[
						{ value: "direct", label: "direct (in-process)" },
						{ value: "subprocess", label: "subprocess (isolated child)" },
					],
				),
				toggleItem(
					configPath,
					"review-enabled",
					"Auto-review enabled",
					"Master switch for the background review loop.",
					"reviewEnabled",
				),
				numberItem(
					configPath,
					"review-turns",
					"Review every N turns",
					"Run a review after this many assistant turns since the last one.",
					"nudgeInterval",
					1,
					100,
				),
				numberItem(
					configPath,
					"review-tool-calls",
					"Review every N tool calls",
					"Run a review after this many tool calls since the last one (whichever threshold hits first).",
					"nudgeToolCalls",
					0,
					1000,
				),
				numberItem(
					configPath,
					"review-messages",
					"Messages per review",
					"How many recent conversation messages are included in the review prompt.",
					"reviewRecentMessages",
					1,
					500,
				),
			],
		},
		{
			id: "memory-stores",
			title: "Memory Stores",
			detail: "Store capacity, consolidation, and retention.",
			items: [
				toggleItem(
					configPath,
					"auto-consolidate",
					"Auto-consolidate",
					"Merge and prune store entries automatically when a store approaches its char limit.",
					"autoConsolidate",
				),
				toggleItem(
					configPath,
					"consolidate-warn",
					"Warn on consolidation failure",
					"Surface a notification when a scheduled consolidation run fails.",
					"autoConsolidationWarnOnFailure",
				),
				numberItem(
					configPath,
					"consolidate-timeout",
					"Consolidation timeout (ms)",
					"Per-target time budget for consolidation runs (LLM transports). Large stores need larger budgets.",
					"consolidationTimeoutMs",
					1000,
					3600000,
				),
				enumItem(
					configPath,
					"overflow-strategy",
					"Overflow strategy",
					"What happens when a store hits its char limit and consolidation cannot free enough space.",
					"memoryOverflowStrategy",
					[
						{ value: "auto-consolidate", label: "auto-consolidate (merge/prune)" },
						{ value: "reject", label: "reject new entries" },
						{ value: "fifo-evict", label: "fifo-evict (drop oldest)" },
					],
				),
				numberItem(
					configPath,
					"memory-limit",
					"Memory store char limit",
					"Capacity for global MEMORY.md.",
					"memoryCharLimit",
					1000,
					10000000,
				),
				numberItem(
					configPath,
					"user-limit",
					"User profile char limit",
					"Capacity for USER.md.",
					"userCharLimit",
					1000,
					10000000,
				),
				numberItem(
					configPath,
					"project-limit",
					"Project store char limit",
					"Capacity for each project memory store.",
					"projectCharLimit",
					1000,
					10000000,
				),
				numberItem(
					configPath,
					"session-retention",
					"Session retention (days)",
					"How long session index/backfill artifacts are kept.",
					"sessionRetentionDays",
					0,
					3650,
				),
			],
		},
		{
			id: "memory-capture",
			title: "Memory Capture",
			detail: "Session flush, correction detection, failure injection, and Jev gates.",
			items: [
				toggleItem(
					configPath,
					"flush-on-compact",
					"Flush on compact",
					"Save memories from the conversation before context compaction drops them.",
					"flushOnCompact",
				),
				toggleItem(
					configPath,
					"flush-on-shutdown",
					"Flush on shutdown",
					"Save memories from the conversation when the session shuts down.",
					"flushOnShutdown",
				),
				numberItem(
					configPath,
					"flush-min-turns",
					"Flush min turns",
					"Skip the flush if the session has fewer turns than this.",
					"flushMinTurns",
					0,
					100,
				),
				numberItem(
					configPath,
					"flush-messages",
					"Flush recent messages",
					"How many recent conversation messages the flush prompt includes.",
					"flushRecentMessages",
					1,
					500,
				),
				toggleItem(
					configPath,
					"correction-detection",
					"Correction detection",
					"Detect user corrections and save them as correction memories.",
					"correctionDetection",
				),
				toggleItem(
					configPath,
					"failure-injection",
					"Failure injection",
					"Inject relevant past failure memories into new sessions.",
					"failureInjectionEnabled",
				),
				numberItem(
					configPath,
					"injection-max-age",
					"Failure injection max age (days)",
					"Older failures are not injected.",
					"failureInjectionMaxAgeDays",
					1,
					3650,
				),
				numberItem(
					configPath,
					"injection-max-entries",
					"Failure injection max entries",
					"Maximum failures injected per session.",
					"failureInjectionMaxEntries",
					1,
					100,
				),
				toggleItem(
					configPath,
					"standing-instructions",
					"Standing instructions",
					"Include STANDING.md instructions from the memory store in every session.",
					"standingInstructionsEnabled",
				),
				toggleItem(
					configPath,
					"quick-check",
					"Quick check on open",
					"Run a quick memory relevance check when a session opens.",
					"quickCheckOnOpen",
				),
				enumItem(
					configPath,
					"memory-mode",
					"Memory mode",
					"policy-only injects memories via the policy prompt; legacy-inject appends them to the system prompt.",
					"memoryMode",
					[
						{ value: "policy-only", label: "policy-only" },
						{ value: "legacy-inject", label: "legacy-inject" },
					],
				),
				enumItem(
					configPath,
					"policy-style",
					"Policy style",
					"How the memory policy prompt is rendered. custom requires memoryPolicyCustomText in the config file.",
					"memoryPolicyStyle",
					[
						{ value: "full", label: "full" },
						{ value: "compact", label: "compact" },
						{ value: "custom", label: "custom" },
						{ value: "none", label: "none" },
					],
				),
				jevToggleItem(
					configPath,
					"jev-pregate",
					"Jev pregate",
					"Classifier gate that decides whether a full review run is worth its cost.",
					"pregate",
				),
				jevToggleItem(
					configPath,
					"jev-admission",
					"Jev admission gate",
					"Classifier gate that scores candidate memories before they are stored.",
					"admission",
				),
				jevToggleItem(
					configPath,
					"jev-audit",
					"Jev audit log",
					"Append gate decisions to ~/.pi/agent/jev-decisions/jev-memory.jsonl.",
					"audit",
				),
			],
		},
	];
}

export default function memorySetup(): SetupSection[] {
	return buildMemorySections();
}

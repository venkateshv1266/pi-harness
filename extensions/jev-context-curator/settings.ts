/**
 * Curator settings layer. /setup → "Jev curator" exposes the master switch,
 * mode, and verifier model, persisted to settings.json `jevCurator`; every
 * other knob is env/defaults-only. JEVCURATOR=0 remains a hard kill switch.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

export interface CuratorConfig {
	enabled: boolean;
	mode: string;
	verifierMode: string;
	verifierModel: string;
	distillModel: string;
	verifierTimeoutMs: number;
	verifyRawCap: number;
	covMin: number;
	cardBgProb: number;
	verifyMaxLines: number;
	repairSlack: number;
	verifierShadowPct: number;
	jevBreaker: number;
	reclassPerTurn: number;
	supersedeMax: number;
	registryCap: number;
	overflowCap: number;
	minChars: number;
	recencyTurns: number;
	stubProb: number;
	truncProb: number;
	minConf: number;
	maxStubs: number;
	minBatchSaved: number;
	contextFloorPct: number;
	criticalPct: number;
	softFloorPct: number;
	autoCompactPct: number;
	autoCompactRiseTurns: number;
	maxHoldTurns: number;
	ingestCap: number;
	capHead: number;
	capTail: number;
	truncHead: number;
	truncTail: number;
	samples: number;
	jevTimeoutMs: number;
	shadowJevTimeoutMs: number;
	scoreJevTimeoutMs: number;
	shadowMaxPerTurn: number;
}

export interface CuratorSettingSpec {
	key: keyof CuratorConfig;
	env: string;
	kind: "toggle" | "enum" | "model";
	label: string;
	detail: string;
	defaultValue: boolean | string;
	options?: { value: string; label?: string; description?: string }[];
}

export const CURATOR_SETTING_SPECS: CuratorSettingSpec[] = [
	{
		key: "enabled",
		env: "JEVCURATOR",
		kind: "toggle",
		label: "Enabled",
		detail: "Master switch for context curation. JEVCURATOR=0 in the environment still forces it off.",
		defaultValue: true,
	},
	{
		key: "mode",
		env: "JEVCURATOR_MODE",
		kind: "enum",
		label: "Mode",
		detail:
			"quality = full V3 pipeline; evidence = log/listing emission on the V2 floor; shadow-quality = classify/propose/verify, log only; v2 = pre-V3 stub/truncate layer.",
		defaultValue: "quality",
		options: [
			{ value: "quality", label: "quality", description: "Full V3 pipeline (default)" },
			{ value: "evidence", label: "evidence", description: "Log/listing emission on the V2 floor" },
			{ value: "shadow-quality", label: "shadow-quality", description: "Classify/propose/verify, log only" },
			{ value: "v2", label: "v2", description: "Pre-V3 stub/truncate economics" },
		],
	},
	{
		key: "verifierMode",
		env: "JEVCURATOR_VERIFIER",
		kind: "enum",
		label: "Verifier protocol",
		detail:
			"hybrid = Jev fact-decomposed verification (coverage check + repair-first) with frontier escalation on uncertainty; jev = Jev-only, uncertain → retainFull; frontier = the holistic frontier gate only.",
		defaultValue: "hybrid",
		options: [
			{ value: "hybrid", label: "hybrid", description: "Jev protocol + frontier escalation (default)" },
			{ value: "jev", label: "jev", description: "Jev protocol only; uncertain cases retain full" },
			{ value: "frontier", label: "frontier", description: "Holistic frontier verifier only (pre-V4 gate)" },
		],
	},
	{
		key: "verifierModel",
		env: "JEVCURATOR_VERIFIER_MODEL",
		kind: "model",
		label: "Verifier model",
		detail:
			"Frontier model for the losslessness gate and compaction summaries; empty = session model. Accepts provider/model:thinking (e.g. openrouter/z-ai/glm-5.3:max).",
		defaultValue: "",
	},
	{
		key: "distillModel",
		env: "JEVCURATOR_DISTILL_MODEL",
		kind: "model",
		label: "Distill model",
		detail:
			"Writes the recited objective: the verbatim first prompt is rewritten once into a self-contained objective (<=320 chars) that recite shows unclipped. Empty = the @slow role model; unset role disables distillation. Accepts provider/model:thinking or @role.",
		defaultValue: "",
	},
];

interface CuratorEnvSpec {
	key: keyof CuratorConfig;
	env: string;
	defaultValue: number;
}

// env/defaults-only knobs: not persisted, not rendered in /setup
const CURATOR_ENV_SPECS: CuratorEnvSpec[] = [
	{ key: "verifierTimeoutMs", env: "JEVCURATOR_VERIFIER_TIMEOUT_MS", defaultValue: 90000 },
	{ key: "verifyRawCap", env: "JEVCURATOR_VERIFY_RAW_CAP", defaultValue: 60000 },
	{ key: "covMin", env: "JEVCURATOR_COV_MIN", defaultValue: 0.5 },
	{ key: "cardBgProb", env: "JEVCURATOR_CARD_BG_PROB", defaultValue: 0.8 },
	{ key: "verifyMaxLines", env: "JEVCURATOR_VERIFY_MAX_LINES", defaultValue: 30 },
	{ key: "repairSlack", env: "JEVCURATOR_REPAIR_SLACK", defaultValue: 1.5 },
	{ key: "verifierShadowPct", env: "JEVCURATOR_VERIFIER_SHADOW_PCT", defaultValue: 0.15 },
	{ key: "jevBreaker", env: "JEVCURATOR_JEV_BREAKER", defaultValue: 2 },
	{ key: "reclassPerTurn", env: "JEVCURATOR_RECLASS_PER_TURN", defaultValue: 5 },
	{ key: "supersedeMax", env: "JEVCURATOR_SUPERSEDE_MAX", defaultValue: 5 },
	{ key: "registryCap", env: "JEVCURATOR_REGISTRY_CAP", defaultValue: 150 },
	{ key: "overflowCap", env: "JEVCURATOR_OVERFLOW_CAP", defaultValue: 50 },
	{ key: "minChars", env: "JEVCURATOR_MIN_CHARS", defaultValue: 1500 },
	{ key: "recencyTurns", env: "JEVCURATOR_RECENCY_TURNS", defaultValue: 3 },
	{ key: "ingestCap", env: "JEVCURATOR_INGEST_CAP", defaultValue: 25000 },
	{ key: "capHead", env: "JEVCURATOR_CAP_HEAD", defaultValue: 15000 },
	{ key: "capTail", env: "JEVCURATOR_CAP_TAIL", defaultValue: 5000 },
	{ key: "truncHead", env: "JEVCURATOR_TRUNC_HEAD", defaultValue: 600 },
	{ key: "truncTail", env: "JEVCURATOR_TRUNC_TAIL", defaultValue: 600 },
	{ key: "stubProb", env: "JEVCURATOR_STUB_PROB", defaultValue: 0.85 },
	{ key: "truncProb", env: "JEVCURATOR_TRUNC_PROB", defaultValue: 0.6 },
	{ key: "minConf", env: "JEVCURATOR_MIN_CONF", defaultValue: 0.65 },
	{ key: "maxStubs", env: "JEVCURATOR_MAX_STUBS", defaultValue: 150 },
	{ key: "minBatchSaved", env: "JEVCURATOR_MIN_BATCH_SAVED", defaultValue: 3000 },
	{ key: "contextFloorPct", env: "JEVCURATOR_CONTEXT_FLOOR_PCT", defaultValue: 70 },
	{ key: "criticalPct", env: "JEVCURATOR_CRITICAL_PCT", defaultValue: 85 },
	{ key: "softFloorPct", env: "JEVCURATOR_SOFT_FLOOR_PCT", defaultValue: 50 },
	{ key: "autoCompactPct", env: "JEVCURATOR_AUTO_COMPACT_PCT", defaultValue: 90 },
	{ key: "autoCompactRiseTurns", env: "JEVCURATOR_AUTO_COMPACT_RISE_TURNS", defaultValue: 3 },
	{ key: "maxHoldTurns", env: "JEVCURATOR_MAX_HOLD_TURNS", defaultValue: 10 },
	{ key: "samples", env: "JEVCURATOR_SAMPLES", defaultValue: 3 },
	{ key: "shadowMaxPerTurn", env: "JEVCURATOR_SHADOW_MAX_PER_TURN", defaultValue: 10 },
	{ key: "jevTimeoutMs", env: "JEVCURATOR_JEV_TIMEOUT_MS", defaultValue: 2500 },
	{ key: "shadowJevTimeoutMs", env: "JEVCURATOR_SHADOW_JEV_TIMEOUT_MS", defaultValue: 8000 },
	{ key: "scoreJevTimeoutMs", env: "JEVCURATOR_SCORE_JEV_TIMEOUT_MS", defaultValue: 25000 },
];

const SETTINGS_PATH = path.join(getAgentDir(), "settings.json");

export function readCuratorSettings(): Record<string, unknown> {
	try {
		if (!fs.existsSync(SETTINGS_PATH)) return {};
		const all = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
		const raw = all.jevCurator;
		return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Top-level settings.json string value, e.g. a model-role assignment (smolModel). */
export function readTopLevelSetting(key: string): string | undefined {
	try {
		if (!fs.existsSync(SETTINGS_PATH)) return undefined;
		const all = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
		const value = all[key];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** Read-merge-write settings.json so concurrent writers never clobber. */
export function updateCuratorSettings(mutate: (settings: Record<string, unknown>) => void): void {
	let all: Record<string, unknown> = {};
	try {
		if (fs.existsSync(SETTINGS_PATH)) all = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
	} catch {
		all = {};
	}
	const raw = all.jevCurator;
	const current = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
	mutate(current);
	all.jevCurator = current;
	fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
	fs.writeFileSync(SETTINGS_PATH, JSON.stringify(all, null, 2) + "\n");
}

function fromStored(spec: CuratorSettingSpec, raw: unknown): boolean | string | undefined {
	if (raw === undefined) return undefined;
	if (spec.kind === "toggle") return typeof raw === "boolean" ? raw : undefined;
	return typeof raw === "string" ? raw : undefined;
}

function fromEnv(spec: CuratorSettingSpec): boolean | string | undefined {
	const raw = process.env[spec.env];
	if (raw === undefined || raw === "") return undefined;
	if (spec.kind === "toggle") return raw !== "0" && raw.toLowerCase() !== "false";
	return raw;
}

export function resolveCuratorConfig(): CuratorConfig {
	const stored = readCuratorSettings();
	const resolved: Record<string, unknown> = {};
	for (const spec of CURATOR_ENV_SPECS) {
		const raw = process.env[spec.env];
		const n = raw === undefined || raw === "" ? undefined : Number(raw);
		resolved[spec.key] = n !== undefined && Number.isFinite(n) ? n : spec.defaultValue;
	}
	for (const spec of CURATOR_SETTING_SPECS) {
		resolved[spec.key] = fromStored(spec, stored[spec.key]) ?? fromEnv(spec) ?? spec.defaultValue;
	}
	return resolved as unknown as CuratorConfig;
}

export function curatorEnabled(config: CuratorConfig): boolean {
	return process.env.JEVCURATOR === "0" ? false : config.enabled;
}

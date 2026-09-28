/**
 * Curator settings layer. Precedence: settings.json `jevCurator` (edited in
 * /setup → "Jev curator"), then JEVCURATOR_* env vars, then defaults.
 * JEVCURATOR=0 remains a hard kill switch.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

export interface CuratorConfig {
	enabled: boolean;
	mode: string;
	verifierModel: string;
	verifierTimeoutMs: number;
	verifyRawCap: number;
	minChars: number;
	recencyTurns: number;
	stubProb: number;
	truncProb: number;
	minConf: number;
	maxStubs: number;
	minBatchSaved: number;
	contextFloorPct: number;
	criticalPct: number;
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
	kind: "number" | "toggle" | "enum" | "model";
	label: string;
	detail: string;
	defaultValue: number | boolean | string;
	min?: number;
	max?: number;
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
		key: "verifierModel",
		env: "JEVCURATOR_VERIFIER_MODEL",
		kind: "model",
		label: "Verifier model",
		detail:
			"Frontier model for the losslessness gate and compaction summaries; empty = session model. Accepts provider/model:thinking (e.g. openrouter/z-ai/glm-5.3:max).",
		defaultValue: "",
	},
	{
		key: "verifierTimeoutMs",
		env: "JEVCURATOR_VERIFIER_TIMEOUT_MS",
		kind: "number",
		label: "Verifier timeout (ms)",
		detail: "Abort deadline for one verifier call; on timeout every candidate keeps full.",
		defaultValue: 90000,
		min: 1000,
	},
	{
		key: "verifyRawCap",
		env: "JEVCURATOR_VERIFY_RAW_CAP",
		kind: "number",
		label: "Verifier raw cap (chars)",
		detail: "Candidates larger than this go to the verifier as an excerpt instead of the full raw.",
		defaultValue: 60000,
		min: 1000,
	},
	{
		key: "minChars",
		env: "JEVCURATOR_MIN_CHARS",
		kind: "number",
		label: "Min output size (chars)",
		detail: "Tool outputs shorter than this are never curated.",
		defaultValue: 1500,
		min: 0,
	},
	{
		key: "recencyTurns",
		env: "JEVCURATOR_RECENCY_TURNS",
		kind: "number",
		label: "V2 recency (turns)",
		detail: "V2: turns an output waits before its keep/stub/truncate verdict is due.",
		defaultValue: 3,
		min: 0,
	},
	{
		key: "ingestCap",
		env: "JEVCURATOR_INGEST_CAP",
		kind: "number",
		label: "Cap-at-rest threshold (chars)",
		detail: "Outputs larger than this are replaced with a head+tail excerpt before first model exposure.",
		defaultValue: 25000,
		min: 1000,
	},
	{
		key: "capHead",
		env: "JEVCURATOR_CAP_HEAD",
		kind: "number",
		label: "Cap head (chars)",
		detail: "Head chars kept when cap-at-rest applies.",
		defaultValue: 15000,
		min: 0,
	},
	{
		key: "capTail",
		env: "JEVCURATOR_CAP_TAIL",
		kind: "number",
		label: "Cap tail (chars)",
		detail: "Tail chars kept when cap-at-rest applies.",
		defaultValue: 5000,
		min: 0,
	},
	{
		key: "truncHead",
		env: "JEVCURATOR_TRUNC_HEAD",
		kind: "number",
		label: "Truncate head (chars)",
		detail: "Head chars kept when a V2 truncate verdict fires.",
		defaultValue: 600,
		min: 0,
	},
	{
		key: "truncTail",
		env: "JEVCURATOR_TRUNC_TAIL",
		kind: "number",
		label: "Truncate tail (chars)",
		detail: "Tail chars kept when a V2 truncate verdict fires.",
		defaultValue: 600,
		min: 0,
	},
	{
		key: "stubProb",
		env: "JEVCURATOR_STUB_PROB",
		kind: "number",
		label: "V2 stub probability",
		detail: "Jev probability at/above which an output is stubbed (0–1).",
		defaultValue: 0.85,
		min: 0,
		max: 1,
	},
	{
		key: "truncProb",
		env: "JEVCURATOR_TRUNC_PROB",
		kind: "number",
		label: "V2 truncate probability",
		detail: "Jev probability at/above which an output is truncated (0–1).",
		defaultValue: 0.6,
		min: 0,
		max: 1,
	},
	{
		key: "minConf",
		env: "JEVCURATOR_MIN_CONF",
		kind: "number",
		label: "V2 min confidence",
		detail: "Verdicts below this Jev confidence are discarded (0–1).",
		defaultValue: 0.65,
		min: 0,
		max: 1,
	},
	{
		key: "maxStubs",
		env: "JEVCURATOR_MAX_STUBS",
		kind: "number",
		label: "V2 max stubs",
		detail: "Session cap on emitted stubs.",
		defaultValue: 150,
		min: 0,
	},
	{
		key: "minBatchSaved",
		env: "JEVCURATOR_MIN_BATCH_SAVED",
		kind: "number",
		label: "V2 batch floor (chars)",
		detail: "A ready batch of stub/truncate edits is held until combined savings reach this.",
		defaultValue: 3000,
		min: 0,
	},
	{
		key: "contextFloorPct",
		env: "JEVCURATOR_CONTEXT_FLOOR_PCT",
		kind: "number",
		label: "V2 context floor %",
		detail: "Above this context usage, truncate gates loosen.",
		defaultValue: 70,
		min: 0,
		max: 100,
	},
	{
		key: "criticalPct",
		env: "JEVCURATOR_CRITICAL_PCT",
		kind: "number",
		label: "V2 critical %",
		detail: "Above this context usage, gates escalate and the batch floor drops.",
		defaultValue: 85,
		min: 0,
		max: 100,
	},
	{
		key: "maxHoldTurns",
		env: "JEVCURATOR_MAX_HOLD_TURNS",
		kind: "number",
		label: "V2 max hold turns",
		detail: "A held batch is emitted anyway after this many turns.",
		defaultValue: 10,
		min: 0,
	},
	{
		key: "samples",
		env: "JEVCURATOR_SAMPLES",
		kind: "number",
		label: "Jev samples",
		detail: "Median-of-N Jev sampling per verdict (classification robustness).",
		defaultValue: 3,
		min: 1,
		max: 9,
	},
	{
		key: "shadowMaxPerTurn",
		env: "JEVCURATOR_SHADOW_MAX_PER_TURN",
		kind: "number",
		label: "Candidates per turn",
		detail: "Cap on tool outputs classified and proposed per turn in V3.",
		defaultValue: 10,
		min: 1,
	},
	{
		key: "jevTimeoutMs",
		env: "JEVCURATOR_JEV_TIMEOUT_MS",
		kind: "number",
		label: "Jev timeout (ms)",
		detail: "Default timeout for Jev client calls.",
		defaultValue: 2500,
		min: 100,
	},
	{
		key: "shadowJevTimeoutMs",
		env: "JEVCURATOR_SHADOW_JEV_TIMEOUT_MS",
		kind: "number",
		label: "Classify timeout (ms)",
		detail: "Timeout for V3 role/shape classification calls.",
		defaultValue: 8000,
		min: 100,
	},
	{
		key: "scoreJevTimeoutMs",
		env: "JEVCURATOR_SCORE_JEV_TIMEOUT_MS",
		kind: "number",
		label: "Line-score timeout (ms)",
		detail: "Timeout for per-chunk line scoring when building extracts.",
		defaultValue: 25000,
		min: 100,
	},
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

function fromStored(spec: CuratorSettingSpec, raw: unknown): number | boolean | string | undefined {
	if (raw === undefined) return undefined;
	switch (spec.kind) {
		case "number":
			return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
		case "toggle":
			return typeof raw === "boolean" ? raw : undefined;
		default:
			return typeof raw === "string" ? raw : undefined;
	}
}

function fromEnv(spec: CuratorSettingSpec): number | boolean | string | undefined {
	const raw = process.env[spec.env];
	if (raw === undefined || raw === "") return undefined;
	switch (spec.kind) {
		case "number": {
			const n = Number(raw);
			return Number.isFinite(n) ? n : undefined;
		}
		case "toggle":
			return raw !== "0" && raw.toLowerCase() !== "false";
		default:
			return raw;
	}
}

export function resolveCuratorConfig(): CuratorConfig {
	const stored = readCuratorSettings();
	const resolved: Record<string, unknown> = {};
	for (const spec of CURATOR_SETTING_SPECS) {
		resolved[spec.key] = fromStored(spec, stored[spec.key]) ?? fromEnv(spec) ?? spec.defaultValue;
	}
	return resolved as unknown as CuratorConfig;
}

export function curatorEnabled(config: CuratorConfig): boolean {
	return process.env.JEVCURATOR === "0" ? false : config.enabled;
}

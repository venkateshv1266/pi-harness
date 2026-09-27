import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { FilterablePicker, THINKING_LEVELS, type PickerRow } from "./model-fallback.ts";
import { logDecision, logOutcome, looksLikeUserCorrection, newId, type Verdict } from "../utils/jev-outcomes.ts";
import { ROLE_NAMES, resolveModelRole, roleSettingRef } from "../utils/model-role.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const LOG_DIR = join(homedir(), ".pi", "agent", "jev-decisions");

const DEFAULT_THRESHOLD = 0.75;
const DEFAULT_TIMEOUT_MS = 1500;
const BREAKER_TRIP_AFTER = 3;
const BREAKER_COOLDOWN_MS = 10 * 60_000;
const MIN_PROMPT_LEN = 12;
const ROUTE_OUTCOME_FILE = "model-router.jsonl";
const ROUTE_OUTCOME_WINDOW_TURNS = 10;
const ROUTE_OUTCOME_VERDICTS: Record<string, Verdict> = {
	tests_passed: "good",
	tests_failed: "bad",
	model_override: "bad",
	user_corrected: "bad",
};
const TEST_RUN_RE =
	/\b(pnpm|npm|yarn|bun|npx)\s+(run\s+)?(test|vitest|jest)\b|\b(vitest|jest|pytest|go test|cargo test|make test)\b/;

const JEV_BASE_URL = process.env.JEV_BASE_URL ?? "https://openrouter.ai/api";
const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest";

type Tier = "fast" | "mid" | "deep";

interface RouterSettings {
	enabled?: boolean;
	threshold?: number;
	timeoutMs?: number;
	fast?: string | null;
	mid?: string | null;
	deep?: string | null;
}

interface JevAnswer {
	choice?: string;
	probabilities?: Record<string, number>;
	confidence?: number;
}

interface RouteRecord {
	ts: string;
	id: string;
	session: string;
	turn: number;
	prompt: string;
	from: string;
	to: string;
	tier: string;
	exec: string | null;
	execP: number | null;
	p: number | null;
	confidence: number | null;
	newTaskP: number | null;
	acted: boolean;
	reason: string;
	latencyMs: number;
}

function loadSettings(): RouterSettings {
	try {
		const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
		const raw = settings.modelRouter;
		return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as RouterSettings) } : {};
	} catch {
		return {};
	}
}

function writeRouter(mutate: (r: RouterSettings) => void): void {
	const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
	const raw = settings.modelRouter;
	const router: RouterSettings = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as RouterSettings) } : {};
	mutate(router);
	settings.modelRouter = router;
	writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

/** Splits "provider/model:thinking" → ref + optional thinking level (same ref syntax as model-fallback pairs). */
function parseRef(ref: string): { ref: string; thinking?: ThinkingLevel } {
	const colon = ref.lastIndexOf(":");
	if (colon > 0) {
		const suffix = ref.slice(colon + 1) as ThinkingLevel;
		if (THINKING_LEVELS.includes(suffix)) {
			return { ref: ref.slice(0, colon), thinking: suffix };
		}
	}
	return { ref };
}

function keyOf(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function resolveModel(ctx: ExtensionContext, ref: string): Model<Api> | undefined {
	const slash = ref.indexOf("/");
	if (slash > 0) {
		const found = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (found) return found;
	}
	const avail = ctx.modelRegistry.getAvailable();
	return avail.find((m) => m.id === ref) ?? avail.find((m) => m.id.includes(ref));
}

export const TIER_DEFAULT_ROLE: Record<Tier, string> = { fast: "smol", mid: "task", deep: "slow" };

type TierResolution =
	| { status: "disabled" }
	| { status: "unconfigured" }
	| { status: "unresolved"; raw: string }
	| { status: "ok"; model: Model<Api>; thinking?: ThinkingLevel; raw: string; via: "explicit" | "default" };

function resolveTierRef(ctx: ExtensionContext, raw: string, via: "explicit" | "default"): TierResolution {
	const { ref, thinking } = parseRef(raw);
	if (ref.startsWith("@")) {
		const { resolvedModel } = resolveModelRole(ref);
		if (!resolvedModel) return { status: "unresolved", raw };
		const roleParsed = parseRef(resolvedModel);
		const model = resolveModel(ctx, roleParsed.ref);
		if (!model) return { status: "unresolved", raw };
		return { status: "ok", model, thinking: thinking ?? roleParsed.thinking, raw, via };
	}
	const model = resolveModel(ctx, ref);
	if (!model) return { status: "unresolved", raw };
	return { status: "ok", model, thinking, raw, via };
}

// Defaults read the /roles settings only — no env/defaultModel chain — so installs that never configured roles stay inert.
function resolveTier(ctx: ExtensionContext, cfg: RouterSettings, tier: Tier): TierResolution {
	const explicit = cfg[tier];
	if (explicit === null) return { status: "disabled" };
	if (explicit !== undefined) return resolveTierRef(ctx, explicit, "explicit");
	const role = TIER_DEFAULT_ROLE[tier];
	const roleRef = roleSettingRef(role);
	if (!roleRef) return { status: "unconfigured" };
	const res = resolveTierRef(ctx, roleRef, "default");
	return res.status === "ok" && !res.raw.startsWith("@") ? { ...res, raw: `@${role}` } : res;
}

function describeTier(ctx: ExtensionContext, cfg: RouterSettings, tier: Tier): string {
	const res = resolveTier(ctx, cfg, tier);
	switch (res.status) {
		case "disabled":
			return `${tier}: (disabled — "/route clear ${tier}" restores the role default)`;
		case "unconfigured":
			return `${tier}: (unset — default @${TIER_DEFAULT_ROLE[tier]} not configured via /roles)`;
		case "unresolved":
			return `${tier}: ${res.raw} → (unresolved: role unset or model not in registry)`;
		case "ok":
			return `${tier}: ${res.raw} → ${keyOf(res.model)}${res.thinking ? `:${res.thinking}` : ""} (${res.via})`;
	}
}

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

const QUESTIONS = {
	new_task: {
		type: "choice",
		instructions: "Is this prompt the start of a new task, or a follow-up/continuation of the task the user was already working on?",
		criteria: {
			yes: "A new task, unrelated to any prior ongoing task",
			no: "A follow-up, correction, or continuation of the current task",
		},
	},
	execution: {
		type: "choice",
		instructions: "Is this prompt a decided execution handoff (a complete, frozen plan/spec to implement mechanically, with no design decisions left to the model), or must the model make design or diagnostic decisions itself?",
		criteria: {
			executing: "Fully decided handoff — exact files, interfaces, contracts, or step-by-step instructions provided; the model applies them rather than deciding",
			deciding: "The model must decide how to do the work — design, diagnose a failure, choose between alternatives, or discover unknowns",
			mixed: "The bulk is execution but some decisions remain",
		},
	},
	tier: {
		type: "choice",
		instructions: "Which compute tier fits the reasoning this model must do on this prompt? Classify the work required now, not the complexity of the artifact being produced. When uncertain prefer keep; when torn between adjacent tiers, err toward the deeper one — but never upgrade a decided execution handoff to deep just because the artifact it describes is complex.",
		criteria: {
			keep: "Ordinary interactive coding, exploration, or orchestration; the current model is appropriate",
			fast: "Trivial mechanical work — tiny edit, rename, formatting, quick lookup; a small fast model suffices",
			mid: "Implementing a fully-decided handoff — the prompt carries the frozen spec (exact files, interfaces, contracts, explicit steps) and the model executes it mechanically, even when the artifact involves retries, concurrency, or multiple failure paths; also careful judgment on existing material — reviewing a diff or findings, synthesizing research, planning a multi-step refactor",
			deep: "Genuine reasoning is required now — root-cause analysis, architecture or design decisions, production incident triage, designing or diagnosing subtle concurrency and failure-path contracts (retries, idempotency, crash recovery, outbox/dead-letter semantics), or open-ended implementation where no decided spec exists; needs the strongest configured reasoning tier",
		},
	},
} as const;

async function jevCall(key: string, state: string, timeoutMs: number): Promise<Record<string, JevAnswer> | null> {
	let res: Response;
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
		const j = (await res.json()) as { answers?: Record<string, JevAnswer> };
		return j.answers ?? null;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	const envKill = process.env.MODEL_ROUTER === "0";
	let pinned = false;
	let selfSwitching = false;
	let consecutiveFails = 0;
	let cooldownUntil = 0;
	const recent: RouteRecord[] = [];
	const warnedRefs = new Set<string>();

	interface PendingRoute {
		id: string;
		session: string;
		tier: string;
		acted: boolean;
		turn: number;
	}

	let pendingRoute: PendingRoute | null = null;
	let routeTurn = 0;

	function sessionIdOf(ctx: ExtensionContext): string {
		try {
			return ctx.sessionManager.getSessionId();
		} catch {
			return "";
		}
	}

	function routeOutcome(outcome: string, detail: Record<string, unknown> = {}) {
		const p = pendingRoute;
		if (!p) return;
		if (routeTurn - p.turn > ROUTE_OUTCOME_WINDOW_TURNS) {
			pendingRoute = null;
			return;
		}
		logOutcome("router", ROUTE_OUTCOME_FILE, p.id, outcome, {
			verdict: ROUTE_OUTCOME_VERDICTS[outcome] ?? "unknown",
			detail: {
				session: p.session,
				tier: p.tier,
				acted: p.acted,
				turnsAfter: Math.max(0, routeTurn - p.turn),
				...detail,
			},
		});
	}

	function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else process.stderr.write(`[model-router] ${text}\n`);
	}

	/** Last user prompts before the current one — Jev's evidence for new-task vs continuation. */
	function previousPrompts(ctx: ExtensionContext, current: string): string[] {
		const out: string[] = [];
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0 && out.length < 3; i--) {
			const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
			const msg = entry.message;
			if (entry.type !== "message" || msg?.role !== "user") continue;
			const content = msg.content;
			const text = typeof content === "string"
				? content
				: Array.isArray(content)
					? content.filter((b) => (b as { type?: string }).type === "text").map((b) => (b as { text?: string }).text ?? "").join("\n")
					: "";
			const trimmed = text.trim();
			if (!trimmed || trimmed === current) continue;
			out.push(trimmed.slice(0, 200));
		}
		return out.reverse();
	}

	function record(r: RouteRecord) {
		recent.push(r);
		if (recent.length > 8) recent.shift();
		pendingRoute = { id: r.id, session: r.session, tier: r.tier, acted: r.acted, turn: r.turn };
		try {
			pi.appendEntry("model-route", r);
		} catch (err) {
			// best-effort audit; surface instead of swallowing
			process.stderr.write(`[model-router] audit write failed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
		logDecision("router", ROUTE_OUTCOME_FILE, { ...r });
	}

	pi.on("model_select", (event) => {
		if (selfSwitching) return;
		if (event.source === "set" || event.source === "cycle") {
			pinned = true;
			routeOutcome("model_override", { to: keyOf(event.model) });
		}
	});

	pi.on("turn_start", () => {
		routeTurn++;
	});

	pi.on("input", async (event) => {
		if (event.source !== "interactive") return;
		if (looksLikeUserCorrection(event.text)) routeOutcome("user_corrected");
	});

	pi.on("session_start", () => {
		pendingRoute = null;
		routeTurn = 0;
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "bash" || !pendingRoute) return;
		const command = typeof event.input?.command === "string" ? event.input.command : "";
		if (!TEST_RUN_RE.test(command)) return;
		routeOutcome(event.isError ? "tests_failed" : "tests_passed", { command: command.slice(0, 120) });
	});

	// Routing fires here — after prompt submission but before the first provider
	// call — so the routed model serves the whole task. Only new tasks are routed;
	// follow-ups keep the current model to preserve prompt-cache coherence.
	pi.on("before_agent_start", async (event, ctx) => {
		if (envKill || cooldownUntil > Date.now()) return;
		const cfg = loadSettings();
		if (cfg.enabled === false) return;
		const tiers = { fast: resolveTier(ctx, cfg, "fast"), mid: resolveTier(ctx, cfg, "mid"), deep: resolveTier(ctx, cfg, "deep") };
		if (TIERS.every((t) => tiers[t].status === "unconfigured")) return;
		const prompt = (event.prompt ?? "").trim();
		if (prompt.length < MIN_PROMPT_LEN || prompt.startsWith("/")) return;
		const model = ctx.model;
		if (!model) return;
		const key = jevKey();
		if (!key) return;

		const threshold = cfg.threshold ?? DEFAULT_THRESHOLD;
		const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const from = keyOf(model);
		const t0 = Date.now();
		const history = previousPrompts(ctx, prompt);
		const answers = await jevCall(
			key,
			scrubSecrets(
				JSON.stringify({
					prompt: prompt.slice(0, 4000),
					previous_prompts: history,
					project: basename(ctx.cwd),
					current_model: from,
				}),
			),
			timeoutMs,
		);
		const latencyMs = Date.now() - t0;

		if (!answers) {
			consecutiveFails++;
			if (consecutiveFails >= BREAKER_TRIP_AFTER) {
				cooldownUntil = Date.now() + BREAKER_COOLDOWN_MS;
				notify(ctx, `Jev unreachable ${consecutiveFails}x — routing paused ${BREAKER_COOLDOWN_MS / 60_000} min`, "warning");
			}
			return;
		}
		consecutiveFails = 0;

		const exec = answers.execution;
		const execChoice = exec?.choice ?? null;
		const execP = execChoice ? (exec?.probabilities?.[execChoice] ?? null) : null;
		const base = {
			ts: new Date().toISOString(),
			id: newId(),
			session: sessionIdOf(ctx),
			turn: routeTurn,
			prompt: prompt.slice(0, 60),
			from,
			latencyMs,
			exec: execChoice,
			execP,
		};
		// With no session history the question is structurally decided — don't let
		// Jev's guess (unanchored without prior turns) suppress the first routing.
		const nt = answers.new_task;
		const newTaskP = history.length === 0 ? 1 : nt?.choice === "yes" ? (nt.probabilities?.yes ?? 0) : 0;
		if (newTaskP < threshold) {
			record({ ...base, to: from, tier: "keep", p: null, confidence: null, newTaskP, acted: false, reason: "continuation-or-unsure" });
			return;
		}
		if (pinned) {
			pinned = false;
			notify(ctx, "Manual model choice honored for this task; auto-routing resumes at the next task boundary");
			record({ ...base, to: from, tier: "keep", p: null, confidence: null, newTaskP, acted: false, reason: "manual-pin" });
			return;
		}

		const tier = answers.tier;
		const choice = tier?.choice ?? "keep";
		const p = tier?.probabilities?.[choice] ?? 0;
		const confidence = tier?.confidence ?? null;
		if (!TIERS.includes(choice as (typeof TIERS)[number]) || p < threshold) {
			record({ ...base, to: from, tier: choice, p, confidence, newTaskP, acted: false, reason: choice === "keep" ? "keep" : "below-threshold" });
			return;
		}
		const res = tiers[choice as (typeof TIERS)[number]];
		if (res.status === "disabled" || res.status === "unconfigured") {
			record({ ...base, to: from, tier: choice, p, confidence, newTaskP, acted: false, reason: res.status === "disabled" ? "tier-disabled" : "tier-unconfigured" });
			return;
		}
		if (res.status === "unresolved") {
			if (!warnedRefs.has(res.raw)) {
				warnedRefs.add(res.raw);
				notify(ctx, `Router tier "${choice}" ref "${res.raw}" unresolved (role unset or model not in registry)`, "warning");
			}
			record({ ...base, to: res.raw, tier: choice, p, confidence, newTaskP, acted: false, reason: "unresolved-ref" });
			return;
		}
		const target = res.model;
		const to = keyOf(target);
		if (to === from) {
			// Same base model: mid/deep differ only in thinking — a cache-safe switch.
			if (res.thinking && res.thinking !== ctx.thinkingLevel) {
				pi.setThinkingLevel(res.thinking);
				notify(ctx, `${from} thinking → ${res.thinking} (tier=${choice} p=${p.toFixed(2)}, ${latencyMs}ms)`);
				record({ ...base, to, tier: choice, p, confidence, newTaskP, acted: true, reason: "thinking-routed" });
				return;
			}
			record({ ...base, to, tier: choice, p, confidence, newTaskP, acted: false, reason: "already-on-tier" });
			return;
		}

		selfSwitching = true;
		let ok = false;
		try {
			ok = await pi.setModel(target);
			if (ok && res.thinking) pi.setThinkingLevel(res.thinking);
		} finally {
			selfSwitching = false;
		}
		if (!ok) {
			notify(ctx, `No auth for routed model ${to}; staying on ${from}`, "warning");
			record({ ...base, to, tier: choice, p, confidence, newTaskP, acted: false, reason: "no-auth" });
			return;
		}
		notify(ctx, `${from} → ${to} (tier=${choice} p=${p.toFixed(2)}${res.thinking ? ` @ ${res.thinking}` : ""}${res.raw.startsWith("@") ? ` via ${res.raw}` : ""}, ${latencyMs}ms)`);
		record({ ...base, to, tier: choice, p, confidence, newTaskP, acted: true, reason: "routed" });
	});

	const TIERS = ["fast", "mid", "deep"] as const;

	const TIER_DESCRIPTIONS: Record<(typeof TIERS)[number], string> = {
		fast: "trivial mechanical work — tiny edits, renames, quick lookups with few edge cases",
		mid: "bounded judgment — review triage, research synthesis, refactors, and local debugging",
		deep: "hard reasoning — root-cause, architecture, incident triage, concurrency/retry contracts, or long-horizon implementations with multiple failure paths",
	};

	function validateTier(ctx: ExtensionContext, name: string): (typeof TIERS)[number] | undefined {
		const tier = TIERS.find((t) => t === name.toLowerCase());
		if (!tier) notify(ctx, `Unknown tier "${name}". Tiers: ${TIERS.join(", ")}`, "error");
		return tier;
	}

	async function setThreshold(ctx: ExtensionContext, arg?: string): Promise<void> {
		let value = arg ? Number(arg) : undefined;
		if (!arg) {
			const choice = await ctx.ui.select("Route threshold (min p to act):", ["0.6", "0.7", "0.75", "0.8", "0.9"]);
			if (!choice) return;
			value = Number(choice);
		}
		if (value === undefined || Number.isNaN(value) || value < 0.5 || value > 0.95) {
			notify(ctx, "Threshold must be a number between 0.5 and 0.95", "error");
			return;
		}
		writeRouter((r) => {
			r.threshold = value;
		});
		notify(ctx, `Threshold = ${value}`);
	}

	async function setTierDirect(ctx: ExtensionContext, tier: (typeof TIERS)[number], refArg: string): Promise<void> {
		if (refArg.toLowerCase() === "off" || refArg.toLowerCase() === "none") {
			writeRouter((r) => {
				r[tier] = null;
			});
			notify(ctx, `${tier} tier disabled — no routing, no role default. "/route clear ${tier}" restores the default.`, "info");
			return;
		}
		const { ref, thinking } = parseRef(refArg);
		if (ref.startsWith("@")) {
			const role = ref.slice(1).toLowerCase();
			if (!(ROLE_NAMES as readonly string[]).includes(role)) {
				notify(ctx, `Unknown role "${ref}". Roles: ${ROLE_NAMES.join(", ")}`, "error");
				return;
			}
			const { resolvedModel } = resolveModelRole(ref);
			const base = resolvedModel ? parseRef(resolvedModel).ref : undefined;
			if (!resolvedModel || !base || !resolveModel(ctx, base)) {
				notify(ctx, `Role ${ref} does not resolve to a registry model — configure it with /roles first`, "error");
				return;
			}
			const value = ref + (thinking ? `:${thinking}` : "");
			writeRouter((r) => {
				r[tier] = value;
			});
			notify(ctx, `Set ${tier} = ${value} (resolves to ${resolvedModel})`, "info");
			return;
		}
		const model = resolveModel(ctx, ref);
		if (!model) {
			notify(ctx, `Model "${ref}" not found in registry`, "error");
			return;
		}
		const value = keyOf(model) + (thinking ? `:${thinking}` : "");
		writeRouter((r) => {
			r[tier] = value;
		});
		notify(ctx, `Set ${tier} = ${value}`, "info");
	}

	async function runTierEdit(ctx: ExtensionContext, tierArg?: string, modelArg?: string): Promise<void> {
		let tier = tierArg ? validateTier(ctx, tierArg) : undefined;
		if (tierArg && !tier) return;
		if (tier && modelArg) {
			await setTierDirect(ctx, tier, modelArg);
			return;
		}
		if (!tier) {
			const cfg = loadSettings();
			const rows: PickerRow[] = TIERS.map((t) => ({
				label: t,
				meta: typeof cfg[t] === "string" ? (cfg[t] as string) : cfg[t] === null ? "(off)" : "(unset)",
				description: TIER_DESCRIPTIONS[t],
			}));
			const picked = await pickRows(ctx, "Pick router tier:", rows);
			if (!picked) return;
			tier = picked.label as (typeof TIERS)[number];
		}
		const roleRows: PickerRow[] = (["smol", "task", "slow", "plan", "designer"] as const)
			.map((role) => ({ label: `@${role}`, meta: roleSettingRef(role) ?? "(unset)", description: "Role alias from /roles — the tier follows the role" }))
			.filter((row) => row.meta !== "(unset)");
		const offRow: PickerRow = { label: "(off)", meta: "disable", description: "Never route to this tier; no role default" };
		const modelRows: PickerRow[] = ctx.modelRegistry.getAvailable().map((m) => ({
			label: keyOf(m),
			meta: m.reasoning ? "reasoning" : "",
			description: `${m.name} · ctx ${Math.round(m.contextWindow / 1000)}k`,
		}));
		const picked = await pickRows(ctx, `Model for ${tier} tier (role alias or model):`, [offRow, ...roleRows, ...modelRows]);
		if (!picked) return;
		let value: string | null;
		if (picked.label === "(off)") value = null;
		else if (picked.label.startsWith("@")) value = picked.label;
		else {
			const model = resolveModel(ctx, picked.label);
			if (!model) return;
			let suffix = "";
			if (ctx.mode === "tui") {
				const levels = ["(none)", ...THINKING_LEVELS];
				const choice = await ctx.ui.select("Thinking level:", levels);
				if (!choice) return;
				suffix = choice !== "(none)" ? `:${choice}` : "";
			}
			value = `${keyOf(model)}${suffix}`;
		}
		writeRouter((r) => {
			r[tier] = value;
		});
		notify(ctx, `Set ${tier} = ${value ?? "(off)"}\nApplies to the next prompt — no reload needed.`, "info");
	}

	async function clearTier(ctx: ExtensionContext, tierArg?: string): Promise<void> {
		const cfg = loadSettings();
		const configured = TIERS.filter((t) => cfg[t] !== undefined);
		if (configured.length === 0) {
			notify(ctx, "No tiers configured", "info");
			return;
		}
		const tier = tierArg ? validateTier(ctx, tierArg) : ((await ctx.ui.select("Clear which tier:", configured)) as (typeof TIERS)[number] | undefined);
		if (!tier || !configured.includes(tier)) return;
		writeRouter((r) => {
			delete r[tier];
		});
		notify(ctx, `Cleared ${tier} — falls back to @${TIER_DEFAULT_ROLE[tier]} if that role is configured via /roles`, "info");
	}

	const fmt = (r: RouteRecord) =>
		`  ${r.ts.slice(11, 19)} ${r.acted ? `${r.from} → ${r.to}` : `kept ${r.from}`} tier=${r.tier} p=${r.p?.toFixed(2) ?? "-"} task=${r.newTaskP?.toFixed(2) ?? "-"} exec=${r.exec ?? "-"}${r.execP !== null ? `@${r.execP.toFixed(2)}` : ""} ${r.reason}`;

	pi.registerCommand("route", {
		description: "Jev-scored per-task model routing (/route status, /route tier, /route on|off)",
		handler: async (args, ctx) => {
			const [sub, tierArg, modelArg] = args.trim().split(/\s+/).filter(Boolean);

			if (sub === "on" || sub === "off") {
				writeRouter((r) => {
					r.enabled = sub === "on";
				});
				notify(ctx, `model-router ${sub === "on" ? "enabled" : "disabled"}`);
				return;
			}
			if (sub === "threshold") {
				await setThreshold(ctx, tierArg);
				return;
			}
			if (sub === "clear") {
				await clearTier(ctx, tierArg);
				return;
			}
			if (sub === "tier") {
				await runTierEdit(ctx, tierArg, modelArg);
				return;
			}
			if (sub && sub !== "status") {
				notify(ctx, "Usage: /route [on|off|tier|clear|threshold]", "error");
				return;
			}
			const cfg = loadSettings();
			notify(
				ctx,
				[
					`enabled: ${cfg.enabled !== false}`,
					`threshold: ${cfg.threshold ?? DEFAULT_THRESHOLD} · timeout: ${cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
					...TIERS.map((t) => describeTier(ctx, cfg, t)),
					`pin: ${pinned ? "active — manual choice honored for current task" : "none"}`,
					`breaker: ${cooldownUntil > Date.now() ? `paused until ${new Date(cooldownUntil).toLocaleTimeString()}` : "clear"}`,
					`recent:\n${recent.length ? recent.map(fmt).join("\n") : "  (none yet)"}`,
					`log: ${join(LOG_DIR, "model-router.jsonl")}`,
					`config: ${SETTINGS_PATH} → "modelRouter" · edit tiers with /route tier`,
				].join("\n"),
			);
		},
	});
}

async function pickRows(ctx: ExtensionContext, title: string, rows: PickerRow[]): Promise<PickerRow | undefined> {
	if (ctx.mode === "tui") {
		return (
			(await ctx.ui.custom<PickerRow | null>((tui, theme, kb, done) =>
				new FilterablePicker({
					tui,
					theme,
					keybindings: kb,
					title,
					rows,
					onPick: done,
					onCancel: () => done(null),
				}),
			)) ?? undefined
		);
	}
	const label = await ctx.ui.select(title, rows.map((r) => r.label));
	return rows.find((r) => r.label === label);
}

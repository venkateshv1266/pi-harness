import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { FilterablePicker, THINKING_LEVELS, type PickerRow } from "./model-fallback.ts";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const LOG_DIR = join(homedir(), ".pi", "agent", "refine");

const DEFAULT_THRESHOLD = 0.75;
const DEFAULT_TIMEOUT_MS = 1500;
const BREAKER_TRIP_AFTER = 3;
const BREAKER_COOLDOWN_MS = 10 * 60_000;
const MIN_PROMPT_LEN = 12;

const JEV_BASE_URL = process.env.JEV_BASE_URL ?? "https://openrouter.ai/api";
const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest";

interface RouterSettings {
	enabled?: boolean;
	threshold?: number;
	timeoutMs?: number;
	fast?: string;
	mid?: string;
	deep?: string;
}

interface JevAnswer {
	choice?: string;
	probabilities?: Record<string, number>;
	confidence?: number;
}

interface RouteRecord {
	ts: string;
	prompt: string;
	from: string;
	to: string;
	tier: string;
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
	tier: {
		type: "choice",
		instructions: "Which compute tier fits this task? When uncertain prefer keep; when torn between adjacent tiers, err toward the deeper one — under-routing loses quality, over-routing only costs money.",
		criteria: {
			keep: "Ordinary interactive coding, exploration, or orchestration; the current model is appropriate",
			fast: "Trivial mechanical work — tiny edit, rename, formatting, quick lookup; a small fast model suffices",
			mid: "Careful judgment on existing material — reviewing a diff or findings for validity, synthesizing research, planning a multi-step refactor; needs more care than trivial work but not maximum reasoning",
			deep: "Hard reasoning — root-cause analysis, architecture, production incident triage, subtle concurrency or multi-system interactions, and long-horizon implementations with multiple failure paths (retries, idempotency, crash recovery, outbox/dead-letter contracts); needs the strongest configured reasoning tier",
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
		try {
			pi.appendEntry("model-route", r);
			mkdirSync(LOG_DIR, { recursive: true });
			appendFileSync(join(LOG_DIR, "model-router.jsonl"), JSON.stringify(r) + "\n");
		} catch (err) {
			// best-effort audit; surface instead of swallowing
			process.stderr.write(`[model-router] audit write failed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}

	pi.on("model_select", (event) => {
		if (selfSwitching) return;
		if (event.source === "set" || event.source === "cycle") pinned = true;
	});

	// Routing fires here — after prompt submission but before the first provider
	// call — so the routed model serves the whole task. Only new tasks are routed;
	// follow-ups keep the current model to preserve prompt-cache coherence.
	pi.on("before_agent_start", async (event, ctx) => {
		if (envKill || cooldownUntil > Date.now()) return;
		const cfg = loadSettings();
		if (cfg.enabled === false) return;
		if (!cfg.fast && !cfg.deep) return;
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

		const base = { ts: new Date().toISOString(), prompt: prompt.slice(0, 60), from, latencyMs };
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
		const ref = cfg[choice as (typeof TIERS)[number]];
		if (!ref) {
			record({ ...base, to: from, tier: choice, p, confidence, newTaskP, acted: false, reason: "tier-unconfigured" });
			return;
		}
		const parsed = parseRef(ref);
		const target = resolveModel(ctx, parsed.ref);
		if (!target) {
			if (!warnedRefs.has(ref)) {
				warnedRefs.add(ref);
				notify(ctx, `Router tier "${choice}" ref "${ref}" not in model registry`, "warning");
			}
			record({ ...base, to: ref, tier: choice, p, confidence, newTaskP, acted: false, reason: "unresolved-ref" });
			return;
		}
		const to = keyOf(target);
		if (to === from) {
			// Same base model: mid/deep differ only in thinking — a cache-safe switch.
			if (parsed.thinking && parsed.thinking !== ctx.thinkingLevel) {
				pi.setThinkingLevel(parsed.thinking);
				notify(ctx, `${from} thinking → ${parsed.thinking} (tier=${choice} p=${p.toFixed(2)}, ${latencyMs}ms)`);
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
			if (ok && parsed.thinking) pi.setThinkingLevel(parsed.thinking);
		} finally {
			selfSwitching = false;
		}
		if (!ok) {
			notify(ctx, `No auth for routed model ${to}; staying on ${from}`, "warning");
			record({ ...base, to, tier: choice, p, confidence, newTaskP, acted: false, reason: "no-auth" });
			return;
		}
		notify(ctx, `${from} → ${to} (tier=${choice} p=${p.toFixed(2)}${parsed.thinking ? ` @ ${parsed.thinking}` : ""}, ${latencyMs}ms)`);
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
		const { ref, thinking } = parseRef(refArg);
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
				meta: cfg[t] ?? "(unset)",
				description: TIER_DESCRIPTIONS[t],
			}));
			const picked = await pickRows(ctx, "Pick router tier:", rows);
			if (!picked) return;
			tier = picked.label as (typeof TIERS)[number];
		}
		const model = await pickAvailableModel(ctx, `Model for ${tier} tier:`);
		if (!model) return;
		let suffix = "";
		if (ctx.mode === "tui") {
			const levels = ["(none)", ...THINKING_LEVELS];
			const choice = await ctx.ui.select("Thinking level:", levels);
			if (!choice) return;
			suffix = choice !== "(none)" ? `:${choice}` : "";
		}
		const value = `${keyOf(model)}${suffix}`;
		writeRouter((r) => {
			r[tier] = value;
		});
		notify(ctx, `Set ${tier} = ${value}\nApplies to the next prompt — no reload needed.`, "info");
	}

	async function clearTier(ctx: ExtensionContext, tierArg?: string): Promise<void> {
		const cfg = loadSettings();
		const configured = TIERS.filter((t) => typeof cfg[t] === "string");
		if (configured.length === 0) {
			notify(ctx, "No tiers configured", "info");
			return;
		}
		const tier = tierArg ? validateTier(ctx, tierArg) : ((await ctx.ui.select("Clear which tier:", configured)) as (typeof TIERS)[number] | undefined);
		if (!tier || !configured.includes(tier)) return;
		writeRouter((r) => {
			delete r[tier];
		});
		notify(ctx, `Cleared ${tier}`, "info");
	}

	const fmt = (r: RouteRecord) =>
		`  ${r.ts.slice(11, 19)} ${r.acted ? `${r.from} → ${r.to}` : `kept ${r.from}`} tier=${r.tier} p=${r.p?.toFixed(2) ?? "-"} task=${r.newTaskP?.toFixed(2) ?? "-"} ${r.reason}`;

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
					`fast: ${cfg.fast ?? "(unset)"}`,
					`mid: ${cfg.mid ?? "(unset)"}`,
					`deep: ${cfg.deep ?? "(unset)"}`,
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

async function pickAvailableModel(ctx: ExtensionContext, title: string): Promise<Model<Api> | undefined> {
	const rows: PickerRow[] = ctx.modelRegistry.getAvailable().map((m) => ({
		label: keyOf(m),
		meta: m.reasoning ? "reasoning" : "",
		description: `${m.name} · ctx ${Math.round(m.contextWindow / 1000)}k`,
	}));
	const picked = await pickRows(ctx, title, rows);
	return picked ? resolveModel(ctx, picked.label) : undefined;
}
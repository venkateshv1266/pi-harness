import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { TIER_DEFAULT_ROLE } from "../model-router.ts";
import { roleSettingRef } from "../../utils/model-role.ts";
import * as io from "./io.ts";
import type { SetupItem, SetupSection } from "./types.ts";

const CLEAR = "__remove";

function routerCfg(s: Record<string, unknown>): Record<string, unknown> {
	const raw = s.modelRouter;
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function tierDisplay(tier: "fast" | "mid" | "deep", raw: unknown, preferRoles: boolean): string {
	if (raw === null) return "(off — disabled)";
	const role = TIER_DEFAULT_ROLE[tier];
	const ref = roleSettingRef(role);
	if (preferRoles && ref) return `@${role} → ${ref} (roles-prefer)`;
	if (typeof raw === "string") return raw;
	return ref ? `(unset → defaults to @${role} → ${ref})` : `(unset — @${role} not configured via /roles)`;
}

function guardrailsCfg(s: Record<string, unknown>): Record<string, unknown> {
	const raw = s.openrouterGuardrails;
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function fallbackCfg(s: Record<string, unknown>): Record<string, unknown> {
	const raw = s.modelFallback;
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function modelThinkingLevels(s: Record<string, unknown>): Record<string, string> {
	const raw = s.modelThinkingLevels;
	return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, string>) } : {};
}

function levelOptions() {
	return io.THINKING_LEVELS.map((l) => ({ value: l, label: l }));
}

// ─── Models ─────────────────────────────────────────────────────────────────

function modelSections(pi: ExtensionAPI, ctx: ExtensionCommandContext): SetupSection[] {
	const s = io.settings();
	const overrides = modelThinkingLevels(s);

	const modelItems: SetupItem[] = [
		{
			id: "default-model",
			label: "Default model",
			detail:
				"Model used when a session starts without --model and no session override. Cycling with Ctrl+P starts from here.",
			effect: "new sessions",
			owner: "pi core · /model",
			kind: "model",
			get: () => {
				const cur = io.settings();
				const p = io.readString(cur, "defaultProvider");
				const m = io.readString(cur, "defaultModel");
				return p && m ? `${p}/${m}` : "(not set)";
			},
			apply: async (c, value) => {
				const model = io.resolveModel(c, value);
				if (!model) return `✗ model not found: ${value}`;
				io.updateSettings((set) => {
					set.defaultProvider = model.provider;
					set.defaultModel = model.id;
				});
				void pi.setModel(model);
				return `default model → ${io.keyOf(model)} (also applied to this session)`;
			},
		},
		{
			id: "default-thinking",
			label: "Default thinking level",
			detail:
				"Reasoning effort for sessions that don't pin one: minimal → low → medium → high → xhigh → max. Higher levels think longer and cost more.",
			effect: "this session + new sessions",
			owner: "pi core · /settings, /thinking",
			kind: "enum",
			options: levelOptions(),
			get: () => {
				const cur = io.readString(io.settings(), "defaultThinkingLevel");
				return cur || "high (pi default)";
			},
			apply: async (_c, value) => {
				io.updateSettings((set) => {
					set.defaultThinkingLevel = value;
				});
				pi.setThinkingLevel(value as ThinkingLevel);
				return `default thinking level → ${value}`;
			},
		},
	];

	modelItems.push({
		id: "model-thinking:add",
		label: "+ Add thinking override",
		detail: "Pin a thinking level for one model regardless of the global default.",
		effect: "this session + new sessions",
		owner: "pi core · /settings",
		kind: "model",
		withThinking: true,
		get: () => "(pick model, then level)",
		apply: async (_c, value) => {
			const { ref, thinking } = io.parseRef(value);
			if (!thinking) return "✗ pick a thinking level";
			io.updateSettings((set) => {
				const all = modelThinkingLevels(set);
				all[ref] = thinking;
				set.modelThinkingLevels = all;
			});
			return `${ref} thinking → ${thinking} (restart or /reload to see it listed)`;
		},
	});

	for (const [modelKey, level] of Object.entries(overrides)) {
		modelItems.push({
			id: `model-thinking:${modelKey}`,
			label: modelKey,
			detail: `Pins thinking level "${level}" for ${io.prettyRef(modelKey)} regardless of the global default.`,
			effect: "this session + new sessions",
			owner: "pi core · /settings",
			kind: "enum",
			removable: true,
			options: levelOptions(),
			get: () => modelThinkingLevels(io.settings())[modelKey] ?? level,
			apply: async (_c, value) => {
				io.updateSettings((set) => {
					const all = modelThinkingLevels(set);
					if (value === CLEAR) delete all[modelKey];
					else all[modelKey] = value;
					set.modelThinkingLevels = all;
				});
				return value === CLEAR
					? `removed thinking override for ${modelKey}`
					: `${modelKey} thinking → ${value}`;
			},
		});
	}

	return [
		{
			id: "models",
			title: "Models",
			detail: "Default model, thinking effort, and per-model overrides.",
			items: modelItems,
		},
	];
}

// ─── Roles ──────────────────────────────────────────────────────────────────

const ROLE_DEFS: { key: string; detail: string }[] = [
	{ key: "smolModel", detail: "Cheap/fast model for lightweight subagent work (@smol); router fast-tier default." },
	{ key: "slowModel", detail: "Deep-reasoning model for hard analysis and verification (@slow); router deep-tier default." },
	{ key: "planModel", detail: "Planning model for decomposing and sequencing work (@plan)." },
	{ key: "taskModel", detail: "General execution model for implementation subagents (@task); router mid-tier default." },
	{ key: "designerModel", detail: "Model for UI/UX and visual design work (@designer)." },
];

function rolesSection(): SetupSection {
	return {
		id: "roles",
		title: "Roles",
		detail: "Model roles used by subagents and, as tier defaults/aliases, the router. Same refs as /roles: \"provider/model\" plus optional \":thinking\".",
		items: ROLE_DEFS.map(({ key, detail }) => ({
			id: `role:${key}`,
			label: key.replace(/Model$/, "") + " role",
			detail,
			effect: "next subagent spawn",
			owner: "model-roles · /roles",
			kind: "model",
			withThinking: true,
			removable: true,
			get: () => io.readString(io.settings(), key) || "(unset — falls back to default model)",
			apply: async (_c, value) => {
				io.updateSettings((set) => {
					if (value === CLEAR) delete set[key];
					else set[key] = value;
				});
				return value === CLEAR ? `cleared ${key}` : `${key} → ${value}`;
			},
		})),
	};
}

// ─── Router ─────────────────────────────────────────────────────────────────

const THRESHOLD_STEPS = ["0.5", "0.6", "0.7", "0.75", "0.8", "0.9"];

function routerSection(): SetupSection {
	return {
		id: "router",
		title: "Router",
		detail: "Prompt classifier that picks the fast, mid, or deep model tier per prompt.",
		items: [
			{
				id: "router:enabled",
				label: "Router enabled",
				detail: "When on, each prompt is classified (cheap vs complex) and routed to the matching tier. When off, every prompt uses the session model as usual.",
				effect: "next prompt",
				owner: "model-router · /route",
				kind: "toggle",
				get: () => (routerCfg(io.settings()).enabled === false ? "off" : "on"),
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.modelRouter = { ...routerCfg(set), enabled: value === "on" };
					});
					return `router ${value === "on" ? "enabled" : "disabled"}`;
				},
			},
			{
				id: "router:preferRoles",
				label: "Prefer roles over explicit tiers",
				detail: "When on, tier models follow the /roles settings (fast→@smol, mid→@task, deep→@slow) even when explicit tier refs are set; 'off' tiers stay off. When off, explicit tier refs win.",
				effect: "next prompt",
				owner: "model-router · /route prefer",
				kind: "toggle",
				get: () => (routerCfg(io.settings()).preferRoles === true ? "on" : "off"),
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.modelRouter = { ...routerCfg(set), preferRoles: value === "on" };
					});
					return `prefer roles ${value === "on" ? "on — /roles win over explicit tier refs" : "off — explicit tier refs win"}`;
				},
			},
			{
				id: "router:threshold",
				label: "Complexity threshold",
				detail: "Minimum calibrated probability that a prompt is complex before paying for the deep tier. Lower → routes to deep more often.",
				effect: "next prompt",
				owner: "model-router · /route threshold",
				kind: "enum",
				options: THRESHOLD_STEPS.map((v) => ({ value: v, label: v })),
				get: () => {
					const t = routerCfg(io.settings()).threshold;
					return typeof t === "number" ? String(t) : "0.75 (default)";
				},
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.modelRouter = { ...routerCfg(set), threshold: Number(value) };
					});
					return `threshold → ${value}`;
				},
			},
			{
				id: "router:timeout",
				label: "Probe timeout (ms)",
				detail: "How long the router waits for its classification probe before giving up and using the current model.",
				effect: "next prompt",
				owner: "model-router · /route",
				kind: "number",
				min: 0,
				max: 30000,
				get: () => {
					const t = routerCfg(io.settings()).timeoutMs;
					return typeof t === "number" ? `${t} ms` : "1500 ms (default)";
				},
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.modelRouter = { ...routerCfg(set), timeoutMs: Number(value) };
					});
					return `probe timeout → ${value} ms`;
				},
			},
			{
				id: "router:fast",
				label: "Fast tier",
				detail: "Model used for cheap/mechanical prompts: formatting, quick lookups, trivial edits. Ref or @role alias; unset → @smol via /roles.",
				effect: "next prompt",
				owner: "model-router · /route tier fast",
				kind: "model",
				withThinking: true,
				get: () => {
					const cfg = routerCfg(io.settings());
					return tierDisplay("fast", cfg.fast, cfg.preferRoles === true);
				},
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.modelRouter = { ...routerCfg(set), fast: value };
					});
					return `fast tier → ${value}`;
				},
			},
			{
				id: "router:mid",
				label: "Mid tier",
				detail: "Model used for careful judgment work: review triage, research synthesis, refactor planning. Ref or @role alias; unset → @task via /roles.",
				effect: "next prompt",
				owner: "model-router · /route tier mid",
				kind: "model",
				withThinking: true,
				get: () => {
					const cfg = routerCfg(io.settings());
					return tierDisplay("mid", cfg.mid, cfg.preferRoles === true);
				},
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.modelRouter = { ...routerCfg(set), mid: value };
					});
					return `mid tier → ${value}`;
				},
			},
			{
				id: "router:deep",
				label: "Deep tier",
				detail: "Model used for complex prompts: architecture, tricky bugs, multi-step reasoning. Ref or @role alias; unset → @slow via /roles.",
				effect: "next prompt",
				owner: "model-router · /route tier deep",
				kind: "model",
				withThinking: true,
				get: () => {
					const cfg = routerCfg(io.settings());
					return tierDisplay("deep", cfg.deep, cfg.preferRoles === true);
				},
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.modelRouter = { ...routerCfg(set), deep: value };
					});
					return `deep tier → ${value}`;
				},
			},
		],
	};
}

// ─── Fallbacks ──────────────────────────────────────────────────────────────

function fallbackSection(): SetupSection {
	const pairs = Object.entries(fallbackCfg(io.settings())).filter(
		([, v]) => typeof v === "string",
	) as [string, string][];
	const items: SetupItem[] = pairs.map(([primary, target]) => ({
		id: `fallback:${primary}`,
		label: primary,
		detail: `When ${io.prettyRef(primary)} fails repeatedly, traffic fails over to this model.`,
		effect: "next provider failure",
		owner: "model-fallback · /fallback",
		kind: "model",
		withThinking: true,
		removable: true,
		get: () => `→ ${io.prettyRef(target)}`,
		apply: async (_c, value) => {
			io.updateSettings((set) => {
				const map = fallbackCfg(set);
				if (value === CLEAR) delete map[primary];
				else map[primary] = value;
				set.modelFallback = map;
			});
			return value === CLEAR ? `removed fallback for ${primary}` : `${primary} → ${value}`;
		},
	}));
	items.push(
		{
			id: "fallback:fail-threshold",
			label: "Failure threshold",
			detail: "Consecutive failures on a model before its fallback triggers.",
			effect: "next provider failure",
			owner: "model-fallback · /fallback",
			kind: "number",
			min: 1,
			max: 10,
			get: () => {
				const t = fallbackCfg(io.settings()).failThreshold;
				return typeof t === "number" ? String(t) : "3 (default)";
			},
			apply: async (_c, value) => {
				io.updateSettings((set) => {
					set.modelFallback = { ...fallbackCfg(set), failThreshold: Number(value) };
				});
				return `fail threshold → ${value}`;
			},
		},
		{
			id: "fallback:add",
			label: "+ Add fallback pair",
			detail: "Pick the primary model, then the fallback it should fail over to.",
			effect: "next provider failure",
			owner: "model-fallback · /fallback",
			kind: "model-pair",
			withThinking: true,
			get: () => "(pick two models)",
			apply: async (_c, value) => {
				const [primary, target] = value.split(">");
				if (!primary || !target) return "✗ incomplete pair";
				io.updateSettings((set) => {
					const map = fallbackCfg(set);
					map[primary] = target;
					set.modelFallback = map;
				});
				return `fallback: ${primary} → ${target}`;
			},
		},
	);
	return {
		id: "fallbacks",
		title: "Fallbacks",
		detail: "Automatic failover pairs: primary model → backup when it keeps failing.",
		items,
	};
}

// ─── Guardrails ─────────────────────────────────────────────────────────────

function guardrailsSection(): SetupSection {
	return {
		id: "guardrails",
		title: "Guardrails",
		detail: "Spend limits for the OpenRouter guardrails shown in the footer.",
		items: [
			{
				id: "guardrails:daily",
				label: "Daily limit (USD)",
				detail: "Approximate daily OpenRouter spend where the footer guardrails start warning you.",
				effect: "next request",
				owner: "custom-footer",
				kind: "number",
				min: 0,
				max: 100000,
				get: () => {
					const d = guardrailsCfg(io.settings()).dailyLimit;
					return typeof d === "number" ? `$${d} / day` : "(not set)";
				},
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.openrouterGuardrails = { ...guardrailsCfg(set), dailyLimit: Number(value) };
					});
					return `daily limit → $${value}`;
				},
			},
			{
				id: "guardrails:monthly",
				label: "Monthly limit (USD)",
				detail: "Approximate monthly OpenRouter spend where the footer guardrails start warning you.",
				effect: "next request",
				owner: "custom-footer",
				kind: "number",
				min: 0,
				max: 1000000,
				get: () => {
					const m = guardrailsCfg(io.settings()).monthlyLimit;
					return typeof m === "number" ? `$${m} / month` : "(not set)";
				},
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.openrouterGuardrails = { ...guardrailsCfg(set), monthlyLimit: Number(value) };
					});
					return `monthly limit → $${value}`;
				},
			},
		],
	};
}

// ─── Appearance ─────────────────────────────────────────────────────────────

function appearanceSection(): SetupSection {
	return {
		id: "appearance",
		title: "Appearance",
		detail: "Theme and TUI layout.",
		items: [
			{
				id: "appearance:theme",
				label: "Theme",
				detail: "Color theme. Includes built-ins (dark/light) and your custom themes.",
				effect: "next start (or /reload)",
				owner: "pi core · /theme",
				kind: "enum",
				options: () => io.availableThemes().map((t) => ({ value: t, label: t })),
				get: () => io.readString(io.settings(), "theme") || "dark (default)",
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.theme = value;
					});
					return `theme → ${value} (restart or /reload to apply)`;
				},
			},
			{
				id: "appearance:tui-mode",
				label: "TUI mode",
				detail: "fullscreen renders pi in an alternate-screen window with scrollbars; normal streams output inline in the terminal.",
				effect: "next start",
				owner: "pi core · /settings",
				kind: "enum",
				options: [
					{ value: "fullscreen", label: "fullscreen", description: "alternate-screen window" },
					{ value: "normal", label: "normal", description: "inline streaming output" },
				],
				get: () => io.readString(io.settings(), "tuiMode") || "fullscreen (default)",
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.tuiMode = value;
					});
					return `tui mode → ${value} (applies next start)`;
				},
			},
		],
	};
}

// ─── Core behavior ──────────────────────────────────────────────────────────

function coreSection(): SetupSection {
	return {
		id: "core",
		title: "Core",
		detail: "pi core behavior flags (settings.json).",
		items: [
			{
				id: "core:trust",
				label: "Default project trust",
				detail: "What pi does in untrusted projects: ask every time, always trust, or never load project-local extensions/skills.",
				effect: "next start",
				owner: "pi core · /settings",
				kind: "enum",
				options: [
					{ value: "ask", label: "ask", description: "prompt when entering an untrusted project" },
					{ value: "always", label: "always", description: "never prompt, trust everything" },
					{ value: "never", label: "never", description: "never load project resources" },
				],
				get: () => io.readString(io.settings(), "defaultProjectTrust") || "ask (default)",
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.defaultProjectTrust = value;
					});
					return `default project trust → ${value}`;
				},
			},
			{
				id: "core:steering",
				label: "Steering mode",
				detail: "How messages sent mid-turn behave: all are delivered as interrupts, or one-at-a-time queues them.",
				effect: "next start",
				owner: "pi core · /settings",
				kind: "enum",
				options: [
					{ value: "all", label: "all", description: "interrupt with every message" },
					{ value: "one-at-a-time", label: "one-at-a-time", description: "deliver queued messages serially" },
				],
				get: () => io.readString(io.settings(), "steeringMode") || "all (default)",
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.steeringMode = value;
					});
					return `steering mode → ${value}`;
				},
			},
			{
				id: "core:followup",
				label: "Follow-up mode",
				detail: "How queued follow-up messages run after the current turn: all at once or one at a time.",
				effect: "next start",
				owner: "pi core · /settings",
				kind: "enum",
				options: [
					{ value: "all", label: "all", description: "send all queued messages together" },
					{ value: "one-at-a-time", label: "one-at-a-time", description: "run queued messages serially" },
				],
				get: () => io.readString(io.settings(), "followUpMode") || "all (default)",
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.followUpMode = value;
					});
					return `follow-up mode → ${value}`;
				},
			},
			{
				id: "core:double-escape",
				label: "Double-escape action",
				detail: "What pressing Esc twice does: open the fork picker, the session tree, or nothing.",
				effect: "next start",
				owner: "pi core · /settings",
				kind: "enum",
				options: [
					{ value: "fork", label: "fork" },
					{ value: "tree", label: "tree" },
					{ value: "none", label: "none" },
				],
				get: () => io.readString(io.settings(), "doubleEscapeAction") || "fork (default)",
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.doubleEscapeAction = value;
					});
					return `double-escape → ${value}`;
				},
			},
			{
				id: "core:quiet-startup",
				label: "Quiet startup",
				detail: "Suppress the changelog banner at startup.",
				effect: "next start",
				owner: "pi core · /settings",
				kind: "toggle",
				get: () => (io.settings().quietStartup === true ? "on" : "off"),
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.quietStartup = value === "on";
					});
					return `quiet startup ${value}`;
				},
			},
			{
				id: "core:thinking-blocks",
				label: "Show thinking blocks",
				detail: "Render the model's thinking output in the transcript.",
				effect: "next start",
				owner: "pi core · /settings",
				kind: "toggle",
				get: () => (io.settings().hideThinkingBlock === true ? "off" : "on"),
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.hideThinkingBlock = value !== "on";
					});
					return `thinking blocks ${value}`;
				},
			},
			{
				id: "core:skill-commands",
				label: "Skill commands",
				detail: "Expose skills as /skill:name slash commands in autocomplete.",
				effect: "next start",
				owner: "pi core · /settings",
				kind: "toggle",
				get: () => (io.settings().enableSkillCommands === false ? "off" : "on"),
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.enableSkillCommands = value === "on";
					});
					return `skill commands ${value}`;
				},
			},
			{
				id: "core:http-idle",
				label: "HTTP idle timeout (ms)",
				detail: "Undici dispatcher idle timeout for provider requests. Raise it if long thinking turns drop the connection.",
				effect: "next start",
				owner: "pi core · /settings",
				kind: "number",
				min: 1000,
				max: 600000,
				get: () => {
					const t = io.readNumber(io.settings(), "httpIdleTimeoutMs");
					return typeof t === "number" ? `${t} ms` : "(pi default)";
				},
				apply: async (_c, value) => {
					io.updateSettings((set) => {
						set.httpIdleTimeoutMs = Number(value);
					});
					return `http idle timeout → ${value} ms`;
				},
			},
		],
	};
}

// ─── Packages & plugins ─────────────────────────────────────────────────────

interface InstalledPlugin {
	marketplace?: string;
	path?: string;
	enabled?: boolean;
	installedAt?: string;
}

function packageSection(): SetupSection {
	const s = io.settings();
	const raw = Array.isArray(s.packages) ? (s.packages as unknown[]) : [];
	const items: SetupItem[] = raw.map((entry, i) => {
		const spec = typeof entry === "string" ? entry : ((entry as { source?: string }).source ?? JSON.stringify(entry));
		return {
			id: `package:${i}`,
			label: spec,
			detail: "pi package (npm/git) loaded at startup. Removing it stops its extensions/skills/themes from loading.",
			effect: "next start",
			owner: "pi core packages",
			kind: "info",
			removable: true,
			get: () => "installed",
			apply: async (_c, value) => {
				io.updateSettings((set) => {
					set.packages = (Array.isArray(set.packages) ? (set.packages as unknown[]) : []).filter(
						(_, j) => j !== i,
					);
				});
				return `removed package ${spec}`;
			},
		};
	});
	items.push({
		id: "package:add",
		label: "+ Add package",
		detail: "npm spec, git URL, or local path — e.g. npm:owner/pkg@1.0.0 or git:github.com/user/repo@v1.",
		effect: "next start",
		owner: "pi core packages",
		kind: "text",
		placeholder: "npm:owner/package",
		get: () => "(spec)",
		apply: async (_c, value) => {
			const spec = value.trim();
			if (!spec) return "✗ empty package spec";
			io.updateSettings((set) => {
				set.packages = [...(Array.isArray(set.packages) ? (set.packages as unknown[]) : []), spec];
			});
			return `added package ${spec} (restart to load)`;
		},
	});

	const plugins = io.readJson<{ installed?: Record<string, InstalledPlugin> }>(io.PLUGINS_PATH)?.installed ?? {};
	for (const [name, p] of Object.entries(plugins)) {
		items.push({
			id: `plugin:${name}`,
			label: name,
			detail: `Plugin from marketplace "${p.marketplace ?? "?"}". Disabled plugins don't load their skills/commands.`,
			effect: "next start",
			owner: "plugins · /plugins",
			kind: "toggle",
			get: () => (p.enabled === false ? "disabled" : "enabled"),
			apply: async (_c, value) => {
				const state = io.readJson<{ installed?: Record<string, InstalledPlugin> }>(io.PLUGINS_PATH);
				if (!state?.installed?.[name]) return `✗ plugin ${name} not found`;
				state.installed[name].enabled = value === "on";
				writeFileSync(io.PLUGINS_PATH, JSON.stringify(state, null, 2) + "\n");
				return `plugin ${name} ${value === "on" ? "enabled" : "disabled"}`;
			},
		});
	}

	return {
		id: "packages",
		title: "Packages",
		detail: "Installed pi packages and plugins.",
		items,
	};
}

// ─── Commands cheat sheet ───────────────────────────────────────────────────

function commandsSection(pi: ExtensionAPI): SetupSection {
	let commands: { name: string; description?: string; source: string }[] = [];
	try {
		commands = pi
			.getCommands()
			.map((c) => ({ name: c.name, description: c.description, source: String(c.source) }));
	} catch (error) {
		process.stderr.write(`[setup] command listing failed: ${error instanceof Error ? error.message : error}\n`);
	}
	const sorted = [...commands].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
	return {
		id: "commands",
		title: "Commands",
		detail: "Every slash command in this session — built-in and from extensions.",
		items: sorted.map((c) => ({
			id: `cmd:${c.name}`,
			label: `/${c.name}`,
			detail: c.description || "(no description)",
			owner: c.source,
			kind: "info",
			get: () => "",
		})),
	};
}

// ─── Rules (TTSR) ───────────────────────────────────────────────────────────

interface RuleFrontmatter {
	name?: string;
	condition?: string[];
	astCondition?: string[];
	scope?: string[];
}

function parseRuleFrontmatter(path: string): RuleFrontmatter & { body: string } {
	try {
		const content = readFileSync(path, "utf8");
		const fm = content.match(/^---\n([\s\S]*?)\n---/);
		const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
		if (!fm) return { body };
		const yaml = fm[1];
		const get = (key: string): string[] | undefined => {
			const m = yaml.match(new RegExp(`^${key}:\\s*\\[(.*)\\]`, "m"));
			return m ? m[1].split(",").map((x) => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean) : undefined;
		};
		const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
		return { name, condition: get("condition"), astCondition: get("astCondition"), scope: get("scope"), body };
	} catch (error) {
		process.stderr.write(`[setup] rule parse failed for ${path}: ${error instanceof Error ? error.message : error}\n`);
		return { body: "" };
	}
}

function listRuleFiles(dir: string): string[] {
	try {
		return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f)) : [];
	} catch (error) {
		process.stderr.write(`[setup] rule listing failed: ${error instanceof Error ? error.message : error}\n`);
		return [];
	}
}

function rulesSection(): SetupSection {
	const paths = [...listRuleFiles(io.RULES_DIR), ...listRuleFiles(io.PROJECT_RULES_DIR)];
	return {
		id: "rules",
		title: "Rules",
		detail: "TTSR stream rules — dormant until model output matches their trigger, then they abort + remind.",
		items: paths.map((p) => {
			const rule = parseRuleFrontmatter(p);
			const triggers = [...(rule.condition ?? []), ...(rule.astCondition ?? [])];
			return {
				id: `rule:${p}`,
				label: rule.name ?? p.split("/").pop() ?? p,
				detail: [
					triggers.length ? `Triggers on: ${triggers.join(" | ")}` : "(rulebook rule — description-only)",
					rule.scope?.length ? `Scope: ${rule.scope.join(", ")}` : "Scope: text, thinking, tool",
					rule.body ? `“${rule.body.slice(0, 400)}${rule.body.length > 400 ? "…" : ""}”` : "",
					`File: ${p}`,
				]
					.filter(Boolean)
					.join("\n"),
				owner: "ttsr · /ttsr, /ttsr-reload",
				kind: "info",
				get: () => (rule.scope?.length ? rule.scope.join(",") : "armed"),
			};
		}),
	};
}

// ─── MCP servers ────────────────────────────────────────────────────────────

interface McpServerDef {
	type?: string;
	command?: string;
	url?: string;
	args?: string[];
	env?: Record<string, string>;
}

function mcpSection(): SetupSection {
	const servers =
		io.readJson<{ mcpServers?: Record<string, McpServerDef> }>(io.MCP_PATH)?.mcpServers ?? {};
	return {
		id: "mcp",
		title: "MCP",
		detail: "Configured MCP servers (mcp.json).",
		items: Object.entries(servers).map(([name, def]) => ({
			id: `mcp:${name}`,
			label: name,
			detail: [
				def.command ? `Command: ${def.command}${def.args?.length ? " " + def.args.join(" ") : ""}` : "",
				def.url ? `URL: ${def.url}` : "",
				def.env ? `Env keys: ${Object.keys(def.env).join(", ")}` : "",
				"Edit mcp.json to change; /mcp manages servers.",
			]
				.filter(Boolean)
				.join("\n"),
			owner: "pi core MCP · /mcp",
			kind: "info",
			get: () => def.type ?? "stdio",
		})),
	};
}

// ─── Skills ─────────────────────────────────────────────────────────────────

const SKILL_FILE = "SKILL.md";
const DISABLED_SUFFIX = ".disabled";

interface SkillEntry {
	name: string;
	file: string;
	root: string;
	enabled: boolean;
}

function isDirectoryEntry(dir: string, entry: Dirent): boolean {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return statSync(join(dir, entry.name)).isDirectory();
	} catch {
		return false;
	}
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** jev-memory keys project stores by cwd basename, or by repo-root name once a .git exists. */
function projectStoreNames(cwd: string): string[] {
	const names = new Set<string>([basename(cwd)]);
	let dir = cwd;
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(dir, ".git"))) {
			names.add(basename(dir));
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return [...names].filter(Boolean);
}

function skillRoots(): { label: string; dir: string }[] {
	const home = homedir();
	const cwd = process.cwd();
	const roots = [
		{ label: "user", dir: join(home, ".pi", "agent", "skills") },
		{ label: "project", dir: join(cwd, ".pi", "skills") },
		{ label: "user · agents", dir: join(home, ".agents", "skills") },
		{ label: "project · agents", dir: join(cwd, ".agents", "skills") },
		{ label: "user · claude", dir: join(home, ".claude", "skills") },
		{ label: "project · claude", dir: join(cwd, ".claude", "skills") },
		{ label: "user · memory", dir: join(home, ".pi", "agent", "jev-memory", "skills") },
	];
	for (const name of projectStoreNames(cwd)) {
		roots.push({
			label: `project · memory (${name})`,
			dir: join(home, ".pi", "agent", "projects-memory", name, "skills"),
		});
	}
	return roots;
}

/** Mirrors pi's loader: a dir holding SKILL.md is one skill (no recursion); otherwise walk subdirs and take root-level .md files. */
function scanSkillRoot(dir: string, root: string, out: SkillEntry[], seen: Set<string>, depth = 0): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	const enabledFile = entries.find((e) => e.name === SKILL_FILE);
	const disabledFile = entries.find((e) => e.name === `${SKILL_FILE}${DISABLED_SUFFIX}`);
	if (enabledFile || disabledFile) {
		const key = canonicalPath(dir);
		if (!seen.has(key)) {
			seen.add(key);
			out.push({
				name: basename(dir),
				file: join(dir, enabledFile ? SKILL_FILE : `${SKILL_FILE}${DISABLED_SUFFIX}`),
				root,
				enabled: Boolean(enabledFile),
			});
		}
		return;
	}

	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (isDirectoryEntry(dir, entry)) {
			if (depth < 8) scanSkillRoot(full, root, out, seen, depth + 1);
			continue;
		}
		if (depth > 0) continue;
		const enabled = entry.name.endsWith(".md");
		const name = enabled
			? entry.name.slice(0, -".md".length)
			: entry.name.endsWith(`.md${DISABLED_SUFFIX}`)
				? entry.name.slice(0, -(`.md${DISABLED_SUFFIX}`).length)
				: "";
		if (!name) continue;
		const key = canonicalPath(full);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name, file: full, root, enabled });
	}
}

function skillFrontmatter(file: string): { name?: string; description?: string } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return {};
	}
	const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fm) return {};
	const yaml = fm[1];
	const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, "");
	const name = yaml.match(/^name:\s*(.+)$/m)?.[1];
	const descLine = yaml.match(/^description:\s*(.*)$/m);
	let description: string | undefined;
	if (descLine) {
		const inline = descLine[1].trim();
		if (/^[>|][+-]?$/.test(inline)) {
			const tail = yaml.slice(yaml.indexOf(descLine[0]) + descLine[0].length).split(/\r?\n/);
			const parts: string[] = [];
			for (const line of tail) {
				if (!line.trim()) continue;
				if (!/^\s+\S/.test(line)) break;
				parts.push(line.trim());
			}
			description = parts.join(" ");
		} else if (inline) {
			description = unquote(inline);
		}
	}
	return { name: name ? unquote(name) : undefined, description };
}

function skillItem(entry: SkillEntry, disambiguate: boolean): SetupItem {
	const meta = skillFrontmatter(entry.file);
	const name = meta.name?.trim() || entry.name;
	const baseFile = entry.file.endsWith(DISABLED_SUFFIX) ? entry.file.slice(0, -DISABLED_SUFFIX.length) : entry.file;
	const disabledFile = `${baseFile}${DISABLED_SUFFIX}`;
	return {
		id: `skill:${baseFile}`,
		label: disambiguate ? `${name} · ${entry.root}` : name,
		detail: [
			meta.description || "(no description — pi does not load a skill without one)",
			`Source: ${entry.root}`,
			`File: ${entry.file}`,
			entry.enabled
				? `Enabled — loaded at startup and available as /skill:${name}.`
				: `Disabled — renamed to ${basename(entry.file)}; pi skips this directory at startup.`,
		]
			.join("\n"),
		effect: "next start · /reload",
		owner: `skills · /skill:${name}`,
		kind: "toggle",
		get: () => (entry.enabled ? "on" : "off"),
		apply: async (_ctx, value) => {
			const enable = value === "on";
			const from = enable ? disabledFile : baseFile;
			const to = enable ? baseFile : disabledFile;
			if (!existsSync(from)) return `✗ ${name}: ${from} not found`;
			try {
				renameSync(from, to);
			} catch (error) {
				return `✗ ${name}: ${error instanceof Error ? error.message : String(error)}`;
			}
			return `skill ${name} ${enable ? "enabled" : "disabled"}`;
		},
	};
}

function skillsSection(): SetupSection {
	const entries: SkillEntry[] = [];
	const seen = new Set<string>();
	for (const root of skillRoots()) scanSkillRoot(root.dir, root.label, entries, seen);
	entries.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
	const counts = new Map<string, number>();
	for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
	return {
		id: "skills",
		title: "Skills",
		detail:
			"Every discovered skill. Toggling off renames SKILL.md to SKILL.md.disabled so pi skips it at startup; toggling on restores it. Package/plugin skills are enabled per plugin in Packages.",
		items: entries.map((entry) => skillItem(entry, (counts.get(entry.name) ?? 0) > 1)),
	};
}

// ─── Export ─────────────────────────────────────────────────────────────────

export function builtinSections(pi: ExtensionAPI, ctx: ExtensionCommandContext): SetupSection[] {
	return [
		...modelSections(pi, ctx),
		rolesSection(),
		routerSection(),
		fallbackSection(),
		guardrailsSection(),
		appearanceSection(),
		coreSection(),
		packageSection(),
		commandsSection(pi),
		rulesSection(),
		skillsSection(),
		mcpSection(),
	];
}
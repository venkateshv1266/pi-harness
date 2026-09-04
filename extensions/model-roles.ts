import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FilterablePicker, THINKING_LEVELS, type PickerRow } from "./model-fallback.ts";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const ROLES = ["smolModel", "slowModel", "planModel", "taskModel", "designerModel"] as const;

const ROLE_DESCRIPTIONS: Record<(typeof ROLES)[number], string> = {
	smolModel: "cheap/fast — lightweight subagent work (@smol/@fast)",
	slowModel: "deep reasoning — hard analysis, verification (@slow/@reasoning)",
	planModel: "planning — decompose and sequence work (@plan)",
	taskModel: "general execution — implementation subagents (@task)",
	designerModel: "UI/UX and visual design work (@designer)",
};

function loadSettings(): Record<string, unknown> {
	return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
}

function writeRole(role: string, ref: string | null): void {
	const settings = loadSettings();
	if (ref === null) delete settings[role];
	else settings[role] = ref;
	writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

/** Splits "provider/model:thinking" → ref + optional thinking level. */
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

function resolveModel(ctx: ExtensionContext, ref: string): Model<Api> | undefined {
	const slash = ref.indexOf("/");
	if (slash > 0) {
		const found = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (found) return found;
	}
	const avail = ctx.modelRegistry.getAvailable();
	return avail.find((m) => m.id === ref) ?? avail.find((m) => m.id.includes(ref));
}

function keyOf(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "warning") {
	if (ctx.hasUI) {
		ctx.ui.notify(text, level);
	} else {
		process.stderr.write(`[model-roles] ${text}\n`);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("roles", {
		description: "Set model roles (smol/slow/plan/task/designer) — /roles [role] [model:thinking] or interactive",
		handler: async (args, ctx) => {
			const [first, second] = args.trim().split(/\s+/).filter(Boolean);

			if (first === "clear") {
				await clearRole(ctx, second);
				return;
			}

			const role = first ? validateRole(ctx, first) : undefined;
			if (first && !role) return;

			if (role && second) {
				await setDirect(ctx, role, second);
				return;
			}

			await runInteractive(ctx, role);
		},
	});

	function validateRole(ctx: ExtensionContext, name: string): string | undefined {
		const role = (ROLES as readonly string[]).find((r) => r.toLowerCase() === name.toLowerCase());
		if (!role) notify(ctx, `Unknown role "${name}". Roles: ${ROLES.join(", ")}`, "error");
		return role;
	}

	async function setDirect(ctx: ExtensionContext, role: string, refArg: string): Promise<void> {
		const { ref, thinking } = parseRef(refArg);
		const model = resolveModel(ctx, ref);
		if (!model) {
			notify(ctx, `Model "${ref}" not found in registry`, "error");
			return;
		}
		const value = keyOf(model) + (thinking ? `:${thinking}` : "");
		writeRole(role, value);
		notify(ctx, `Set ${role} = ${value}`, "info");
	}

	async function clearRole(ctx: ExtensionContext, name?: string): Promise<void> {
		const settings = loadSettings();
		const configured = ROLES.filter((r) => typeof settings[r] === "string");
		if (configured.length === 0) {
			notify(ctx, "No roles configured", "info");
			return;
		}
		const role = name ? validateRole(ctx, name) : await ctx.ui.select("Clear which role:", configured);
		if (!role) return;
		if (!configured.includes(role as (typeof ROLES)[number])) {
			notify(ctx, `${role} is not configured`, "error");
			return;
		}
		writeRole(role, null);
		notify(ctx, `Cleared ${role}`, "info");
	}

	async function runInteractive(ctx: ExtensionContext, roleArg?: string): Promise<void> {
		const settings = loadSettings();

		let role = roleArg;
		if (!role) {
			const rows: PickerRow[] = ROLES.map((r) => ({
				label: `@${r.replace(/Model$/, "")}`,
				meta: typeof settings[r] === "string" ? String(settings[r]) : "(unset)",
				description: ROLE_DESCRIPTIONS[r],
			}));
			const picked = await pick(ctx, "Pick model role:", rows);
			if (!picked) return;
			role = (ROLES as readonly string[]).find((r) => `@${r.replace(/Model$/, "")}` === picked.label) ?? "";
			if (!role) return;
		}

		const model = await pickModel(ctx, `Model for ${role}:`);
		if (!model) return;

		let suffix = "";
		if (ctx.mode === "tui") {
			const levels = ["(none)", ...THINKING_LEVELS];
			const choice = await ctx.ui.select("Thinking level:", levels);
			if (!choice) return;
			suffix = choice !== "(none)" ? `:${choice}` : "";
		}

		const value = `${keyOf(model)}${suffix}`;
		writeRole(role, value);
		notify(ctx, `Set ${role} = ${value}\nRestart pi (or /reload) for it to take effect.`, "info");
	}
}

async function pick(ctx: ExtensionContext, title: string, rows: PickerRow[]): Promise<PickerRow | undefined> {
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

async function pickModel(ctx: ExtensionContext, title: string): Promise<Model<Api> | undefined> {
	const rows: PickerRow[] = ctx.modelRegistry.getAvailable().map((m) => ({
		label: keyOf(m),
		meta: m.reasoning ? "reasoning" : "",
		description: `${m.name} · ctx ${Math.round(m.contextWindow / 1000)}k`,
	}));
	const picked = await pick(ctx, title, rows);
	return picked ? resolveModel(ctx, picked.label) : undefined;
}

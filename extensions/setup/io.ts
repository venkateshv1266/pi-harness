import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
export const THEMES_DIR = join(homedir(), ".pi", "agent", "themes");
export const PLUGINS_PATH = join(homedir(), ".pi", "agent", "plugins.json");
export const MCP_PATH = join(homedir(), ".pi", "agent", "mcp-servers.json");
export const RULES_DIR = join(homedir(), ".pi", "agent", "rules");
export const PROJECT_RULES_DIR = join(process.cwd(), ".pi", "rules");

export const THINKING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function readJson<T>(path: string): T | undefined {
	try {
		return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
	} catch (error) {
		process.stderr.write(`[setup] failed to parse ${path}: ${error instanceof Error ? error.message : error}\n`);
		return undefined;
	}
}

export function settings(): Record<string, unknown> {
	return readJson<Record<string, unknown>>(SETTINGS_PATH) ?? {};
}

/** Read-merge-write so concurrent extension writes (router, roles, fallback) never clobber. */
export function updateSettings(mutate: (s: Record<string, unknown>) => void): void {
	const s = readJson<Record<string, unknown>>(SETTINGS_PATH) ?? {};
	mutate(s);
	writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n");
}

export function readString(s: Record<string, unknown>, key: string): string {
	const v = s[key];
	return typeof v === "string" ? v : "";
}

export function readNumber(s: Record<string, unknown>, key: string): number | undefined {
	const v = s[key];
	return typeof v === "number" ? v : undefined;
}

/** "provider/model:thinking" → { ref, thinking? } — mirrors the convention in model-roles/model-fallback. */
export function parseRef(ref: string): { ref: string; thinking?: ThinkingLevel } {
	const colon = ref.lastIndexOf(":");
	if (colon > 0) {
		const suffix = ref.slice(colon + 1);
		if ((THINKING_LEVELS as string[]).includes(suffix)) {
			return { ref: ref.slice(0, colon), thinking: suffix as ThinkingLevel };
		}
	}
	return { ref };
}

export function availableModels(ctx: ExtensionCommandContext): Model<never>[] {
	try {
		return ctx.modelRegistry.getAvailable() as unknown as Model<never>[];
	} catch (error) {
		process.stderr.write(`[setup] model registry unavailable: ${error instanceof Error ? error.message : error}\n`);
		return [];
	}
}

export function resolveModel(ctx: ExtensionCommandContext, ref: string): Model<never> | undefined {
	const slash = ref.indexOf("/");
	if (slash > 0) {
		const found = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1)) as unknown as
			| Model<never>
			| undefined;
		if (found) return found;
	}
	const avail = availableModels(ctx);
	return avail.find((m) => m.id === ref) ?? avail.find((m) => m.id.includes(ref));
}

export function keyOf(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/** Display-only: drop the default provider prefix wherever it appears as a path token ("openrouter/z-ai/glm" → "z-ai/glm"). */
export function prettyRef(ref: string): string {
	if (!ref) return ref;
	const provider = readString(settings(), "defaultProvider");
	if (!provider) return ref;
	return ref.replace(new RegExp(`(?<![\\w-])${provider}/`, "g"), "");
}

export function availableThemes(): string[] {
	const names = new Set<string>(["dark", "light"]);
	try {
		for (const f of existsSync(THEMES_DIR) ? readdirSync(THEMES_DIR) : []) {
			if (f.endsWith(".json")) names.add(f.replace(/\.json$/, ""));
		}
	} catch (error) {
		// expected: theme dir unreadable — built-ins are still offered
		process.stderr.write(`[setup] theme listing failed: ${error instanceof Error ? error.message : error}\n`);
	}
	return [...names].sort();
}
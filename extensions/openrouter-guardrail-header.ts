import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const API_BASE = "https://openrouter.ai/api/v1";
const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

type KeyBudget = {
	byok_usage_daily?: number;
	byok_usage_monthly?: number;
	daily_limit?: number | null;
	limit?: number | null;
	limit_reset?: string | null;
	monthly_limit?: number | null;
	usage_daily?: number;
	usage_monthly?: number;
};

type BudgetLimits = {
	daily?: number;
	monthly?: number;
};

type HeaderState =
	| { status: "loading" }
	| { status: "unavailable"; message: string }
	| {
			status: "ready";
			daily: Budget;
			monthly: Budget;
		};

type Budget = {
		limit?: number;
		used: number;
};

type ApiError = {
	error?: { message?: string };
};

async function getJson<T>(url: string, apiKey: string): Promise<T> {
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(10_000),
	});

	if (!response.ok) {
		let message = response.statusText || `HTTP ${response.status}`;
		try {
			const body = (await response.json()) as ApiError;
			message = body.error?.message || message;
		} catch (error) {
			if (error instanceof Error && error.message) message = error.message;
		}
		throw new Error(`${response.status}: ${message}`);
	}

	return (await response.json()) as T;
}

function numberOrUndefined(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberOrZero(value: number | undefined): number {
	return numberOrUndefined(value) ?? 0;
}

function readBudgetLimits(): BudgetLimits {
	if (!fs.existsSync(SETTINGS_PATH)) return {};
	try {
		const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as {
			openrouterGuardrails?: {
				dailyLimit?: number;
				monthlyLimit?: number;
			};
		};
		const config = settings.openrouterGuardrails ?? {};
		return {
			daily: numberOrUndefined(config.dailyLimit),
			monthly: numberOrUndefined(config.monthlyLimit),
		};
	} catch (error) {
		console.error("[openrouter-guardrail-header] Invalid settings.json:", error);
		return {};
	}
}

function loadBudgetState(key: KeyBudget, configuredLimits: BudgetLimits): Extract<HeaderState, { status: "ready" }> {
	const dailyUsed = numberOrZero(key.usage_daily) + numberOrZero(key.byok_usage_daily);
	const monthlyUsed = numberOrZero(key.usage_monthly) + numberOrZero(key.byok_usage_monthly);
	const keyLimit = numberOrUndefined(key.limit);
	const reset = key.limit_reset?.toLowerCase();
	const dailyLimit = configuredLimits.daily ?? numberOrUndefined(key.daily_limit) ?? (reset === "daily" ? keyLimit : undefined);
	const monthlyLimit =
		configuredLimits.monthly ?? numberOrUndefined(key.monthly_limit) ?? (reset === "monthly" ? keyLimit : undefined);

	return {
		status: "ready",
		daily: { used: dailyUsed, limit: dailyLimit },
		monthly: { used: monthlyUsed, limit: monthlyLimit },
	};
}

function budgetColor(budget: Budget): ThemeColor {
	if (budget.limit === undefined || budget.limit <= 0) return "muted";
	const percentage = (budget.used / budget.limit) * 100;
	return percentage >= 90 ? "error" : percentage >= 75 ? "warning" : "success";
}

function formatBudget(label: string, budget: Budget, theme: Theme): string {
	const used = `$${budget.used.toFixed(2)}`;
	const limit = budget.limit === undefined ? "—" : `$${budget.limit.toFixed(2)}`;
	const percentage = budget.limit && budget.limit > 0 ? ` (${Math.round((budget.used / budget.limit) * 100)}%)` : "";
	return (
		theme.fg("muted", `${label}: `) +
		theme.fg(budgetColor(budget), `${used}/${limit}${percentage}`)
	);
}

function renderHeader(state: HeaderState, width: number, theme: Theme): string[] {
	let content: string;
	if (state.status === "loading") {
		content = theme.fg("muted", "◌ Guardrails: loading…");
	} else if (state.status === "unavailable") {
		content = theme.fg("warning", `⚠ Guardrails: ${state.message}`);
	} else {
		const left = theme.fg("accent", "💰 Guardrails  ") + formatBudget("D", state.daily, theme);
		const right = formatBudget("M", state.monthly, theme);
		const gap = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)));
		content = left + gap + right;
	}
	const line = truncateToWidth(content, width, "");
	const paddedLine = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	const background = theme.bg("toolPendingBg", " ".repeat(width));
	return [background, theme.bg("toolPendingBg", paddedLine), background];
}

async function getCurrentOpenRouterKey(ctx: ExtensionContext): Promise<string | undefined> {
	const auth = await ctx.modelRegistry.getProviderAuth("openrouter");
	return auth?.auth.apiKey;
}

export default function (pi: ExtensionAPI) {
	let cleanup = () => {};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		cleanup();

		let disposed = false;
		let state: HeaderState = { status: "loading" };
		let requestRender: (() => void) | undefined;
		let refreshInFlight = false;
		let timer: ReturnType<typeof setInterval> | undefined;

		let closeOverlay = () => {};
		void ctx.ui
			.custom<void>(
				(tui, theme, _keybindings, done) => {
					requestRender = () => tui.requestRender();
					closeOverlay = () => done(undefined);
					return {
						render: (width: number) => renderHeader(state, width, theme),
						invalidate() {},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-center",
						width: "100%",
						maxHeight: 3,
						margin: 0,
						nonCapturing: true,
					},
				},
			)
			.catch((error) => console.error("[openrouter-guardrail-header] Overlay closed with an error:", error));

		const refresh = async () => {
			if (disposed || refreshInFlight) return;
			refreshInFlight = true;
			try {
				const apiKey = await getCurrentOpenRouterKey(ctx);
				if (!apiKey) {
					state = { status: "unavailable", message: "current OpenRouter key unavailable" };
				} else {
					const keyResponse = await getJson<{ data?: KeyBudget }>(`${API_BASE}/key`, apiKey);
					if (!keyResponse.data) throw new Error("no budget data returned");

					state = loadBudgetState(keyResponse.data, readBudgetLimits());
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "request failed";
				state = { status: "unavailable", message };
			} finally {
				refreshInFlight = false;
				if (!disposed) requestRender?.();
			}
		};

		void refresh();
		timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
		cleanup = () => {
			disposed = true;
			if (timer) clearInterval(timer);
			closeOverlay();
			closeOverlay = () => {};
		};
	});

	pi.on("session_shutdown", async () => {
		cleanup();
		cleanup = () => {};
	});
}

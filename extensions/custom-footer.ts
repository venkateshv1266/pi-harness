/**
 * Custom Footer Extension — one-line guardrail footer + status strips on the
 * editor border rows.
 *
 * Footer:  (blank margin row)
 *          D: $used/$cap (pct%)                     M: $used/$cap (pct%)
 * Editor:  ╭─────────── 🤖 <model> (<thinking>) ─╮            (top border)
 *          │ <input>                               │            (side borders)
 *          ╰─ 🌿 <branch> ─────── <ctx%> (<max>) $<cost> ─╯    (bottom; 📁 <cwd> when not a git repo)
 *
 * Strips are non-capturing overlays, re-created whenever the editor's rendered
 * geometry changes (multi-line input, autocomplete height) and hidden while the
 * editor is not focused. Toggle everything with /footer.
 */

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const API_BASE = "https://openrouter.ai/api/v1";
const SETTINGS_PATH = nodePath.join(os.homedir(), ".pi", "agent", "settings.json");
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const BRANCH_STRIP_MIN = 9;
const USAGE_STRIP_MIN = 15;
const EDGE_STRIP_WIDTH = 1;
const FOOTER_ROWS = 2;

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

type Budget = {
	limit?: number;
	used: number;
};

type BudgetState =
	| { status: "loading" }
	| { status: "unavailable"; message: string }
	| { status: "ready"; daily: Budget; monthly: Budget };

type ApiError = {
	error?: { message?: string };
};

type EditorGeometry = { focused: boolean; rows: number; autocomplete: number };
type StripGeometry = EditorGeometry & { width: number; modelWidth: number; branchWidth: number; usageWidth: number };
type BranchLabel = { icon: string; text: string };

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

function numberOrUndefined(value?: number | null): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberOrZero(value?: number): number {
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
		console.error("[custom-footer] Invalid settings.json:", error);
		return {};
	}
}

function readEditorPaddingX(): number {
	if (!fs.existsSync(SETTINGS_PATH)) return 0;
	try {
		const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as { editorPaddingX?: number };
		const padding = settings.editorPaddingX;
		return typeof padding === "number" && Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
	} catch (error) {
		console.error("[custom-footer] Invalid settings.json:", error);
		return 0;
	}
}

function loadBudgetState(key: KeyBudget, configuredLimits: BudgetLimits): Extract<BudgetState, { status: "ready" }> {
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

async function getCurrentOpenRouterKey(ctx: ExtensionContext): Promise<string | undefined> {
	const auth = await ctx.modelRegistry.getProviderAuth("openrouter");
	return auth?.auth.apiKey;
}

function sessionCost(ctx: ExtensionContext): number {
	let cost = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			cost += (e.message as AssistantMessage).usage.cost.total;
		}
	}
	return cost;
}

function truncateMiddle(text: string, max: number): string {
	if (visibleWidth(text) <= max) return text;
	if (max <= 1) return "…";
	const keep = max - 1;
	const head = text.slice(0, Math.ceil(keep / 2));
	const tail = text.slice(text.length - Math.floor(keep / 2));
	return `${head}…${tail}`;
}

function thinkingBorder(theme: Theme, level: ExtensionContext["thinkingLevel"]): (s: string) => string {
	return theme.getThinkingBorderColor?.(level ?? "off") ?? ((s: string) => theme.fg("border", s));
}

function renderModelStrip(ctx: ExtensionContext, width: number, theme: Theme): string[] {
	const border = thinkingBorder(theme, ctx.thinkingLevel);
	const thinking = ctx.thinkingLevel ? ` (${ctx.thinkingLevel})` : "";
	const chrome = visibleWidth("─ ") + visibleWidth("🤖 ") + visibleWidth(thinking) + visibleWidth(" ─╮");
	const modelId = truncateMiddle(ctx.model?.id || "no-model", Math.max(4, width - chrome));
	const content = border("─ ") + theme.fg("text", `🤖 ${modelId}`) + theme.fg("dim", thinking) + border(" ─╮");
	const pad = border("─".repeat(Math.max(0, width - visibleWidth(content))));
	return [truncateToWidth(pad + content, width)];
}

function renderBranchStrip(label: BranchLabel, width: number, theme: Theme, level: ExtensionContext["thinkingLevel"]): string[] {
	const border = thinkingBorder(theme, level);
	const chrome = visibleWidth("─ ") + visibleWidth(`${label.icon} `) + visibleWidth(" ─");
	const name = truncateMiddle(label.text, Math.max(4, width - chrome));
	const content = border("─ ") + theme.fg("muted", `${label.icon} `) + theme.fg("success", name) + border(" ─");
	const pad = border("─".repeat(Math.max(0, width - visibleWidth(content))));
	return [truncateToWidth(content + pad, width)];
}

function fmtCtx(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(n / 1000)}k`;
}

function renderUsageStrip(ctx: ExtensionContext, width: number, theme: Theme): string[] {
	const border = thinkingBorder(theme, ctx.thinkingLevel);
	const usage = ctx.getContextUsage();
	const ctxMax = ctx.model?.contextWindow ?? 0;
	const pct = ctxMax > 0 ? Math.min(100, Math.round(((usage?.tokens ?? 0) / ctxMax) * 100)) : 0;
	const color: ThemeColor = pct >= 85 ? "error" : pct >= 60 ? "warning" : "muted";
	const pctText = theme.fg(color, `${pct}%`);
	const costText = theme.fg("warning", ` $${sessionCost(ctx).toFixed(3)}`);
	const full = border("─ ") + pctText + theme.fg("dim", ` (${fmtCtx(ctxMax)})`) + costText + border(" ─╯");
	const compact = border("─ ") + pctText + costText + border(" ─╯");
	const content = width >= visibleWidth(full) ? full : compact;
	const pad = border("─".repeat(Math.max(0, width - visibleWidth(content))));
	return [truncateToWidth(pad + content, width)];
}

function renderEdge(theme: Theme, level: ExtensionContext["thinkingLevel"], glyph: string, rows = 1): string[] {
	const line = thinkingBorder(theme, level)(glyph);
	return Array.from({ length: Math.max(1, rows) }, () => line);
}

function modelContentWidth(ctx: ExtensionContext): number {
	const thinking = ctx.thinkingLevel ? ` (${ctx.thinkingLevel})` : "";
	return (
		visibleWidth("─ ") +
		visibleWidth("🤖 ") +
		visibleWidth(ctx.model?.id || "no-model") +
		visibleWidth(thinking) +
		visibleWidth(" ─╮")
	);
}

function branchContentWidth(label: BranchLabel): number {
	return visibleWidth("─ ") + visibleWidth(`${label.icon} `) + visibleWidth(label.text) + visibleWidth(" ─");
}

function usageContentWidth(ctx: ExtensionContext, withMax: boolean): number {
	const usage = ctx.getContextUsage();
	const ctxMax = ctx.model?.contextWindow ?? 0;
	const pct = ctxMax > 0 ? Math.min(100, Math.round(((usage?.tokens ?? 0) / ctxMax) * 100)) : 0;
	const maxPart = withMax ? visibleWidth(` (${fmtCtx(ctxMax)})`) : 0;
	return (
		visibleWidth("─ ") +
		visibleWidth(`${pct}%`) +
		maxPart +
		visibleWidth(` $${sessionCost(ctx).toFixed(3)}`) +
		visibleWidth(" ─╯")
	);
}

function stripWidths(ctx: ExtensionContext, label: BranchLabel, width: number): { model: number; branch: number; usage: number } {
	const available = Math.max(0, width - 1);
	const thinking = ctx.thinkingLevel ? ` (${ctx.thinkingLevel})` : "";
	const modelMin = visibleWidth("─ ") + visibleWidth("🤖 ") + visibleWidth(thinking) + visibleWidth(" ─╮") + 4;
	const model = available < modelMin ? 0 : Math.min(modelContentWidth(ctx), available);
	let branchWidth = Math.min(branchContentWidth(label), available);
	let usage = Math.min(usageContentWidth(ctx, true), available);
	if (branchWidth + usage > available) usage = Math.min(usage, usageContentWidth(ctx, false));
	if (branchWidth + usage > available) {
		const over = branchWidth + usage - available;
		const usageCut = Math.min(over, Math.max(0, usage - USAGE_STRIP_MIN));
		usage -= usageCut;
		branchWidth -= Math.min(over - usageCut, Math.max(0, branchWidth - BRANCH_STRIP_MIN));
	}
	if (branchWidth + usage > available) branchWidth = 0;
	if (usage < USAGE_STRIP_MIN) usage = 0;
	if (branchWidth < BRANCH_STRIP_MIN) branchWidth = 0;
	return { model, branch: branchWidth, usage };
}

function editorGeometry(tui: TUI): EditorGeometry {
	const editor = (
		tui as unknown as {
			focusedComponent?: { renderedVisibleLineCount?: number; renderedAutocompleteHeight?: number };
		}
	).focusedComponent;
	const rows = editor?.renderedVisibleLineCount;
	if (typeof rows !== "number" || rows < 1) return { focused: false, rows: 1, autocomplete: 0 };
	const autocomplete = editor?.renderedAutocompleteHeight;
	return {
		focused: true,
		rows,
		autocomplete: typeof autocomplete === "number" && autocomplete > 0 ? autocomplete : 0,
	};
}

function installStatusStrips(
	ctx: ExtensionContext,
	getLabel: () => BranchLabel,
	showSides: boolean,
): { tick: (tui: TUI, width: number) => void; dispose: () => void } {
	let disposed = false;
	let focused = true;
	let builtKey: string | undefined;
	let handles: OverlayHandle[] = [];
	let scheduled = false;
	let pending: StripGeometry | undefined;

	const addStrip = (render: (width: number, theme: Theme) => string[], options: OverlayOptions) => {
		void ctx.ui
			.custom<void>(
				(_tui, theme, _keybindings, _done) => ({
					render: (width: number) => render(width, theme),
					invalidate() {},
				}),
				{
					overlay: true,
					overlayOptions: options,
					onHandle: (handle) => {
						handles.push(handle);
						if (!focused) handle.hide();
					},
				},
			)
			.catch((error) => console.error("[custom-footer] strip overlay closed:", error));
	};

	const create = (geometry: StripGeometry) => {
		const bottom = -(FOOTER_ROWS + geometry.autocomplete);
		const top = -(FOOTER_ROWS + 1 + geometry.autocomplete + geometry.rows);
		const shared = {
			margin: 0,
			nonCapturing: true,
		};
		addStrip((_w, t) => renderEdge(t, ctx.thinkingLevel, "╭"), {
			...shared,
			anchor: "bottom-left",
			offsetY: top,
			offsetX: 0,
			width: EDGE_STRIP_WIDTH,
		});
		addStrip((_w, t) => renderEdge(t, ctx.thinkingLevel, "╰"), {
			...shared,
			anchor: "bottom-left",
			offsetY: bottom,
			offsetX: 0,
			width: EDGE_STRIP_WIDTH,
		});
		if (showSides) {
			addStrip((_w, t) => renderEdge(t, ctx.thinkingLevel, "│", geometry.rows), {
				...shared,
				anchor: "bottom-left",
				offsetY: bottom - 1,
				offsetX: 0,
				width: EDGE_STRIP_WIDTH,
			});
			addStrip((_w, t) => renderEdge(t, ctx.thinkingLevel, "│", geometry.rows), {
				...shared,
				anchor: "bottom-right",
				offsetY: bottom - 1,
				offsetX: 0,
				width: EDGE_STRIP_WIDTH,
			});
		}
		if (geometry.modelWidth > 0) {
			addStrip((w, t) => renderModelStrip(ctx, w, t), {
				...shared,
				anchor: "bottom-right",
				offsetY: top,
				offsetX: 0,
				width: geometry.modelWidth,
			});
		}
		if (geometry.branchWidth > 0) {
			addStrip((w, t) => renderBranchStrip(getLabel(), w, t, ctx.thinkingLevel), {
				...shared,
				anchor: "bottom-left",
				offsetY: bottom,
				offsetX: 1,
				width: geometry.branchWidth,
			});
		}
		if (geometry.usageWidth > 0) {
			addStrip((w, t) => renderUsageStrip(ctx, w, t), {
				...shared,
				anchor: "bottom-right",
				offsetY: bottom,
				offsetX: 0,
				width: geometry.usageWidth,
			});
		}
	};

	const rebuild = (geometry: StripGeometry) => {
		if (disposed) return;
		for (const handle of handles) handle.hide();
		handles = [];
		if (!focused) {
			builtKey = undefined;
			return;
		}
		create(geometry);
	};

	const tick = (tui: TUI, width: number) => {
		if (disposed) return;
		const base = editorGeometry(tui);
		if (base.focused !== focused) {
			focused = base.focused;
			if (!focused) {
				// hidden-but-stacked strips make hideOverlay() pop the wrong entry for overlays opened later
				for (const handle of handles) handle.hide();
				handles = [];
				builtKey = undefined;
			}
		}
		if (!base.focused) return;
		const effectiveWidth = Math.max(1, Math.floor(width));
		const widths = stripWidths(ctx, getLabel(), effectiveWidth);
		const geometry: StripGeometry = {
			...base,
			width: effectiveWidth,
			modelWidth: widths.model,
			branchWidth: widths.branch,
			usageWidth: widths.usage,
		};
		const key = [
			geometry.rows,
			geometry.autocomplete,
			geometry.width,
			geometry.modelWidth,
			geometry.branchWidth,
			geometry.usageWidth,
		].join(":");
		if (key === builtKey) return;
		builtKey = key;
		pending = geometry;
		if (scheduled) return;
		scheduled = true;
		setTimeout(() => {
			scheduled = false;
			const next = pending;
			pending = undefined;
			if (next) rebuild(next);
		}, 0);
	};

	return {
		tick,
		dispose: () => {
			disposed = true;
			for (const handle of handles) handle.hide();
			handles = [];
		},
	};
}

function installFooter(ctx: ExtensionContext): () => void {
	let disposed = false;
	let refreshInFlight = false;
	let state: BudgetState = { status: "loading" };
	let requestRender: (() => void) | undefined;
	let readBranchLabel = () => ({ icon: "📁", text: nodePath.basename(process.cwd()) });

	const strips = installStatusStrips(ctx, () => readBranchLabel(), readEditorPaddingX() >= 1);

	ctx.ui.setFooter((tui, theme, footerData) => {
		readBranchLabel = () => {
			const branch = footerData.getGitBranch();
			return branch ? { icon: "🌿", text: branch } : { icon: "📁", text: nodePath.basename(process.cwd()) };
		};
		const unsub = footerData.onBranchChange(() => tui.requestRender());
		requestRender = () => tui.requestRender();

		return {
			dispose: () => {
				unsub();
				requestRender = undefined;
			},
			invalidate() {},
			render(width: number): string[] {
				strips.tick(tui, width);

				let left: string;
				let right = "";
				if (state.status === "loading") {
					left = theme.fg("muted", "◌ Guardrails: loading…");
				} else if (state.status === "unavailable") {
					left = theme.fg("warning", `⚠ Guardrails: ${state.message}`);
				} else {
					left = formatBudget("D", state.daily, theme);
					right = formatBudget("M", state.monthly, theme);
				}

				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
				return ["", truncateToWidth(left + pad + right, width)];
			},
		};
	});

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
	const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
	return () => {
		disposed = true;
		clearInterval(timer);
		strips.dispose();
	};
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let cleanupRefresh: (() => void) | undefined;

	// Auto-enable on every session start (new, resume, fork, reload).
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		cleanupRefresh?.();
		cleanupRefresh = undefined;
		if (enabled) cleanupRefresh = installFooter(ctx);
	});

	pi.on("session_shutdown", async () => {
		cleanupRefresh?.();
		cleanupRefresh = undefined;
	});

	pi.registerCommand("footer", {
		description: "Toggle custom footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;

			if (enabled) {
				cleanupRefresh?.();
				cleanupRefresh = installFooter(ctx);
				ctx.ui.notify("Custom footer enabled", "info");
			} else {
				cleanupRefresh?.();
				cleanupRefresh = undefined;
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}

/**
 * Custom Footer Extension — two-line colourful status bar, enabled by default.
 *
 * Line 1: 📁 <cwd>  🌿 <branch>            (directory + git branch)
 * Line 2: 🛡 <gate-mode> %ctx (max) $cost   <model>   (permission mode + context + cost + model)
 *
 * Auto-enabled on session start. Toggle with /footer.
 */

import nodePath from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function installFooter(ctx: ExtensionContext) {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsub = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsub,
			invalidate() {},
			render(width: number): string[] {
				// --- session cost total ---
				let cost = 0;
				for (const e of ctx.sessionManager.getBranch()) {
					if (e.type === "message" && e.message.role === "assistant") {
						cost += (e.message as AssistantMessage).usage.cost.total;
					}
				}

				const branch = footerData.getGitBranch();
				const cwdName = nodePath.basename(process.cwd());
				const fmtCtx = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(n / 1000)}k`);

				// --- context-window usage ---
				const ctxUsage = ctx.getContextUsage();
				const ctxTokens = ctxUsage?.tokens ?? 0;
				const ctxMax = ctx.model?.contextWindow ?? 0;
				const ctxPct = ctxMax > 0 ? Math.min(100, Math.round((ctxTokens / ctxMax) * 100)) : 0;
				const ctxColor: ThemeColor = ctxPct >= 85 ? "error" : ctxPct >= 60 ? "warning" : "thinkingLow";

				// --- Line 1: directory + git branch ---
				const dirLabel = theme.fg("accent", "📁 ");
				const dirText = theme.fg("mdLink", cwdName);
				const branchPart = branch
					? theme.fg("muted", "  🌿 ") + theme.fg("success", branch)
					: theme.fg("dim", "  🌿 -");
				const line1Left = dirLabel + dirText + branchPart;

				// --- permission gate mode (published by permission-gate.ts) ---
				const gateMode = ((globalThis as Record<string, unknown>).__permissionGateMode as string) ?? "auto";
				const gateColor: ThemeColor = gateMode === "auto" ? "success" : gateMode === "ask" ? "warning" : "dim";

				// --- Line 2: gate mode + context/cost stats + model ---
				const stats =
					theme.fg(gateColor, `🛡 ${gateMode}`) +
					theme.fg("dim", " ") +
					theme.fg(ctxColor, `${ctxPct}%`) +
					theme.fg("dim", ` (${fmtCtx(ctxMax)})`) +
					theme.fg("dim", " ") +
					theme.fg("warning", `$${cost.toFixed(3)}`);
				const modelText = theme.fg("mdHeading", `🤖 ${ctx.model?.id || "no-model"}`);

				const pad1 = " ".repeat(Math.max(1, width - visibleWidth(line1Left)));
				const pad2 = " ".repeat(Math.max(1, width - visibleWidth(stats) - visibleWidth(modelText)));

				return [
					truncateToWidth(line1Left + pad1, width),
					truncateToWidth(stats + pad2 + modelText, width),
				];
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	// Auto-enable on every session start (new, resume, fork, reload).
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (enabled) installFooter(ctx);
	});

	pi.registerCommand("footer", {
		description: "Toggle custom footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;

			if (enabled) {
				installFooter(ctx);
				ctx.ui.notify("Custom footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}

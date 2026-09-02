/**
 * Vendored symbol vocabulary (omp `modes/theme/symbols.ts` UNICODE preset subset).
 *
 * Earendil's public `Theme` only exposes `fg/bg/bold/...`; it has no
 * `boxRound`/`tree`/`sep`/`status`/`icon`/`format`/`styledSymbol`/`spinnerFrames`.
 * This module provides those glyphs as plain constants plus a `styledSymbol`
 * helper that colors a glyph via the earendil theme's `fg`.
 */

export type ThemeColor =
	| "accent" | "border" | "borderAccent" | "borderMuted" | "success" | "error"
	| "warning" | "muted" | "dim" | "text" | "toolTitle" | "toolOutput";

/** Minimal theme surface this module needs (earendil `Theme` satisfies it). */
export interface ThemeLike {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
	getBgAnsi(color: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg"): string;
}

interface BoxRound {
	topLeft: string; topRight: string; bottomLeft: string; bottomRight: string;
	horizontal: string; vertical: string;
	cross: string; teeDown: string; teeUp: string; teeRight: string; teeLeft: string;
}
interface Tree { branch: string; last: string; vertical: string; horizontal: string; hook: string; }
interface Sep { dot: string; slash: string; pipe: string; space: string; }
interface Status {
	success: string; error: string; warning: string; info: string;
	pending: string; running: string; aborted: string; done: string;
}
interface Icon { extensionTool: string; file: string; folder: string; package: string; }
interface Format { bullet: string; dash: string; bracketLeft: string; bracketRight: string; }

export interface RichSymbols {
	boxRound: BoxRound;
	tree: Tree;
	sep: Sep;
	status: Status;
	icon: Icon;
	format: Format;
}

// Rounded box reuses sharp tee/cross glyphs (no rounded Unicode junctions).
export const SYMBOLS: RichSymbols = {
	boxRound: {
		topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯",
		horizontal: "─", vertical: "│",
		cross: "┼", teeDown: "┬", teeUp: "┴", teeRight: "├", teeLeft: "┤",
	},
	tree: { branch: "├─", last: "└─", vertical: "│", horizontal: "─", hook: "└" },
	sep: { dot: " · ", slash: " / ", pipe: " │ ", space: " " },
	status: {
		success: "✔", error: "✘", warning: "⚠", info: "ⓘ",
		pending: "⏳", running: "⟳", aborted: "⏹", done: "•",
	},
	icon: { extensionTool: "🛠", file: "📄", folder: "📁", package: "📦" },
	format: { bullet: "•", dash: "—", bracketLeft: "⟦", bracketRight: "⟧" },
};

export const SPINNER_FRAMES = {
	status: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
	activity: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

/** Rotating circle-halves — a single circle that spins, for the per-agent
 *  "working" indicator. Each frame is 1 display cell. */
export const CIRCLE_SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

/** Resolve a status key to a symbol, applying the spinner frame for "running". */
export function statusSymbol(status: "success" | "error" | "warning" | "info" | "pending" | "running" | "aborted" | "done", spinnerFrame?: number): string {
	if (status === "running" && spinnerFrame !== undefined) {
		return SPINNER_FRAMES.status[spinnerFrame % SPINNER_FRAMES.status.length];
	}
	return SYMBOLS.status[status];
}

/** Color a symbol via the theme (omp `theme.styledSymbol(key, color)`). */
export function styledSymbol(symbol: string, color: ThemeColor, theme: ThemeLike): string {
	return theme.fg(color, symbol);
}

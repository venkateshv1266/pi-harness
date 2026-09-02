/**
 * Vendored render helpers (omp `tools/render-utils.ts` subset), adapted to the
 * earendil theme surface. Re-exports the pi-tui width utilities that omp's
 * originals import from `@oh-my-pi/pi-tui`.
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CIRCLE_SPINNER_FRAMES, SYMBOLS, SPINNER_FRAMES, statusSymbol, styledSymbol, type ThemeColor, type ThemeLike } from "./symbols.ts";

export { truncateToWidth, visibleWidth, wrapTextWithAnsi };

/** Replace tab characters with 3 spaces (matches earendil `render-utils.replaceTabs`). */
export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export type ToolUIStatus = "success" | "done" | "error" | "warning" | "info" | "pending" | "running" | "aborted";

/** Collapse whitespace runs (incl. newlines) and truncate to `maxWidth` cells. */
export function previewLine(text: string, maxWidth: number): string {
	return truncateToWidth(text.replace(/\s+/g, " ").trim(), maxWidth);
}

export function pluralize(word: string, count: number): string {
	return count === 1 ? word : `${word}s`;
}

export function formatNumber(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/** Human wall-clock duration from ms. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	if (m < 60) return `${m}m${rem > 0 ? ` ${rem}s` : ""}`;
	const h = Math.floor(m / 60);
	const mm = m % 60;
	return `${h}h${mm > 0 ? ` ${mm}m` : ""}`;
}

export function wrapBrackets(text: string, _theme: ThemeLike): string {
	return `${SYMBOLS.format.bracketLeft}${text}${SYMBOLS.format.bracketRight}`;
}

/** Status icon (colored) for a given state, with spinner frame for running. */
export function formatStatusIcon(status: ToolUIStatus, theme: ThemeLike, spinnerFrame?: number): string {
	const sym = statusSymbol(status, spinnerFrame);
	switch (status) {
		case "success":
		case "done":
			return styledSymbol(sym, "success", theme);
		case "error":
			return styledSymbol(sym, "error", theme);
		case "warning":
			return styledSymbol(sym, "warning", theme);
		case "info":
			return styledSymbol(sym, "accent", theme);
		case "pending":
			return styledSymbol(sym, "muted", theme);
		case "running":
			return theme.fg("accent", sym);
		case "aborted":
			return styledSymbol(sym, "error", theme);
	}
}

export function expandKeyHint(): string {
	return "Ctrl+O";
}

export function formatExpandHint(theme: ThemeLike, expanded?: boolean, hasMore?: boolean): string {
	if (expanded) return "";
	if (hasMore === false) return "";
	return theme.fg("dim", wrapBrackets(`${expandKeyHint()}: Expand`, theme));
}

/** `[label]` badge colored with `color`. */
export function formatBadge(label: string, color: ThemeColor, theme: ThemeLike): string {
	return theme.fg(color, `${SYMBOLS.format.bracketLeft}${label}${SYMBOLS.format.bracketRight}`);
}

/** `… N more {itemType}` suffix for truncated lists. */
export function formatMoreItems(remaining: number, itemType: string): string {
	const n = Number.isFinite(remaining) ? remaining : 0;
	return `… ${n} more ${pluralize(itemType, n)}`;
}

export function formatMeta(meta: string[], theme: ThemeLike): string {
	return meta.length > 0 ? ` ${theme.fg("muted", meta.join(SYMBOLS.sep.dot))}` : "";
}

const PREVIEW_WINDOW_RESERVED_ROWS = 20;
const PREVIEW_WINDOW_MIN_LINES = 6;
const PREVIEW_WINDOW_FALLBACK_ROWS = 30;

/** Tail-window height for collapsed streaming previews. */
export function previewWindowRows(): number {
	const rows = process.stdout.rows || PREVIEW_WINDOW_FALLBACK_ROWS;
	return Math.max(PREVIEW_WINDOW_MIN_LINES, rows - PREVIEW_WINDOW_RESERVED_ROWS);
}

export function capPreviewLines(
	lines: string[],
	theme: ThemeLike,
	options: { max?: number; expanded?: boolean; prefix?: string; expandHint?: boolean } = {},
): string[] {
	if (options.expanded) return lines;
	const max = options.max ?? previewWindowRows();
	if (lines.length <= max) return lines;
	const visible = max <= 1 ? [] : lines.slice(lines.length - (max - 1));
	const hidden = lines.length - visible.length;
	const hint = options.expandHint === false ? "" : formatExpandHint(theme, false, true);
	const marker = `… ${hidden} earlier ${pluralize("line", hidden)}${hint ? ` ${hint}` : ""}`;
	return [`${options.prefix ?? ""}${theme.fg("dim", marker)}`, ...visible];
}

const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g");
const OSC_RE = new RegExp(`${ESC}\\][^${ESC}]*${ESC}\\\\`, "g");

/** Strip ANSI/OSC escape sequences for safe display. */
export function sanitizeText(text: string): string {
	return text.replace(ANSI_RE, "").replace(OSC_RE, "");
}

export { SPINNER_FRAMES, CIRCLE_SPINNER_FRAMES };

/** Agent lifecycle status (omp `AgentProgress["status"]` shape). */
export type AgentStatus = "running" | "pending" | "completed" | "failed" | "aborted";

/** Per-agent row status icon (1-cell glyph + trailing space → width 2 for
 *  name alignment). Colored via the earendil theme `fg`.
 *
 *  - running: animated rotating circle ◐◓◑◒, accent
 *  - pending: ○, muted
 *  - completed: ✔, success
 *  - failed: ✘, error
 *  - aborted: ⏹, error */
export function formatCircleStatusIcon(status: AgentStatus, theme: ThemeLike, spinnerFrame?: number): string {
	switch (status) {
		case "running": {
			const f = spinnerFrame !== undefined ? CIRCLE_SPINNER_FRAMES[spinnerFrame % CIRCLE_SPINNER_FRAMES.length] : "◐";
			return `${theme.fg("accent", f)} `;
		}
		case "pending":
			return `${theme.fg("muted", "○")} `;
		case "completed":
			return `${theme.fg("success", "✔")} `;
		case "failed":
			return `${theme.fg("error", "✘")} `;
		case "aborted":
			return `${theme.fg("error", "⏹")} `;
	}
}

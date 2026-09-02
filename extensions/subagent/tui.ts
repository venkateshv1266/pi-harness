/**
 * Vendored TUI primitives (omp `tui/output-block.ts` + `tui/status-line.ts` +
 * `tui/utils.ts`), adapted to the earendil theme surface.
 *
 * `framedBlock` returns a `Component` whose `render(width)` emits a rounded,
 * state-colored, bg-filled bordered box. Pair with `renderShell: "self"` on
 * the tool definition so `ToolExecutionComponent` renders it flush (no extra
 * padding/background) — the earendil equivalent of omp's `markFramedBlockComponent`.
 */
import { visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { SYMBOLS, type ThemeColor, type ThemeLike } from "./symbols.ts";
import { formatStatusIcon, truncateToWidth, type ToolUIStatus } from "./render-utils.ts";

export type State = "pending" | "running" | "success" | "error" | "warning";

export interface OutputBlockSection {
	label?: string;
	lines: readonly string[];
	separator?: boolean;
}

export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: OutputBlockSection[];
	width: number;
	applyBg?: boolean;
	contentPaddingLeft?: number;
	contentPaddingRight?: number;
	/** Override state-derived border color (e.g. muted legacy frames). */
	borderColor?: ThemeColor;
}

function padding(n: number): string {
	return n > 0 ? " ".repeat(n) : "";
}

function normalizePad(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 1;
	return Math.max(0, Math.floor(value));
}

function getStateBgColor(state: State | undefined): "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" {
	if (state === "success") return "toolSuccessBg";
	if (state === "error") return "toolErrorBg";
	return "toolPendingBg";
}

function padToWidth(text: string, width: number, bgFn?: (s: string) => string): string {
	if (width <= 0) return bgFn ? bgFn(text) : text;
	const need = Math.max(0, width - visibleWidth(text));
	const padded = need > 0 ? text + padding(need) : text;
	return bgFn ? bgFn(padded) : padded;
}

type BlockRow =
	| { kind: "bar"; leftChar: string; rightChar: string; label?: string; meta?: string }
	| { kind: "bottom"; leftChar: string; rightChar: string }
	| { kind: "content"; inner: string };

export function renderOutputBlock(options: OutputBlockOptions, theme: ThemeLike): string[] {
	const { header, headerMeta, state, sections = [], width, applyBg = true } = options;
	const h = SYMBOLS.boxRound.horizontal;
	const v = SYMBOLS.boxRound.vertical;
	const cap = h.repeat(3);
	const lineWidth = Math.max(0, width);

	const borderColor: ThemeColor =
		options.borderColor ??
		(state === "error"
			? "error"
			: state === "warning"
				? "warning"
				: state === "running" || state === "pending"
					? "accent"
					: "dim");
	const border = (text: string) => theme.fg(borderColor, text);

	const bgFn = (() => {
		if (!state || !applyBg) return undefined;
		const bgAnsi = theme.getBgAnsi(getStateBgColor(state));
		return (text: string) => {
			const stabilized = text
				.replace(/\x1b\[(?:0)?m/g, (m) => `${m}${bgAnsi}`)
				.replace(/\x1b\[49m/g, (m) => `${m}${bgAnsi}`);
			return `${bgAnsi}${stabilized}\x1b[49m`;
		};
	})();

	const contentPaddingLeft = normalizePad(options.contentPaddingLeft);
	const contentPaddingRight = normalizePad(options.contentPaddingRight ?? contentPaddingLeft);
	const contentWidth = Math.max(0, lineWidth - visibleWidth(v) - contentPaddingLeft - contentPaddingRight - visibleWidth(v));
	const contentLeftPad = contentPaddingLeft > 0 ? padding(contentPaddingLeft) : "";
	const contentRightPad = contentPaddingRight > 0 ? padding(contentPaddingRight) : "";

	const rows: BlockRow[] = [];
	rows.push({ kind: "bar", leftChar: SYMBOLS.boxRound.topLeft, rightChar: SYMBOLS.boxRound.topRight, label: header, meta: headerMeta });

	const normalizedSections = sections.length > 0 ? sections : [{ lines: [] as string[] }];
	for (let si = 0; si < normalizedSections.length; si++) {
		const section = normalizedSections[si]!;
		if (section.label) {
			rows.push({ kind: "bar", leftChar: SYMBOLS.boxRound.teeRight, rightChar: SYMBOLS.boxRound.teeLeft, label: section.label });
		} else if (section.separator && si > 0) {
			rows.push({ kind: "bar", leftChar: SYMBOLS.boxRound.teeRight, rightChar: SYMBOLS.boxRound.teeLeft });
		}
		const allLines = section.lines.flatMap((l) => l.split("\n"));
		for (const line of allLines) {
			const wrapped = wrapTextWithAnsi(line.trimEnd(), contentWidth);
			for (const wl of wrapped) {
				const innerPad = padding(Math.max(0, contentWidth - visibleWidth(wl)));
				rows.push({ kind: "content", inner: `${wl}${innerPad}` });
			}
		}
	}
	rows.push({ kind: "bottom", leftChar: SYMBOLS.boxRound.bottomLeft, rightChar: SYMBOLS.boxRound.bottomRight });

	const renderBar = (row: { leftChar: string; rightChar: string; label?: string; meta?: string }): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		if (lineWidth <= 0) return border(leftGlyphs) + border(rightGlyph);
		const labelText = [row.label, row.meta].filter(Boolean).join(SYMBOLS.sep.dot);
		if (!labelText) {
			const fillCount = Math.max(0, lineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
			return `${border(leftGlyphs)}${border(h.repeat(fillCount))}${border(rightGlyph)}`;
		}
		const rawLabel = ` ${labelText} `;
		const leftW = visibleWidth(leftGlyphs);
		const rightW = visibleWidth(rightGlyph);
		const maxLabelW = Math.max(0, lineWidth - leftW - rightW);
		const trimmedLabel = truncateToWidth(rawLabel, maxLabelW);
		const labelW = visibleWidth(trimmedLabel);
		const fillCount = Math.max(0, lineWidth - leftW - labelW - rightW);
		return `${border(leftGlyphs)}${trimmedLabel}${border(h.repeat(fillCount))}${border(rightGlyph)}`;
	};

	const renderBottom = (row: { leftChar: string; rightChar: string }): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		const fillCount = Math.max(0, lineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
		return `${border(leftGlyphs)}${border(h.repeat(fillCount))}${border(rightGlyph)}`;
	};

	const renderContent = (inner: string): string =>
		`${border(v)}${contentLeftPad}${inner}${contentRightPad}${border(v)}`;

	const lines: string[] = [];
	for (const row of rows) {
		const line = row.kind === "bar" ? renderBar(row) : row.kind === "bottom" ? renderBottom(row) : renderContent(row.inner);
		lines.push(padToWidth(line, lineWidth, bgFn));
	}
	return lines;
}

export interface FramedBlockComponent extends Component {
	invalidate(): void;
}

/**
 * Self-framing bordered tool component. `build` returns block options for a
 * given width; a small keyed cache avoids re-computing on the spinner's
 * ~33ms re-render when nothing changed.
 */
export function framedBlock(theme: ThemeLike, build: (width: number) => OutputBlockOptions): FramedBlockComponent {
	let cacheKey = "";
	let cachedLines: readonly string[] = [];
	let cachedWidth = -1;
	const invalidate = () => {
		cacheKey = "";
		cachedLines = [];
		cachedWidth = -1;
	};
	const buildKey = (o: OutputBlockOptions): string => {
		const parts: string[] = [`${o.width}`, `${o.state ?? ""}`, `${o.header ?? ""}`, `${o.headerMeta ?? ""}`, `${o.borderColor ?? ""}`, `${o.applyBg ?? ""}`];
		if (o.sections) {
			for (const s of o.sections) {
				parts.push(`${s.label ?? ""}|${s.separator ?? ""}`);
				for (const l of s.lines) parts.push(l);
			}
		}
		return parts.join("\u0001");
	};
	return {
		render(width: number): string[] {
			const opts = build(width);
			const key = buildKey(opts);
			if (key === cacheKey && width === cachedWidth) return [...cachedLines];
			const lines = renderOutputBlock(opts, theme);
			cacheKey = key;
			cachedLines = lines;
			cachedWidth = width;
			return [...lines];
		},
		invalidate,
	};
}

// ============================================================================
// Status header (omp `tui/status-line.ts`)
// ============================================================================

export interface StatusLineOptions {
	icon?: ToolUIStatus;
	iconOverride?: string;
	spinnerFrame?: number;
	title: string;
	titleColor?: ThemeColor;
	description?: string;
	badge?: { label: string; color: ThemeColor };
	meta?: string[];
}

function flattenForHeader(text: string): string {
	return text.replace(/\r\n?|\n/g, " ");
}

export function renderStatusLine(options: StatusLineOptions, theme: ThemeLike): string {
	const icon = options.iconOverride ?? (options.icon ? formatStatusIcon(options.icon, theme, options.spinnerFrame) : "");
	const titleColor = options.titleColor ?? "accent";
	const title = theme.fg(titleColor, flattenForHeader(options.title));
	let line = icon ? `${icon} ${title}` : title;
	if (options.description) line += `: ${theme.fg("muted", flattenForHeader(options.description))}`;
	if (options.badge) {
		const { label, color } = options.badge;
		line += ` ${theme.fg(color, `${SYMBOLS.format.bracketLeft}${flattenForHeader(label)}${SYMBOLS.format.bracketRight}`)}`;
	}
	const meta = options.meta?.map(flattenForHeader).filter((v) => v.trim().length > 0) ?? [];
	if (meta.length > 0) line += ` ${theme.fg("dim", meta.join(SYMBOLS.sep.dot))}`;
	return line;
}

// ============================================================================
// Tree helpers (omp `tui/utils.ts`)
// ============================================================================

export function buildTreePrefix(ancestors: boolean[], _theme: ThemeLike): string {
	return ancestors.map((hasNext) => (hasNext ? `${SYMBOLS.tree.vertical}  ` : "   ")).join("");
}

export function getTreeBranch(isLast: boolean, _theme: ThemeLike): string {
	return isLast ? SYMBOLS.tree.last : SYMBOLS.tree.branch;
}

export function getTreeContinuePrefix(isLast: boolean, _theme: ThemeLike): string {
	return isLast ? "   " : `${SYMBOLS.tree.vertical}  `;
}

export { padToWidth, getStateBgColor };

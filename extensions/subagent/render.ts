/**
 * Subagent TUI renderer — port of omp `task/render.ts`, adapted to this
 * extension's `SingleResult`/`SubagentDetails` data model and the earendil
 * theme surface. Renders the omp framed-block + tree-row look via the vendored
 * `tui.ts` primitives, paired with `renderShell: "self"` in `index.ts`.
 */
import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, type Component } from "@earendil-works/pi-tui";
import {
	SYMBOLS,
	styledSymbol,
	type ThemeLike,
} from "./symbols.ts";
import {
	capPreviewLines,
	formatBadge,
	formatCircleStatusIcon,
	formatDuration,
	formatExpandHint,
	formatMoreItems,
	formatNumber,
	formatStatusIcon,
	previewLine,
	previewWindowRows,
	replaceTabs,
	sanitizeText,
	truncateToWidth,
	type ToolUIStatus,
} from "./render-utils.ts";
import {
	buildTreePrefix,
	framedBlock,
	getTreeBranch,
	getTreeContinuePrefix,
	type FramedBlockComponent,
	renderStatusLine,
	type State,
} from "./tui.ts";
import { CIRCLE_SPINNER_FRAMES } from "./symbols.ts";

// ============================================================================
// Data shapes (satisfied by index.ts `SingleResult` / `SubagentDetails`)
// ============================================================================

export interface RenderSingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number; // -1 = still running
	messages: Message[];
	stderr: string;
	usage: {
		input: number; output: number; cacheRead: number; cacheWrite: number;
		cost: number; contextTokens: number; turns: number;
	};
	model?: string;
	modelRole?: string;
	stopReason?: string;
	errorMessage?: string;
	structuredData?: unknown;
	schemaError?: string;
	timedOut?: boolean;
	step?: number;
	id: string;
	index: number;
	startMs: number;
	endMs?: number;
	description?: string;
	aborted?: boolean;
	abortReason?: string;
	error?: string;
	truncated?: boolean;
	/** `details` of nested `subagent` calls this agent made, keyed by toolCallId. */
	nestedResults?: NestedResultStash[];
}

export interface RenderSubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: "user" | "project" | "both";
	projectAgentsDir: string | null;
	results: RenderSingleResult[];
	totalDurationMs: number;
}

export interface TaskParamsLike {
	agent?: string;
	name?: string;
	task?: string;
	tasks?: Array<{ agent?: string; task?: string; name?: string; isolated?: boolean }>;
	chain?: Array<{ agent?: string; task?: string; name?: string }>;
	context?: string;
	isolated?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const COLLAPSED_AGENT_LIMIT = 4;
const ASSIGNMENT_FRAME_INSET = 3; // left border + 1-cell inset + right border

// ============================================================================
// Message derivation (current tool / recent tools / recent output)
// ============================================================================

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** One-line preview of a tool call, omp-style. */
function formatToolDetail(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			return previewLine(cmd, 40);
		}
		case "read": {
			const p = shortenPath((args.file_path || args.path || "...") as string);
			return p;
		}
		case "write":
		case "edit": {
			return shortenPath((args.file_path || args.path || "...") as string);
		}
		case "grep":
			return `/${(args.pattern || "") as string}/`;
		case "find":
			return (args.pattern || "*") as string;
		case "ls":
			return shortenPath((args.path || ".") as string);
		case "subagent": {
			const agent = typeof args.agent === "string" ? args.agent : "";
			const batch = Array.isArray(args.tasks) ? args.tasks.length : Array.isArray(args.chain) ? args.chain.length : 0;
			return agent ? (batch > 1 ? `${agent} +${batch - 1}` : agent) : "";
		}
		default: {
			const s = JSON.stringify(args);
			return previewLine(s, 40);
		}
	}
}

interface ToolCallSeen { id: string; name: string; arguments: Record<string, unknown>; }

function scanToolActivity(messages: Message[]): {
	currentTool?: { name: string; args: Record<string, unknown> };
	recentTools: Array<{ name: string; args: Record<string, unknown> }>;
	recentOutput: string[];
	toolCount: number;
} {
	const calls: ToolCallSeen[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "toolCall") calls.push({ id: part.id, name: part.name, arguments: part.arguments });
			}
		}
	}
	const results: Array<{ id: string; name: string; text: string }> = [];
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			const text = msg.content
				.map((c) => (c.type === "text" ? c.text : ""))
				.join("")
				.trim();
			results.push({ id: msg.toolCallId, name: msg.toolName, text });
		}
	}
	const resultIds = new Set(results.map((r) => r.id));
	const inflight = calls.filter((c) => !resultIds.has(c.id));
	const completed = calls.filter((c) => resultIds.has(c.id));
	const currentTool = inflight.length > 0
		? { name: inflight[inflight.length - 1]!.name, args: inflight[inflight.length - 1]!.arguments }
		: undefined;
	const recentTools = completed.slice().reverse().map((c) => ({ name: c.name, args: c.arguments }));
	const recentOutput = results.map((r) => r.text).filter(Boolean).slice(-8).reverse();
	return { currentTool, recentTools, recentOutput, toolCount: calls.length };
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant") {
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const part = msg.content[j];
				if (part?.type === "text" && part.text.trim()) return part.text;
			}
		}
	}
	return "";
}

// ============================================================================
// Nested subagents (a spawned agent delegating via `subagent` itself)
// ============================================================================

interface NestedResultStash {
	toolCallId: string;
	results: unknown[];
}

interface NestedItem {
	agent: string;
	taskBrief: string;
}

interface NestedAgentRow {
	agent: string;
	brief: string;
	state: "running" | "completed" | "failed";
}

interface NestedDetails {
	agent?: string;
	description?: string;
	exitCode?: number;
	aborted?: boolean;
	error?: string;
}

const NESTED_ROWS_COLLAPSED = 3;
const NESTED_ROWS_EXPANDED = 8;

function firstTextLine(text: string): string {
	return previewLine(text.split("\n").map((l) => l.trim()).find(Boolean) ?? "", 64);
}

function nestedCallItems(args: Record<string, unknown>): NestedItem[] {
	const items: NestedItem[] = [];
	if (typeof args.agent === "string" && args.agent.trim()) {
		items.push({ agent: args.agent.trim(), taskBrief: taskFirstLine(args.task) });
	}
	for (const key of ["tasks", "chain"] as const) {
		const arr = args[key];
		if (!Array.isArray(arr)) continue;
		for (const t of arr) {
			if (!t || typeof t !== "object") continue;
			const record = t as Record<string, unknown>;
			if (typeof record.agent === "string" && record.agent.trim()) {
				items.push({ agent: record.agent.trim(), taskBrief: taskFirstLine(record.task) });
			}
		}
	}
	return items;
}

function rowsFromDetails(items: NestedItem[], details: unknown[]): NestedAgentRow[] {
	const used = new Set<number>();
	return items.map((item) => {
		let idx = details.findIndex((d, i) => !used.has(i) && (d as NestedDetails)?.agent === item.agent);
		if (idx === -1) idx = details.findIndex((d, i) => !used.has(i));
		if (idx === -1) return { agent: item.agent, brief: item.taskBrief, state: "completed" as const };
		used.add(idx);
		const d = details[idx] as NestedDetails;
		// exitCode -1 is the "still running" sentinel, not a failure.
		if (d.exitCode === -1 && !d.aborted && !d.error) return { agent: item.agent, brief: item.taskBrief, state: "running" as const };
		const failed = d.aborted === true || !!d.error || (d.exitCode !== undefined && d.exitCode !== 0);
		const brief =
			typeof d.description === "string" && d.description.trim()
				? previewLine(sanitizeText(d.description), 64)
				: item.taskBrief;
		return { ...item, brief, state: failed ? ("failed" as const) : ("completed" as const) };
	});
}

function rowsFromText(items: NestedItem[], text: string, isError: boolean): NestedAgentRow[] {
	const callFailed =
		isError ||
		/^(Agent (failed|error|aborted)|Chain stopped|Canceled:|Invalid parameters|Unknown agent|Too many parallel)/.test(text);
	const brief = firstTextLine(text);
	return items.map((item) => {
		const escaped = item.agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const section = text.match(new RegExp(`^### \\[${escaped}\\] (completed|failed)`, "m"));
		if (section) return { ...item, brief, state: section[1] === "failed" ? ("failed" as const) : ("completed" as const) };
		return { ...item, brief, state: callFailed ? ("failed" as const) : ("completed" as const) };
	});
}

function extractNestedRows(r: RenderSingleResult, agentDone: boolean): NestedAgentRow[] {
	const calls: Array<{ id: string; items: NestedItem[] }> = [];
	for (const msg of r.messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "toolCall" && part.name === "subagent") {
				calls.push({ id: part.id, items: nestedCallItems(part.arguments) });
			}
		}
	}
	if (calls.length === 0) return [];

	const textResults = new Map<string, { text: string; isError: boolean }>();
	for (const msg of r.messages) {
		if (msg.role !== "toolResult" || msg.toolName !== "subagent") continue;
		textResults.set(msg.toolCallId, {
			text: msg.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim(),
			isError: msg.isError === true,
		});
	}

	const rows: NestedAgentRow[] = [];
	for (const call of calls) {
		if (call.items.length === 0) continue;
		const details = r.nestedResults?.find((n) => n.toolCallId === call.id)?.results;
		if (details && details.length > 0) {
			rows.push(...rowsFromDetails(call.items, details));
			continue;
		}
		const textResult = textResults.get(call.id);
		if (textResult && textResult.text) {
			rows.push(...rowsFromText(call.items, textResult.text, textResult.isError));
			continue;
		}
		// No result on the wire yet; once the parent agent is done the call must
		// have ended with it, so avoid a spinner that never settles.
		rows.push(...call.items.map((item) => ({ agent: item.agent, brief: item.taskBrief, state: agentDone ? ("completed" as const) : ("running" as const) })));
	}
	return rows;
}

function renderNestedRows(
	rows: NestedAgentRow[],
	continuePrefix: string,
	expanded: boolean,
	theme: ThemeLike,
	spinnerFrame?: number,
): string[] {
	if (rows.length === 0) return [];
	const limit = expanded ? NESTED_ROWS_EXPANDED : NESTED_ROWS_COLLAPSED;
	const lines: string[] = [];
	if (rows.length > limit) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", formatMoreItems(rows.length - limit, "agent"))}`);
	}
	const visible = rows.slice(-limit);
	for (let i = 0; i < visible.length; i++) {
		const row = visible[i]!;
		const connector = theme.fg("dim", i === visible.length - 1 ? SYMBOLS.tree.last : SYMBOLS.tree.branch);
		const icon = formatCircleStatusIcon(
			row.state === "running" ? "running" : row.state === "failed" ? "failed" : "completed",
			theme,
			spinnerFrame,
		);
		let line = `${continuePrefix}${connector} ${icon}${theme.fg("accent", theme.bold(row.agent))}`;
		if (row.brief) line += `${theme.fg("accent", ":")} ${theme.fg("dim", row.brief)}`;
		lines.push(line);
	}
	return lines;
}

// ============================================================================
// Status / badges / ids
// ============================================================================

export function formatTaskId(id: string): string {
	const sanitized = sanitizeText(id);
	const segments = sanitized.split(".");
	return segments.length < 2 ? sanitized : segments.join(">");
}

export function agentTypeBadge(agent: string | undefined, theme: ThemeLike): string {
	const trimmed = agent?.trim();
	if (!trimmed || trimmed === "task") return "";
	return ` ${theme.fg("dim", `${SYMBOLS.format.bracketLeft}${trimmed}${SYMBOLS.format.bracketRight}`)}`;
}

function agentStatus(r: RenderSingleResult): "running" | "pending" | "completed" | "failed" | "aborted" {
	if (r.exitCode === -1) return "running";
	if (r.aborted || r.timedOut && r.stopReason === "aborted") return "aborted";
	if (r.exitCode !== 0 || r.error || r.errorMessage) return "failed";
	return "completed";
}

function agentDurationMs(r: RenderSingleResult, nowMs: number): number {
	const end = r.endMs ?? nowMs;
	return Math.max(0, end - r.startMs);
}

function appendAgentStats(
	line: string,
	opts: {
		toolCount?: number;
		requests?: number;
		tokens: number;
		contextTokens?: number;
		cost: number;
		resolvedModel?: string;
		showResolvedModelBadge?: boolean;
	},
	theme: ThemeLike,
): string {
	if (opts.toolCount) {
		line += `${SYMBOLS.sep.dot}${theme.fg("dim", `${formatNumber(opts.toolCount)} ${SYMBOLS.icon.extensionTool}`)}`;
	}
	if (opts.requests) {
		line += `${SYMBOLS.sep.dot}${theme.fg("dim", `${formatNumber(opts.requests)} req`)}`;
	}
	if (opts.contextTokens && opts.contextTokens > 0) {
		line += `${SYMBOLS.sep.dot}${theme.fg("dim", `${formatNumber(opts.contextTokens)} ctx`)}`;
	}
	if (opts.cost > 0) {
		line += `${SYMBOLS.sep.dot}${theme.fg("dim", `$${opts.cost.toFixed(opts.cost < 0.01 ? 4 : 2)}`)}`;
	}
	if (opts.resolvedModel && opts.showResolvedModelBadge) {
		line += `${SYMBOLS.sep.dot}${theme.fg("dim", truncateToWidth(replaceTabs(opts.resolvedModel), 30))}`;
	}
	return line;
}

// ============================================================================
// Assignment / context markdown sections (persist across call → result)
// ============================================================================

const ASSIGNMENT_FRAME_INSET_CONST = 3;

function createMarkdownSectionRenderer(text: string, theme: ThemeLike): (width: number) => { lines: string[] } {
	const md = new Markdown(text, 0, 0, getMarkdownTheme(), { color: (l: string) => theme.fg("muted", l) });
	return (width) => ({ lines: md.render(Math.max(1, width - ASSIGNMENT_FRAME_INSET_CONST)) });
}

function createAssignmentSectionRenderer(args: TaskParamsLike | undefined, theme: ThemeLike) {
	const assignment = sanitizeText(args?.task ?? "").trim();
	return assignment ? createMarkdownSectionRenderer(assignment, theme) : undefined;
}

function createContextSectionRenderer(args: TaskParamsLike | undefined, theme: ThemeLike) {
	const context = sanitizeText(args?.context ?? "").trim();
	return context ? createMarkdownSectionRenderer(context, theme) : undefined;
}

// ============================================================================
// Call preview (per-agent bullet list while args stream)
// ============================================================================

function taskFirstLine(task: unknown): string {
	if (typeof task !== "string") return "";
	const trimmed = sanitizeText(task).trim();
	const nl = trimmed.indexOf("\n");
	return nl === -1 ? trimmed : trimmed.slice(0, nl);
}

function renderTaskItemLines(
	items: Array<{ name?: string; task?: string; agent?: string; isolated?: boolean }>,
	theme: ThemeLike,
): string[] {
	if (!Array.isArray(items) || items.length === 0) return [];
	const bullet = theme.fg("dim", SYMBOLS.format.bullet);
	const cap = Math.min(items.length, COLLAPSED_AGENT_LIMIT);
	const lines: string[] = [];
	for (let i = 0; i < cap; i++) {
		const item = items[i]!;
		const rawName = typeof item.name === "string" ? item.name.trim() : "";
		const idLabel = rawName ? formatTaskId(rawName) : `#${i + 1}`;
		let line = `${bullet} ${theme.fg("accent", theme.bold(idLabel))}`;
		const brief = taskFirstLine(item.task);
		if (brief) line += `: ${theme.fg("muted", previewLine(brief, 64))}`;
		line += agentTypeBadge(item.agent, theme);
		if (item.isolated === true) line += theme.fg("dim", " [isolated]");
		lines.push(line);
	}
	if (cap < items.length) {
		lines.push(`${bullet} ${theme.fg("dim", formatMoreItems(items.length - cap, "agent"))}`);
	}
	return lines;
}

function renderTaskCallLines(args: TaskParamsLike | undefined, theme: ThemeLike): string[] {
	if (!args) return [];
	const bullet = theme.fg("dim", SYMBOLS.format.bullet);
	const lines: string[] = [];
	const rawName = typeof args.name === "string" ? args.name.trim() : "";
	const idLabel = rawName ? formatTaskId(rawName) : "";
	const brief = taskFirstLine(args.task);
	if (idLabel || brief) {
		let line = `${bullet} ${theme.fg("accent", theme.bold(idLabel || "agent"))}`;
		if (brief) line += `: ${theme.fg("muted", previewLine(brief, 64))}`;
		line += agentTypeBadge(args.agent, theme);
		lines.push(line);
	}
	lines.push(...renderTaskItemLines(args.tasks ?? [], theme));
	return lines;
}

function emptyFramedComponent(): FramedBlockComponent {
	return { render: () => [], invalidate: () => {} };
}

// ============================================================================
// Call renderer
// ============================================================================

export interface TaskRenderOptions {
	expanded: boolean;
	isPartial: boolean;
	argsComplete?: boolean;
	executionStarted?: boolean;
	spinnerFrame?: number;
}

export function renderCall(
	args: TaskParamsLike,
	options: { argsComplete?: boolean; executionStarted?: boolean },
	theme: ThemeLike,
): Component {
	// Earendil stacks call + result components (no swap like omp). Once args
	// are complete the result frame takes over; return empty to avoid a
	// duplicated frame above the result.
	if (options.argsComplete) return emptyFramedComponent();

	const showIsolated = args.isolated === true;
	const header = renderStatusLine(
		{
			iconOverride: styledSymbol("⇶", "accent", theme),
			title: "Task",
			description: typeof args.agent === "string" && args.agent.trim() ? args.agent.trim() : undefined,
		},
		theme,
	);
	const assignmentSection = createAssignmentSectionRenderer(args, theme);
	const contextSection = createContextSectionRenderer(args, theme);

	return framedBlock(theme, (width) => {
		const sections: Array<{ label?: string; lines: readonly string[]; separator?: boolean }> = [];
		if (contextSection) sections.push(contextSection(width));
		if (assignmentSection) sections.push(assignmentSection(width));
		const callLines = renderTaskCallLines(args, theme);
		if (callLines.length > 0) sections.push({ separator: true, lines: callLines });
		return {
			header,
			headerMeta: showIsolated ? "isolated" : undefined,
			sections,
			state: "pending",
			borderColor: "borderMuted",
			width,
		};
	});
}

// ============================================================================
// JSON tree (structured output)
// ============================================================================

function formatJsonScalar(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return `"${truncateToWidth(sanitizeText(value), 70)}"`;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function renderJsonTreeLines(value: unknown, theme: ThemeLike, maxDepth: number, maxLines: number): { lines: string[]; truncated: boolean } {
	const lines: string[] = [];
	let truncated = false;
	const iconObject = theme.fg("muted", SYMBOLS.icon.folder);
	const iconArray = theme.fg("muted", SYMBOLS.icon.package);
	const iconScalar = theme.fg("muted", SYMBOLS.icon.file);

	const pushLine = (line: string): boolean => {
		if (lines.length >= maxLines) { truncated = true; return false; }
		lines.push(line);
		return true;
	};

	const renderNode = (val: unknown, key: string | undefined, ancestors: boolean[], isLast: boolean, depth: number) => {
		if (lines.length >= maxLines) { truncated = true; return; }
		const connector = isLast ? SYMBOLS.tree.last : SYMBOLS.tree.branch;
		const prefix = `${buildTreePrefix(ancestors, theme)}${theme.fg("dim", connector)} `;
		const scalar = formatJsonScalar(val);
		if (scalar) {
			const label = key ? theme.fg("muted", sanitizeText(key)) : theme.fg("muted", "value");
			pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", scalar)}`);
			return;
		}
		if (Array.isArray(val)) {
			const header = key ? theme.fg("muted", sanitizeText(key)) : theme.fg("muted", "array");
			pushLine(`${prefix}${iconArray} ${header}`);
			if (val.length === 0 || depth >= maxDepth) {
				pushLine(`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", SYMBOLS.tree.last)} ${theme.fg("dim", val.length === 0 ? "[]" : "…")}`);
				return;
			}
			const next = [...ancestors, !isLast];
			for (let i = 0; i < val.length; i++) {
				renderNode(val[i], `[${i}]`, next, i === val.length - 1, depth + 1);
				if (lines.length >= maxLines) { truncated = true; return; }
			}
			return;
		}
		if (val && typeof val === "object") {
			const header = key ? theme.fg("muted", sanitizeText(key)) : theme.fg("muted", "object");
			pushLine(`${prefix}${iconObject} ${header}`);
			const entries = Object.entries(val as Record<string, unknown>);
			if (entries.length === 0 || depth >= maxDepth) {
				pushLine(`${buildTreePrefix([...ancestors, !isLast], theme)}${theme.fg("dim", SYMBOLS.tree.last)} ${theme.fg("dim", entries.length === 0 ? "{}" : "…")}`);
				return;
			}
			const next = [...ancestors, !isLast];
			for (let i = 0; i < entries.length; i++) {
				const [ck, cv] = entries[i]!;
				renderNode(cv, ck, next, i === entries.length - 1, depth + 1);
				if (lines.length >= maxLines) { truncated = true; return; }
			}
			return;
		}
		const label = key ? theme.fg("muted", sanitizeText(key)) : theme.fg("muted", "value");
		pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", sanitizeText(String(val)))}`);
	};

	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			renderNode(value[i], `[${i}]`, [], i === value.length - 1, 1);
			if (lines.length >= maxLines) break;
		}
	} else if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		for (let i = 0; i < entries.length; i++) {
			const [ck, cv] = entries[i]!;
			renderNode(cv, ck, [], i === entries.length - 1, 1);
			if (lines.length >= maxLines) break;
		}
	} else {
		renderNode(value, undefined, [], true, 0);
	}
	return { lines, truncated };
}

function formatScalarInline(value: unknown, maxLen: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (typeof value === "string") {
		const s = sanitizeText(value);
		const first = s.split("\n")[0]!.trim();
		if (first.length === 0) return `"" (${s.split("\n").length} lines)`;
		const p = truncateToWidth(first, maxLen);
		return s.includes("\n") ? `"${p}…" (${s.split("\n").length} lines)` : `"${p}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") return `{${Object.keys(value).length} keys}`;
	return sanitizeText(String(value));
}

function formatOutputInline(data: unknown, maxWidth = 80): string {
	if (data === null || data === undefined) return "Output: none";
	if (typeof data !== "object") return `Output: ${formatScalarInline(data, 60)}`;
	if (Array.isArray(data)) {
		if (data.length === 0) return "Output: []";
		return `Output: [${data.length} items] ${formatScalarInline(data[0], 40)}${data.length > 1 ? "…" : ""}`;
	}
	const entries = Object.entries(data as Record<string, unknown>);
	if (entries.length === 0) return "Output: {}";
	const pairs: string[] = [];
	let total = "Output: ".length;
	for (const [k, v] of entries) {
		const pair = `${sanitizeText(k)}=${formatScalarInline(v, 24)}`;
		const add = pairs.length > 0 ? pair.length + 2 : pair.length;
		if (total + add > maxWidth && pairs.length > 0) { pairs.push("…"); break; }
		pairs.push(pair);
		total += add;
	}
	return `Output: ${pairs.join(", ")}`;
}

// ============================================================================
// Output / task sections
// ============================================================================

function renderOutputSection(
	output: string,
	continuePrefix: string,
	expanded: boolean,
	theme: ThemeLike,
	maxCollapsed = 3,
	maxExpanded = 10,
): string[] {
	const lines: string[] = [];
	const trimmed = sanitizeText(output).trimEnd();
	if (!trimmed) return lines;

	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (!expanded) {
				lines.push(`${continuePrefix}${theme.fg("dim", formatOutputInline(parsed))}`);
				return lines;
			}
			lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);
			const tree = renderJsonTreeLines(parsed, theme, expanded ? 6 : 2, expanded ? 24 : 6);
			for (const l of tree.lines) lines.push(`${continuePrefix}  ${l}`);
			if (tree.truncated) lines.push(`${continuePrefix}  ${theme.fg("dim", "…")}`);
			return lines;
		} catch {
			// fall through to raw
		}
	}

	lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);
	const outLines = trimmed.split("\n");
	const n = expanded ? maxExpanded : maxCollapsed;
	for (const l of outLines.slice(0, n)) lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(l), 70))}`);
	if (outLines.length > n) lines.push(`${continuePrefix}  ${theme.fg("dim", formatMoreItems(outLines.length - n, "line"))}`);
	return lines;
}

function renderTaskSection(task: string, continuePrefix: string, expanded: boolean, theme: ThemeLike): string[] {
	const lines: string[] = [];
	const trimmed = sanitizeText(task).trim();
	if (!expanded || !trimmed) return lines;
	lines.push(`${continuePrefix}${theme.fg("dim", "Task")}`);
	const taskLines = trimmed.split("\n");
	for (const l of taskLines.slice(0, 20)) lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(l), 70))}`);
	if (taskLines.length > 20) lines.push(`${continuePrefix}  ${theme.fg("dim", formatMoreItems(taskLines.length - 20, "line"))}`);
	return lines;
}

// ============================================================================
// Per-agent rows
// ============================================================================

function renderAgentRow(
	r: RenderSingleResult,
	prefix: string,
	continuePrefix: string,
	expanded: boolean,
	theme: ThemeLike,
	spinnerFrame: number | undefined,
	nowMs: number,
): string[] {
	const lines: string[] = [];
	const status = agentStatus(r);
	const { currentTool, recentTools, recentOutput, toolCount } = scanToolActivity(r.messages);
	const tokens = r.usage.input + r.usage.output;
	const durationMs = agentDurationMs(r, nowMs);

	const iconColor: "success" | "error" | "warning" | "accent" | "text" | "dim" | "muted" =
		status === "completed" ? "success"
		: status === "failed" || status === "aborted" ? "error"
		: status === "running" ? "accent"
		: "muted";

	const displayId = formatTaskId(r.id);
	const trimmedDescription = r.description ? sanitizeText(r.description).trim() : undefined;
	const description = trimmedDescription ? previewLine(trimmedDescription, 64) : undefined;

	// Per-agent status icon: animated circle spinner while working, ✔/✘/⏹ for
	// terminal states. Width-2 so names align across rows.
	let statusLine: string;
	if (status === "running" || status === "pending") {
		const icon = formatCircleStatusIcon(status, theme, spinnerFrame);
		const name = theme.fg("accent", description ? theme.bold(displayId) : displayId);
		statusLine = `${prefix ? `${prefix} ` : ""}${icon} ${name}`;
		if (description) statusLine += `${theme.fg("accent", ":")} ${theme.fg("accent", description)}`;
	} else if (status === "completed") {
		const icon = formatCircleStatusIcon("completed", theme);
		const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
		statusLine = `${prefix ? `${prefix} ` : ""}${icon} ${theme.fg("text", titlePart)}`;
	} else {
		const icon = formatCircleStatusIcon(status === "aborted" ? "aborted" : "failed", theme);
		const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
		statusLine = `${prefix ? `${prefix} ` : ""}${icon} ${theme.fg("accent", titlePart)}`;
	}
	statusLine += agentTypeBadge(r.agent, theme);

	const statusLabel = status === "completed" ? "done" : status === "aborted" ? "aborted" : status === "failed" ? "failed" : undefined;
	if (statusLabel && status !== "running" && status !== "pending") {
		statusLine += ` ${formatBadge(statusLabel, iconColor === "success" ? "success" : iconColor === "error" ? "error" : "warning", theme)}`;
	}

	statusLine = appendAgentStats(
		statusLine,
		{
			toolCount,
			requests: r.usage.turns,
			tokens,
			contextTokens: r.usage.contextTokens,
			cost: r.usage.cost,
			resolvedModel: r.model,
			showResolvedModelBadge: true,
		},
		theme,
	);
	if (status !== "running" && status !== "pending") {
		statusLine += `${SYMBOLS.sep.dot}${theme.fg("dim", formatDuration(durationMs))}`;
	}
	if (r.truncated) statusLine += ` ${theme.fg("warning", "[truncated]")}`;
	lines.push(statusLine);

	lines.push(
		...renderNestedRows(extractNestedRows(r, status !== "running"), continuePrefix, expanded, theme, spinnerFrame),
	);

	// Task brief (expanded only)
	lines.push(...renderTaskSection(r.task, continuePrefix, expanded, theme));

	// Current / recent tool (nested `subagent` calls render as their own rows above)
	if (status === "running") {
		const active =
			currentTool ??
			(recentTools.length > 0 ? { name: recentTools[0]!.name, args: recentTools[0]!.args } : undefined);
		if (active && active.name !== "subagent") {
			let toolLine = `${continuePrefix}${SYMBOLS.tree.hook} ${theme.fg("muted", sanitizeText(active.name))}`;
			const detail = formatToolDetail(active.name, active.args);
			if (detail) toolLine += `: ${theme.fg("dim", previewLine(sanitizeText(detail), 40))}`;
			lines.push(toolLine);
		}
	}

	// Aborted reason
	if (status === "aborted" && r.abortReason) {
		lines.push(`${continuePrefix}${theme.fg("error", SYMBOLS.status.aborted)} ${theme.fg("dim", previewLine(sanitizeText(r.abortReason), 80))}`);
	}

	// Structured data (JSON tree) or raw output — hidden when collapsed; the
	// status line alone is the at-a-glance view, Ctrl+O expands.
	const finalOutput = getFinalOutput(r.messages);
	const showStructured = r.structuredData !== undefined && r.structuredData !== null;
	if (showStructured && expanded) {
		lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);
		const tree = renderJsonTreeLines(r.structuredData, theme, 6, 24);
		for (const l of tree.lines) lines.push(`${continuePrefix}  ${l}`);
		if (tree.truncated) lines.push(`${continuePrefix}  ${theme.fg("dim", "…")}`);
	} else if (finalOutput && expanded) {
		lines.push(...renderOutputSection(finalOutput, continuePrefix, expanded, theme, 3, 12));
	} else if (status === "running" && expanded) {
		const previewRows = previewWindowRows();
		const out = capPreviewLines(sanitizeText([...recentOutput].reverse().join("\n")).split("\n"), theme, { max: previewRows, expanded, expandHint: false }).join("\n");
		lines.push(...renderOutputSection(out, continuePrefix, expanded, theme, 2, previewRows));
	}

	// Schema error
	if (r.schemaError) {
		lines.push(`${continuePrefix}${theme.fg("warning", `schema: ${previewLine(sanitizeText(r.schemaError), 70)}`)}`);
	}

	// Error message
	if (r.error && status !== "completed") {
		lines.push(`${continuePrefix}${theme.fg("error", previewLine(sanitizeText(r.error), 70))}`);
	}

	return lines;
}

// ============================================================================
// Ordering / folding
// ============================================================================

function orderResultsForDisplay(results: readonly RenderSingleResult[]): RenderSingleResult[] {
	return [...results].sort((a, b) => (a.endMs ?? 0) - a.startMs - ((b.endMs ?? 0) - b.startMs) || a.index - b.index);
}

function orderProgressForDisplay(results: readonly RenderSingleResult[]): RenderSingleResult[] {
	const finished: RenderSingleResult[] = [];
	const unfinished: RenderSingleResult[] = [];
	for (const r of results) (r.exitCode === -1 ? unfinished : finished).push(r);
	finished.sort((a, b) => agentDurationMs(a, 0) - agentDurationMs(b, 0) || a.index - b.index);
	return finished.concat(unfinished);
}

function selectCollapsedResults(ordered: readonly RenderSingleResult[]): readonly RenderSingleResult[] {
	if (ordered.length <= COLLAPSED_AGENT_LIMIT) return ordered;
	const picked = new Set<RenderSingleResult>();
	for (const r of ordered) {
		if (picked.size >= COLLAPSED_AGENT_LIMIT) break;
		if (r.aborted || r.exitCode !== 0 || r.error || r.errorMessage) picked.add(r);
	}
	for (const r of ordered) {
		if (picked.size >= COLLAPSED_AGENT_LIMIT) break;
		picked.add(r);
	}
	return ordered.filter((r) => picked.has(r));
}

function formatHiddenProgressLine(hidden: readonly RenderSingleResult[], theme: ThemeLike): string {
	let running = 0, completed = 0, failed = 0, aborted = 0;
	for (const r of hidden) {
		const s = agentStatus(r);
		if (s === "running") running++;
		else if (s === "completed") completed++;
		else if (s === "aborted") aborted++;
		else failed++;
	}
	const parts: string[] = [];
	if (completed > 0) parts.push(theme.fg("dim", `${completed} done`));
	if (running > 0) parts.push(theme.fg("dim", `${running} running`));
	if (failed > 0) parts.push(theme.fg("error", `${failed} failed`));
	if (aborted > 0) parts.push(theme.fg("error", `${aborted} aborted`));
	const breakdown = parts.length > 0 ? `${theme.fg("dim", " (")}${parts.join(theme.fg("dim", SYMBOLS.sep.dot))}${theme.fg("dim", ")")}` : "";
	const hint = formatExpandHint(theme, false, true);
	return `${theme.fg("dim", formatMoreItems(hidden.length, "agent"))}${breakdown}${hint ? ` ${hint}` : ""}`;
}

// ============================================================================
// Result renderer
// ============================================================================

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: RenderSubagentDetails; isError?: boolean },
	options: TaskRenderOptions,
	theme: ThemeLike,
	args?: TaskParamsLike,
): Component {
	const fallbackText = result.content.find((c) => c.type === "text")?.text ?? "";
	const details = result.details;
	const assignmentSection = createAssignmentSectionRenderer(args, theme);
	const contextSection = createContextSectionRenderer(args, theme);

	if (!details || details.results.length === 0) {
		// In-flight with nothing streamed yet: render nothing instead of an
		// empty frame that pops in and out at call start.
		if (options.isPartial) return emptyFramedComponent();
		const errored = result.isError === true;
		const header = renderStatusLine(
			{ icon: errored ? "error" : undefined, iconOverride: errored ? undefined : styledSymbol(SYMBOLS.status.done, "accent", theme), title: "Task", description: args?.agent?.trim() || undefined },
			theme,
		);
		return framedBlock(theme, (width) => ({
			header,
			sections: [
				...(contextSection ? [contextSection(width)] : []),
				...(assignmentSection ? [assignmentSection(width)] : []),
				...(fallbackText.trim() ? [{ separator: true, lines: [theme.fg("dim", truncateToWidth(fallbackText, width))] }] : []),
			],
			state: errored ? "error" : "success",
			borderColor: errored ? "error" : "borderMuted",
			width,
		}));
	}

	// Header counts (single pass)
	let abortedCount = 0, failCount = 0, successCount = 0, requestTotal = 0;
	let runningCount = 0;
	for (const r of details.results) {
		requestTotal += r.usage.turns ?? 0;
		const s = agentStatus(r);
		if (s === "aborted") abortedCount++;
		else if (s === "failed") failCount++;
		else if (s === "completed") successCount++;
		else runningCount++;
	}
	const isError = abortedCount > 0 || failCount > 0;
	const agentCount = details.results.length;
	const isRunning = runningCount > 0 && !options.expanded ? false : runningCount > 0 && options.isPartial;
	const icon: ToolUIStatus = isRunning ? "running" : isError ? "error" : "success";
	const countLabel = `${agentCount} ${agentCount === 1 ? "agent" : "agents"}`;
	const header = renderStatusLine(
		{
			icon: icon === "success" || icon === "running" ? undefined : icon,
			iconOverride:
				isRunning ? styledSymbol("⇶", "accent", theme)
				: icon === "success" ? styledSymbol(SYMBOLS.status.done, "accent", theme)
				: undefined,
			title: "Task",
			meta: [countLabel],
		},
		theme,
	);

	return framedBlock(theme, (width) => {
		const { expanded, isPartial } = options;
		// Earendel's ToolRenderResultOptions exposes no spinner frame, and `nowMs`
		// from the outer closure is frozen at renderResult-call time. The framed
		// block's `render(width)` re-invokes this `build` closure every frame (the
		// working Loader drives ~80ms re-renders via requestRender), so reading the
		// clock fresh here is what makes the spinner actually advance.
		const liveNowMs = Date.now();
		const spinnerFrame = Math.floor(liveNowMs / 80) % CIRCLE_SPINNER_FRAMES.length;
		const lines: string[] = [];

		if (isPartial && runningCount > 0) {
			// Live progress: finished sort to top, running pinned to bottom.
			const ordered = orderProgressForDisplay(details.results);
			const visible = expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
			if (visible.length < ordered.length) {
				lines.push(formatHiddenProgressLine(ordered.slice(0, ordered.length - visible.length), theme));
			}
			for (const r of visible) {
				lines.push(...renderAgentRow(r, "", "  ", expanded, theme, spinnerFrame, liveNowMs));
			}
		} else {
			const ordered = orderResultsForDisplay(details.results);
			const visible = expanded ? ordered : selectCollapsedResults(ordered);
			for (const r of visible) {
				const isLast = visible.indexOf(r) === visible.length - 1;
				const treePrefix = details.mode === "chain" ? getTreeBranch(r.step ? false : isLast, theme) : "";
				const contPrefix = details.mode === "chain" ? getTreeContinuePrefix(r.step ? false : isLast, theme) : "  ";
				const stepPrefix = r.step ? theme.fg("muted", `${r.step}. `) : "";
				// Inject step label into the id for chain rows.
				const row: RenderSingleResult = r.step ? { ...r, id: `${r.step}.${r.id}` } : r;
				const rendered = renderAgentRow(row, treePrefix, contPrefix, expanded, theme, spinnerFrame, liveNowMs);
				if (r.step) {
					// prefix the first line with the step number
					rendered[0] = rendered[0]!.replace(row.id, `${stepPrefix}${theme.fg("accent", theme.bold(formatTaskId(row.id)))}`);
				}
				lines.push(...rendered);
			}
			if (visible.length < ordered.length) {
				const hint = formatExpandHint(theme, false, true);
				lines.push(`${theme.fg("dim", formatMoreItems(ordered.length - visible.length, "agent"))}${hint ? ` ${hint}` : ""}`);
			}

			// Summary footer only when expanded — collapsed rows are one line each.
			if (expanded) {
				const summaryParts: string[] = [];
				if (abortedCount > 0) summaryParts.push(theme.fg("error", `${abortedCount} aborted`));
				if (successCount > 0) summaryParts.push(theme.fg("success", `${successCount} succeeded`));
				if (failCount > 0) summaryParts.push(theme.fg("error", `${failCount} failed`));
				if (requestTotal > 0) summaryParts.push(theme.fg("dim", `${formatNumber(requestTotal)} req`));
				summaryParts.push(theme.fg("dim", formatDuration(details.totalDurationMs)));
				lines.push(
					theme.fg("dim", SYMBOLS.format.bracketLeft) +
					summaryParts.join(theme.fg("dim", SYMBOLS.sep.dot)) +
					theme.fg("dim", SYMBOLS.format.bracketRight),
				);
			}
		}

		const state: State = isPartial && runningCount > 0 ? "running" : isError ? "error" : "success";
		const borderColor = isError ? "error" : "borderMuted";

		while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
		return {
			header,
			sections: [
				...(contextSection ? [contextSection(width)] : []),
				...(assignmentSection ? [assignmentSection(width)] : []),
				...(lines.length > 0 ? [{ separator: true, lines }] : []),
			],
			state,
			borderColor,
			width,
		};
	});
}

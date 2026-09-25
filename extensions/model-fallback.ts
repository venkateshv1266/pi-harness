import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { Component, Focusable, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const THINKING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** primary ref → fallback ref, same "provider/model:thinking" syntax as model roles in settings.json */
interface ModelFallbackSettings {
	failThreshold?: number;
	[key: string]: string | number | undefined;
}

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

function writeFallbackPair(primary: string, fallback: string | null): void {
	const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
	const current = settings.modelFallback;
	const pairs: Record<string, string | number | undefined> =
		current && typeof current === "object" && !Array.isArray(current)
			? { ...(current as ModelFallbackSettings) }
			: {};
	if (fallback === null) delete pairs[primary];
	else pairs[primary] = fallback;
	settings.modelFallback = pairs;
	writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function loadFallbackSettings(): { threshold: number; pairs: Record<string, string> } {
	try {
		const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
		const raw = settings.modelFallback;
		if (!raw || typeof raw !== "object") return { threshold: 1, pairs: {} };
		if (typeof raw === "string") return { threshold: 1, pairs: { "": raw } };
		const entries = Object.entries(raw as ModelFallbackSettings).filter(
			([k, v]) => k !== "failThreshold" && typeof v === "string",
		) as [string, string][];
		const threshold = typeof (raw as ModelFallbackSettings).failThreshold === "number"
			? (raw as ModelFallbackSettings).failThreshold!
			: 1;
		return { threshold, pairs: Object.fromEntries(entries) };
	} catch {
		return { threshold: 1, pairs: {} };
	}
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

function keyOf(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function findFallbackRef(pairs: Record<string, string>, model: Model<Api>): string | undefined {
	const full = keyOf(model);
	if (pairs[full] !== undefined) return pairs[full];
	if (pairs[model.id] !== undefined) return pairs[model.id];
	for (const [k, v] of Object.entries(pairs)) {
		if (model.id.includes(k)) return v;
	}
	return undefined;
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

function trunc(s: string, max: number): string {
	return visibleWidth(s) <= max ? s : truncateToWidth(s, max, "");
}

export type PickerRow = { label: string; meta?: string; description?: string };

// Searchable fuzzy picker: type to filter, ↑↓ navigate, Enter to pick, Esc to cancel.
export class FilterablePicker implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly kb: KeybindingsManager;
	private readonly title: string;
	private readonly rows: PickerRow[];
	private readonly maxVisible: number;
	private readonly onPick: (row: PickerRow) => void;
	private readonly onCancel: () => void;
	private readonly input = new Input();
	private filtered: PickerRow[];
	private selected = 0;
	private _focused = false;

	constructor(opts: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		title: string;
		rows: PickerRow[];
		maxVisible?: number;
		onPick: (row: PickerRow) => void;
		onCancel: () => void;
	}) {
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.kb = opts.keybindings;
		this.title = opts.title;
		this.rows = opts.rows;
		// Description lines double row height — halve the visible window so the picker stays a sane size.
		this.maxVisible = opts.maxVisible ?? (opts.rows.some((r) => r.description) ? 6 : 12);
		this.onPick = opts.onPick;
		this.onCancel = opts.onCancel;
		this.filtered = opts.rows;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	private applyFilter(): void {
		const query = this.input.getValue().trim().toLowerCase();
		this.filtered = query
			? this.rows.filter((r) => `${r.label} ${r.description ?? ""} ${r.meta ?? ""}`.toLowerCase().includes(query))
			: this.rows;
		this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
	}

	render(width: number): string[] {
		const theme = this.theme;
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const lines: string[] = [];
		lines.push(...border.render(width));
		lines.push(theme.fg("accent", theme.bold(trunc(` ${this.title}`, width - 2))));
		lines.push(theme.fg("dim", ` ${this.rows.length} models · type to filter`));
		lines.push(...this.input.render(width));

		if (this.filtered.length === 0) {
			lines.push(theme.fg("warning", "  No matches"));
		} else {
			const nameWidth = Math.min(48, Math.max(...this.rows.map((r) => visibleWidth(r.label))) + 1);
			const start = Math.max(
				0,
				Math.min(this.selected - Math.floor(this.maxVisible / 2), this.filtered.length - this.maxVisible),
			);
			const end = Math.min(start + this.maxVisible, this.filtered.length);
			for (let i = start; i < end; i++) {
				const row = this.filtered[i];
				if (!row) continue;
				const isSel = i === this.selected;
				const prefix = isSel ? "→ " : "  ";
				const label = row.label + " ".repeat(Math.max(1, nameWidth - visibleWidth(row.label)));
				const styledLabel = isSel ? theme.fg("accent", prefix + label) : prefix + label;
				const meta = row.meta ? theme.fg("dim", row.meta) : "";
				lines.push(truncateToWidth(styledLabel + meta, width, ""));
				if (row.description) {
					lines.push(truncateToWidth(theme.fg("dim", `     ${row.description}`), width, ""));
				}
			}
			if (start > 0 || end < this.filtered.length) {
				lines.push(theme.fg("dim", `  (${this.selected + 1}/${this.filtered.length})`));
			}
		}
		lines.push(
			theme.fg(
				"dim",
				`  ${keyHint("tui.select.confirm", "select")} · ${keyHint("tui.select.cancel", "cancel")} · ↑↓ navigate`,
			),
		);
		lines.push(...border.render(width));
		return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width, "") : l));
	}

	handleInput(data: string): void {
		if (this.kb.matches(data, "tui.select.up")) {
			if (this.filtered.length > 0) {
				this.selected = this.selected === 0 ? this.filtered.length - 1 : this.selected - 1;
			}
		} else if (this.kb.matches(data, "tui.select.down")) {
			if (this.filtered.length > 0) {
				this.selected = this.selected === this.filtered.length - 1 ? 0 : this.selected + 1;
			}
		} else if (this.kb.matches(data, "tui.select.confirm")) {
			const row = this.filtered[this.selected];
			if (row) this.onPick(row);
			return;
		} else if (this.kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		} else {
			this.input.handleInput(data);
			this.applyFilter();
		}
		this.tui.requestRender();
	}

	invalidate(): void {}
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "warning") {
	if (ctx.hasUI) {
		ctx.ui.notify(text, level);
	} else {
		process.stderr.write(`[model-fallback] ${text}\n`);
	}
}

const SHARED_INFRA_WINDOW_MS = 60_000;
const MAX_AUTO_RESUMES = 2;
const RESUME_MARKER =
	"[model-fallback] The previous attempt died mid-run on a transient provider error. Please redo or continue the last user request above.";

// Transport-level failures kill every model behind the connection equally — switching
// cannot help, and auto-resuming would just ping-pong between fallback pairs.
const TRANSPORT_ERROR_PATTERN = new RegExp(
	[
		"fetch failed",
		"getaddrinfo",
		"ENOTFOUND",
		"EAI_AGAIN",
		"ECONNREFUSED",
		"ECONNRESET",
		"connection (?:error|refused|reset|lost)",
		"other side closed",
		"socket hang up",
		"socket connection was closed",
		"upstream connect",
		"reset before headers",
		"terminated",
		"ended without",
		"stream ended before",
		"websocket (?:closed|error)",
		"network error",
	].join("|"),
	"i",
);

export default function (pi: ExtensionAPI) {
	const failCounts = new Map<string, number>();
	const lastFailedAt = new Map<string, number>();
	let switching = false;
	let switchedDuringRun = false;
	let resumePending = false;
	let autoResumes = 0;
	const visitedModels = new Set<string>();

	function isAbortish(errorMessage: string | undefined): boolean {
		return !!errorMessage && /abort|cancel/i.test(errorMessage);
	}

	function isTransportError(errorMessage: string | undefined): boolean {
		return !!errorMessage && TRANSPORT_ERROR_PATTERN.test(errorMessage);
	}

	function recordFailure(ctx: ExtensionContext, statusDesc: string): boolean {
		if (ctx.signal?.aborted) return false;
		const model = ctx.model;
		if (!model) return false;
		const key = keyOf(model);
		const { threshold, pairs } = loadFallbackSettings();
		const count = (failCounts.get(key) ?? 0) + 1;
		failCounts.set(key, count);
		lastFailedAt.set(key, Date.now());

		if (switching || count < threshold) return false;
		const now = Date.now();
		const sibling = [...lastFailedAt.entries()].find(
			([k, t]) => k !== key && now - t < SHARED_INFRA_WINDOW_MS,
		);
		if (sibling) {
			notify(
				ctx,
				`${key} failed ${count}x (${statusDesc}) and ${sibling[0]} failed ${Math.round((now - sibling[1]) / 1000)}s ago — shared network/infra issue, not switching`,
				"error",
			);
			return false;
		}
		const fallbackSpec = findFallbackRef(pairs, model);
		if (!fallbackSpec) return false;

		const { ref, thinking } = parseRef(fallbackSpec);
		const target = resolveModel(ctx, ref);
		if (!target) {
			notify(ctx, `Fallback model "${ref}" not found in registry`, "error");
			return false;
		}
		const targetKey = keyOf(target);
		if (targetKey === key || visitedModels.has(targetKey)) return false;

		switching = true;
		visitedModels.add(targetKey);
		void (async () => {
			try {
				const ok = await pi.setModel(target);
				if (!ok) {
					notify(ctx, `No auth for fallback ${targetKey}; staying on ${key}`, "error");
					return;
				}
				if (thinking) pi.setThinkingLevel(thinking);
				failCounts.set(targetKey, 0);
				switchedDuringRun = true;
				notify(
					ctx,
					`${key} failed ${count}x (${statusDesc}) → fell back to ${targetKey}` +
						(thinking ? ` @ ${thinking} thinking` : ""),
				);
			} finally {
				switching = false;
			}
		})();
		return true;
	}

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.signal?.aborted) return;
		if (event.status === 429 || event.status >= 500) {
			recordFailure(ctx, `HTTP ${event.status}`);
		} else if (event.status < 400 && ctx.model) {
			failCounts.set(keyOf(ctx.model), 0);
			lastFailedAt.delete(keyOf(ctx.model));
		}
	});

	// Auto-resume runs continue the same logical prompt as the run that died; only an
	// outside-initiated run (new prompt, /retry, queued steer) may reset the fallback
	// epoch — otherwise the guards below are cleared by the very loop they guard.
	pi.on("agent_start", () => {
		switchedDuringRun = false;
		if (!resumePending) {
			visitedModels.clear();
			autoResumes = 0;
		}
		resumePending = false;
	});

	// Catches stream-level errors (timeouts, mid-body disconnects) that never produce an HTTP status.
	pi.on("turn_end", (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant" || msg.stopReason !== "error" || isAbortish(msg.errorMessage)) return;
		// Attribute the failure to the model that produced it, not whichever model is current now
		// (a mid-run switch may already have happened for this same failed attempt).
		if (ctx.model && msg.provider && msg.model !== ctx.model.id) return;
		if (isTransportError(msg.errorMessage)) {
			notify(
				ctx,
				`Network error (${msg.errorMessage?.slice(0, 80) ?? "stream error"}) — not switching models; re-send your prompt once connectivity is back`,
				"error",
			);
			return;
		}
		recordFailure(ctx, msg.errorMessage?.slice(0, 120) ?? "stream error");
	});

	// Retries exhausted and the run died on a real model error after a mid-run switch:
	// resume on the fallback model with a short marker — the original prompt is already
	// in the branch, so re-sending its full text would only balloon the context.
	pi.on("agent_settled", (_event, ctx) => {
		if (!switchedDuringRun || ctx.signal?.aborted) return;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as { type?: string; message?: { role?: string; stopReason?: string; errorMessage?: string } };
			const msg = entry.message;
			if (entry.type === "message" && msg?.role === "assistant") {
				if (msg.stopReason === "error" && !isAbortish(msg.errorMessage)) {
					if (autoResumes >= MAX_AUTO_RESUMES) {
						switchedDuringRun = false;
						notify(
							ctx,
							`Auto-resume limit (${MAX_AUTO_RESUMES}) reached — staying on ${keyOf(ctx.model!)}; fix the underlying issue and re-send your prompt`,
							"warning",
						);
					} else {
						switchedDuringRun = false;
						autoResumes++;
						resumePending = true;
						notify(ctx, `Resuming on ${keyOf(ctx.model!)} (auto-resume ${autoResumes}/${MAX_AUTO_RESUMES})`);
						void pi.sendUserMessage(RESUME_MARKER, { deliverAs: "followUp" });
					}
				}
				break;
			}
		}
	});

	pi.registerCommand("fallback", {
		description: "Manage model fallback pairs (/fallback, /fallback add, /fallback remove)",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "add") {
				await addPair(ctx, rest);
				return;
			}
			if (sub === "remove") {
				await removePair(ctx, rest[0]);
				return;
			}
			if (sub && sub !== "list") {
				notify(ctx, `Unknown subcommand "${sub}". Use /fallback, /fallback add, /fallback remove.`, "error");
				return;
			}
			const { threshold, pairs } = loadFallbackSettings();
			const pairLines = Object.entries(pairs)
				.map(([k, v]) => `  ${k} → ${v}`)
				.join("\n");
			const counts = [...failCounts.entries()].filter(([, c]) => c > 0).map(([k, c]) => `${k}: ${c}`).join(", ");
			notify(
				ctx,
				`pairs:\n${pairLines || "  (none configured)"}\nthreshold: ${threshold} · auto-resume cap: ${MAX_AUTO_RESUMES} · shared-infra window: ${SHARED_INFRA_WINDOW_MS / 1000}s\nfailures: ${counts || "none"}\nconfig: ${SETTINGS_PATH} → "modelFallback"\n\n/fallback add [primary fallback [thinking]] · /fallback remove [primary]`,
				"info",
			);
		},
	});

	async function addPair(ctx: ExtensionContext, rest: string[]): Promise<void> {
		const available = ctx.modelRegistry.getAvailable();
		const modelRows: PickerRow[] = available.map((m) => ({
			label: keyOf(m),
			meta: m.reasoning ? "reasoning" : "",
			description: `${m.name} · ctx ${Math.round(m.contextWindow / 1000)}k`,
		}));

		async function pickModel(title: string, preselect?: string): Promise<string | undefined> {
			if (preselect) {
				const resolved = resolveModel(ctx, preselect);
				if (resolved) return keyOf(resolved);
				notify(ctx, `Model "${preselect}" not found in registry`, "error");
				return undefined;
			}
			if (ctx.mode === "tui") {
				const picked = await ctx.ui.custom<PickerRow | null>((tui, theme, kb, done) =>
					new FilterablePicker({
						tui,
						theme,
						keybindings: kb,
						title,
						rows: modelRows,
						onPick: done,
						onCancel: () => done(null),
					}),
				);
				return picked?.label;
			}
			return ctx.ui.select(title, modelRows.map((r) => r.label));
		}

		async function pickThinking(): Promise<string> {
			const levels = ["(keep current)", ...THINKING_LEVELS];
			const choice = await ctx.ui.select("Fallback thinking level:", levels);
			return choice && choice !== "(keep current)" ? `:${choice}` : "";
		}

		const [primaryArg, fallbackArg, thinkingArg] = rest;
		const primary = await pickModel("Primary model (gets the fallback):", primaryArg);
		if (!primary) return;

		const fallback = await pickModel("Fallback model:", fallbackArg);
		if (!fallback) return;
		if (fallback === primary) {
			notify(ctx, "Primary and fallback must differ", "error");
			return;
		}

		let suffix = "";
		if (thinkingArg) {
			if (!THINKING_LEVELS.includes(thinkingArg as ThinkingLevel)) {
				notify(ctx, `Thinking level must be one of: ${THINKING_LEVELS.join(" ")}`, "error");
				return;
			}
			suffix = `:${thinkingArg}`;
		} else {
			suffix = await pickThinking();
		}

		writeFallbackPair(primary, fallback + suffix);
		notify(ctx, `Saved: ${primary} → ${fallback}${suffix}`, "info");
	}

	async function removePair(ctx: ExtensionContext, primaryArg?: string): Promise<void> {
		const { pairs } = loadFallbackSettings();
		const keys = Object.keys(pairs).filter((k) => k !== "failThreshold");
		if (keys.length === 0) {
			notify(ctx, "No fallback pairs configured", "info");
			return;
		}
		const primary = primaryArg ?? (await ctx.ui.select("Remove which pair:", keys));
		if (!primary) return;
		const match = keys.find((k) => k === primary) ?? keys.find((k) => k.includes(primary));
		if (!match) {
			notify(ctx, `No pair for "${primary}"`, "error");
			return;
		}
		writeFallbackPair(match, null);
		notify(ctx, `Removed: ${match}`, "info");
	}
}

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, KeybindingsManager, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import { THINKING_LEVELS, availableModels, keyOf, prettyRef } from "./io.ts";
import type { EnumOption, SetupItem, SetupSection } from "./types.ts";

const CLEAR = "__remove";

type Mode = "browse" | "enum" | "model" | "pair" | "input" | "help" | "filter";

interface Row {
	section: SetupSection;
	item: SetupItem;
	sectionIdx: number;
	itemIdx: number;
}

function effectColor(effect?: string): "success" | "accent" | "warning" | "muted" {
	if (!effect) return "muted";
	const e = effect.toLowerCase();
	if (e.includes("immediately") || e.includes("next request") || e.includes("next prompt")) return "success";
	if (e.includes("next start") || e.includes("restart") || e.includes("new sessions")) return "warning";
	return "accent";
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

export class SetupWindow implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly kb: KeybindingsManager;
	private readonly ctx: ExtensionCommandContext;
	private readonly refresh: () => SetupSection[];
	private readonly onDone: (changes: string[]) => void;

	private sections: SetupSection[];
	private active: number;
	private scroll = 0;
	private sel = 0;
	private mode: Mode = "browse";
	private editingRow: Row | undefined;

	// enum editor (also reused for the thinking-level step of model edits)
	private enumIdx = 0;
	private enumList: EnumOption[] = [];

	// model / pair editors
	private modelInput = new Input();
	private modelFiltered: Model<never>[] = [];
	private modelSel = 0;
	private modelPhase: "model" | "thinking" = "model";
	private pendingRef = "";
	private pairPrimary = "";
	private pairStep: 1 | 2 = 1;

	// text input editor
	private textInput = new Input();

	// filter
	private filterInput = new Input();

	private flash: { text: string; ok: boolean } | undefined;
	private changes: string[] = [];

	// layout memo for mouse hit-testing
	private bodyTop = 4;
	private bodyRows = 10;
	private leftW = 40;

	private _focused = false;

	constructor(opts: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		ctx: ExtensionCommandContext;
		sections: SetupSection[];
		refresh: () => SetupSection[];
		onDone: (changes: string[]) => void;
		initialActive?: number;
	}) {
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.kb = opts.keybindings;
		this.ctx = opts.ctx;
		this.sections = opts.sections;
		this.refresh = opts.refresh;
		this.onDone = opts.onDone;
		this.active = clamp(opts.initialActive ?? 0, 0, Math.max(0, this.sections.length - 1));
	}

	// ─── Focusable (propagate IME focus to whichever Input is live) ─────────

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		const activeInput =
			this.mode === "filter" ? this.filterInput : this.mode === "input" ? this.textInput : this.mode === "model" || this.mode === "pair" ? this.modelInput : undefined;
		if (activeInput) activeInput.focused = value;
	}

	// ─── Data ───────────────────────────────────────────────────────────────

	private allRows(): Row[] {
		const out: Row[] = [];
		this.sections.forEach((section, sectionIdx) => {
			section.items.forEach((item, itemIdx) => out.push({ section, item, sectionIdx, itemIdx }));
		});
		return out;
	}

	private filterActive(): boolean {
		return this.filterInput.getValue().trim().length > 0;
	}

	private visibleRows(): Row[] {
		const q = this.filterInput.getValue().trim().toLowerCase();
		if (q) {
			return this.allRows().filter((r) => `${r.section.title} ${r.item.label}`.toLowerCase().includes(q));
		}
		const section = this.sections[this.active];
		if (!section) return [];
		return section.items.map((item, itemIdx) => ({ section, item, sectionIdx: this.active, itemIdx }));
	}

	private currentRow(): Row | undefined {
		return this.visibleRows()[this.sel];
	}

	/** Rebuild sections (fresh disk state), keeping the selection on the same item. */
	private refreshData(): void {
		const before = this.currentRow();
		const key = before ? `${before.section.id}/${before.item.id}` : undefined;
		this.sections = this.refresh();
		if (key) {
			for (const [sectionIdx, section] of this.sections.entries()) {
				const itemIdx = section.items.findIndex((it) => `${section.id}/${it.id}` === key);
				if (itemIdx >= 0) {
					this.active = sectionIdx;
					this.sel = itemIdx;
					break;
				}
			}
		}
	}

	private resolveOptions(item: SetupItem): EnumOption[] {
		if (!item.options) return [];
		return typeof item.options === "function" ? item.options(this.ctx) : item.options;
	}

	// ─── Editor state transitions ───────────────────────────────────────────

	private resetEditorChrome(): void {
		this.flash = undefined;
	}

	private openEnumEditor(row: Row): void {
		this.enumList = this.resolveOptions(row.item);
		if (this.enumList.length === 0) return;
		const cur = row.item.get(this.ctx);
		const match = this.enumList.findIndex((o) => o.value === cur);
		this.enumIdx = match >= 0 ? match : 0;
		this.mode = "enum";
		this.editingRow = row;
	}

	private syncModelList(): void {
		const q = this.modelInput.getValue().trim().toLowerCase();
		const prev = this.modelFiltered[this.modelSel] ? keyOf(this.modelFiltered[this.modelSel]) : "";
		const models = availableModels(this.ctx);
		this.modelFiltered = q
			? models.filter((m) => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(q))
			: models;
		if (prev) {
			const idx = this.modelFiltered.findIndex((m) => keyOf(m) === prev);
			if (idx >= 0) {
				this.modelSel = idx;
				return;
			}
		}
		this.modelSel = Math.min(this.modelSel, Math.max(0, this.modelFiltered.length - 1));
	}

	private openModelEditor(row: Row): void {
		this.mode = "model";
		this.modelPhase = "model";
		this.editingRow = row;
		this.modelInput = new Input();
		this.modelInput.focused = this._focused;
		this.syncModelList();
		const cur = row.item.get(this.ctx);
		const bare = cur.startsWith("(") ? "" : cur.split(":")[0];
		const idx = this.modelFiltered.findIndex((m) => keyOf(m) === bare);
		this.modelSel = idx >= 0 ? idx : 0;
	}

	private openPairEditor(row: Row): void {
		this.mode = "pair";
		this.modelPhase = "model";
		this.editingRow = row;
		this.pairStep = 1;
		this.pendingRef = "";
		this.modelInput = new Input();
		this.modelInput.focused = this._focused;
		this.syncModelList();
		this.modelSel = 0;
	}

	private toThinkingStep(ref: string): void {
		this.pendingRef = ref;
		this.modelPhase = "thinking";
		this.enumList = [
			{ value: "none", label: "no suffix (use model default)" },
			...THINKING_LEVELS.map((l) => ({ value: l, label: l })),
		];
		this.enumIdx = 0;
	}

	private openInputEditor(row: Row): void {
		this.mode = "input";
		this.editingRow = row;
		this.textInput = new Input();
		this.textInput.focused = this._focused;
	}

	private exitEdit(): void {
		this.mode = "browse";
		this.editingRow = undefined;
		this.modelPhase = "model";
		this.tui.requestRender();
	}

	private async applyValue(row: Row | undefined, value: string): Promise<void> {
		if (!row) return;
		const item = row.item;
		if (!item.apply) return;
		try {
			const msg = await item.apply(this.ctx, value);
			const ok = !msg.startsWith("✗");
			this.flash = { text: msg, ok };
			if (ok) {
				this.changes.push(msg);
				this.refreshData();
			}
		} catch (error) {
			this.flash = { text: `✗ ${error instanceof Error ? error.message : String(error)}`, ok: false };
		}
		this.tui.requestRender();
	}

	// ─── Input handling ─────────────────────────────────────────────────────

	handleInput(data: string): void {
		switch (this.mode) {
			case "help":
				this.mode = "browse";
				break;
			case "enum":
				this.handleEnumInput(data);
				break;
			case "model":
			case "pair":
				this.handleModelInput(data);
				break;
			case "input":
				this.handleTextInput(data);
				break;
			case "filter":
				this.handleFilterInput(data);
				break;
			default:
				this.handleBrowseInput(data);
		}
		this.tui.requestRender();
	}

	private moveSel(delta: number): void {
		const rows = this.visibleRows();
		if (rows.length === 0) return;
		this.sel = (this.sel + delta + rows.length) % rows.length;
		const row = rows[this.sel];
		if (row && row.sectionIdx !== this.active && this.mode === "filter") this.active = row.sectionIdx;
	}

	private jumpSection(delta: number): void {
		this.active = (this.active + delta + this.sections.length) % this.sections.length;
		this.sel = 0;
	}

	private handleBrowseInput(data: string): void {
		if (this.kb.matches(data, "tui.select.up") || matchesKey(data, Key.up) || data === "k") {
			this.moveSel(-1);
		} else if (this.kb.matches(data, "tui.select.down") || matchesKey(data, Key.down) || data === "j") {
			this.moveSel(1);
		} else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
			this.jumpSection(-1);
		} else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.jumpSection(1);
		} else if (this.kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			if (this.filterActive()) {
				this.filterInput.setValue("");
				this.sel = 0;
			} else {
				this.onDone(this.changes);
			}
		} else if (this.kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
			void this.activate(this.currentRow());
		} else if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
			void this.removeRow(this.currentRow());
		} else if (data === "/") {
			this.filterInput = new Input();
			this.filterInput.focused = this._focused;
			this.mode = "filter";
		} else if (data === "?") {
			this.mode = "help";
		} else if (data === "g") {
			this.sel = 0;
		} else if (data === "G") {
			this.sel = Math.max(0, this.visibleRows().length - 1);
		}
	}

	private async activate(row: Row | undefined): Promise<void> {
		if (!row) return;
		const item = row.item;
		if (item.kind === "info") return;
		if (item.kind === "toggle") {
			const cur = item.get(this.ctx);
			await this.applyValue(row, cur === "on" ? "off" : "on");
			return;
		}
		if (item.kind === "action") {
			if (item.run) {
				try {
					const msg = await item.run(this.ctx);
					this.flash = { text: msg, ok: !msg.startsWith("✗") };
					if (!msg.startsWith("✗")) {
						this.changes.push(msg);
						this.refreshData();
					}
				} catch (error) {
					this.flash = { text: `✗ ${error instanceof Error ? error.message : String(error)}`, ok: false };
				}
			}
			return;
		}
		if (item.kind === "enum") {
			this.resetEditorChrome();
			this.openEnumEditor(row);
			return;
		}
		if (item.kind === "model") {
			this.resetEditorChrome();
			this.openModelEditor(row);
			return;
		}
		if (item.kind === "model-pair") {
			this.resetEditorChrome();
			this.openPairEditor(row);
			return;
		}
		if (item.kind === "number" || item.kind === "text") {
			this.resetEditorChrome();
			this.openInputEditor(row);
		}
	}

	private async removeRow(row: Row | undefined): Promise<void> {
		if (!row?.item.removable || !row.item.apply) return;
		await this.applyValue(row, CLEAR);
	}

	private handleEnumInput(data: string): void {
		const row = this.editingRow;
		if (!row) {
			this.exitEdit();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.exitEdit();
		} else if (matchesKey(data, Key.up)) {
			this.enumIdx = (this.enumIdx - 1 + this.enumList.length) % this.enumList.length;
		} else if (matchesKey(data, Key.down)) {
			this.enumIdx = (this.enumIdx + 1) % this.enumList.length;
		} else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			const delta = matchesKey(data, Key.left) ? -1 : 1;
			this.enumIdx = (this.enumIdx + delta + this.enumList.length) % this.enumList.length;
		} else if (matchesKey(data, Key.enter)) {
			const opt = this.enumList[this.enumIdx];
			if (opt) {
				void this.applyValue(row, opt.value).then(() => this.exitEdit());
			}
		}
	}

	private handleModelInput(data: string): void {
		const row = this.editingRow;
		if (!row) {
			this.exitEdit();
			return;
		}
		if (this.modelPhase === "thinking") return this.handleThinkingInput(data, row);

		if (matchesKey(data, Key.escape)) {
			this.exitEdit();
		} else if (this.kb.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
			this.modelSel = Math.max(0, this.modelSel - 1);
		} else if (this.kb.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
			this.modelSel = Math.min(this.modelFiltered.length - 1, this.modelSel + 1);
		} else if (matchesKey(data, Key.enter) || this.kb.matches(data, "tui.select.confirm")) {
			const model = this.modelFiltered[this.modelSel];
			if (!model) return;
			if (this.mode === "pair") {
				if (this.pairStep === 1) {
					this.pairPrimary = keyOf(model);
					this.pendingRef = this.pairPrimary;
					this.pairStep = 2;
					this.modelInput = new Input();
					this.modelInput.focused = this._focused;
					this.syncModelList();
					this.modelSel = 0;
					return;
				}
				if (row.item.withThinking) {
					this.toThinkingStep(keyOf(model));
					return;
				}
				void this.applyValue(row, `${this.pairPrimary}>${keyOf(model)}`).then(() => this.exitEdit());
				return;
			}
			if (row.item.withThinking) {
				this.toThinkingStep(keyOf(model));
				return;
			}
			void this.applyValue(row, keyOf(model)).then(() => this.exitEdit());
		} else {
			this.modelInput.handleInput(data);
			this.syncModelList();
			this.modelSel = Math.min(this.modelSel, Math.max(0, this.modelFiltered.length - 1));
		}
	}

	private handleThinkingInput(data: string, row: Row): void {
		if (matchesKey(data, Key.escape)) {
			this.modelPhase = "model";
		} else if (matchesKey(data, Key.up)) {
			this.enumIdx = (this.enumIdx - 1 + this.enumList.length) % this.enumList.length;
		} else if (matchesKey(data, Key.down)) {
			this.enumIdx = (this.enumIdx + 1) % this.enumList.length;
		} else if (matchesKey(data, Key.enter)) {
			const opt = this.enumList[this.enumIdx];
			if (opt) {
				const ref = opt.value === "none" ? this.pendingRef : `${this.pendingRef}:${opt.value}`;
				const value = this.mode === "pair" ? `${this.pairPrimary}>${ref}` : ref;
				void this.applyValue(row, value).then(() => this.exitEdit());
			}
		}
	}

	private handleTextInput(data: string): void {
		const row = this.editingRow;
		const item = row?.item;
		if (matchesKey(data, Key.escape)) {
			this.exitEdit();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const raw = this.textInput.getValue().trim();
			if (!item?.apply) return;
			if (item.kind === "number") {
				const num = Number(raw);
				if (raw === "" || Number.isNaN(num)) {
					this.flash = { text: `✗ not a number: ${raw}`, ok: false };
					return;
				}
				const clamped = clamp(num, item.min ?? num, item.max ?? num);
				void this.applyValue(row, String(clamped)).then(() => this.exitEdit());
				return;
			}
			if (!row) return;
			void this.applyValue(row, raw).then(() => this.exitEdit());
			return;
		}
		this.textInput.handleInput(data);
	}

	private handleFilterInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.filterInput.setValue("");
			this.mode = "browse";
			this.sel = 0;
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.mode = "browse";
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveSel(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveSel(1);
			return;
		}
		this.filterInput.handleInput(data);
		this.sel = 0;
	}

	// ─── Mouse ──────────────────────────────────────────────────────────────

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			this.moveSel(event.wheelDelta > 0 ? -3 : 3);
			return { handled: true };
		}
		if (event.type !== "click" && event.type !== "press") return undefined;
		const localRow = event.y;
		if (localRow < this.bodyTop || localRow >= this.bodyTop + this.bodyRows) return undefined;
		if (event.x > this.leftW) return undefined;
		const rows = this.visibleRows();
		const idx = this.scroll + (localRow - this.bodyTop);
		if (idx >= rows.length) return undefined;
		if (idx === this.sel && this.mode === "browse") {
			void this.activate(rows[idx]);
		} else {
			this.sel = idx;
			const row = rows[idx];
			if (row) this.active = row.sectionIdx;
		}
		return { handled: true };
	}

	invalidate(): void {}

	// ─── Rendering ──────────────────────────────────────────────────────────

	render(width: number): string[] {
		const theme = this.theme;
		const totalRows = Math.max(16, (process.stdout.rows ?? 40) - 1);
		const inner = Math.max(20, width - 2);
		this.leftW = Math.min(110, Math.max(30, Math.floor(inner * 0.55)));
		const rightW = inner - this.leftW - 1;
		this.bodyRows = Math.max(4, totalRows - 6);
		this.bodyTop = 4;

		const border = (s: string) => theme.fg("borderMuted", s);
		const lines: string[] = [];
		lines.push(border("╭" + "─".repeat(inner) + "╮"));
		lines.push(this.renderTitleLine(inner));
		const tabs = this.renderTabs(inner - 1);
		lines.push(border("│") + tabs + " ".repeat(Math.max(0, inner - 1 - visibleWidth(tabs))) + " " + border("│"));
		lines.push(border("├" + "─".repeat(this.leftW) + "┬" + "─".repeat(rightW) + "┤"));

		const leftGapW = this.leftW - 1;
		const rightGapW = rightW - 2;
		const leftLines = this.renderLeft(leftGapW, this.bodyRows);
		const rightLines = this.renderRight(rightGapW, this.bodyRows);
		for (let i = 0; i < this.bodyRows; i++) {
			const l = truncateToWidth(leftLines[i] ?? "", leftGapW, "");
			const r = truncateToWidth(rightLines[i] ?? "", rightGapW, "");
			const lPad = l + " ".repeat(Math.max(0, leftGapW - visibleWidth(l)));
			const rPad = r + " ".repeat(Math.max(0, rightGapW - visibleWidth(r)));
			lines.push(border("│") + lPad + " " + border("│") + " " + rPad + " " + border("│"));
		}

		lines.push(this.renderStatusLine(inner));
		lines.push(border("╰" + "─".repeat(inner) + "╯"));
		return lines.slice(0, totalRows).map((l) => truncateToWidth(l, width, ""));
	}

	private renderTitleLine(inner: number): string {
		const theme = this.theme;
		const title = ` ⚙ pi setup — ${this.sections[this.active]?.title ?? ""} `;
		const help = this.mode === "browse" ? "? help · esc close " : "esc back ";
		const t = truncateToWidth(title, Math.max(4, inner - visibleWidth(help) - 1), "");
		const pad = Math.max(1, inner - visibleWidth(t) - visibleWidth(help));
		return (
			this.theme.fg("borderMuted", "│") +
			theme.fg("accent", theme.bold(t)) +
			" ".repeat(pad) +
			theme.fg("dim", help) +
			this.theme.fg("borderMuted", "│")
		);
	}

	private renderTabs(inner: number): string {
		const theme = this.theme;
		const labels = this.sections.map((s) => s.title);
		let startIdx = this.active;
		// grow the window outwards from the active tab until it stops fitting
		let endIdx = this.active;
		let used = visibleWidth(labels[this.active] ?? "") + 4;
		while (endIdx < labels.length - 1 && used + visibleWidth(labels[endIdx + 1]) + 3 <= inner - 4) {
			endIdx++;
			used += visibleWidth(labels[endIdx]) + 3;
		}
		while (startIdx > 0 && used + visibleWidth(labels[startIdx - 1]) + 3 <= inner - 4) {
			startIdx--;
			used += visibleWidth(labels[startIdx]) + 3;
		}
		let out = " ";
		if (startIdx > 0) out += theme.fg("dim", "… ");
		for (let i = startIdx; i <= endIdx; i++) {
			const last = i === endIdx;
			const sep = theme.fg("dim", last ? "" : " · ");
			const label = i === this.active ? theme.fg("accent", theme.bold(`[${labels[i]}]`)) : theme.fg("muted", labels[i]);
			out += label + sep;
		}
		if (endIdx < labels.length - 1) out += theme.fg("dim", " …");
		return truncateToWidth(out, inner, "");
	}

	private renderStatusLine(inner: number): string {
		const theme = this.theme;
		const rows = this.visibleRows();
		const metaText = ` ${this.sections[this.active]?.title ?? ""} ${this.sel + 1}/${rows.length} `;
		const metaW = visibleWidth(metaText);
		const meta = theme.fg("dim", metaText);
		const hint = truncateToWidth(theme.fg("dim", this.modeHint()), Math.max(4, inner - metaW - 2), "");
		let flashText = "";
		if (this.flash) {
			const pretty = prettyRef(this.flash.text);
			flashText = this.flash.ok ? theme.fg("success", `✓ ${pretty}`) : theme.fg("error", pretty);
		}
		const flashVisible = flashText
			? truncateToWidth(flashText, Math.max(0, inner - visibleWidth(hint) - metaW - 2), "")
			: "";
		const pad = Math.max(1, inner - visibleWidth(hint) - visibleWidth(flashVisible) - metaW);
		return theme.fg("borderMuted", "│") + hint + " ".repeat(pad) + flashVisible + meta + theme.fg("borderMuted", "│");
	}

	private modeHint(): string {
		switch (this.mode) {
			case "enum":
				return "↑↓ pick · ←→ cycle · enter apply · esc cancel";
			case "model":
				return "type to filter · ↑↓ move · enter pick · esc cancel";
			case "pair":
				return `pick ${this.pairStep === 1 ? "primary" : "fallback"} · enter pick · esc cancel`;
			case "input":
				return "type value · enter apply · esc cancel";
			case "filter":
				return "filter all sections · enter accept · esc clear";
			case "help":
				return "any key to return";
			default:
				return "↑↓ move · ←→ section · enter edit · ⌫ remove · / filter · ? help";
		}
	}

	private renderLeft(w: number, rows: number): string[] {
		if (this.mode === "model" || this.mode === "pair") return this.renderModelList(w, rows);

		const theme = this.theme;
		const lines: string[] = [];
		if (this.mode === "filter") {
			lines.push(" " + theme.fg("accent", "/ ") + (this.filterInput.render(Math.max(1, w - 3))[0] ?? ""));
		} else if (this.mode === "input") {
			lines.push(" " + theme.fg("accent", "> ") + (this.textInput.render(Math.max(1, w - 3))[0] ?? ""));
			lines.push("");
		}

		const listRows = Math.max(1, rows - lines.length);
		const visible = this.visibleRows();
		const start = clamp(this.sel - Math.floor(listRows / 2), 0, Math.max(0, visible.length - listRows));
		for (let i = 0; i < listRows; i++) {
			const row = visible[start + i];
			lines.push(row ? this.renderRow(row, w, start + i === this.sel) : "");
		}
		return lines;
	}

	private renderRow(row: Row, w: number, isSel: boolean): string {
		const theme = this.theme;
		const prefix = isSel ? theme.fg("accent", "→ ") : "  ";
		const value = prettyRef(safeGet(row.item, this.ctx));
		const label = prettyRef(row.item.label);
		const labelW = clamp(Math.floor(w * 0.48), 12, 44);
		const padded =
			visibleWidth(label) > labelW ? truncateToWidth(label, labelW, "…") : label + " ".repeat(labelW - visibleWidth(label));
		const labelText = isSel ? padded : theme.fg("muted", padded);
		const valueMax = Math.max(4, w - labelW - 3);
		const valueTrim = visibleWidth(value) > valueMax ? truncateToWidth(value, valueMax, "…") : value;
		const valueText =
			row.item.kind === "info" || row.item.kind === "action" || !value
				? theme.fg("dim", valueTrim)
				: theme.fg("muted", valueTrim);
		return truncateToWidth(prefix + labelText + " " + valueText, w, "");
	}

	private renderModelList(w: number, rows: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		lines.push(" " + theme.fg("accent", "/ ") + (this.modelInput.render(Math.max(1, w - 3))[0] ?? ""));
		const listRows = Math.max(1, rows - 1);
		const start = clamp(this.modelSel - Math.floor(listRows / 2), 0, Math.max(0, this.modelFiltered.length - listRows));
		const nameW = clamp(
			Math.max(10, ...this.modelFiltered.slice(start, start + listRows).map((m) => visibleWidth(keyOf(m)))) + 1,
			10,
			Math.floor(w * 0.62),
		);
		for (let i = 0; i < listRows; i++) {
			const m = this.modelFiltered[start + i];
			if (!m) {
				lines.push("");
				continue;
			}
			const isSel = start + i === this.modelSel;
			const name = prettyRef(keyOf(m));
			const padded =
				visibleWidth(name) > nameW ? truncateToWidth(name, nameW, "…") : name + " ".repeat(nameW - visibleWidth(name));
			const meta = [m.reasoning ? "reasoning" : "", m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : ""]
				.filter(Boolean)
				.join(" · ");
			const label = isSel ? theme.fg("accent", padded) : padded;
			lines.push(truncateToWidth((isSel ? theme.fg("accent", "→ ") : "  ") + label + (meta ? theme.fg("dim", "  " + meta) : ""), w, ""));
		}
		return lines;
	}

	private renderRight(w: number, rows: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const push = (s: string): void => {
			for (const part of s.split("\n")) {
				if (lines.length >= rows) return;
				if (part === "") {
					lines.push("");
					continue;
				}
				for (const l of wrapTextWithAnsi(part, Math.max(8, w))) {
					if (lines.length >= rows) return;
					lines.push(l);
				}
			}
		};

		if (this.mode === "help") return this.renderHelp(w, rows);

		if (this.mode === "model" || this.mode === "pair") {
			if (this.modelPhase === "thinking") return this.renderThinkingPick(w, rows);
			const m = this.modelFiltered[this.modelSel];
			push(theme.fg("accent", theme.bold(this.mode === "pair" ? `Pick ${this.pairStep === 1 ? "primary" : "fallback"} model` : "Pick model")));
			push("");
			if (m) {
				push(theme.fg("text", theme.bold(prettyRef(keyOf(m)))));
				if (m.name) push(theme.fg("muted", m.name));
				push(theme.fg("muted", `provider: ${m.provider}${m.reasoning ? " · reasoning: yes" : " · reasoning: no"}`));
				if (m.contextWindow) push(theme.fg("muted", `context: ${Math.round(m.contextWindow / 1000)}k tokens`));
			} else {
				push(theme.fg("warning", "no models match the filter"));
			}
			if (this.mode === "pair") {
				push("");
				push(theme.fg("dim", this.pairStep === 1 ? "Step 1/2 — pick the primary (failing) model" : `Step 2/2 — pick the fallback for ${prettyRef(this.pendingRef)}`));
			}
			return lines;
		}

		if (this.mode === "enum") {
			const row = this.editingRow;
			if (!row) return lines;
			push(theme.fg("accent", theme.bold(prettyRef(row.item.label))));
			push(theme.fg("muted", `current: ${prettyRef(safeGet(row.item, this.ctx))}`));
			push("");
			for (const [i, opt] of this.enumList.entries()) {
				const isSel = i === this.enumIdx;
				const label = opt.label ?? opt.value;
				push(isSel ? theme.fg("accent", `→ ${label}`) : `  ${theme.fg("text", label)}`);
				if (opt.description && isSel) push(theme.fg("dim", `    ${opt.description}`));
			}
			return lines;
		}

		if (this.mode === "input") {
			const row = this.editingRow;
			if (!row) return lines;
			push(theme.fg("accent", theme.bold(prettyRef(row.item.label))));
			push(theme.fg("muted", `current: ${prettyRef(safeGet(row.item, this.ctx))}`));
			push("");
			for (const l of wrapTextWithAnsi(row.item.detail, w - 1)) push(l);
			if (row.item.placeholder) push(theme.fg("dim", `format: ${row.item.placeholder}`));
			if (row.item.kind === "number") {
				push(theme.fg("dim", `allowed: ${row.item.min ?? "-∞"} … ${row.item.max ?? "∞"}`));
			}
			return lines;
		}

		// browse / filter detail pane
		const row = this.currentRow();
		if (this.filterInput.getValue().trim() && row) push(theme.fg("dim", `${row.section.title} ›`));
		if (!row) {
			push(theme.fg("dim", this.sections[this.active]?.detail ?? ""));
			return lines;
		}
		push(theme.fg("accent", theme.bold(prettyRef(row.item.label))));
		if (row.item.kind !== "info") push(theme.fg("muted", `current: ${prettyRef(safeGet(row.item, this.ctx))}`));
		push("");
		for (const l of wrapTextWithAnsi(row.item.detail, w - 1)) push(l);
		push("");
		if (row.item.effect) {
			push(theme.fg(effectColor(row.item.effect), `● applies: ${row.item.effect}`));
		}
		if (row.item.owner) push(theme.fg("dim", `set by: ${row.item.owner}`));
		if (row.item.removable) push(theme.fg("dim", "⌫ removes this entry"));
		if (row.item.kind === "enum" && !row.item.detail.includes("\n")) {
			push("");
			for (const opt of this.resolveOptions(row.item)) {
				if (lines.length >= rows - 1) break;
				const marker = opt.value === safeGet(row.item, this.ctx) ? theme.fg("success", "● ") : "  ";
				push(marker + theme.fg("muted", opt.label ?? opt.value));
			}
		}
		if (lines.length < rows - 2) {
			const section = this.sections[this.active];
			if (section?.detail) {
				push("");
				push(theme.fg("dim", `about ${row.section.title}: ${section.detail}`));
			}
		}
		return lines;
	}

	private renderThinkingPick(w: number, rows: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const push = (s: string): void => {
			if (lines.length < rows) lines.push(truncateToWidth(s, w, ""));
		};
		push(theme.fg("accent", theme.bold(`thinking level for ${prettyRef(this.pendingRef)}`)));
		push(theme.fg("dim", "enter pick · esc back"));
		push("");
		for (const [i, opt] of this.enumList.entries()) {
			push(i === this.enumIdx ? theme.fg("accent", `→ ${opt.label}`) : `  ${theme.fg("text", opt.label ?? opt.value)}`);
		}
		return lines;
	}

	private renderHelp(w: number, rows: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const push = (s: string): void => {
			if (lines.length < rows) lines.push(truncateToWidth(s, w, ""));
		};
		push(theme.fg("accent", theme.bold("pi setup — help")));
		push("");
		push(theme.fg("text", "Everything here writes the same config the individual commands write."));
		push(theme.fg("text", "The right pane explains what a setting does and when a change takes effect."));
		push("");
		push(theme.fg("accent", "Keys"));
		push(theme.fg("muted", "  ↑/↓ or j/k    move within a section"));
		push(theme.fg("muted", "  ←/→           previous / next section"));
		push(theme.fg("muted", "  enter         edit the selected setting"));
		push(theme.fg("muted", "  ⌫ / del       remove the selected entry (mapping, override, package)"));
		push(theme.fg("muted", "  /             filter settings across all sections"));
		push(theme.fg("muted", "  g / G         jump to top / bottom"));
		push(theme.fg("muted", "  esc           cancel edit, or close the window"));
		push("");
		push(theme.fg("accent", "Add your own section"));
		push(theme.fg("muted", "  Any extension can contribute a section to this window."));
		push(theme.fg("muted", "  Ship <name>.setup.ts next to your extension (or <dir>/setup.ts)"));
		push(theme.fg("muted", "  exporting a default SetupSection — see extensions/setup/types.ts."));
		return lines;
	}
}

function safeGet(item: SetupItem, ctx: ExtensionCommandContext): string {
	try {
		return item.get(ctx) ?? "";
	} catch (error) {
		process.stderr.write(`[setup] get() failed for ${item.id}: ${error instanceof Error ? error.message : error}\n`);
		return "?";
	}
}
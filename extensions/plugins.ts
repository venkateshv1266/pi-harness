import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component, Focusable, KeybindingsManager, SelectItem, SelectListTheme, TUI } from "@earendil-works/pi-tui";
import { Input, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// pi "plugins" — browse/install skills from Claude Code plugin marketplaces.
// Installed plugins are referenced in place (no copy): skills load via
// resources_discover, so a git pull of the marketplace repo updates them.
// Marketplace list lives in ~/.pi/agent/plugins.json (local config, not code).

const STATE_FILE = join(homedir(), ".pi", "agent", "plugins.json");

type MarketplaceMeta = { name: string; path: string };
type InstalledEntry = { marketplace: string; path: string; enabled: boolean; installedAt: string };
type PluginState = { version: 1; marketplaces: MarketplaceMeta[]; installed: Record<string, InstalledEntry> };

type CatalogEntry = {
  name: string;
  description: string;
  author?: string;
  category?: string;
  marketplace: string;
  pluginDir?: string;
  remoteSource?: string;
};

type PluginInfo = { skills: string[]; agents: number; commands: number; hasMcp: boolean };

function loadState(): PluginState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as PluginState;
    if (parsed && Array.isArray(parsed.marketplaces) && parsed.installed) {
      return { version: 1, marketplaces: parsed.marketplaces, installed: parsed.installed };
    }
  } catch {
    // expected: first run or corrupt state — fall back to defaults, rewritten on next save
  }
  const marketplaces: MarketplaceMeta[] = [];
  const envPath = process.env.PI_PLUGIN_MARKETPLACE;
  if (envPath && existsSync(join(envPath, ".claude-plugin", "marketplace.json"))) {
    marketplaces.push({
      name: readMarketplaceFile(envPath)?.name ?? basename(envPath),
      path: resolve(envPath),
    });
  }
  return { version: 1, marketplaces, installed: {} };
}

function saveState(state: PluginState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function readMarketplaceFile(marketplacePath: string): { name: string; plugins: unknown[] } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(marketplacePath, ".claude-plugin", "marketplace.json"), "utf8"));
    if (parsed && typeof parsed.name === "string" && Array.isArray(parsed.plugins)) {
      return { name: parsed.name, plugins: parsed.plugins };
    }
  } catch {
    // expected: missing/corrupt marketplace.json — callers surface this as an unreadable-marketplace error
  }
  return undefined;
}

function collectCatalog(state: PluginState): { entries: CatalogEntry[]; errors: string[] } {
  const entries: CatalogEntry[] = [];
  const errors: string[] = [];
  for (const mp of state.marketplaces) {
    const file = readMarketplaceFile(mp.path);
    if (!file) {
      errors.push(`marketplace "${mp.name}" unreadable at ${mp.path}`);
      continue;
    }
    for (const raw of file.plugins) {
      const p = raw as Record<string, unknown>;
      const name = typeof p.name === "string" ? p.name : undefined;
      if (!name) continue;
      const source = typeof p.source === "string" ? p.source : undefined;
      let pluginDir: string | undefined;
      let remoteSource: string | undefined;
      if (!source) {
        remoteSource = "(no source)";
      } else if (/^(git|github|https?):/i.test(source)) {
        remoteSource = source;
      } else {
        const dir = isAbsolute(source) ? source : resolve(mp.path, source);
        if (existsSync(dir)) pluginDir = dir;
        else remoteSource = `${source} (path not found)`;
      }
      entries.push({
        name,
        description: typeof p.description === "string" ? p.description : "",
        author:
          typeof p.author === "string"
            ? p.author
            : p.author && typeof p.author === "object" && typeof (p.author as Record<string, unknown>).name === "string"
              ? ((p.author as Record<string, unknown>).name as string)
              : undefined,
        category: typeof p.category === "string" ? p.category : undefined,
        marketplace: mp.name,
        pluginDir,
        remoteSource,
      });
    }
  }
  return { entries, errors };
}

function walkSkillDirs(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) stack.push(join(dir, e.name));
      else if (e.name === "SKILL.md") out.push(dir);
    }
  }
  return out;
}

function inspectPlugin(pluginDir: string, fallbackName: string): PluginInfo {
  const skillsDir = join(pluginDir, "skills");
  let skills: string[] = [];
  if (existsSync(skillsDir)) {
    skills = walkSkillDirs(skillsDir).map((d) => basename(d));
  } else if (existsSync(join(pluginDir, "SKILL.md"))) {
    skills = [fallbackName];
  }
  const countMd = (sub: string): number => {
    const dir = join(pluginDir, sub);
    if (!existsSync(dir)) return 0;
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md")).length;
  };
  return {
    skills,
    agents: countMd("agents"),
    commands: countMd("commands"),
    hasMcp: existsSync(join(pluginDir, ".mcp.json")),
  };
}

function skillPathsFor(pluginDir: string): string[] {
  const skillsDir = join(pluginDir, "skills");
  if (existsSync(skillsDir)) return [skillsDir];
  const rootSkill = join(pluginDir, "SKILL.md");
  if (existsSync(rootSkill)) return [rootSkill];
  return [];
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function selectTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  };
}

type PickerRow = { label: string; meta?: string; description?: string };

// Searchable fuzzy picker: type to filter (label + description + meta), bounded
// height with scroll indicator, wrapped description of the selected row.
class FilterablePicker implements Component, Focusable {
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
    this.maxVisible = opts.maxVisible ?? 10;
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

  private filterText(row: PickerRow): string {
    return `${row.label} ${row.description ?? ""} ${row.meta ?? ""}`.toLowerCase();
  }

  private applyFilter(): void {
    const query = this.input.getValue().trim().toLowerCase();
    this.filtered = query
      ? this.rows.filter((r) => this.filterText(r).includes(query))
      : this.rows;
    this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
  }

  private styleMeta(meta: string, selected: boolean): string {
    if (meta.startsWith("✓")) return this.theme.fg("success", meta);
    if (meta.startsWith("✗")) return this.theme.fg("warning", meta);
    return selected ? this.theme.fg("accent", meta) : this.theme.fg("dim", meta);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    lines.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));
    lines.push(theme.fg("accent", theme.bold(trunc(` ${this.title}`, width - 2))));
    lines.push(theme.fg("dim", ` ${this.rows.length} items · type to filter`));
    lines.push(...this.input.render(width));

    if (this.filtered.length === 0) {
      lines.push(theme.fg("warning", "  No matches"));
    } else {
      const nameWidth = Math.min(38, Math.max(...this.rows.map((r) => visibleWidth(r.label))) + 1);
      const showMeta = width - nameWidth >= 18;
      const start = Math.max(0, Math.min(this.selected - Math.floor(this.maxVisible / 2), this.filtered.length - this.maxVisible));
      const end = Math.min(start + this.maxVisible, this.filtered.length);
      for (let i = start; i < end; i++) {
        const row = this.filtered[i];
        if (!row) continue;
        const isSel = i === this.selected;
        const prefix = isSel ? "→ " : "  ";
        const label = row.label + " ".repeat(Math.max(1, nameWidth - visibleWidth(row.label)));
        const styledLabel = isSel ? theme.fg("accent", prefix + label) : prefix + label;
        const meta = showMeta && row.meta ? this.styleMeta(row.meta, isSel) : "";
        lines.push(truncateToWidth(styledLabel + meta, width, ""));
      }
      if (start > 0 || end < this.filtered.length) {
        lines.push(theme.fg("dim", `  (${this.selected + 1}/${this.filtered.length})`));
      }
      const sel = this.filtered[this.selected];
      if (sel?.description) {
        lines.push("");
        const wrapped = wrapTextWithAnsi(sel.description, Math.max(20, width - 4)).slice(0, 3);
        for (const l of wrapped) lines.push(theme.fg("muted", `  ${l}`));
      }
    }
    lines.push(
      theme.fg(
        "dim",
        `  ${keyHint("tui.select.confirm", "open")} · ${keyHint("tui.select.cancel", "back")} · ↑↓ navigate`,
      ),
    );
    lines.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));
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

type DetailSection = { text: string; color: ThemeColor };

// Framed detail view with word-wrapped sections and an action list.
class ActionsDialog implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly title: string;
  private readonly sections: DetailSection[];
  private readonly list: SelectList;

  constructor(opts: {
    tui: TUI;
    theme: Theme;
    title: string;
    sections: DetailSection[];
    actions: string[];
    onAction: (action: string) => void;
    onCancel: () => void;
  }) {
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.title = opts.title;
    this.sections = opts.sections;
    const items: SelectItem[] = opts.actions.map((a) => ({ value: a, label: a }));
    this.list = new SelectList(items, items.length, selectTheme(opts.theme));
    this.list.onSelect = (item) => opts.onAction(item.value);
    this.list.onCancel = () => opts.onCancel();
  }

  render(width: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    lines.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));
    lines.push(theme.fg("accent", theme.bold(trunc(` ${this.title}`, width - 2))));
    for (const section of this.sections) {
      lines.push("");
      const wrapped = wrapTextWithAnsi(section.text, Math.max(20, width - 4));
      const shown = wrapped.slice(0, 8);
      for (const l of shown) lines.push(theme.fg(section.color, `  ${l}`));
      if (wrapped.length > shown.length) lines.push(theme.fg(section.color, "  …"));
    }
    lines.push("");
    lines.push(...this.list.render(width));
    lines.push(theme.fg("dim", `  ${keyHint("tui.select.confirm", "select")} · ${keyHint("tui.select.cancel", "back")}`));
    lines.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));
    return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width, "") : l));
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

async function offerReload(ctx: ExtensionCommandContext): Promise<boolean> {
  if (!ctx.hasUI) return false;
  if (await ctx.ui.confirm("Reload now?", "Run /reload to activate the change in this session.")) {
    await ctx.reload();
    // the old ctx is stale after reload — callers must unwind instead of reusing it
    return true;
  }
  return false;
}

function install(state: PluginState, entry: CatalogEntry): boolean {
  if (!entry.pluginDir) return false;
  state.installed[entry.name] = {
    marketplace: entry.marketplace,
    path: entry.pluginDir,
    enabled: true,
    installedAt: new Date().toISOString(),
  };
  saveState(state);
  return true;
}

function detailSections(entry: CatalogEntry, info: PluginInfo): DetailSection[] {
  const sections: DetailSection[] = [{ text: entry.description || "(no description)", color: "text" }];
  const meta = [
    entry.author ? `Author: ${entry.author}` : undefined,
    entry.category ? `Category: ${entry.category}` : undefined,
    `Marketplace: ${entry.marketplace}`,
  ]
    .filter((s): s is string => s !== undefined)
    .join(" · ");
  sections.push({ text: meta, color: "dim" });
  if (entry.remoteSource) {
    sections.push({ text: `Source: ${entry.remoteSource} — not a local path, cannot install`, color: "warning" });
    return sections;
  }
  sections.push({ text: `Skills (${info.skills.length}): ${info.skills.join(", ") || "none"}`, color: "muted" });
  if (info.agents > 0) sections.push({ text: `Agents (${info.agents}): not supported yet`, color: "warning" });
  if (info.commands > 0) sections.push({ text: `Commands (${info.commands}): not supported yet`, color: "warning" });
  if (info.hasMcp) sections.push({ text: "MCP servers (.mcp.json): not supported yet", color: "warning" });
  return sections;
}

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", (_event, ctx: ExtensionContext) => {
    const state = loadState();
    const skillPaths: string[] = [];
    const missing: string[] = [];
    for (const [name, entry] of Object.entries(state.installed)) {
      if (!entry.enabled) continue;
      const paths = skillPathsFor(entry.path);
      if (paths.length === 0) missing.push(name);
      skillPaths.push(...paths);
    }
    if (missing.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`plugins: ${missing.join(", ")} missing on disk — run /plugins to uninstall`, "warning");
    }
    return { skillPaths };
  });

  // returns true when the session was reloaded and the caller must unwind (ctx is stale)
  async function browse(ctx: ExtensionCommandContext): Promise<boolean> {
    for (;;) {
      const state = loadState();
      const { entries, errors } = collectCatalog(state);
      if (errors.length > 0) ctx.ui.notify(errors.join("\n"), "warning");
      if (entries.length === 0) {
        ctx.ui.notify("No plugins found — add a marketplace first (/plugins marketplace add <path>)", "warning");
        return false;
      }
      const rows: PickerRow[] = entries.map((e) => {
        const inst = state.installed[e.name];
        const meta = inst
          ? inst.enabled
            ? "✓ installed"
            : "✗ disabled"
          : e.pluginDir
            ? `${inspectPlugin(e.pluginDir, e.name).skills.length} skills`
            : "not installable";
        return { label: e.name, meta, description: e.description || "(no description)" };
      });
      const mpLabel = state.marketplaces.map((m) => m.name).join(", ");
      const picked = await ctx.ui.custom<PickerRow | null>((tui, theme, kb, done) =>
        new FilterablePicker({
          tui,
          theme,
          keybindings: kb,
          title: `Browse plugins — ${mpLabel} (${entries.length})`,
          rows,
          onPick: done,
          onCancel: () => done(null),
        }),
      );
      if (!picked) return false;
      const entry = entries.find((e) => e.name === picked.label);
      if (entry) return await pluginDetail(ctx, entry);
    }
  }

  // returns true when the session was reloaded and the caller must unwind (ctx is stale)
  async function pluginDetail(ctx: ExtensionCommandContext, entry: CatalogEntry): Promise<boolean> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(`Use /plugins install ${entry.name} (interactive view needs TUI mode)`, "info");
      return false;
    }
    const info = entry.pluginDir
      ? inspectPlugin(entry.pluginDir, entry.name)
      : { skills: [], agents: 0, commands: 0, hasMcp: false };
    const installed = loadState().installed[entry.name];
    const actions = entry.pluginDir
      ? installed
        ? [...(installed.enabled ? ["Disable", "Uninstall"] : ["Enable", "Uninstall"])]
        : ["Install"]
      : [];
    const action = await ctx.ui.custom<string | null>((tui, theme, kb, done) =>
      new ActionsDialog({
        tui,
        theme,
        title: `${entry.name}${entry.category ? ` (${entry.category})` : ""}`,
        sections: detailSections(entry, info),
        actions: actions.length > 0 ? actions : ["Back"],
        onAction: done,
        onCancel: () => done(null),
      }),
    );
    if (!action || action === "Back") return false;
    const state = loadState();
    if (action === "Install") {
      if (install(state, entry)) {
        ctx.ui.notify(`Installed ${entry.name} (${info.skills.length} skills)`, "info");
        return await offerReload(ctx);
      }
    } else if (action === "Uninstall") {
      delete state.installed[entry.name];
      saveState(state);
      ctx.ui.notify(`Uninstalled ${entry.name}`, "info");
      return await offerReload(ctx);
    } else if (action === "Enable" || action === "Disable") {
      const e = state.installed[entry.name];
      if (e) {
        e.enabled = action === "Enable";
        saveState(state);
        ctx.ui.notify(`${entry.name} ${e.enabled ? "enabled" : "disabled"}`, "info");
        return await offerReload(ctx);
      }
    }
    return false;
  }

  // returns true when the session was reloaded and the caller must unwind (ctx is stale)
  async function manageInstalled(ctx: ExtensionCommandContext): Promise<boolean> {
    for (;;) {
      const state = loadState();
      const names = Object.keys(state.installed);
      if (names.length === 0) {
        ctx.ui.notify("No plugins installed — browse to install some", "info");
        return false;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`Installed plugins:\n${names.map((n) => `  ${n}`).join("\n")}`, "info");
        return false;
      }
      const rows: PickerRow[] = names.map((n) => {
        const e = state.installed[n];
        const info = inspectPlugin(e.path, n);
        return {
          label: n,
          meta: e.enabled ? `✓ enabled · ${info.skills.length} skills` : "✗ disabled",
          description: `${e.marketplace} · ${e.path}`,
        };
      });
      const picked = await ctx.ui.custom<PickerRow | null>((tui, theme, kb, done) =>
        new FilterablePicker({
          tui,
          theme,
          keybindings: kb,
          title: `Installed plugins (${names.length})`,
          rows,
          onPick: done,
          onCancel: () => done(null),
        }),
      );
      if (!picked) return false;
      const name = picked.label;
      const entry = state.installed[name];
      const action = await ctx.ui.custom<string | null>((tui, theme, kb, done) =>
        new ActionsDialog({
          tui,
          theme,
          title: name,
          sections: [{ text: `${entry.marketplace} · ${entry.path}`, color: "dim" }],
          actions: [...(entry.enabled ? ["Disable", "Uninstall"] : ["Enable", "Uninstall"]), "Back"],
          onAction: done,
          onCancel: () => done(null),
        }),
      );
      if (!action || action === "Back") continue;
      const fresh = loadState();
      if (action === "Uninstall") {
        delete fresh.installed[name];
        saveState(fresh);
        ctx.ui.notify(`Uninstalled ${name}`, "info");
        return await offerReload(ctx);
      }
      const e = fresh.installed[name];
      if (e) {
        e.enabled = action === "Enable";
        saveState(fresh);
        ctx.ui.notify(`${name} ${e.enabled ? "enabled" : "disabled"}`, "info");
        return await offerReload(ctx);
      }
    }
  }

  async function manageMarketplaces(ctx: ExtensionCommandContext): Promise<void> {
    for (;;) {
      const state = loadState();
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          state.marketplaces.length > 0
            ? `Marketplaces:\n${state.marketplaces.map((m) => `  ${m.name} — ${m.path}`).join("\n")}`
            : "No marketplaces configured.",
          "info",
        );
        return;
      }
      const installedByMp = new Map<string, number>();
      for (const e of Object.values(state.installed)) {
        installedByMp.set(e.marketplace, (installedByMp.get(e.marketplace) ?? 0) + 1);
      }
      const rows: PickerRow[] = [
        ...state.marketplaces.map((m) => ({
          label: m.name,
          meta: `${installedByMp.get(m.name) ?? 0} installed`,
          description: m.path,
        })),
        { label: "+ Add marketplace…", description: "Path to a local marketplace repo (or its marketplace.json)" },
      ];
      const picked = await ctx.ui.custom<PickerRow | null>((tui, theme, kb, done) =>
        new FilterablePicker({
          tui,
          theme,
          keybindings: kb,
          title: "Marketplaces",
          rows,
          onPick: done,
          onCancel: () => done(null),
        }),
      );
      if (!picked) return;
      if (picked.label === "+ Add marketplace…") {
        const input = await ctx.ui.input("Add marketplace", "path to marketplace repo (or its marketplace.json)");
        if (!input) continue;
        const result = addMarketplace(input.trim());
        ctx.ui.notify(
          result.ok ? `Added marketplace ${result.name}` : (result.error ?? "Failed to add marketplace"),
          result.ok ? "info" : "error",
        );
        continue;
      }
      const mp = state.marketplaces.find((m) => m.name === picked.label);
      if (mp && await ctx.ui.confirm(`Remove ${mp.name}?`, "Installed plugins from it keep working (paths are absolute).")) {
        const fresh = loadState();
        fresh.marketplaces = fresh.marketplaces.filter((m) => m.path !== mp.path);
        saveState(fresh);
        ctx.ui.notify(`Removed marketplace ${mp.name}`, "info");
      }
    }
  }

  function addMarketplace(input: string): { ok: true; name: string } | { ok: false; error: string } {
    const mpPath = input.endsWith("marketplace.json") ? dirname(resolve(input)) : resolve(input);
    const file = readMarketplaceFile(mpPath);
    if (!file) return { ok: false, error: `No .claude-plugin/marketplace.json at ${mpPath}` };
    const state = loadState();
    if (state.marketplaces.some((m) => m.path === mpPath)) {
      return { ok: false, error: `Marketplace ${file.name} already added` };
    }
    state.marketplaces.push({ name: file.name, path: mpPath });
    saveState(state);
    return { ok: true, name: file.name };
  }

  pi.registerCommand("plugins", {
    description: "Browse and manage Claude Code marketplace plugins (skills)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = (values: string[]): AutocompleteItem[] => values.map((v) => ({ value: v, label: v }));
      const m = prefix.match(/^(install\s+)(\S*)$/);
      if (m) {
        const names = collectCatalog(loadState()).entries.map((e) => e.name).filter((n) => n.startsWith(m[2]));
        return names.length > 0 ? items(names) : null;
      }
      const u = prefix.match(/^(uninstall\s+|enable\s+|disable\s+)(\S*)$/);
      if (u) {
        const names = Object.keys(loadState().installed).filter((n) => n.startsWith(u[2]));
        return names.length > 0 ? items(names) : null;
      }
      const subs = ["install", "uninstall", "enable", "disable", "list", "marketplace"].filter((s) => s.startsWith(prefix));
      return subs.length > 0 ? items(subs) : null;
    },
    handler: async (args, ctx) => {
      const argv = args.trim().split(/\s+/).filter(Boolean);
      const sub = argv[0];
      const usage = "Usage: /plugins [install|uninstall|enable|disable|list|marketplace ...]";

      if (!sub) {
        if (!ctx.hasUI) {
          ctx.ui.notify(usage, "warning");
          return;
        }
        for (;;) {
          const choice = await ctx.ui.select("Plugins — marketplace skills for pi", [
            "Browse & install plugins",
            "Installed plugins",
            "Marketplaces",
            "Close",
          ]);
          if (!choice || choice === "Close") return;
          if (choice === "Browse & install plugins") { if (await browse(ctx)) return; }
          else if (choice === "Installed plugins") { if (await manageInstalled(ctx)) return; }
          else await manageMarketplaces(ctx);
        }
      }

      if (sub === "list") {
        if (argv[1] === "all" || argv[1] === "available") {
          if (ctx.mode === "tui") {
            await browse(ctx);
            return;
          }
          const { entries } = collectCatalog(loadState());
          ctx.ui.notify(entries.map((e) => `  ${e.name} — ${trunc(e.description, 60)}`).join("\n"), "info");
          return;
        }
        const state = loadState();
        const names = Object.keys(state.installed);
        const text =
          names.length === 0
            ? "No plugins installed."
            : names
                .map((n) => {
                  const e = state.installed[n];
                  return `  ${e.enabled ? "[✓]" : "[✗]"} ${n} — ${e.marketplace}${e.enabled ? "" : " (disabled)"}`;
                })
                .join("\n");
        ctx.ui.notify(`Installed plugins:\n${text}`, "info");
        return;
      }

      if (sub === "marketplace") {
        if (argv[1] === "add" && argv[2]) {
          const r = addMarketplace(argv.slice(2).join(" "));
          ctx.ui.notify(r.ok ? `Added marketplace ${r.name}` : (r.error ?? "Failed"), r.ok ? "info" : "error");
          return;
        }
        if (argv[1] === "remove" && argv[2]) {
          const name = argv.slice(2).join(" ");
          const state = loadState();
          const mp = state.marketplaces.find((m) => m.name === name || m.path === resolve(name));
          if (!mp) {
            ctx.ui.notify(`No marketplace named ${name}`, "error");
            return;
          }
          state.marketplaces = state.marketplaces.filter((m) => m !== mp);
          saveState(state);
          ctx.ui.notify(`Removed marketplace ${mp.name}`, "info");
          return;
        }
        const state = loadState();
        ctx.ui.notify(
          state.marketplaces.length > 0
            ? `Marketplaces:\n${state.marketplaces.map((m) => `  ${m.name} — ${m.path}`).join("\n")}`
            : "No marketplaces configured. Add one with /plugins marketplace add <path>",
          "info",
        );
        return;
      }

      const name = argv[1];
      if (!name) {
        ctx.ui.notify(usage, "warning");
        return;
      }
      const state = loadState();
      const entry = state.installed[name];

      if (sub === "install") {
        const { entries } = collectCatalog(state);
        const found = entries.find((e) => e.name === name);
        if (!found) {
          ctx.ui.notify(`Plugin "${name}" not found. Use /plugins to browse.`, "error");
          return;
        }
        if (!found.pluginDir) {
          ctx.ui.notify(`Plugin "${name}" source is not a local path (${found.remoteSource})`, "error");
          return;
        }
        if (entry) {
          ctx.ui.notify(`${name} is already installed${entry.enabled ? "" : " (disabled)"}`, "warning");
          return;
        }
        const info = inspectPlugin(found.pluginDir, found.name);
        if (install(state, found)) {
          ctx.ui.notify(`Installed ${found.name} (${info.skills.length} skills)`, "info");
          await offerReload(ctx);
        }
        return;
      }

      if (sub === "uninstall") {
        if (!entry) {
          ctx.ui.notify(`${name} is not installed`, "error");
          return;
        }
        delete state.installed[name];
        saveState(state);
        ctx.ui.notify(`Uninstalled ${name}`, "info");
        await offerReload(ctx);
        return;
      }

      if (sub === "enable" || sub === "disable") {
        if (!entry) {
          ctx.ui.notify(`${name} is not installed`, "error");
          return;
        }
        entry.enabled = sub === "enable";
        saveState(state);
        ctx.ui.notify(`${name} ${entry.enabled ? "enabled" : "disabled"}`, "info");
        await offerReload(ctx);
        return;
      }

      ctx.ui.notify(usage, "warning");
    },
  });
}

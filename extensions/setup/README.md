# setup

> `/setup` — a full-screen settings window that puts every setting and slash command in one place, extensible by any other extension.

## What it does

`/setup` opens a centered, full-viewport two-pane window: the left pane lists every setting with its current value, the right pane explains the selected item (what it does, when a change takes effect, which extension owns it) and hosts the editors. Edits write straight through to the same config files the individual commands write — there is no separate state. After closing, a notification summarizes how many settings were changed.

Outside the TUI (`ctx.mode !== "tui"`), `/setup` prints every section and current value as plain text instead of opening the window.

### Built-in sections

| Section | Manages | Owner / related command |
|---|---|---|
| Models | Default model, default thinking level, per-model thinking overrides | pi core · `/model`, `/settings` |
| Roles | `@smol`/`@slow`/`@plan`/`@task`/`@designer` role models | [model-roles](../model-roles.ts) · `/roles` |
| Router | Enable, prefer-roles, complexity threshold, probe timeout, fast/mid/deep tiers | [model-router](../model-router.ts) · `/route` |
| Fallbacks | Primary → fallback failover pairs, failure threshold | [model-fallback](../model-fallback.ts) · `/fallback` |
| Guardrails | OpenRouter daily/monthly spend limits | [openrouter-guardrail-header](../openrouter-guardrail-header.ts) |
| Appearance | Theme, TUI mode | pi core · `/theme`, `/settings` |
| Core | Project trust, steering, follow-ups, double-escape, quiet startup, thinking blocks, skill commands, HTTP idle timeout | pi core · `/settings` |
| Packages | Installed pi packages and marketplace plugins | pi core packages · `/plugins` |
| Commands | Every slash command in the session, sorted by source | per-item source |
| Rules | TTSR rule files and their triggers/scopes | [ttsr](../ttsr/README.md) · `/ttsr` |
| MCP | Configured MCP servers | [mcp-bridge](../mcp-bridge/README.md) · `/mcp` |

## Commands and tools

| Command | What it does |
|---|---|
| `/setup` | Open the full setup window (starts on the first section) |
| `/setup <section>` | Open focused on a section; the argument matches section id, title, or a title substring, case-insensitive |

No tools are registered.

## Configuration

The extension itself has no settings or env vars. It reads and writes these files:

| File | Use |
|---|---|
| `~/.pi/agent/settings.json` | Nearly all settings (table below) |
| `~/.pi/agent/plugins.json` | Plugin enable/disable toggles (Packages section) |
| `~/.pi/agent/mcp-servers.json` | Display only; edit the file to change servers |
| `~/.pi/agent/themes/` | Custom `*.json` themes offered alongside `dark`/`light` |
| `~/.pi/agent/rules/*.md`, `<project>/.pi/rules/*.md` | Display only; TTSR rules with parsed frontmatter |

Settings keys written to `~/.pi/agent/settings.json` (defaults as shown in the UI):

| Key | Default | Effect |
|---|---|---|
| `defaultProvider` / `defaultModel` | (not set) | Default model; also applied to the current session |
| `defaultThinkingLevel` | `high` (pi default) | One of `minimal`–`low`–`medium`–`high`–`xhigh`–`max` |
| `modelThinkingLevels` | (none) | Per-model thinking-level pins |
| `smolModel` … `designerModel` | unset → default model | Role models |
| `modelRouter.enabled` | on | Prompt classifier routing |
| `modelRouter.preferRoles` | off | `/roles` settings win over explicit tier refs |
| `modelRouter.threshold` | `0.75` | Steps: 0.5–0.9 |
| `modelRouter.timeoutMs` | `1500` | 0–30000 |
| `modelRouter.fast` / `mid` / `deep` | unset → `@smol`/`@task`/`@slow` via `/roles` | `null` disables a tier |
| `modelFallback` | (none) | Primary→target pairs; `failThreshold` default `3` (1–10) |
| `openrouterGuardrails.dailyLimit` / `monthlyLimit` | (not set) | 0–100000 / 0–1000000 USD |
| `theme` | `dark` | Next start (or `/reload`) |
| `tuiMode` | `fullscreen` | `fullscreen` or `normal`; next start |
| `defaultProjectTrust` | `ask` | `ask`, `always`, or `never`; next start |
| `steeringMode` | `all` | `all` or `one-at-a-time`; next start |
| `followUpMode` | `all` | `all` or `one-at-a-time`; next start |
| `doubleEscapeAction` | `fork` | `fork`, `tree`, or `none`; next start |
| `quietStartup` | off | Suppresses the changelog banner |
| `hideThinkingBlock` | off | Thinking blocks are shown by default |
| `enableSkillCommands` | on | Skills as `/skill:name` commands |
| `httpIdleTimeoutMs` | pi default | 1000–600000 |
| `packages` | (none) | npm/git/local specs; loaded at next start |

## How it works

### Read-merge-write

Every settings edit goes through one helper that re-reads `settings.json` from disk, applies the mutation, and writes the whole file back — so concurrent writes from other extensions (router, roles, fallback) never clobber each other. After each successful change the sections are rebuilt from fresh disk state, keeping the selection on the same item. `plugins.json` is edited the same way.

### The window

Title bar (`⚙ pi setup — <section>`) with a tab strip of section names; left pane lists items with their current values; right pane shows the detail, the `● applies: <effect>` line (green for immediate/next prompt/request, yellow for next start/restart), the owner, and enum options with the current value marked; status line shows the mode hint, the last change (`✓`/`✗`), and the selection position. The mouse wheel scrolls the list and clicking a row selects it (clicking the selected row opens its editor).

| Key | Action |
|---|---|
| `↑`/`↓` or `j`/`k` | Move within a section |
| `←`/`→` (or shift-tab/tab) | Previous / next section |
| `enter` | Edit the selected item |
| `⌫`/`del` | Remove the selected entry (removable items only) |
| `/` | Filter items across all sections (matches section titles and item labels) |
| `g` / `G` | Jump to top / bottom |
| `?` | Help screen |
| `esc` | Cancel edit · clear filter · close window |

Editors per item kind: **toggle** flips on enter; **enum** cycles with `←`/`→` or opens a pick list; **model** opens a type-to-filter model picker, optionally followed by a thinking-level step (`no suffix` or one of the six levels); **model-pair** runs two sequential picks (primary, then target) joined as `primary>target`; **number**/**text** open an input line — numbers are validated and clamped to `min`/`max`. Failed edits flash `✗ …` and are not recorded; a failed contributor appears as a `Broken` section with the error.

### Contributing a section

Any extension can add a section. Place a contributor file under `~/.pi/agent/extensions/`:

- `<name>.setup.ts` next to `<name>.ts`, or a standalone `*.setup.ts`, or
- `<dir>/setup.ts` inside a directory extension (`setup` and `node_modules` entries are skipped).

Export a default: either a function `(pi, ctx) => SetupSection | SetupSection[]` (may be async, receives the `ExtensionAPI` and command context) or a plain section/array. Files are imported each time `/setup` runs. The same discovery rules are codified in `SETUP_SECTION_FILES` in `types.ts`. A working example is [decision-tuner's setup.ts](../decision-tuner/setup.ts).

```ts
// ~/.pi/agent/extensions/my-ext.setup.ts
import type { SetupSection } from "./setup/types.ts";

export default function setup(): SetupSection {
	return {
		id: "my-ext",
		title: "My extension",
		detail: "One-liner shown for the section.",
		items: [
			{
				id: "mode",
				label: "Mode",
				detail: "What this setting controls.",
				effect: "next start",
				owner: "my-ext · /my-ext-mode",
				kind: "enum",
				options: [
					{ value: "fast", label: "fast" },
					{ value: "thorough", label: "thorough" },
				],
				get: () => readConfig().mode,
				apply: (_ctx, value) => {
					writeConfig({ mode: value });
					return `mode → ${value}`;
				},
			},
		],
	};
}
```

`SetupItem` surface (from `types.ts`): `id`, `label`, `detail` (help text shown in the right pane), `effect` (when a change takes effect), `owner` (owning extension + equivalent command), `get(ctx)` (current value shown in the row), `kind`, plus per-kind extras — `options` (static or lazy `EnumOption[]`), `min`/`max`/`placeholder` (number/text), `withThinking` (model/model-pair), `removable` (⌫ deletes by applying the sentinel `__remove`), `run` (action), and `apply(ctx, value)` (all editable kinds). `apply`/`run` return the flash message; a message starting with `✗` is treated as a failure.

## Caveats

- Edits persist immediately, but most take effect later — check the `applies:` line. Theme changes need a restart or `/reload`; new thinking overrides appear in the list after a restart or `/reload`; packages and most Core flags need a restart.
- `⌫` removal is immediate, with no confirmation.
- Rules, MCP, and Commands are display-only sections.
- Contributor files are re-imported per `/setup` invocation, but an already-imported module may stay cached for the life of the process — contributor edits may require a restart (not documented in code).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Public contribution API for /setup.
 *
 * Any extension can ship a setup section that the /setup window auto-discovers:
 *   - `foo.setup.ts` next to `foo.ts`, or
 *   - `<ext-dir>/setup.ts` for directory extensions.
 *
 * Export a default function returning one SetupSection or an array of them:
 *
 *   import type { SetupSection } from "./setup/types.ts";
 *   export default function setup(): SetupSection { ... }
 */

export interface EnumOption {
	value: string;
	label?: string;
	description?: string;
}

export type SetupEditorKind =
	| "enum" // ←/→ cycles, enter opens option list in the detail pane
	| "model" // filterable model picker, optional thinking-level suffix
	| "model-pair" // two sequential model picks (source then target)
	| "number"
	| "text"
	| "toggle" // ←/→ flips on/off immediately
	| "action" // enter runs item.run
	| "info"; // display only

export interface SetupItem {
	id: string;
	label: string;
	/** Self-explanatory help shown in the detail pane: what this setting is. */
	detail: string;
	/** When a change takes effect, e.g. "immediately", "next prompt", "next start". */
	effect?: string;
	/** Owner extension + equivalent command, e.g. "model-router · /route". */
	owner?: string;
	/** Current value rendered in the row (right column). */
	get(ctx: ExtensionCommandContext): string;
	kind: SetupEditorKind;
	/** enum choices; may be computed lazily. */
	options?: EnumOption[] | ((ctx: ExtensionCommandContext) => EnumOption[]);
	min?: number;
	max?: number;
	placeholder?: string;
	/** For kind="model"/"model-pair": offer a thinking-level suffix step after the model pick. */
	withThinking?: boolean;
	/** Row can be deleted with backspace/delete (e.g. mapping entries). */
	removable?: boolean;
	/** kind="action": invoked on enter; returns the flash message. */
	run?(ctx: ExtensionCommandContext): Promise<string> | string;
	/** Editable kinds: apply the new value; returns the flash message. */
	apply?(ctx: ExtensionCommandContext, value: string): Promise<string> | string;
}

export interface SetupSection {
	id: string;
	title: string;
	/** One-liner shown for the section itself. */
	detail?: string;
	items: SetupItem[];
}

export type SetupSectionContributor = (
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
) => SetupSection | SetupSection[] | Promise<SetupSection | SetupSection[]>;

/** Discovery conventions relative to ~/.pi/agent/extensions/. */
export const SETUP_SECTION_FILES = (entry: string): string[] => {
	if (entry.endsWith(".setup.ts")) return [entry];
	if (!entry.endsWith(".ts") && entry !== "node_modules") return [`${entry}/setup.ts`];
	if (entry.endsWith(".ts")) return [entry.replace(/\.ts$/, ".setup.ts")];
	return [];
};
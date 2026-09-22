import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prettyRef } from "./io.ts";
import { builtinSections } from "./sections.ts";
import type { SetupSection, SetupSectionContributor } from "./types.ts";
import { SetupWindow } from "./window.ts";

const EXT_DIR = join(homedir(), ".pi", "agent", "extensions");

function contributorPaths(): string[] {
	const paths: string[] = [];
	try {
		for (const entry of readdirSync(EXT_DIR)) {
			if (entry === "setup" || entry === "node_modules") continue;
			if (entry.endsWith(".setup.ts")) {
				paths.push(join(EXT_DIR, entry));
			} else if (entry.endsWith(".ts")) {
				const sibling = join(EXT_DIR, entry.replace(/\.ts$/, ".setup.ts"));
				if (existsSync(sibling)) paths.push(sibling);
			} else {
				const nested = join(EXT_DIR, entry, "setup.ts");
				if (existsSync(nested)) paths.push(nested);
			}
		}
	} catch (error) {
		process.stderr.write(`[setup] extension scan failed: ${error instanceof Error ? error.message : error}\n`);
	}
	return paths;
}

let loadedPi: ExtensionAPI | undefined;

async function loadContributors(ctx: ExtensionCommandContext): Promise<SetupSection[]> {
	const sections: SetupSection[] = [];
	for (const p of contributorPaths()) {
		try {
			const mod = (await import(pathToFileURL(p).href)) as {
				default?: SetupSectionContributor | SetupSection | SetupSection[];
			};
			const value = typeof mod === "function" ? mod : mod?.default;
			if (typeof value === "function") {
				const result = await (value as SetupSectionContributor)(loadedPi as ExtensionAPI, ctx);
				sections.push(...(Array.isArray(result) ? result : [result]));
			} else if (value) {
				sections.push(...(Array.isArray(value) ? value : [value]));
			}
		} catch (error) {
			const name = p.split("/").slice(-2).join("/");
			const msg = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[setup] contributor ${name} failed to load: ${msg}\n`);
			sections.push({
				id: "broken",
				title: "Broken",
				detail: "A setup section failed to load — details on stderr.",
				items: [
					{
						id: `broken:${name}`,
						label: name,
						detail: `Failed to load setup section: ${msg}`,
						kind: "info",
						get: () => "error",
					},
				],
			});
		}
	}
	return sections;
}

export default function (pi: ExtensionAPI): void {
	loadedPi = pi;

	pi.registerCommand("setup", {
		description: "Open the full setup window — every setting and command in one place",
		handler: async (args, ctx) => {
			const extra = await loadContributors(ctx);
			const refresh = (): SetupSection[] => [...builtinSections(pi, ctx), ...extra];
			const sections = refresh();

			const arg = (args ?? "").trim().toLowerCase();
			const match = arg
				? sections.findIndex(
						(s) =>
							s.id.toLowerCase() === arg || s.title.toLowerCase() === arg || s.title.toLowerCase().includes(arg),
					)
				: -1;

			if (ctx.mode !== "tui") {
				const lines = sections.flatMap((s) => [`## ${s.title}`, ...s.items.map((it) => `  ${it.label}: ${it.get(ctx)}`)]);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const changes = await ctx.ui.custom<string[]>(
				(tui, theme, keybindings, done) =>
					new SetupWindow({
						tui,
						theme,
						keybindings,
						ctx,
						sections,
						refresh,
						onDone: done,
						initialActive: match >= 0 ? match : undefined,
					}),
				{ overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } },
			);

			if (changes && changes.length > 0) {
				const list = changes.slice(0, 5).map((c) => prettyRef(c)).join("\n  ");
				ctx.ui.notify(`setup: ${changes.length} change${changes.length > 1 ? "s" : ""}:\n  ${list}`, "info");
			}
		},
	});
}
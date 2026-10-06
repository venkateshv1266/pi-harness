/**
 * Adapter registry. Built-in decision adapters plus auto-discovered modules:
 * any sibling `.ts` file whose default export is `Adapter[]` is loaded and
 * merged. Adding observability for a new subsystem = drop a file here.
 */
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { log } from "../log";
import type { Adapter } from "./define";
import { decisionAdapters } from "./decisions";

const CORE = new Set(["define.ts", "index.ts", "decisions.ts", "sessions.ts"]);

export async function loadAdapters(): Promise<Adapter[]> {
	const dir = path.dirname(new URL(import.meta.url).pathname);
	const adapters = decisionAdapters();
	const seen = new Set(adapters.map((a) => a.id));
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".ts") || CORE.has(file)) continue;
		try {
			const mod = (await import(path.join(dir, file))) as { default?: Adapter[] };
			for (const adapter of mod.default ?? []) {
				if (!seen.has(adapter.id)) {
					adapters.push(adapter);
					seen.add(adapter.id);
				}
			}
		} catch (err) {
			log.error(`adapter ${file} failed to load: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return adapters;
}

export type { Adapter } from "./define";

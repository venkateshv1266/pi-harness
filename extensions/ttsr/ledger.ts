/**
 * Context-ledger helpers: read receipts, staleness, adjudication cache keys.
 *
 * Kept dependency-free (no pi imports) so it is unit-testable standalone.
 */

import * as fs from "node:fs";

export interface ReadReceipt {
	/** Turn in which the doc was read. */
	turn: number;
	/** Doc mtime at read time (a later mtime means the read is stale). */
	mtimeMs: number;
}

/**
 * True when every resolvable path has a read receipt and has not changed since.
 * Paths that no longer exist are ignored (nothing left to enforce); an empty
 * list is vacuously satisfied.
 */
export function noveltySatisfied(
	reads: string[],
	receipts: Map<string, ReadReceipt>,
	statSync: (p: string) => { mtimeMs: number } = fs.statSync,
): boolean {
	for (const p of reads) {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(p).mtimeMs;
		} catch {
			continue;
		}
		const r = receipts.get(p);
		if (!r) return false;
		if (mtimeMs > r.mtimeMs) return false;
	}
	return true;
}

/** Cheap deterministic key for the adjudication cache (FNV-1a + length). */
export function cacheKey(rule: string, state: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < state.length; i++) {
		h ^= state.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `${rule}:${(h >>> 0).toString(36)}:${state.length}`;
}

/**
 * Improvements adapter. Snapshots are not a JSONL decision stream — they are
 * materialized daily views computed by `server/snapshots.ts` — so this adapter
 * declares the panels and leaves `file` null. The ingest loop skips it and the
 * `/api/improvements*` endpoints read the snapshot files directly.
 */
import type { Adapter } from "./define";

const improvements: Adapter = {
	id: "improvements",
	title: "Improvements",
	description:
		"One materialized snapshot per day: what armed, what was pruned or rolled back, gate pass rate, rule-fire outcome mix, extension usage and the harness digest delta.",
	file: null,
	channel: "snapshot",
	panels: [
		{ id: "improvements-days", title: "Daily improvements", kind: "table", query: "improvements", description: "One row per day with the day's ledger." },
		{ id: "improvements-compare", title: "Day-over-day", kind: "table", query: "improvements-compare", description: "N vs N−1 with percentage-point deltas for rates." },
	],
};

export default [improvements];

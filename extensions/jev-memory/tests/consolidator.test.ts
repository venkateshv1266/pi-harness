import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAudit } from "../src/jev/audit.js";
import { jevCall, type JevAnswers, type JevState } from "../src/jev/client.js";
import { DEFAULT_JEV_CONFIG, type JevConfig } from "../src/jev/config.js";
import {
	buildExecutorPlan,
	buildStalePlan,
	chunkEntries,
	chunkStaleCandidates,
	CONSOLIDATOR_CHUNK_CHAR_LIMIT,
	selectPairs,
	selectStaleCandidates,
	type ConsolidatorEntry,
	type ConsolidatorPair,
} from "../src/jev/consolidator.js";
import { runTypedConsolidation, shouldAttemptFreestyleFallback, triggerConsolidation } from "../src/handlers/auto-consolidate.js";
import { loadConfig } from "../src/config.js";
import { ENTRY_DELIMITER } from "../src/constants.js";
import { MemoryStore } from "../src/store/memory-store.js";
import { rerankBlendOrder } from "../src/tools/memory-search-tool.js";

const NOW = new Date("2026-03-01T00:00:00.000Z");

test("shouldAttemptFreestyleFallback skips oversized targets", () => {
	assert.equal(shouldAttemptFreestyleFallback(50_001, DEFAULT_JEV_CONFIG), false);
});

test("shouldAttemptFreestyleFallback allows small targets", () => {
	assert.equal(shouldAttemptFreestyleFallback(50_000, DEFAULT_JEV_CONFIG), true);
});

test("triggerConsolidation skips all LLM fallbacks for oversized empty typed plans", async () => {
	let directCalls = 0;
	const store = {
		getMemoryEntries: () => ["x".repeat(50_001)],
	} as unknown as MemoryStore;
	const result = await triggerConsolidation(
		{} as never,
		store,
		"memory",
		undefined,
		undefined,
		undefined,
		{ reviewTransport: "direct" },
		{} as never,
		undefined,
		undefined,
		DEFAULT_JEV_CONFIG,
		{
			runTypedConsolidation: async () => ({
				status: "empty",
				removed: 0,
				shrinkBytes: 0,
				chunks: 1,
				pairsJudged: 7,
				staleJudged: 0,
			}),
			runDirectMemoryCompletion: (async () => {
				directCalls++;
				return { ok: true, appliedCount: 1 };
			}) as never,
		},
	);

	assert.equal(result.consolidated, false);
	assert.equal(directCalls, 0);
	assert.match(result.error ?? "", /7 pairs judged, 0 stale candidates judged/);
	assert.match(result.error ?? "", /whole-file LLM fallback skipped/);
	assert.match(result.error ?? "", /only pruned after 30d of age and 30d without a reference/);
	assert.match(result.error ?? "", /stale\.ageDays and jev\.consolidation\.stale\.referencedDays/);
	assert.match(result.error ?? "", /aggressive pass/);
});

const staleDisabledConfig = (): JevConfig => ({
	...DEFAULT_JEV_CONFIG,
	consolidation: {
		...DEFAULT_JEV_CONFIG.consolidation,
		stale: { ...DEFAULT_JEV_CONFIG.consolidation.stale, enabled: false },
	},
});

test("triggerConsolidation keeps the pre-stale oversized message when the stale stage is disabled", async () => {
	let directCalls = 0;
	const store = {
		getMemoryEntries: () => ["x".repeat(50_001)],
	} as unknown as MemoryStore;
	const result = await triggerConsolidation(
		{} as never,
		store,
		"memory",
		undefined,
		undefined,
		undefined,
		{ reviewTransport: "direct" },
		{} as never,
		undefined,
		undefined,
		staleDisabledConfig(),
		{
			runTypedConsolidation: async () => ({
				status: "empty",
				removed: 0,
				shrinkBytes: 0,
				chunks: 1,
				pairsJudged: 3,
				staleJudged: 5,
			}),
			runDirectMemoryCompletion: (async () => {
				directCalls++;
				return { ok: true, appliedCount: 1 };
			}) as never,
		},
	);

	assert.equal(result.consolidated, false);
	assert.equal(directCalls, 0);
	assert.match(result.error ?? "", /3 pairs judged\)/);
	assert.doesNotMatch(result.error ?? "", /stale candidates judged/);
	assert.match(result.error ?? "", /retention pass/);
});

const noul = (noul: number) => ({ type: "noul" as const, noul });
const choice = (choice: string, confidence: number) => ({ type: "choice" as const, choice, confidence, probabilities: {} });

const entry = (id: string, content: string, created: string, lastReferenced: string): ConsolidatorEntry => ({
	id,
	content,
	created,
	lastReferenced,
});

test("chunkEntries: 90 entries x 1000 chars split at entry boundaries, never mid-entry", () => {
	const entries = Array.from({ length: 90 }, (_, i) =>
		entry(String(i), `${String(i).padStart(4, "0")} ${"x".repeat(996)}`, "2026-01-01", "2026-01-01"));
	const total = entries.map((e) => e.content).join(ENTRY_DELIMITER).length;
	assert.ok(total > CONSOLIDATOR_CHUNK_CHAR_LIMIT);

	const chunks = chunkEntries(entries);
	assert.ok(chunks.length >= 3, `expected 3+ chunks, got ${chunks.length}`);
	const seen: ConsolidatorEntry[] = [];
	for (const chunk of chunks) {
		assert.ok(chunk.map((e) => e.content).join(ENTRY_DELIMITER).length <= CONSOLIDATOR_CHUNK_CHAR_LIMIT);
		seen.push(...chunk);
	}
	assert.equal(seen.length, entries.length);
	assert.deepEqual(seen.map((e) => e.id), entries.map((e) => e.id));

	assert.deepEqual(chunkEntries(entries.slice(0, 5)), [entries.slice(0, 5)]);

	const oversized = entry("big", "y".repeat(CONSOLIDATOR_CHUNK_CHAR_LIMIT + 10), "2026-01-01", "2026-01-01");
	assert.deepEqual(chunkEntries([entries[0]!, oversized, entries[1]!]), [
		[entries[0]],
		[oversized],
		[entries[1]],
	]);
});

test("selectPairs: duplicate-ish entries pair up, unrelated do not, recency window applies", () => {
	const chunk = [
		entry("0", "user prefers pnpm for all package installs", "2026-01-01", "2026-01-01"),
		entry("1", "user prefers pnpm for package installs everywhere", "2026-02-01", "2026-02-20"),
		entry("2", "sunset photographs are nice", "2026-02-25", "2026-02-25"),
	];
	const pairs = selectPairs(chunk, { now: NOW });
	assert.equal(pairs.length, 1);
	assert.deepEqual([pairs[0]?.firstId, pairs[0]?.secondId].sort(), ["0", "1"]);

	// Both dates outside the 45-day window: the entry is not offered as a pair candidate.
	const stale = [
		entry("0", "user prefers pnpm for all package installs", "2025-11-01", "2025-11-01"),
		entry("1", "user prefers pnpm for package installs everywhere", "2025-12-01", "2025-12-01"),
	];
	assert.deepEqual(selectPairs(stale, { now: NOW }), []);

	const many = Array.from({ length: 100 }, (_, i) =>
		entry(String(i), `shared tokens alpha beta gamma ${i % 3}`, "2026-02-01", "2026-02-01"));
	assert.equal(selectPairs(many, { now: NOW }).length, 40);
});

const pairAnswers = (p: number, representation: string, redundant: number, contradiction = 0.1): JevAnswers => ({
	[`pair_${p}_redundant`]: noul(redundant),
	[`pair_${p}_contradiction`]: noul(contradiction),
	[`pair_${p}_obsolete`]: noul(0.2),
	[`pair_${p}_representation`]: choice(representation, 0.9),
});

test("buildExecutorPlan: retire removes the older entry; merge defers; malformed degrades; contradiction keeps", () => {
	const chunk = [
		entry("0", "user prefers pnpm for every install", "2026-01-01", "2026-02-01"),
		entry("1", "user prefers pnpm across all installs", "2026-01-15", "2026-02-20"),
	];
	const pairs: ConsolidatorPair[] = [{ firstId: "0", secondId: "1" }];

	const retire = buildExecutorPlan(chunk, pairs, pairAnswers(0, "retire", 0.5), { now: NOW });
	assert.equal(retire.degraded, false);
	assert.equal(retire.retires.length, 1);
	assert.equal(retire.retires[0]?.entryId, "0");
	assert.equal(retire.retires[0]?.oldText, "user prefers pnpm for every install");

	const merge = buildExecutorPlan(chunk, pairs, pairAnswers(0, "merge", 0.6), { now: NOW });
	assert.equal(merge.retires.length, 0);
	assert.deepEqual(merge.mergeDeferred, [{ firstId: "0", secondId: "1" }]);

	const malformed = buildExecutorPlan(chunk, pairs, {
		pair_0_representation: choice("retire", 0.9),
	} as JevAnswers, { now: NOW });
	assert.equal(malformed.retires.length, 0);
	assert.equal(malformed.degraded, true);

	const contradictory = buildExecutorPlan(chunk, pairs, pairAnswers(0, "retire", 0.95, 0.9), { now: NOW });
	assert.equal(contradictory.retires.length, 0);
	assert.equal(contradictory.mergeDeferred.length, 0);
	assert.equal(contradictory.degraded, false);
});

test("buildExecutorPlan: last_referenced within 7 days is sticky unless redundant >= 0.9", () => {
	const stickyChunk = [
		entry("0", "user prefers pnpm for every install", "2026-01-01", "2026-02-27"),
		entry("1", "user prefers pnpm across all installs", "2026-01-15", "2026-01-20"),
	];
	const pairs: ConsolidatorPair[] = [{ firstId: "0", secondId: "1" }];

	const blocked = buildExecutorPlan(stickyChunk, pairs, pairAnswers(0, "retire", 0.5), { now: NOW });
	assert.equal(blocked.retires.length, 0);
	assert.equal(blocked.stickyBlocked, 1);

	const redundantEnough = buildExecutorPlan(stickyChunk, pairs, pairAnswers(0, "retire", 0.95), { now: NOW });
	assert.equal(redundantEnough.retires.length, 1);
	assert.equal(redundantEnough.retires[0]?.entryId, "0");
});

test("selectStaleCandidates: age and reference gates, stickiness exclusion", () => {
	const entries = [
		entry("0", "fresh entry", "2026-02-15", "2026-02-15"),
		entry("1", "old but referenced recently", "2025-12-01", "2026-02-20"),
		entry("2", "old and unreferenced", "2025-12-01", "2026-01-15"),
		entry("3", "referenced inside sticky window", "2025-11-01", "2026-02-27"),
	];
	const config = { ageDays: 30, referencedDays: 30 };
	assert.deepEqual(selectStaleCandidates(entries, config, NOW).map((candidate) => candidate.id), ["2"]);

	// Referenced 2 days ago: clears a 3-day referencedDays gate, but the 7-day
	// sticky window still excludes it.
	assert.deepEqual(selectStaleCandidates([entries[3]], { ageDays: 30, referencedDays: 3 }, NOW), []);
});

test("chunkStaleCandidates caps at 60 entries per chunk within the shared char limit", () => {
	const tiny = Array.from({ length: 90 }, (_, i) => entry(String(i), `stale fact ${i}`, "2025-11-01", "2026-01-01"));
	assert.deepEqual(chunkStaleCandidates(tiny).map((chunk) => chunk.length), [60, 30]);

	const big = Array.from({ length: 130 }, (_, i) =>
		entry(String(i), `${String(i).padStart(4, "0")} ${"x".repeat(996)}`, "2025-11-01", "2026-01-01"));
	const bigChunks = chunkStaleCandidates(big);
	assert.equal(bigChunks.flat().length, 130);
	for (const chunk of bigChunks) {
		assert.ok(chunk.length <= 60);
		assert.ok(chunk.map((e) => e.content).join(ENTRY_DELIMITER).length <= CONSOLIDATOR_CHUNK_CHAR_LIMIT);
	}
	assert.deepEqual(chunkStaleCandidates([]), []);
});

test("buildStalePlan: threshold retire, below-threshold keep, malformed skip + degraded", () => {
	const chunk = [
		entry("0", "expired event note", "2025-11-01", "2026-01-01"),
		entry("1", "evergreen preference", "2025-12-01", "2026-01-01"),
	];
	const plan = buildStalePlan(chunk, { entry_0_stale: noul(0.9), entry_1_stale: noul(0.2) });
	assert.equal(plan.degraded, false);
	assert.equal(plan.retires.length, 1);
	assert.equal(plan.retires[0]?.entryId, "0");
	assert.equal(plan.retires[0]?.oldText, "expired event note");

	assert.equal(buildStalePlan([chunk[0]], { entry_0_stale: noul(0.85) }).retires.length, 1);
	assert.equal(buildStalePlan([chunk[0]], { entry_0_stale: noul(0.84) }).retires.length, 0);
	assert.deepEqual(
		buildStalePlan([chunk[1]], { entry_0_stale: noul(0.5) }, { threshold: 0.4 }).retires.map((retire) => retire.entryId),
		["1"],
	);

	const malformed = buildStalePlan(chunk, { entry_0_stale: noul(0.9) });
	assert.equal(malformed.retires.length, 1);
	assert.equal(malformed.degraded, true);
});

const rawEntry = (text: string, created: string, last: string) => `${text} <!-- created=${created}, last=${last} -->`;

async function seededMemoryStore(entries: string[]): Promise<{ store: MemoryStore; dir: string }> {
	const dir = mkdtempSync(join(tmpdir(), "jev-consolidator-"));
	const store = new MemoryStore({ ...loadConfig(join(dir, "missing-config.json")), memoryDir: dir });
	writeFileSync(join(dir, "MEMORY.md"), entries.join(ENTRY_DELIMITER), "utf-8");
	await store.loadFromDisk();
	return { store, dir };
}

const fakeJev = (answersForPair: (p: number) => JevAnswers): typeof jevCall => {
	return async (state: JevState) => {
		const candidates = (state as { candidates?: unknown[] }).candidates ?? [];
		let answers: JevAnswers = {};
		for (let p = 0; p < candidates.length; p++) answers = { ...answers, ...answersForPair(p) };
		return answers;
	};
};

const retireAnswers = (p: number) => pairAnswers(p, "retire", 0.95);
const mergeAnswers = (p: number) => pairAnswers(p, "merge", 0.6);

const staleAnswers = (values: number[]): JevAnswers => {
	const answers: JevAnswers = {};
	for (let i = 0; i < values.length; i++) answers[`entry_${i}_stale`] = noul(values[i]!);
	return answers;
};

/** Pair calls carry a `candidates` array; stale calls only `entries`. */
const fakeTwoStageJev = (
	pairsFor: (p: number) => JevAnswers,
	staleFor: (staleChunk: number, size: number) => JevAnswers | null,
): typeof jevCall => {
	let staleChunk = 0;
	return async (state: JevState) => {
		const candidates = (state as { candidates?: unknown[] }).candidates;
		if (Array.isArray(candidates)) {
			let answers: JevAnswers = {};
			for (let p = 0; p < candidates.length; p++) answers = { ...answers, ...pairsFor(p) };
			return answers;
		}
		const staleEntries = (state as { entries?: unknown[] }).entries ?? [];
		const answers = staleFor(staleChunk, staleEntries.length);
		staleChunk++;
		return answers;
	};
};

async function withAuditRedirected<T>(fn: (auditPath: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "jev-consolidator-audit-"));
	const auditPath = join(dir, "audit.jsonl");
	const previous = process.env.JEVM_AUDIT_PATH;
	process.env.JEVM_AUDIT_PATH = auditPath;
	try {
		return await fn(auditPath);
	} finally {
		if (previous === undefined) delete process.env.JEVM_AUDIT_PATH;
		else process.env.JEVM_AUDIT_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

const seededEntries = () => [
	rawEntry("user prefers pnpm for every install", "2026-01-01", "2026-02-01"),
	rawEntry("user prefers pnpm across all installs", "2026-01-15", "2026-02-20"),
	rawEntry("sunset photographs are nice", "2026-02-25", "2026-02-25"),
];

test("runTypedConsolidation: retire decision honored, older entry removed, chunk audited", async () => {
	await withAuditRedirected(async () => {
		const { store, dir } = await seededMemoryStore(seededEntries());
		try {
			const outcome = await runTypedConsolidation(store, "memory", "memory", DEFAULT_JEV_CONFIG, {
				deps: { jevCall: fakeJev(retireAnswers), now: () => NOW },
			});
			assert.equal(outcome.status, "applied");
			assert.equal(outcome.removed, 1);
			assert.ok(outcome.shrinkBytes > 0);

			const remaining = store.getMemoryEntries();
			assert.equal(remaining.length, 2);
			assert.ok(!remaining.includes("user prefers pnpm for every install"));
			assert.ok(remaining.includes("user prefers pnpm across all installs"));

			const records = readAudit().filter((record) => record.decision === "consolidation");
			assert.equal(records.length, 1);
			assert.equal(records[0]?.outcome, "run");
			assert.equal(records[0]?.target, "memory");
			assert.equal(records[0]?.scores?.pairs, 1);
			assert.equal(records[0]?.scores?.retires, 1);
			assert.ok((records[0]?.scores?.shrink_bytes ?? 0) > 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("runTypedConsolidation: merge verdict deferred and audited, store untouched", async () => {
	await withAuditRedirected(async () => {
		const { store, dir } = await seededMemoryStore(seededEntries());
		try {
			const outcome = await runTypedConsolidation(store, "memory", "memory", DEFAULT_JEV_CONFIG, {
				deps: { jevCall: fakeJev(mergeAnswers), now: () => NOW },
			});
			assert.equal(outcome.status, "empty");
			assert.equal(outcome.removed, 0);
			assert.equal(store.getMemoryEntries().length, 3);

			const records = readAudit().filter((record) => record.decision === "consolidation");
			assert.equal(records.length, 1);
			assert.equal(records[0]?.outcome, "run");
			assert.equal(records[0]?.scores?.merges_deferred, 1);
			assert.equal(records[0]?.scores?.retires, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("runTypedConsolidation: null Jev answers stop the run, nothing applied, audited degraded", async () => {
	await withAuditRedirected(async () => {
		const { store, dir } = await seededMemoryStore(seededEntries());
		try {
			const outcome = await runTypedConsolidation(store, "memory", "memory", DEFAULT_JEV_CONFIG, {
				deps: { jevCall: async () => null, now: () => NOW },
			});
			assert.equal(outcome.status, "unavailable");
			assert.equal(store.getMemoryEntries().length, 3);
			const records = readAudit().filter((record) => record.decision === "consolidation");
			assert.equal(records.length, 1);
			assert.equal(records[0]?.outcome, "degraded");
			assert.equal(records[0]?.degraded, true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("runTypedConsolidation: requireShrink abort path leaves the store untouched and audits aborted", async () => {
	await withAuditRedirected(async () => {
		// The victim's text is a substring of the other entry, so the atomic
		// remove plan cannot apply — the run must abort with nothing removed.
		const { store, dir } = await seededMemoryStore([
			rawEntry("alpha beta", "2026-01-15", "2026-01-15"),
			rawEntry("alpha beta gamma delta", "2026-01-16", "2026-01-16"),
		]);
		try {
			const outcome = await runTypedConsolidation(store, "memory", "memory", DEFAULT_JEV_CONFIG, {
				deps: { jevCall: fakeJev(retireAnswers), now: () => NOW },
			});
			assert.equal(outcome.status, "aborted");
			assert.match(outcome.reason ?? "", /Multiple entries matched/);
			assert.equal(store.getMemoryEntries().length, 2);

			const records = readAudit().filter((record) => record.decision === "consolidation");
			const aborted = records.find((record) => record.outcome === "aborted");
			assert.ok(aborted, "expected an aborted consolidation audit record");
			assert.match(aborted.error ?? "", /Multiple entries matched/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("runTypedConsolidation: overlapping retire pairs collapse to one remove op instead of aborting", async () => {
	await withAuditRedirected(async () => {
		// 3-way duplicate cluster: entry 0 loses to both 1 and 2, so two retire
		// verdicts name the same victim — they must dedup to a single remove op.
		const { store, dir } = await seededMemoryStore([
			rawEntry("user prefers pnpm for every install", "2026-01-01", "2026-02-01"),
			rawEntry("user prefers pnpm across all installs", "2026-01-15", "2026-01-15"),
			rawEntry("user prefers pnpm for all package work", "2026-01-20", "2026-01-20"),
		]);
		try {
			const clusterAnswers = (p: number) => (p < 2 ? retireAnswers(p) : pairAnswers(p, "keep_separate", 0.5));
			const outcome = await runTypedConsolidation(store, "memory", "memory", DEFAULT_JEV_CONFIG, {
				deps: { jevCall: fakeJev(clusterAnswers), now: () => NOW },
			});
			assert.equal(outcome.status, "applied");
			assert.equal(outcome.removed, 1);

			const remaining = store.getMemoryEntries();
			assert.equal(remaining.length, 2);
			assert.ok(!remaining.includes("user prefers pnpm for every install"));
			assert.ok(remaining.includes("user prefers pnpm across all installs"));
			assert.ok(remaining.includes("user prefers pnpm for all package work"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("runTypedConsolidation: stale stage disabled never asks Jev about old entries", async () => {
	await withAuditRedirected(async () => {
		const { store, dir } = await seededMemoryStore([
			rawEntry("expired one-time note", "2025-11-01", "2026-01-01"),
			rawEntry("expired second note", "2025-11-02", "2026-01-02"),
		]);
		try {
			let calls = 0;
			const outcome = await runTypedConsolidation(store, "memory", "memory", staleDisabledConfig(), {
				deps: { jevCall: async () => { calls++; return null; }, now: () => NOW },
			});
			assert.equal(outcome.status, "empty");
			assert.equal(outcome.staleJudged, 0);
			assert.equal(calls, 0);
			assert.equal(store.getMemoryEntries().length, 2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("runTypedConsolidation: pair and stale retires dedup by entryId in one shrink plan", async () => {
	await withAuditRedirected(async () => {
		// Entry 0 is both the pair victim and stale-retired — one remove op, not two.
		const { store, dir } = await seededMemoryStore([
			rawEntry("user prefers pnpm for every install", "2026-01-20", "2026-01-25"),
			rawEntry("user prefers pnpm for all installs", "2026-01-25", "2026-01-30"),
			rawEntry("outdated one-time migration note", "2025-12-01", "2026-01-15"),
		]);
		try {
			const jev = fakeTwoStageJev(
				retireAnswers,
				() => staleAnswers([0.9, 0.1, 0.9]),
			);
			const outcome = await runTypedConsolidation(store, "memory", "memory", DEFAULT_JEV_CONFIG, {
				deps: { jevCall: jev, now: () => NOW },
			});
			assert.equal(outcome.status, "applied");
			assert.equal(outcome.removed, 2);
			assert.equal(outcome.pairsJudged, 1);
			assert.equal(outcome.staleJudged, 3);

			const remaining = store.getMemoryEntries();
			assert.equal(remaining.length, 1);
			assert.ok(remaining.includes("user prefers pnpm for all installs"));

			const records = readAudit().filter((record) => record.decision === "consolidation");
			assert.equal(records.length, 2);
			const staleRecord = records.find((record) => record.scores?.staleCandidates !== undefined);
			assert.ok(staleRecord, "expected a stale-stage audit record");
			assert.equal(staleRecord?.outcome, "run");
			assert.equal(staleRecord?.scores?.staleCandidates, 3);
			assert.equal(staleRecord?.scores?.staleRetires, 2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("runTypedConsolidation: malformed stale answers fail open — entries skipped, degraded audit", async () => {
	await withAuditRedirected(async () => {
		const { store, dir } = await seededMemoryStore([
			rawEntry("expired one-time note", "2025-11-01", "2026-01-01"),
			rawEntry("expired second note", "2025-11-02", "2026-01-02"),
		]);
		try {
			const outcome = await runTypedConsolidation(store, "memory", "memory", DEFAULT_JEV_CONFIG, {
				deps: { jevCall: async () => ({}), now: () => NOW },
			});
			assert.equal(outcome.status, "empty");
			assert.equal(outcome.staleJudged, 2);
			assert.equal(store.getMemoryEntries().length, 2);

			const records = readAudit().filter((record) => record.decision === "consolidation");
			const degraded = records.find((record) => record.outcome === "degraded");
			assert.ok(degraded, "expected a degraded stale audit record");
			assert.equal(degraded?.degraded, true);
			assert.equal(degraded?.scores?.staleCandidates, 2);
			assert.equal(degraded?.scores?.staleRetires, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("runTypedConsolidation: stale stage stops at the first null chunk, judging only completed chunks", async () => {
	await withAuditRedirected(async () => {
		// 90 tiny old entries: no pairs (outside the 45-day recency window), but
		// 90 stale candidates → two stale chunks under the 60-entry cap.
		const raws = Array.from({ length: 90 }, (_, i) => rawEntry(`stale fact ${i}`, "2025-11-01", "2026-01-01"));
		const { store, dir } = await seededMemoryStore(raws);
		try {
			const jev = fakeTwoStageJev(
				() => ({}),
				(staleChunk, size) => (staleChunk === 0 ? staleAnswers(Array.from({ length: size }, () => 0.2)) : null),
			);
			const outcome = await runTypedConsolidation(store, "memory", "memory", DEFAULT_JEV_CONFIG, {
				deps: { jevCall: jev, now: () => NOW },
			});
			assert.equal(outcome.status, "unavailable");
			assert.equal(outcome.reason, "jev unavailable");
			assert.equal(outcome.pairsJudged, 0);
			assert.equal(outcome.staleJudged, 60);
			assert.equal(store.getMemoryEntries().length, 90);

			const records = readAudit().filter((record) => record.decision === "consolidation");
			const staleRun = records.find((record) => record.scores?.staleRetires !== undefined);
			assert.ok(staleRun);
			assert.equal(staleRun?.scores?.staleCandidates, 60);
			const degraded = records.find((record) => record.outcome === "degraded");
			assert.ok(degraded);
			assert.equal(degraded?.degraded, true);
			assert.equal(degraded?.scores?.staleCandidates, 30);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

const rerankAnswers = (means: number[]): JevAnswers => {
	const answers: JevAnswers = {};
	for (let i = 0; i < means.length; i++) {
		answers[`pair_${i}_relevance`] = noul(means[i]!);
		answers[`pair_${i}_adds_detail`] = noul(means[i]!);
		answers[`pair_${i}_actionable_now`] = noul(means[i]!);
	}
	return answers;
};

test("rerankBlendOrder flips the order when Jev relevance contradicts BM25", () => {
	const blend = rerankBlendOrder(4, rerankAnswers([0, 1, 0.8, 0.8]), 0.35);
	assert.equal(blend.degraded, false);
	// Blended scores [0.5, 0.8333, 0.5667, 0.4]: candidate 1 out-ranks the BM25 winner.
	assert.deepEqual(blend.order, [1, 2, 0, 3]);
});

test("rerankBlendOrder floor never reduces the pool below three results", () => {
	// All-zero nouls leave only rank-component scores (0.5, 0.4, 0.3, 0.2,
	// 0.1, 0): one clears the floor, but the min-3 guarantee keeps three.
	const blend = rerankBlendOrder(6, rerankAnswers([0, 0, 0, 0, 0, 0]), 0.35);
	assert.equal(blend.degraded, false);
	assert.equal(blend.order.length, 3);
	assert.deepEqual(blend.order, [0, 1, 2]);
});

test("rerankBlendOrder: null client or malformed per-candidate answers keep the identity BM25 order", () => {
	assert.deepEqual(rerankBlendOrder(3, null, 0.35), { order: [0, 1, 2], degraded: true });

	const partial: JevAnswers = {
		pair_0_relevance: noul(0.9),
		pair_1_relevance: noul(0.9),
		pair_1_adds_detail: noul(0.9),
		pair_1_actionable_now: noul(0.9),
	};
	assert.deepEqual(rerankBlendOrder(2, partial, 0.35), { order: [0, 1], degraded: true });

	const malformed = {
		pair_0_relevance: { type: "noul" },
		pair_0_adds_detail: noul(1),
		pair_0_actionable_now: noul(1),
		pair_1_relevance: noul(1),
		pair_1_adds_detail: noul(1),
		pair_1_actionable_now: noul(1),
	} as unknown as JevAnswers;
	assert.deepEqual(rerankBlendOrder(2, malformed, 0.35), { order: [0, 1], degraded: true });
});

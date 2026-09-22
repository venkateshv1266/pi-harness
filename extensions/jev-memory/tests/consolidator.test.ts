import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAudit } from "../src/jev/audit.js";
import { jevCall, type JevAnswers, type JevState } from "../src/jev/client.js";
import { DEFAULT_JEV_CONFIG } from "../src/jev/config.js";
import {
	buildExecutorPlan,
	chunkEntries,
	CONSOLIDATOR_CHUNK_CHAR_LIMIT,
	selectPairs,
	type ConsolidatorEntry,
	type ConsolidatorPair,
} from "../src/jev/consolidator.js";
import { runTypedConsolidation } from "../src/handlers/auto-consolidate.js";
import { loadConfig } from "../src/config.js";
import { ENTRY_DELIMITER } from "../src/constants.js";
import { MemoryStore } from "../src/store/memory-store.js";
import { rerankBlendOrder } from "../src/tools/memory-search-tool.js";

const NOW = new Date("2026-03-01T00:00:00.000Z");
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

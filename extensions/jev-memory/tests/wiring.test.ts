import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendAudit, readAudit } from "../src/jev/audit.js";
import { clearJevCache, jevCall, type JevAnswers } from "../src/jev/client.js";
import { DEFAULT_JEV_CONFIG, resolveJevConfig, type JevConfig } from "../src/jev/config.js";
import {
	admissionGate,
	buildCorrectionState,
	buildTurnDigest,
	correctionGate,
	isExactDuplicate,
	pregateGate,
	selectAdmissionCandidates,
	type AdmissionState,
} from "../src/jev/gates.js";
import { ADMISSION_QUESTIONS } from "../src/jev/questions.js";
import { admissionScore } from "../src/jev/scoring.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/store/memory-store.js";
import { applyReviewOperations } from "../src/handlers/review-memory-ops.js";

const noul = (noul: number) => ({ type: "noul" as const, noul });
const admissionAnswers = (values: { should_store: number; future_utility: number; importance: number; novelty: number; redundancy: number }): JevAnswers => ({
	should_store: noul(values.should_store),
	future_utility: noul(values.future_utility),
	importance: noul(values.importance),
	novelty: noul(values.novelty),
	redundancy: noul(values.redundancy),
});
const state: AdmissionState = { content: "a durable fact about the user", exact_duplicate: false, candidates: [] };

test("admissionGate degrades to pass-through when the client returns null", async () => {
	clearJevCache();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() => { throw new Error("fetch must not be called"); }) as typeof fetch;
	try {
		process.env.JEVM_JEV = "0";
		const answers = await jevCall(state, ADMISSION_QUESTIONS);
		assert.equal(answers, null);
		const gate = admissionGate(state, answers, DEFAULT_JEV_CONFIG);
		assert.equal(gate.verdict, "pass-through");
		assert.equal(gate.reason, undefined);
	} finally {
		delete process.env.JEVM_JEV;
		globalThis.fetch = originalFetch;
	}
});

test("admissionGate fails open on a non-null response with missing or malformed answers", () => {
	assert.equal(admissionGate(state, {}, DEFAULT_JEV_CONFIG).verdict, "pass-through");
	assert.equal(admissionGate(state, { should_store: noul(0.9) }, DEFAULT_JEV_CONFIG).verdict, "pass-through");
	const malformedNoul = { should_store: { type: "noul" }, future_utility: noul(1), importance: noul(1), novelty: noul(1), redundancy: noul(0) } as unknown as JevAnswers;
	assert.equal(admissionGate(state, malformedNoul, DEFAULT_JEV_CONFIG).verdict, "pass-through");
	assert.equal(admissionGate(state, admissionAnswers({ should_store: 0.9, future_utility: 0.8, importance: 0.7, novelty: 0.9, redundancy: 0.1 }), DEFAULT_JEV_CONFIG).verdict, "allow");
});

test("admissionGate blocks exact duplicates without a Jev call, even with answers present", () => {
	const duplicateState: AdmissionState = { content: "same text", exact_duplicate: true, candidates: [] };
	const blocked = admissionGate(duplicateState, null, DEFAULT_JEV_CONFIG);
	assert.equal(blocked.verdict, "block");
	assert.match(blocked.reason ?? "", /exact duplicate of an existing entry/);
	const withAnswers = admissionGate(duplicateState, admissionAnswers({ should_store: 1, future_utility: 1, importance: 1, novelty: 1, redundancy: 0 }), DEFAULT_JEV_CONFIG);
	assert.equal(withAnswers.verdict, "block");
});

test("admissionGate allows high scores and blocks low ones with the five raw values in the reason", () => {
	const high = admissionGate(state, admissionAnswers({ should_store: 0.9, future_utility: 0.8, importance: 0.7, novelty: 0.9, redundancy: 0.1 }), DEFAULT_JEV_CONFIG);
	assert.equal(high.verdict, "allow");
	assert.equal(high.scores?.should_store, 0.9);

	const low = admissionGate(state, admissionAnswers({ should_store: 0.2, future_utility: 0.1, importance: 0.1, novelty: 0.1, redundancy: 0.9 }), DEFAULT_JEV_CONFIG);
	assert.equal(low.verdict, "block");
	for (const name of ["should_store", "future_utility", "importance", "novelty", "redundancy"]) {
		assert.ok(low.reason?.includes(name), `reason must include ${name}`);
	}
	assert.ok(low.reason?.includes("rephrase and retry"));
});

test("admissionGate honors the configured threshold and weights", () => {
	const config: JevConfig = { ...DEFAULT_JEV_CONFIG, admission: { enabled: true, threshold: 0.6 } };
	const atBoundary = admissionGate(state, admissionAnswers({ should_store: 1, future_utility: 0.6, importance: 0.6, novelty: 0.6, redundancy: 0 }), config);
	assert.ok(Math.abs((atBoundary.score ?? -1) - 0.6) < 1e-12);
	assert.equal(atBoundary.verdict, "allow");
	const below = admissionGate(state, admissionAnswers({ should_store: 0.9, future_utility: 0.6, importance: 0.6, novelty: 0.6, redundancy: 0 }), config);
	assert.equal(below.verdict, "block");

	const weighted: JevConfig = { ...DEFAULT_JEV_CONFIG, admission: { enabled: true, threshold: 0.5 }, admissionWeights: [1, 0, 0, 0] };
	const gate = admissionGate(state, admissionAnswers({ should_store: 1, future_utility: 0.5, importance: 0, novelty: 0, redundancy: 1 }), weighted);
	assert.ok(Math.abs((gate.score ?? -1) - 0.5) < 1e-12);
	assert.equal(gate.verdict, "allow");
});

test("admissionScore formula edge cases", () => {
	const values = { should_store: 1, future_utility: 1, importance: 1, novelty: 1, redundancy: 1 };
	// should_store sits outside the max(): zero should_store zeroes the score.
	assert.equal(admissionScore({ ...values, should_store: 0 }), 0);
	// Negative inner term is clamped by max(0, ...).
	assert.equal(admissionScore({ should_store: 1, future_utility: 0, importance: 0, novelty: 0, redundancy: 1 }), 0);
	// Full redundancy subtracts w3 but cannot push below zero.
	assert.equal(admissionScore(values), 1 - 0.2);
	// Custom weights flow through from the config tuple.
	assert.equal(admissionScore({ ...values, redundancy: 0 }, [1, 0, 0, 0]), 1);
});

test("isExactDuplicate normalizes both sides before exact comparison", () => {
	assert.ok(isExactDuplicate("  USE  TypeScript\nEverywhere ", ["USE  TypeScript"]));
	assert.ok(!isExactDuplicate("USE TypeScript", ["USE  TypeScript"]));
	assert.ok(!isExactDuplicate("brand new content", ["USE  TypeScript"]));
	assert.ok(!isExactDuplicate("", ["USE  TypeScript"]));
	assert.ok(!isExactDuplicate("anything", []));
});

test("selectAdmissionCandidates ranks by token-set Jaccard, ignores short tokens, and caps at the limit", () => {
	const entries = [
		"alpha beta gamma delta",
		"alpha only",
		"completely unrelated note about sunsets",
		"to do it",
	];
	const candidates = selectAdmissionCandidates("alpha beta gamma", entries);
	assert.equal(candidates[0], "alpha beta gamma delta");
	assert.equal(candidates[1], "alpha only");
	assert.ok(!candidates.includes("completely unrelated note about sunsets"));
	assert.ok(!candidates.includes("to do it"));

	const many = Array.from({ length: 15 }, (_, i) => `alpha beta shared number ${i}`);
	assert.equal(selectAdmissionCandidates("alpha beta gamma", many).length, 10);
	assert.deepEqual(selectAdmissionCandidates("no overlapping tokens here", entries), []);
});

test("pregateGate fails open and applies the threshold at the boundary", () => {
	const degraded = pregateGate(null, DEFAULT_JEV_CONFIG);
	assert.equal(degraded.run, true);
	assert.equal(degraded.degraded, true);
	const malformed = pregateGate({}, DEFAULT_JEV_CONFIG);
	assert.equal(malformed.run, true);
	assert.equal(malformed.degraded, true);
	const malformedNoul = pregateGate({ worth_review: { type: "noul" } } as unknown as JevAnswers, DEFAULT_JEV_CONFIG);
	assert.equal(malformedNoul.run, true);
	assert.equal(malformedNoul.degraded, true);
	assert.equal(pregateGate({ worth_review: noul(0.4) }, DEFAULT_JEV_CONFIG).run, false);
	assert.equal(pregateGate({ worth_review: noul(0.55) }, DEFAULT_JEV_CONFIG).run, true);
	const run = pregateGate({ worth_review: noul(0.9) }, DEFAULT_JEV_CONFIG);
	assert.equal(run.run, true);
	assert.equal(run.degraded, false);
	assert.equal(run.worthReview, 0.9);
});

test("correctionGate fails open, skips below-threshold corrections, and routes the target", () => {
	const degraded = correctionGate(null);
	assert.equal(degraded.save, true);
	assert.equal(degraded.degraded, true);
	const malformed = correctionGate({});
	assert.equal(malformed.save, true);
	assert.equal(malformed.degraded, true);
	const malformedNoul = correctionGate({ is_correction: { type: "noul" } } as unknown as JevAnswers);
	assert.equal(malformedNoul.save, true);
	assert.equal(malformedNoul.degraded, true);
	assert.equal(correctionGate({ is_correction: noul(0.59) }).save, false);
	const boundary = correctionGate({ is_correction: noul(0.6) });
	assert.equal(boundary.save, true);
	assert.equal(boundary.target, undefined);
	const routed = correctionGate({
		is_correction: noul(0.9),
		directive_target: { type: "choice", choice: "project", confidence: 0.9, probabilities: { project: 0.9 } },
	});
	assert.equal(routed.save, true);
	assert.equal(routed.target, "project");
	const invalid = correctionGate({
		is_correction: noul(0.9),
		directive_target: { type: "choice", choice: "bogus", confidence: 0.9, probabilities: {} },
	});
	assert.equal(invalid.save, true);
	assert.equal(invalid.target, undefined);
});

test("buildTurnDigest joins parts and truncates to 8000 chars", () => {
	assert.equal(buildTurnDigest(["a", "b"]), "a\n\nb");
	assert.equal(buildTurnDigest([`${"x".repeat(9000)}`]).length, 8000);
});

test("buildCorrectionState extracts the last user message and preceding assistant context", () => {
	const parts = ["[USER]: first question", "[ASSISTANT]: first answer", "[USER]: no, use pnpm", "[ASSISTANT]: okay"];
	const built = buildCorrectionState(parts);
	assert.equal(built.user_message, "no, use pnpm");
	assert.equal(built.last_assistant_context, "first answer");

	const truncated = buildCorrectionState([`[ASSISTANT]: ${"y".repeat(3000)}`, "[USER]: fix it"]);
	assert.equal(truncated.last_assistant_context.length, 2000);

	const noAssistant = buildCorrectionState(["[USER]: fix it"]);
	assert.equal(noAssistant.user_message, "fix it");
	assert.equal(noAssistant.last_assistant_context, "");
});

test("resolveJevConfig: missing file, overrides, invalid fields, and malformed JSON", () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-config-"));
	const configPath = join(dir, "jev-memory-config.json");
	try {
		assert.deepEqual(resolveJevConfig(configPath), DEFAULT_JEV_CONFIG);

		writeFileSync(configPath, JSON.stringify({
			jev: {
				enabled: false,
				admission: { threshold: 0.7 },
				admissionWeights: [1, 0, 0, 0],
				pregate: { enabled: false, threshold: 0.9 },
				correction: { enabled: false },
				audit: { enabled: false },
				unknownField: 42,
			},
		}));
		const overridden = resolveJevConfig(configPath);
		assert.equal(overridden.enabled, false);
		assert.equal(overridden.admission.enabled, true);
		assert.equal(overridden.admission.threshold, 0.7);
		assert.deepEqual(overridden.admissionWeights, [1, 0, 0, 0]);
		assert.equal(overridden.pregate.enabled, false);
		assert.equal(overridden.pregate.threshold, 0.9);
		assert.equal(overridden.correction.enabled, false);
		assert.equal(overridden.audit.enabled, false);

		writeFileSync(configPath, JSON.stringify({
			jev: {
				enabled: "yes",
				admission: { threshold: "high", enabled: 1 },
				admissionWeights: [1, 2],
				pregate: { threshold: null },
			},
		}));
		const invalid = resolveJevConfig(configPath);
		assert.equal(invalid.enabled, true);
		assert.equal(invalid.admission.enabled, true);
		assert.equal(invalid.admission.threshold, 0.6);
		assert.deepEqual(invalid.admissionWeights, [0.4, 0.3, 0.3, 0.2]);
		assert.equal(invalid.pregate.threshold, 0.55);

		writeFileSync(configPath, JSON.stringify({ jev: { admissionWeights: [0, 0, 0, 1] } }));
		assert.deepEqual(resolveJevConfig(configPath).admissionWeights, [0.4, 0.3, 0.3, 0.2]);

		writeFileSync(configPath, "{not json");
		assert.deepEqual(resolveJevConfig(configPath), DEFAULT_JEV_CONFIG);

		writeFileSync(configPath, JSON.stringify({ other: true }));
		assert.deepEqual(resolveJevConfig(configPath), DEFAULT_JEV_CONFIG);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("applyReviewOperations: null client leaves the add reachable; exact duplicates and blocks are dropped silently", async () => {
	clearJevCache();
	const dir = mkdtempSync(join(tmpdir(), "jev-store-"));
	const freshDir = mkdtempSync(join(tmpdir(), "jev-store-fresh-"));
	const auditPath = join(dir, "audit.jsonl");
	const previousAuditPath = process.env.JEVM_AUDIT_PATH;
	process.env.JEVM_AUDIT_PATH = auditPath;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() => { throw new Error("fetch must not be called"); }) as typeof fetch;
	try {
		const store = new MemoryStore({ ...loadConfig(join(dir, "missing-config.json")), memoryDir: dir });
		const seeded = await store.add("memory", "Existing durable fact");
		assert.equal(seeded.success, true);

		// Jev unavailable (kill switch): the agent flow stays reachable — the add applies.
		process.env.JEVM_JEV = "0";
		const degraded = await applyReviewOperations(store, null, [{ action: "add", target: "memory", content: "A brand new fact" }], null, null, { jevConfig: DEFAULT_JEV_CONFIG });
		assert.equal(degraded.appliedCount, 1);
		assert.equal(degraded.skippedCount, 0);
		assert.equal(degraded.error, undefined);
		delete process.env.JEVM_JEV;

		// Exact duplicate blocks without a Jev call; replace/remove pass ungated.
		const fresh = new MemoryStore({ ...loadConfig(join(dir, "missing-config.json")), memoryDir: freshDir });
		await fresh.add("memory", "Existing durable fact");
		const mixed = await applyReviewOperations(fresh, null, [
			{ action: "add", target: "memory", content: "Existing durable fact" },
			{ action: "replace", target: "memory", old_text: "Existing durable fact", content: "Existing durable fact, revised" },
		], null, null, { jevConfig: DEFAULT_JEV_CONFIG });
		assert.equal(mixed.appliedCount, 1);
		assert.equal(mixed.skippedCount, 1);
		assert.equal(mixed.error, undefined);

		const records = readAudit();
		const admissionRecords = records.filter((record) => record.decision === "admission");
		assert.ok(admissionRecords.length >= 2);
		assert.ok(admissionRecords.some((record) => record.outcome === "degraded"));
		assert.ok(admissionRecords.some((record) => record.outcome === "exact-duplicate"));
		assert.ok(admissionRecords.every((record) => record.target === "memory"));
	} finally {
		if (previousAuditPath === undefined) delete process.env.JEVM_AUDIT_PATH;
		else process.env.JEVM_AUDIT_PATH = previousAuditPath;
		delete process.env.JEVM_JEV;
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
		rmSync(freshDir, { recursive: true, force: true });
	}
});

test("applyReviewOperations admits a non-duplicate add in mock mode and audits the allow", async () => {
	clearJevCache();
	const dir = mkdtempSync(join(tmpdir(), "jev-store-mock-"));
	const auditPath = join(dir, "audit.jsonl");
	const previousAuditPath = process.env.JEVM_AUDIT_PATH;
	process.env.JEVM_AUDIT_PATH = auditPath;
	process.env.JEVM_MOCK = "1";
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() => { throw new Error("fetch must not be called"); }) as typeof fetch;
	try {
		const store = new MemoryStore({ ...loadConfig(join(dir, "missing-config.json")), memoryDir: dir });
		const result = await applyReviewOperations(store, null, [{ action: "add", target: "memory", content: "A durable mock fact" }], null, null, { jevConfig: DEFAULT_JEV_CONFIG });
		assert.equal(result.appliedCount, 1);
		assert.equal(result.skippedCount, 0);
		const records = readAudit().filter((record) => record.decision === "admission");
		assert.equal(records.length, 1);
		assert.equal(records[0]?.outcome, "allow");
		assert.equal(records[0]?.scores?.should_store, 0.9);
	} finally {
		if (previousAuditPath === undefined) delete process.env.JEVM_AUDIT_PATH;
		else process.env.JEVM_AUDIT_PATH = previousAuditPath;
		delete process.env.JEVM_MOCK;
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("applyReviewOperations fails open when Jev returns malformed answers", async () => {
	clearJevCache();
	const dir = mkdtempSync(join(tmpdir(), "jev-store-malformed-"));
	const auditPath = join(dir, "audit.jsonl");
	const previousAuditPath = process.env.JEVM_AUDIT_PATH;
	const previousApiKey = process.env.JEVM_API_KEY;
	process.env.JEVM_AUDIT_PATH = auditPath;
	process.env.JEVM_API_KEY = "test-key";
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })) as typeof fetch;
	try {
		const store = new MemoryStore({ ...loadConfig(join(dir, "missing-config.json")), memoryDir: dir });
		const result = await applyReviewOperations(store, null, [{ action: "add", target: "memory", content: "A fact Jev cannot score" }], null, null, { jevConfig: DEFAULT_JEV_CONFIG });
		assert.equal(result.appliedCount, 1);
		assert.equal(result.skippedCount, 0);
		const records = readAudit().filter((record) => record.decision === "admission");
		assert.equal(records.length, 1);
		assert.equal(records[0]?.outcome, "degraded");
		assert.equal(records[0]?.degraded, true);
	} finally {
		if (previousAuditPath === undefined) delete process.env.JEVM_AUDIT_PATH;
		else process.env.JEVM_AUDIT_PATH = previousAuditPath;
		if (previousApiKey === undefined) delete process.env.JEVM_API_KEY;
		else process.env.JEVM_API_KEY = previousApiKey;
		globalThis.fetch = originalFetch;
		clearJevCache();
		rmSync(dir, { recursive: true, force: true });
	}
});

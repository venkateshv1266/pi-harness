import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendAudit, readAudit } from "../src/jev/audit.js";
import { CallBudget, clearJevCache, jevCall } from "../src/jev/client.js";
import { ADMISSION_QUESTIONS, CONSOLIDATION_QUESTIONS, CORRECTION_QUESTIONS, PREGATE_QUESTION, RERANK_QUESTIONS } from "../src/jev/questions.js";
import { admissionScore } from "../src/jev/scoring.js";

const noul = (noul: number) => ({ noul });

test("admissionScore uses the paper formula", () => {
	const score = admissionScore({ should_store: noul(0.9), future_utility: noul(0.8), importance: noul(0.7), novelty: noul(0.9), redundancy: noul(0.1) });
	const expected = 0.9 * Math.max(0, (0.4 * 0.8 + 0.3 * 0.7 + 0.3 * 0.9) / 1.0 - 0.2 * 0.1);
	assert.ok(Math.abs(score - expected) < 1e-12);
	assert.equal(admissionScore({ should_store: noul(0), future_utility: noul(1), importance: noul(1), novelty: noul(1), redundancy: noul(0) }), 0);
	const lowRedundancy = admissionScore({ should_store: noul(1), future_utility: noul(1), importance: noul(1), novelty: noul(1), redundancy: noul(0) });
	const highRedundancy = admissionScore({ should_store: noul(1), future_utility: noul(1), importance: noul(1), novelty: noul(1), redundancy: noul(1) });
	assert.ok(highRedundancy < lowRedundancy);
});

test("jevCall mock mode is deterministic and respects cache, kill switch, and budget", async () => {
	clearJevCache();
	const state = { content: "durable" };
	const first = await jevCall(state, ADMISSION_QUESTIONS, { mock: true });
	assert.equal((first?.should_store as { noul: number }).noul, 0.9);
	const second = await jevCall(state, ADMISSION_QUESTIONS, { mock: true });
	assert.equal((second as { __cached?: boolean }).__cached, true);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() => { throw new Error("fetch must not be called"); }) as typeof fetch;
	try {
		process.env.JEVM_JEV = "0";
		assert.equal(await jevCall({ uncached: true }, ADMISSION_QUESTIONS, { mock: true }), null);
	} finally {
		delete process.env.JEVM_JEV;
		globalThis.fetch = originalFetch;
	}
	assert.equal(await jevCall({ budgeted: true }, ADMISSION_QUESTIONS, { mock: true, budget: new CallBudget(0, Date.now() + 10000) }), null);
});

test("audit append and read round trip", () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-audit-"));
	const previous = process.env.JEVM_AUDIT_PATH;
	process.env.JEVM_AUDIT_PATH = join(dir, "audit.jsonl");
	try {
		appendAudit({ ts: new Date().toISOString(), decision: "admission", outcome: "allow", latency_ms: 1 });
		const records = readAudit();
		assert.equal(records.length, 1);
		assert.equal(records[0]?.decision, "admission");
	} finally {
		if (previous === undefined) delete process.env.JEVM_AUDIT_PATH;
		else process.env.JEVM_AUDIT_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("all exported question constants have the required wire shape", () => {
	const constants = [ADMISSION_QUESTIONS, PREGATE_QUESTION, CORRECTION_QUESTIONS, RERANK_QUESTIONS, CONSOLIDATION_QUESTIONS];
	for (const questions of constants) {
		for (const question of Object.values(questions)) {
			assert.ok(question.type);
			assert.ok(question.instructions);
			assert.ok(question.criteria);
			if (question.type === "noul") assert.deepEqual(Object.keys(question.criteria).sort(), ["false", "true"]);
			if (question.type === "choice") assert.ok(Object.keys(question.criteria).length > 0);
		}
	}
	const consolidationChoice = CONSOLIDATION_QUESTIONS["pair_{i}_representation"];
	assert.deepEqual(Object.keys(consolidationChoice.criteria ?? {}).sort(), ["keep_separate", "merge", "retire", "uncertain"]);
});

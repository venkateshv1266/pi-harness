import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { test } from "node:test";

import { cacheSplit, cacheValue, overview, type Price } from "../server/queries.ts";

const SOL: Price = { model: "sol-model", input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 };
const rateFor = (model: string): Price | null => (model === SOL.model ? SOL : null);

/** overview() reads model_calls, messages and events; nothing else is needed. */
function fixture(): Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE model_calls (
			msg_id TEXT PRIMARY KEY, session_id TEXT, project TEXT, ts_ms INTEGER, model TEXT,
			input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
			reasoning INTEGER, total_tokens INTEGER, cost REAL, stop_reason TEXT
		);
		CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, ts_ms INTEGER);
		CREATE TABLE events (id INTEGER PRIMARY KEY, session_id TEXT, ts_ms INTEGER, system TEXT, kind TEXT, origin TEXT, severity TEXT, cost_usd REAL, data TEXT);
	`);
	const calls: Array<[string, number, number, number]> = [
		["sol-model", 10, 1000, 0],
		["sol-model", 10, 1000, 9000],
		["sol-model", 10, 1000, 9000],
		["other-model", 5000, 0, 0],
	];
	calls.forEach(([model, input, read, write], i) => {
		db.run(
			"INSERT INTO model_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[`m${i}`, "s1", "demo", 1_700_000_000_000 + i * 1000, model, input, 0, read, write, 0, 0, 0.01, "stop"],
		);
	});
	return db;
}

const range = { from: 0, to: Number.MAX_SAFE_INTEGER };

test("cacheSplit divides by the full prompt, writes included", () => {
	const split = cacheSplit(10, 1000, 9000);
	assert.equal(split.prompt, 10_010);
	assert.ok(Math.abs((split.readRate ?? 0) - 1000 / 10_010) < 1e-12);
	assert.ok(Math.abs((split.writeRate ?? 0) - 9000 / 10_010) < 1e-12);
	assert.deepEqual(cacheSplit(0, 0, 0), { prompt: 0, readRate: null, writeRate: null, uncachedRate: null });
});

test("a write-heavy model does not report a near-100% cache read rate", () => {
	// Dividing by input + cache_read alone gives 3000/3030 = 99% here.
	const data = overview(fixture(), range, "sol-model");
	assert.equal(data.totals.calls, 3);
	assert.ok((data.totals.cacheRate ?? 1) < 0.15, `read rate was ${data.totals.cacheRate}`);
	assert.ok((data.totals.cacheWriteRate ?? 0) > 0.85, `write rate was ${data.totals.cacheWriteRate}`);
});

test("overview scopes every cache figure to the selected model", () => {
	const data = overview(fixture(), range, "absent-model");
	assert.equal(data.totals.calls, 0);
	assert.equal(data.totals.cacheRate, null);
	assert.equal(data.totals.cacheWriteRate, null);
});

test("cache reuse nets out the write premium", () => {
	const rows = [
		{ cache_read: 2000, cache_write: 0 },
		{ cache_read: 0, cache_write: 18_000 },
	];
	const value = cacheValue(rows, rateFor, () => "sol-model");
	assert.ok(Math.abs(value.savingsUsd - 0.0038) < 1e-9, `savings ${value.savingsUsd}`);
	assert.ok(Math.abs(value.writePremiumUsd - 0.009) < 1e-9, `premium ${value.writePremiumUsd}`);
	assert.ok(value.netUsd < 0, `net should be negative, was ${value.netUsd}`);
});

test("an unpriced model contributes tokens but no dollars", () => {
	const value = cacheValue([{ cache_read: 1000, cache_write: 1000 }], rateFor, () => "unknown-model");
	assert.deepEqual(value, { savingsUsd: 0, writePremiumUsd: 0, netUsd: 0, readTokens: 1000, writeTokens: 1000 });
});

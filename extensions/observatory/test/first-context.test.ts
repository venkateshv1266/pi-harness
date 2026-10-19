import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { test } from "node:test";

import { firstContext } from "../server/queries.ts";

function fixture(): Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project TEXT, title TEXT, started_ts TEXT);
		CREATE TABLE session_context (session_id TEXT PRIMARY KEY, sections TEXT, tools TEXT, section_chars INTEGER, tool_chars INTEGER, tool_count INTEGER);
		CREATE TABLE model_calls (msg_id TEXT PRIMARY KEY, session_id TEXT, ts_ms INTEGER, input INTEGER, cache_read INTEGER, model TEXT);
	`);
	return db;
}

function seed(db: Database, id: string, startedTs: string, sectionChars: number, toolChars: number, promptTokens: number): void {
	db.run("INSERT INTO sessions (session_id, project, title, started_ts) VALUES (?, ?, ?, ?)", [id, "demo", null, startedTs]);
	db.run("INSERT INTO session_context (session_id, sections, tools, section_chars, tool_chars, tool_count) VALUES (?, ?, ?, ?, ?, ?)", [
		id,
		JSON.stringify({ skills: sectionChars - 100, rules: 100 }),
		JSON.stringify({ delegate: toolChars }),
		sectionChars,
		toolChars,
		1,
	]);
	db.run("INSERT INTO model_calls (msg_id, session_id, ts_ms, input, cache_read, model) VALUES (?, ?, ?, ?, ?, ?)", [
		`${id}-first`,
		id,
		Date.parse(startedTs),
		promptTokens,
		0,
		"test/model",
	]);
}

test("firstContext splits the billed prompt by character share", () => {
	const db = fixture();
	seed(db, "s1", "2026-10-19T10:00:00.000Z", 1_000, 3_000, 40_000);
	const result = firstContext(db, { limit: 10 });
	const session = result.sessions[0];

	assert.equal(session.promptTokens, 40_000);
	assert.equal(session.systemTokens + session.toolTokens, 40_000);
	assert.equal(session.toolTokens, 30_000);
	assert.equal(session.systemTokens, 10_000);
	assert.equal(session.toolCount, 1);
	assert.equal(result.summary.toolShare, 0.75);
	assert.deepEqual(
		session.sections.map((part) => part.name),
		["skills", "rules"],
	);
	// Shares are of the whole prompt, so sections and tools together sum to 1.
	assert.equal(Math.round(session.sections.reduce((total, part) => total + part.share, 0) * 100) / 100, 0.25);
	assert.equal(Math.round([...session.sections, ...session.tools].reduce((total, part) => total + part.share, 0) * 100) / 100, 1);
	db.close();
});

test("firstContext orders newest first and compares against the previous session", () => {
	const db = fixture();
	seed(db, "old", "2026-10-18T10:00:00.000Z", 1_000, 1_000, 20_000);
	seed(db, "new", "2026-10-19T10:00:00.000Z", 1_000, 1_000, 30_000);
	const result = firstContext(db, { limit: 10 });

	assert.deepEqual(
		result.sessions.map((session) => session.sessionId),
		["new", "old"],
	);
	assert.equal(result.summary.latestTokens, 30_000);
	assert.equal(result.summary.medianTokens, 25_000);
	assert.equal(result.summary.deltaTokens, 10_000);
	assert.deepEqual(
		result.trend.map((point) => point.total),
		[20_000, 30_000],
	);
	db.close();
});

test("firstContext filters to one directory and still lists every directory", () => {
	const db = fixture();
	seed(db, "h1", "2026-10-18T10:00:00.000Z", 1_000, 1_000, 20_000);
	seed(db, "h2", "2026-10-19T10:00:00.000Z", 1_000, 1_000, 30_000);
	db.run("UPDATE sessions SET project = 'harness' WHERE session_id IN ('h1', 'h2')");
	db.run("INSERT INTO sessions (session_id, project, title, started_ts) VALUES ('w1', 'service', null, '2026-10-19T11:00:00.000Z')");
	db.run("INSERT INTO session_context (session_id, sections, tools, section_chars, tool_chars, tool_count) VALUES ('w1', '{}', '{}', 2_000, 2_000, 1)");
	db.run("INSERT INTO model_calls (msg_id, session_id, ts_ms, input, cache_read, model) VALUES ('w1-first', 'w1', 0, 50_000, 0, 'test/model')");

	const all = firstContext(db, { limit: 10 });
	assert.equal(all.sessions.length, 3);
	assert.deepEqual(
		all.projects.map((row) => row.project),
		["harness", "service"],
	);

	const harness = firstContext(db, { limit: 10, project: "harness" });
	assert.equal(harness.filter, "harness");
	assert.deepEqual(
		harness.sessions.map((session) => session.sessionId),
		["h2", "h1"],
	);
	assert.equal(harness.summary.medianTokens, 25_000);
	assert.equal(harness.projects.length, 2, "the picker still lists every directory");
	db.close();
});

test("firstContext respects the selected time range", () => {
	const db = fixture();
	seed(db, "old", "2026-10-01T10:00:00.000Z", 1_000, 1_000, 20_000);
	seed(db, "new", "2026-10-19T10:00:00.000Z", 1_000, 1_000, 30_000);
	const to = Date.parse("2026-10-20T00:00:00.000Z");

	const week = firstContext(db, { limit: 10, from: to - 7 * 86_400_000, to });
	assert.deepEqual(
		week.sessions.map((session) => session.sessionId),
		["new"],
	);
	assert.deepEqual(
		week.projects.map((row) => row.project),
		["demo"],
	);
	assert.equal(week.summary.count, 1);

	const all = firstContext(db, { limit: 10, from: 0, to });
	assert.equal(all.sessions.length, 2);
	db.close();
});

test("firstContext ignores sessions with no recorded context", () => {
	const db = fixture();
	db.run("INSERT INTO sessions (session_id, project, title, started_ts) VALUES ('empty', 'demo', null, '2026-10-19T10:00:00.000Z')");
	assert.equal(firstContext(db, { limit: 10 }).summary.count, 0);
	db.close();
});

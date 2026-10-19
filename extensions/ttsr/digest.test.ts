/**
 * Session-digest tests: verify gates judge current intent (approval wording)
 * and repo state (PR already raised), so the digest must carry both.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { repoContext, type SessionEntryLike } from "./index.ts";

const msg = (role: string, text: string): SessionEntryLike => ({ type: "message", message: { role, content: [{ type: "text", text }] } });
const toolResult = (text: string): SessionEntryLike => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } });

test("reports PR number and branch when both are evidenced", () => {
	const ctx = repoContext([
		toolResult("Switched to a new branch 'feat/gate'"),
		toolResult("https://github.com/acme/widgets/pull/481\nCreated pull request"),
	]);
	assert.equal(ctx, "SESSION GIT CONTEXT: branch=feat/gate, pr=#481");
});

test("reports pr=none-seen-in-session when only a branch is known", () => {
	const ctx = repoContext([toolResult("On branch main\nnothing to commit")]);
	assert.equal(ctx, "SESSION GIT CONTEXT: branch=main, pr=none-seen-in-session");
});

test("returns null when the session shows no git evidence", () => {
	assert.equal(repoContext([msg("user", "hello"), toolResult("ls output")]), null);
});

test("scans newest evidence first and tolerates non-message entries", () => {
	const ctx = repoContext([
		{ type: "custom", customType: "goal", data: {} },
		msg("assistant", "opened https://github.com/acme/widgets/pull/12"),
		toolResult("Switched to branch 'fix/ci'"),
	]);
	assert.equal(ctx, "SESSION GIT CONTEXT: branch=fix/ci, pr=#12");
});

test("ignores non-text content blocks", () => {
	const ctx = repoContext([{ type: "message", message: { role: "assistant", content: [{ type: "image", data: "x" }] } }]);
	assert.equal(ctx, null);
});

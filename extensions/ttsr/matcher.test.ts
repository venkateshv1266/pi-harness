/**
 * Matcher extraction tests: the live engine and the probe engine must agree on
 * frontmatter parsing, scope/glob gating and OR'd conditions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { initAstGrep, matchAstRules, matchRules, parseRuleSource } from "./matcher.ts";

const rule = (frontmatter: string): string => `---\n${frontmatter}\n---\n\nReminder body.\n`;

test("parses condition, flags, scope and globs", () => {
	const parsed = parseRuleSource(
		rule('name: demo\ncondition: ["foo", "bar"]\nflags: i\nscope: [tool]\nglobs: ["src/**/*.ts"]'),
		"demo.md",
	);
	assert.ok(parsed);
	assert.equal(parsed.name, "demo");
	assert.equal(parsed.bucket, "ttsr");
	assert.equal(parsed.conditions.length, 2);
	assert.deepEqual(parsed.scope, ["tool"]);
	assert.equal(parsed.globs?.length, 1);
	assert.ok(parsed.conditions[0].test("FOO"));
});

test("conditions are OR'd and scope-gated", () => {
	const parsed = parseRuleSource(rule('name: demo\ncondition: ["alpha", "beta"]\nscope: [text]'), "demo.md");
	assert.ok(parsed);
	assert.equal(matchRules([parsed], "say beta now", "text").length, 1);
	assert.equal(matchRules([parsed], "say beta now", "tool").length, 0);
	assert.equal(matchRules([parsed], "nothing relevant", "text").length, 0);
});

test("glob gating applies to tool scope only", () => {
	const parsed = parseRuleSource(rule('name: demo\ncondition: ["needle"]\nscope: [tool]\nglobs: ["src/**/*.ts"]'), "demo.md");
	assert.ok(parsed);
	assert.equal(matchRules([parsed], "needle", "tool", "src/service.ts").length, 1);
	assert.equal(matchRules([parsed], "needle", "tool", "docs/readme.md").length, 0);
	assert.equal(matchRules([parsed], "needle", "tool").length, 0);
});

test("quoted commas survive inline-list parsing", () => {
	const parsed = parseRuleSource(rule('name: demo\ncondition: ["a{0,4}", "b"]\nscope: [text]'), "demo.md");
	assert.ok(parsed);
	assert.equal(parsed.conditions.length, 2);
	assert.ok(parsed.conditions[0].test("aaa"));
});

test("non-rules return null", () => {
	assert.equal(parseRuleSource("no frontmatter here", "x.md"), null);
	assert.equal(parseRuleSource(rule("name: demo\ndescription: prose only"), "demo.md")?.bucket, "rulebook");
});

test("ast conditions are parsed and invalid snippets do not throw", async () => {
	const parsed = parseRuleSource(rule('name: demo\nastCondition: ["if ($X) clearTimeout($X)"]\nscope: [tool]'), "demo.md");
	assert.ok(parsed);
	assert.equal(parsed.astConditions.length, 1);
	const ast = await initAstGrep();
	if (!ast) {
		assert.equal(matchAstRules([parsed], "if (t) clearTimeout(t);", "src/timer.ts").length, 0);
		return;
	}
	assert.equal(matchAstRules([parsed], "if (t) clearTimeout(t);", "src/timer.ts").length, 1);
	assert.equal(matchAstRules([parsed], "clearTimeout(t);", "src/timer.ts").length, 0);
	assert.equal(matchAstRules([parsed], "this is not typescript {{{", "src/timer.ts").length, 0);
	assert.equal(matchAstRules([parsed], "if (t) clearTimeout(t);", "notes.txt").length, 0);
});

test("matchRules is pure across repeated calls", () => {
	const parsed = parseRuleSource(rule('name: demo\ncondition: ["hit"]\nscope: [text, thinking]'), "demo.md");
	assert.ok(parsed);
	const first = matchRules([parsed], "hit", "text").map((r) => r.name);
	const second = matchRules([parsed], "hit", "text").map((r) => r.name);
	assert.deepEqual(first, ["demo"]);
	assert.deepEqual(second, first);
});

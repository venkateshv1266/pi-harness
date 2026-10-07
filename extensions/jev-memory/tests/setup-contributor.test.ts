import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import memorySetupDefault, { buildMemorySections } from "../setup.ts";
import { loadConfig } from "../src/config.js";
import { resolveJevConfig } from "../src/jev/config.js";
import type { SetupItem, SetupSection } from "../../setup/types.ts";

const ctx = {} as never;

function tempConfig(initial: Record<string, unknown> = {}): { path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "jev-setup-test-"));
	const path = join(dir, "jev-memory-config.json");
	writeFileSync(path, JSON.stringify(initial, null, 2) + "\n");
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function item(sections: SetupSection[], id: string): SetupItem {
	const found = sections.flatMap((s) => s.items).find((i) => i.id === id);
	assert.ok(found, `missing setup item: ${id}`);
	return found;
}

function rawJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("review model item writes, merges, and clears llmModelOverride", async () => {
	const { path, cleanup } = tempConfig({ consolidationTimeoutMs: 1200000 });
	try {
		const sections = buildMemorySections(path);
		const model = item(sections, "review-model");

		assert.equal(model.get(ctx), "(unset — active session model)");
		assert.equal(
			await model.apply!(ctx, "deepseek/deepseek-v4.1-flash:max"),
			"review model → deepseek/deepseek-v4.1-flash:max",
		);
		assert.equal(model.get(ctx), "deepseek/deepseek-v4.1-flash:max");
		assert.equal(loadConfig(path).llmModelOverride, "deepseek/deepseek-v4.1-flash:max");
		assert.equal(rawJson(path).consolidationTimeoutMs, 1200000);

		assert.equal(await model.apply!(ctx, "__remove"), "review model → session default");
		assert.equal("llmModelOverride" in rawJson(path), false);
		assert.equal(rawJson(path).consolidationTimeoutMs, 1200000);
		assert.equal(model.get(ctx), "(unset — active session model)");
	} finally {
		cleanup();
	}
});

test("toggle, number, and enum items round-trip the config file", async () => {
	const { path, cleanup } = tempConfig();
	try {
		const sections = buildMemorySections(path);

		const enabled = item(sections, "review-enabled");
		assert.equal(enabled.get(ctx), "on");
		await enabled.apply!(ctx, "off");
		assert.equal(loadConfig(path).reviewEnabled, false);
		assert.equal(enabled.get(ctx), "off");

		const turns = item(sections, "review-turns");
		assert.match(turns.get(ctx), /\(default\)$/);
		await turns.apply!(ctx, "25");
		assert.equal(turns.get(ctx), "25");
		assert.equal(loadConfig(path).nudgeInterval, 25);
		assert.match(await turns.apply!(ctx, "not-a-number"), /^✗/);

		const transport = item(sections, "review-transport");
		assert.equal(transport.get(ctx), "direct");
		await transport.apply!(ctx, "subprocess");
		assert.equal(loadConfig(path).reviewTransport, "subprocess");
		assert.match(await transport.apply!(ctx, "bogus"), /^✗/);
	} finally {
		cleanup();
	}
});

test("jev gate toggles write nested config visible to resolveJevConfig", async () => {
	const { path, cleanup } = tempConfig();
	try {
		const sections = buildMemorySections(path);

		const pregate = item(sections, "jev-pregate");
		assert.equal(pregate.get(ctx), "on");
		await pregate.apply!(ctx, "off");
		assert.equal(resolveJevConfig(path).pregate.enabled, false);
		assert.equal((rawJson(path) as { jev?: { pregate?: { enabled?: boolean } } }).jev?.pregate?.enabled, false);

		const admission = item(sections, "jev-admission");
		await admission.apply!(ctx, "off");
		assert.equal(resolveJevConfig(path).admission.enabled, false);

		await pregate.apply!(ctx, "on");
		assert.equal((rawJson(path) as { jev?: { admission?: { enabled?: boolean } } }).jev?.admission?.enabled, false);
		assert.equal(resolveJevConfig(path).pregate.enabled, true);
	} finally {
		cleanup();
	}
});

test("apply refuses to write when the config file is corrupt", async () => {
	const { path, cleanup } = tempConfig();
	try {
		writeFileSync(path, "{ not json");
		const sections = buildMemorySections(path);
		const result = await item(sections, "review-enabled").apply!(ctx, "on");
		assert.match(result, /^✗/);
		assert.equal(readFileSync(path, "utf8"), "{ not json");
	} finally {
		cleanup();
	}
});

test("default export contributes three populated sections with unique item ids", () => {
	const sections = memorySetupDefault();
	assert.deepEqual(
		sections.map((s) => s.id),
		["memory-review", "memory-stores", "memory-capture"],
	);
	const ids = sections.flatMap((s) => s.items.map((i) => i.id));
	assert.equal(new Set(ids).size, ids.length);
	for (const section of sections) {
		assert.ok(section.items.length > 0, `section ${section.id} has no items`);
	}
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	KIND_SPECS,
	applySettingsPatch,
	bundleHash,
	contentHash,
	describeSettingsPatch,
	harnessDigest,
	primaryContent,
	validateBundle,
	validateSettingsPatch,
} from "./harness-surface.ts";

const rule = (name: string, body = "Stop and re-read the schema first.") =>
	`---\nname: ${name}\ncondition: ["re-invent"]\n---\n${body}\n`;

test("rule bundle validates and requires a trigger", () => {
	assert.equal(validateBundle("rule", "no-reinvent", { "no-reinvent.md": rule("no-reinvent") }).ok, true);
	const missing = validateBundle("rule", "no-reinvent", { "no-reinvent.md": "---\nname: no-reinvent\n---\nbody\n" });
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.match(missing.error, /condition|astCondition/);
});

test("rule bundle rejects a mismatched frontmatter name", () => {
	const result = validateBundle("rule", "alpha", { "alpha.md": rule("beta") });
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /must equal/);
});

test("note bundle requires non-empty content", () => {
	assert.equal(validateBundle("note", "env-fact", { "env-fact.md": "pnpm, not npm." }).ok, true);
	const empty = validateBundle("note", "env-fact", { "env-fact.md": "   " });
	assert.equal(empty.ok, false);
});

test("memory bundle requires a supported target and stays compact", () => {
	const entry = "---\ntarget: memory\ncategory: insight\n---\nThe repo uses pnpm workspaces.\n";
	assert.equal(validateBundle("memory", "uses-pnpm", { "entry.md": entry }).ok, true);
	const badTarget = validateBundle("memory", "uses-pnpm", { "entry.md": "---\ntarget: global\n---\nx\n" });
	assert.equal(badTarget.ok, false);
	const big = validateBundle("memory", "big", { "entry.md": `---\ntarget: memory\n---\n${"x".repeat(1300)}\n` });
	assert.equal(big.ok, false);
});

test("context bundle pairs a doc with a registry fragment", () => {
	const files = {
		"grafana-runbook.md": "# Runbook\n\nQuery Loki first.\n",
		"entry.yaml": "id: grafana-runbook\nfile: grafana-runbook.md\ntier: advisory\ntriggers:\n  - tool: '^mcp__grafana'\n",
	};
	assert.equal(validateBundle("context", "grafana-runbook", files).ok, true);
	const mismatch = validateBundle("context", "grafana-runbook", { ...files, "entry.yaml": "id: other\nfile: grafana-runbook.md\n" });
	assert.equal(mismatch.ok, false);
});

test("agent and skill bundles require frontmatter with a description", () => {
	const agent = "---\nname: explorer\ndescription: Finds things.\ntools: read, grep\nmodel: \"@smol\"\n---\nBody\n";
	assert.equal(validateBundle("agent", "explorer", { "explorer.md": agent }).ok, true);
	const noDescription = validateBundle("agent", "explorer", { "explorer.md": "---\nname: explorer\n---\nBody\n" });
	assert.equal(noDescription.ok, false);
	assert.equal(validateBundle("skill", "release", { "SKILL.md": "---\nname: release\ndescription: Ship it.\n---\nSteps\n" }).ok, true);
});

test("settings patch is allowlisted, primitive-only and prototype-safe", () => {
	assert.equal(validateSettingsPatch({ "modelRouter.threshold": 0.8 }), null);
	assert.match(validateSettingsPatch({ "auth.token": "x" }) ?? "", /outside the allowlist/);
	assert.match(validateSettingsPatch({ "modelRouter.threshold": { deep: 1 } }) ?? "", /must be a string/);
	assert.match(validateSettingsPatch({ "modelRouter.__proto__.polluted": true }) ?? "", /not allowed/);
	assert.match(validateSettingsPatch({}) ?? "", /empty/);
});

test("settings bundles parse patch.json", () => {
	assert.equal(validateBundle("settings", "router-floor", { "patch.json": '{"modelRouter.threshold":0.8}' }).ok, true);
	const broken = validateBundle("settings", "router-floor", { "patch.json": "{nope" });
	assert.equal(broken.ok, false);
});

test("extension proposals are rejected until the wave-2 gate exists", () => {
	const result = validateBundle("extension", "new-tool", { "index.ts": "export default () => {};" });
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /wave 2/);
});

test("bundle path traversal is rejected", () => {
	const result = validateBundle("note", "x", { "../escape.md": "nope" });
	assert.equal(result.ok, false);
});

test("bundleHash is order-independent (whitespace-normalized) and kind-sensitive", () => {
	const a = bundleHash("context", "doc", { "doc.md": "A", "entry.yaml": "id: doc" });
	const b = bundleHash("context", "doc", { "entry.yaml": "id: doc", "doc.md": "A" });
	const c = bundleHash("context", "doc", { "doc.md": "A", "entry.yaml": "id:  doc " });
	assert.equal(a, b);
	assert.equal(a, c);
	assert.notEqual(bundleHash("note", "doc", { "doc.md": "A" }), bundleHash("rule", "doc", { "doc.md": "A" }));
});

test("contentHash ignores whitespace and case", () => {
	assert.equal(contentHash("Hello   World"), contentHash("hello world"));
});

test("primaryContent prefers the kind's conventional file", () => {
	const files = { "SKILL.md": "skill body", "notes.md": "other" };
	assert.equal(primaryContent("skill", "x", files), "skill body");
	assert.equal(primaryContent("rule", "x", { "x.md": "rule body" }), "rule body");
});

test("applySettingsPatch is pure and sets nested paths", () => {
	const settings = { modelRouter: { threshold: 0.75, deep: "@slow" }, other: 1 };
	const next = applySettingsPatch(settings, { "modelRouter.threshold": 0.85, "courseCheck.intervalTurns": 5 });
	const nested = next.modelRouter as Record<string, unknown>;
	assert.equal(nested.threshold, 0.85);
	assert.equal(nested.deep, "@slow");
	assert.equal((next.courseCheck as Record<string, unknown>).intervalTurns, 5);
	assert.equal((settings.modelRouter as Record<string, unknown>).threshold, 0.75);
});

test("describeSettingsPatch renders before -> after", () => {
	const lines = describeSettingsPatch({ modelRouter: { threshold: 0.75 } }, { "modelRouter.threshold": 0.9, "refine.auto": true });
	assert.deepEqual(lines, ['modelRouter.threshold: 0.75 → 0.9', 'refine.auto: (unset) → true']);
});

test("harnessDigest is stable, path-sorted and excludes disabled files", () => {
	const root = mkdtempSync(join(tmpdir(), "surface-digest-"));
	try {
		mkdirSync(join(root, "rules"), { recursive: true });
		mkdirSync(join(root, "agents"), { recursive: true });
		writeFileSync(join(root, "rules", "a.md"), "rule a");
		writeFileSync(join(root, "rules", "b.md.disabled"), "disabled rule");
		writeFileSync(join(root, "agents", "x.md"), "agent x");
		writeFileSync(join(root, "settings.json"), '{"modelRouter":{"threshold":0.8}}');

		const first = harnessDigest(root);
		assert.match(first, /^[0-9a-f]{16}$/);
		assert.equal(harnessDigest(root), first);

		writeFileSync(join(root, "rules", "a.md"), "rule a changed");
		assert.notEqual(harnessDigest(root), first);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("kind specs agree on proposable kinds and floors", () => {
	assert.equal(KIND_SPECS.rule.autoProposable, true);
	assert.equal(KIND_SPECS.extension.autoProposable, false);
	for (const spec of Object.values(KIND_SPECS)) {
		for (const part of spec.parts) {
			if (part === "novelty") continue;
			assert.equal(typeof spec.floors[part], "number", `${spec.kind} needs a ${part} floor`);
		}
	}
});

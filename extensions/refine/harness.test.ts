import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	armProposal,
	dedupeProposals,
	describeArm,
	listCoverage,
	listStaged,
	migrateLegacyStaging,
	parseProposals,
	previewArm,
	proposalHash,
	rollbackArm,
	stageProposal,
	toProposal,
	type Proposal,
	type StagedItem,
} from "./harness.ts";
import type { ExtensionGateResult } from "./extension-gate.ts";

const roots = () => {
	const root = mkdtempSync(join(tmpdir(), "refine-harness-"));
	const agentRoot = join(root, "agent");
	const refineRoot = join(root, "refine");
	mkdirSync(agentRoot, { recursive: true });
	mkdirSync(refineRoot, { recursive: true });
	return {
		root,
		agentRoot,
		refineRoot,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
};

const meta = { score: 0.8, parts: { evidence: 0.8, trigger: 0.8, novelty: 0.8 }, session: "s1", stagedAt: "2026-10-19T00:00:00.000Z", trigger: "correction" };

const ruleProposal = (name = "no-reinvent"): Proposal => ({
	kind: "rule",
	name,
	title: "Stop reinventing",
	evidence: "User: don't rewrite the parser",
	files: { [`${name}.md`]: `---\nname: ${name}\ncondition: ["rewrite the parser"]\n---\nReuse the existing parser.\n` },
});

const extensionProposal = (name = "json-diff"): Proposal => ({
	kind: "extension",
	name,
	title: "JSON diff tool",
	evidence: "User asked twice for a structural JSON diff",
	expectation: "tool:json_diff",
	files: {
		"index.ts": "import type { ExtensionAPI } from \"@earendil-works/pi-coding-agent\";\nexport default function (pi: ExtensionAPI) { void pi; }\n",
		"README.md": "Structural JSON diff helper.\n",
		"pairing.md": "---\nname: use-json-diff\ncondition: [\"compare .json files\"]\n---\nUse the json_diff tool instead of eyeballing large JSON.\n",
	},
});

const gatePass: ExtensionGateResult = {
	ok: true,
	reasons: [],
	warnings: [],
	compile: { ok: true, detail: "injected" },
	smoke: { ok: true, detail: "injected", tools: ["json_diff"], commands: [], handlers: [] },
	safety: { ok: true, detail: "injected", flags: [] },
};

test("toProposal accepts legacy content and bundle shapes", () => {
	const legacy = toProposal({ kind: "rule", name: "no-reinvent", title: "t", evidence: "e", content: "---\nname: no-reinvent\ncondition: [\"x\"]\n---\nbody\n" });
	assert.ok(legacy);
	assert.deepEqual(Object.keys(legacy.files), ["no-reinvent.md"]);

	const bundle = toProposal({ kind: "note", name: "env-fact", title: "t", evidence: "e", files: { "env-fact.md": "pnpm only" } });
	assert.ok(bundle);

	assert.equal(toProposal({ kind: "extension", name: "x", files: { "index.ts": "export {}" } }), null);
	const extension = toProposal({
		kind: "extension",
		name: "json-diff",
		title: "t",
		evidence: "e",
		expectation: "tool:json_diff",
		files: {
			"index.ts": "export default function () {}",
			"README.md": "readme",
			"pairing.md": "---\nname: use-json-diff\ncondition: [\"diff json\"]\n---\nUse it.\n",
		},
	});
	assert.ok(extension);
	assert.equal(extension?.expectation, "tool:json_diff");
	assert.equal(toProposal({
		kind: "extension",
		name: "json-diff",
		files: { "index.ts": "export default function () {}", "README.md": "readme", "pairing.md": "---\nname: use-json-diff\ncondition: [\"x\"]\n---\nbody\n" },
	}), null);
	assert.equal(toProposal({ kind: "rule", name: "Bad Name", content: "x" }), null);
	assert.equal(toProposal({ kind: "rule", name: "no-trigger", content: "---\nname: no-trigger\n---\nbody\n" }), null);
});

test("parseProposals tolerates fences and drops invalid items", () => {
	const raw = "```json\n" + JSON.stringify({
		proposals: [
			{ kind: "note", name: "ok", title: "t", evidence: "e", content: "body" },
			{ kind: "rule", name: "bad", title: "t", evidence: "e", content: "no frontmatter" },
		],
	}) + "\n```";
	const parsed = parseProposals(raw);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].name, "ok");
	assert.deepEqual(parseProposals("not json"), []);
});

test("dedupeProposals removes coverage collisions across kinds and staging", () => {
	const coverage = { rules: ["a"], notes: ["b"], contexts: ["c"], agents: ["d"], skills: ["e"], extensions: ["f"], staged: ["rule:g", "note:h"] };
	const proposals = [
		{ ...ruleProposal("a") },
		{ ...ruleProposal("g") },
		toProposal({ kind: "note", name: "h", title: "t", evidence: "e", content: "x" })!,
		toProposal({ kind: "note", name: "i", title: "t", evidence: "e", content: "x" })!,
	];
	assert.deepEqual(dedupeProposals(proposals, coverage).map((p) => p.name), ["i"]);
});

test("stage -> list -> arm -> rollback for a rule", async () => {
	const { agentRoot, refineRoot, cleanup } = roots();
	try {
		const p = ruleProposal();
		assert.equal(await stageProposal(refineRoot, p, { ...meta, kind: "rule", name: p.name, title: p.title, evidence: p.evidence, files: p.files, tier: "ready" }), true);
		assert.equal(await stageProposal(refineRoot, p, { ...meta, kind: "rule", name: p.name, title: p.title, evidence: p.evidence, files: p.files, tier: "ready" }), false);

		const staged = await listStaged(refineRoot);
		assert.equal(staged.length, 1);
		assert.equal(staged[0].kind, "rule");
		assert.match(staged[0].content, /Reuse the existing parser/);

		const armed = await armProposal({ agentRoot, refineRoot, item: staged[0], timestamp: "2026-10-19T00-00-00" });
		assert.equal(armed.ok, true);
		if (!armed.ok) return;
		assert.match(readFileSync(join(agentRoot, "rules", "no-reinvent.md"), "utf8"), /Reuse the existing parser/);

		const again = await armProposal({ agentRoot, refineRoot, item: staged[0], timestamp: "2026-10-19T00-00-01" });
		assert.equal(again.ok, false);

		const rollback = await rollbackArm({ kind: "rule", name: "no-reinvent", armed: armed.armed });
		assert.equal(rollback.ok, true);
		assert.equal(existsSync(join(agentRoot, "rules", "no-reinvent.md")), false);
	} finally {
		cleanup();
	}
});

test("memory arm appends a delimited entry with metadata and dedupes", async () => {
	const { agentRoot, refineRoot, cleanup } = roots();
	try {
		const p = toProposal({
			kind: "memory",
			name: "uses-pnpm",
			title: "pnpm",
			evidence: "npm failed twice",
			files: { "entry.md": "---\ntarget: memory\ncategory: insight\n---\nUse pnpm workspaces in this repo.\n" },
		})!;
		const manifest = { ...meta, kind: "memory" as const, name: p.name, title: p.title, evidence: p.evidence, files: p.files };
		await stageProposal(refineRoot, p, manifest);
		const item = (await listStaged(refineRoot))[0];
		const first = await armProposal({ agentRoot, refineRoot, item, timestamp: "t1" });
		assert.equal(first.ok, true);
		const memory = readFileSync(join(agentRoot, "jev-memory", "MEMORY.md"), "utf8");
		assert.match(memory, /Use pnpm workspaces/);
		assert.match(memory, /<!-- created=\d{4}-\d{2}-\d{2}, last=\d{4}-\d{2}-\d{2} -->/);

		const second = await armProposal({ agentRoot, refineRoot, item, timestamp: "t2" });
		assert.equal(second.ok, false);

		const rollback = await rollbackArm({ kind: "memory", name: "uses-pnpm", armed: first.ok ? first.armed : [] });
		assert.equal(rollback.ok, true);
		assert.equal(existsSync(join(agentRoot, "jev-memory", "MEMORY.md")), false);
	} finally {
		cleanup();
	}
});

test("context arm writes the doc and registry fragment", async () => {
	const { agentRoot, refineRoot, cleanup } = roots();
	try {
		const p = toProposal({
			kind: "context",
			name: "grafana-runbook",
			title: "Grafana",
			evidence: "queried prod blindly",
			files: {
				"grafana-runbook.md": "# Runbook\n\nQuery Loki first.\n",
				"entry.yaml": "id: grafana-runbook\nfile: grafana-runbook.md\ntier: advisory\ntriggers:\n  - tool: '^mcp__grafana'\n",
			},
		})!;
		await stageProposal(refineRoot, p, { ...meta, kind: "context", name: p.name, title: p.title, evidence: p.evidence, files: p.files });
		const item = (await listStaged(refineRoot))[0];
		const armed = await armProposal({ agentRoot, refineRoot, item, timestamp: "t1" });
		assert.equal(armed.ok, true);
		assert.match(readFileSync(join(agentRoot, "contexts", "grafana-runbook.md"), "utf8"), /Query Loki/);
		assert.match(readFileSync(join(agentRoot, "contexts", "entries", "grafana-runbook.yaml"), "utf8"), /id: grafana-runbook/);
	} finally {
		cleanup();
	}
});

test("agent and skill arm to their live homes", async () => {
	const { agentRoot, refineRoot, cleanup } = roots();
	try {
		const agent = toProposal({
			kind: "agent",
			name: "explorer",
			title: "Explorer",
			evidence: "repeated file hunting",
			files: { "explorer.md": "---\nname: explorer\ndescription: finds things\ntools: read, grep\n---\nBody\n" },
		})!;
		const skill = toProposal({
			kind: "skill",
			name: "release",
			title: "Release",
			evidence: "same 6 steps three times",
			files: { "SKILL.md": "---\nname: release\ndescription: ship it\n---\nSteps\n" },
		})!;
		for (const p of [agent, skill]) {
			await stageProposal(refineRoot, p, { ...meta, kind: p.kind, name: p.name, title: p.title, evidence: p.evidence, files: p.files });
		}
		for (const item of await listStaged(refineRoot)) {
			const armed = await armProposal({ agentRoot, refineRoot, item, timestamp: `t-${item.kind}` });
			assert.equal(armed.ok, true, `${item.kind}: ${armed.ok ? "" : armed.reason}`);
		}
		assert.match(readFileSync(join(agentRoot, "agents", "explorer.md"), "utf8"), /finds things/);
		assert.match(readFileSync(join(agentRoot, "skills", "release", "SKILL.md"), "utf8"), /ship it/);
	} finally {
		cleanup();
	}
});

test("settings arm previews, applies, backs up and rolls back", async () => {
	const { agentRoot, refineRoot, cleanup } = roots();
	try {
		writeFileSync(join(agentRoot, "settings.json"), JSON.stringify({ modelRouter: { threshold: 0.75, deep: "@slow" } }, null, 2));
		const p = toProposal({
			kind: "settings",
			name: "router-threshold",
			title: "Raise router threshold",
			evidence: "acted routes failed twice",
			files: { "patch.json": JSON.stringify({ "modelRouter.threshold": 0.85 }) },
		})!;
		await stageProposal(refineRoot, p, { ...meta, kind: "settings", name: p.name, title: p.title, evidence: p.evidence, files: p.files });
		const item = (await listStaged(refineRoot))[0];

		assert.deepEqual(await previewArm(agentRoot, item), ["modelRouter.threshold: 0.75 → 0.85"]);
		assert.deepEqual(await describeArm(agentRoot, item), ["modelRouter.threshold: 0.75 → 0.85"]);

		const armed = await armProposal({ agentRoot, refineRoot, item, timestamp: "t1" });
		assert.equal(armed.ok, true);
		const settings = JSON.parse(readFileSync(join(agentRoot, "settings.json"), "utf8")) as { modelRouter: { threshold: number; deep: string } };
		assert.equal(settings.modelRouter.threshold, 0.85);
		assert.equal(settings.modelRouter.deep, "@slow");

		const rollback = await rollbackArm({ kind: "settings", name: "router-threshold", armed: armed.ok ? armed.armed : [] });
		assert.equal(rollback.ok, true);
		const restored = JSON.parse(readFileSync(join(agentRoot, "settings.json"), "utf8")) as { modelRouter: { threshold: number } };
		assert.equal(restored.modelRouter.threshold, 0.75);
	} finally {
		cleanup();
	}
});

test("listCoverage finds every armed kind", async () => {
	const { agentRoot, refineRoot, cleanup } = roots();
	try {
		mkdirSync(join(agentRoot, "rules"), { recursive: true });
		mkdirSync(join(agentRoot, "agents"), { recursive: true });
		mkdirSync(join(agentRoot, "skills", "release"), { recursive: true });
		mkdirSync(join(agentRoot, "contexts", "entries"), { recursive: true });
		mkdirSync(join(agentRoot, "extensions", "json-diff"), { recursive: true });
		mkdirSync(join(refineRoot, "notes"), { recursive: true });
		writeFileSync(join(agentRoot, "rules", "a.md"), "---\nname: a\ncondition: [x]\n---\nbody\n");
		writeFileSync(join(agentRoot, "rules", "b.md.disabled"), "disabled");
		writeFileSync(join(agentRoot, "agents", "x.md"), "---\nname: x\ndescription: d\n---\nbody\n");
		writeFileSync(join(agentRoot, "skills", "release", "SKILL.md"), "---\nname: release\ndescription: d\n---\nbody\n");
		writeFileSync(join(agentRoot, "contexts", "registry.yaml"), "contexts:\n  - id: c1\n    file: c1.md\n");
		writeFileSync(join(agentRoot, "contexts", "entries", "c2.yaml"), "id: c2\nfile: c2.md\n");
		writeFileSync(join(agentRoot, "extensions", "json-diff", "index.ts"), "export default () => {};\n");
		writeFileSync(join(refineRoot, "notes", "n.md"), "note");

		const coverage = await listCoverage(agentRoot, refineRoot);
		assert.deepEqual(coverage.rules, ["a"]);
		assert.deepEqual(coverage.notes, ["n"]);
		assert.deepEqual(coverage.agents, ["x"]);
		assert.deepEqual(coverage.skills, ["release"]);
		assert.deepEqual(coverage.extensions, ["json-diff"]);
		assert.deepEqual(coverage.contexts.sort(), ["c1", "c2"]);
	} finally {
		cleanup();
	}
});

test("legacy rules-staging migrates into the kind layout", async () => {
	const { refineRoot, cleanup } = roots();
	try {
		mkdirSync(join(refineRoot, "rules-staging"), { recursive: true });
		writeFileSync(join(refineRoot, "rules-staging", "old.md"), "---\nname: old\ncondition: [x]\n---\nbody\n");
		writeFileSync(join(refineRoot, "rules-staging", "old.meta.json"), JSON.stringify({ title: "Old", tier: "ready" }));
		const moved = await migrateLegacyStaging(refineRoot);
		assert.equal(moved, 1);
		const staged = await listStaged(refineRoot);
		assert.equal(staged.length, 1);
		assert.equal(staged[0].name, "old");
		assert.equal(staged[0].meta.tier, "ready");
		assert.equal(await migrateLegacyStaging(refineRoot), 0);
	} finally {
		cleanup();
	}
});

test("proposalHash is stable across key order and changes with content", () => {
	const a = ruleProposal("a");
	const b: Proposal = { ...a, files: { "a.md": a.files["a.md"] } };
	assert.equal(proposalHash(a), proposalHash(b));
	const c: Proposal = { ...a, files: { "a.md": `${a.files["a.md"]}\nmore` } };
	assert.notEqual(proposalHash(a), proposalHash(c));
});

test("extension arm pairs source with its TTSR trigger and rolls both back", async () => {
	const { agentRoot, refineRoot, cleanup } = roots();
	try {
		const p = extensionProposal();
		assert.ok(await stageProposal(refineRoot, p, { ...meta, kind: "extension", name: p.name, title: p.title, evidence: p.evidence, files: p.files, expectation: p.expectation, tier: "ready" }));
		const item = (await listStaged(refineRoot)).find((entry) => entry.kind === "extension");
		assert.ok(item);
		if (!item) return;

		const hints = await describeArm(agentRoot, item);
		assert.ok(hints.some((hint) => hint.includes("rules/use-json-diff.md")));

		const armed = await armProposal({ agentRoot, refineRoot, item, timestamp: "ext1", gate: gatePass });
		assert.equal(armed.ok, true);
		if (!armed.ok) return;
		assert.equal(existsSync(join(agentRoot, "extensions", "json-diff", "index.ts")), true);
		assert.equal(existsSync(join(agentRoot, "extensions", "json-diff", "README.md")), true);
		assert.equal(existsSync(join(agentRoot, "rules", "use-json-diff.md")), true);

		const rollback = await rollbackArm({ kind: "extension", name: "json-diff", armed: armed.armed });
		assert.equal(rollback.ok, true);
		assert.equal(existsSync(join(agentRoot, "extensions", "json-diff", "index.ts")), false);
		assert.equal(existsSync(join(agentRoot, "rules", "use-json-diff.md")), false);
	} finally {
		cleanup();
	}
});

test("extension arm pairs a context entry and rolls both files back", async () => {
	const { agentRoot, refineRoot, cleanup } = roots();
	try {
		const p = extensionProposal();
		p.files = {
			"index.ts": p.files["index.ts"],
			"README.md": p.files["README.md"],
			"pairing.md": "When comparing large JSON payloads, read this doc first.\n",
			"pairing.yaml": "id: json-diff-context\nfile: json-diff-context.md\ntier: advisory\ntriggers: [\"compare json\"]\n",
		};
		assert.ok(await stageProposal(refineRoot, p, { ...meta, kind: "extension", name: p.name, title: p.title, evidence: p.evidence, files: p.files, expectation: p.expectation, tier: "ready" }));
		const item = (await listStaged(refineRoot)).find((entry) => entry.kind === "extension");
		assert.ok(item);
		if (!item) return;
		const armed = await armProposal({ agentRoot, refineRoot, item, timestamp: "ext2", gate: gatePass });
		assert.equal(armed.ok, true);
		if (!armed.ok) return;
		assert.equal(existsSync(join(agentRoot, "contexts", "json-diff-context.md")), true);
		assert.equal(existsSync(join(agentRoot, "contexts", "entries", "json-diff-context.yaml")), true);
		await rollbackArm({ kind: "extension", name: "json-diff", armed: armed.armed });
		assert.equal(existsSync(join(agentRoot, "contexts", "json-diff-context.md")), false);
		assert.equal(existsSync(join(agentRoot, "contexts", "entries", "json-diff-context.yaml")), false);
	} finally {
		cleanup();
	}
});

test("a failed gate arms nothing", async () => {
	const { agentRoot, refineRoot, cleanup } = roots();
	try {
		const p = extensionProposal();
		await stageProposal(refineRoot, p, { ...meta, kind: "extension", name: p.name, title: p.title, evidence: p.evidence, files: p.files, expectation: p.expectation, tier: "ready" });
		const item = (await listStaged(refineRoot)).find((entry) => entry.kind === "extension");
		assert.ok(item);
		if (!item) return;
		const armed = await armProposal({ agentRoot, refineRoot, item, timestamp: "ext3", gate: { ...gatePass, ok: false, reasons: ["compile: boom"] } });
		assert.equal(armed.ok, false);
		assert.equal(existsSync(join(agentRoot, "extensions", "json-diff", "index.ts")), false);
		assert.equal(existsSync(join(agentRoot, "rules", "use-json-diff.md")), false);
	} finally {
		cleanup();
	}
});

test("a taken pairing target blocks the whole extension arm", async () => {
	const { agentRoot, refineRoot, cleanup } = roots();
	try {
		mkdirSync(join(agentRoot, "rules"), { recursive: true });
		writeFileSync(join(agentRoot, "rules", "use-json-diff.md"), "existing\n");
		const p = extensionProposal();
		await stageProposal(refineRoot, p, { ...meta, kind: "extension", name: p.name, title: p.title, evidence: p.evidence, files: p.files, expectation: p.expectation, tier: "ready" });
		const item = (await listStaged(refineRoot)).find((entry) => entry.kind === "extension");
		assert.ok(item);
		if (!item) return;
		const armed = await armProposal({ agentRoot, refineRoot, item, timestamp: "ext4", gate: gatePass });
		assert.equal(armed.ok, false);
		assert.equal(existsSync(join(agentRoot, "extensions", "json-diff", "index.ts")), false);
	} finally {
		cleanup();
	}
});

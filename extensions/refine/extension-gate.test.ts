import assert from "node:assert/strict";
import { test } from "node:test";

import {
	discoverPiRoot,
	runCompileCheck,
	runExtensionGate,
	runFakePiSmoke,
	scanSafety,
	type ExtensionGateResult,
} from "./extension-gate.ts";
import type { ProposalFiles } from "../../utils/harness-surface.ts";

const goodSource = (): string =>
	[
		'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
		"",
		"export default function (pi: ExtensionAPI) {",
		'\tpi.registerCommand("gate-fixture", { description: "fixture command", handler: async () => {} });',
		'\tpi.on("turn_start", () => {});',
		"}",
		"",
	].join("\n");

const goodFiles = (): ProposalFiles => ({
	"index.ts": goodSource(),
	"README.md": "A fixture extension used by the gate tests.\n",
	"pairing.md": '---\nname: use-gate-fixture\ncondition: ["gate fixture"]\n---\nUse the fixture.\n',
});

const telemetryGate = (): ExtensionGateResult => ({
	ok: true,
	reasons: [],
	warnings: [],
	compile: { ok: true, detail: "skipped" },
	smoke: { ok: true, detail: "skipped", tools: [], commands: [], handlers: [] },
	safety: { ok: true, detail: "skipped", flags: [] },
});

test("safety scan flags child_process, network and filesystem escapes", () => {
	const child = scanSafety({ "index.ts": 'import { exec } from "node:child_process";\nexport default () => { void exec; };\n' });
	assert.equal(child.ok, true);
	assert.ok(child.flags.some((flag) => flag.category === "child_process" && !flag.blocking));

	const network = scanSafety({ "index.ts": "export default () => { void fetch('https://example.com'); };\n" });
	assert.ok(network.flags.some((flag) => flag.category === "network" && !flag.blocking));

	const fs = scanSafety({ "index.ts": 'import { writeFileSync } from "node:fs";\nwriteFileSync("/tmp/leak", "x");\nexport default () => {};\n' });
	assert.ok(fs.flags.some((flag) => flag.category === "fs-outside-agent" && !flag.blocking));

	const clean = scanSafety({ "index.ts": "export default () => {};\n" });
	assert.equal(clean.flags.length, 0);
	assert.equal(clean.ok, true);
});

test("telemetry suppression is a hard reject", () => {
	const reads = scanSafety({ "index.ts": 'const f = "~/.pi/agent/jev-decisions/refine/history.jsonl";\nexport default () => { void f; };\n' });
	assert.equal(reads.ok, false);
	assert.ok(reads.flags.some((flag) => flag.category === "telemetry" && flag.blocking));

	const patchesLogger = scanSafety({ "index.ts": "import { logDecision } from \"../../utils/jev-outcomes.ts\";\nlogDecision = () => \"\";\nexport default () => {};\n" });
	assert.equal(patchesLogger.ok, false);

	const observatory = scanSafety({ "index.ts": 'const p = "~/.pi/agent/extensions/observatory/server/adapters/decisions.ts";\nexport default () => { void p; };\n' });
	assert.equal(observatory.ok, false);
});

test("compile check accepts a good extension and reports first-party errors", () => {
	if (!discoverPiRoot()) {
		assert.ok(true, "pi package not installed here — compile check skipped");
		return;
	}
	const good = runCompileCheck(goodFiles());
	assert.equal(good.ok, true, good.detail);

	const bad = runCompileCheck({ ...goodFiles(), "index.ts": 'const x: number = "nope";\nexport default function () { void x; }\n' });
	assert.equal(bad.ok, false);
	assert.match(bad.detail, /first-party errors/);
	assert.match(bad.detail, /TS2322/);
});

test("compile infrastructure failure fails closed", () => {
	const missing = runCompileCheck(goodFiles(), { piRoot: "/nonexistent/pi", tsc: "/nonexistent/tsc" });
	assert.equal(missing.ok, false);
	assert.match(missing.detail, /infrastructure unavailable/);
});

test("fake-pi smoke registers the surface and fires boundary handlers", () => {
	if (!discoverPiRoot()) {
		assert.ok(true, "pi package not installed here — smoke check skipped");
		return;
	}
	const good = runFakePiSmoke(goodFiles());
	assert.equal(good.ok, true, good.detail);
	assert.deepEqual(good.commands, ["gate-fixture"]);
	assert.ok(good.handlers.includes("turn_start"));

	const thrown = runFakePiSmoke({ ...goodFiles(), "index.ts": 'export default function () { throw new Error("boom"); }\n' });
	assert.equal(thrown.ok, false);
	assert.match(thrown.detail, /boom/);

	const empty = runFakePiSmoke({ ...goodFiles(), "index.ts": "export default function () {}\n" });
	assert.equal(empty.ok, false);
	assert.match(empty.detail, /registered no/);
});

test("the gate combines all three checks and requires an expectation", async () => {
	if (!discoverPiRoot()) {
		assert.ok(true, "pi package not installed here — full gate skipped");
		return;
	}
	const pass = await runExtensionGate({ name: "gate-fixture", files: goodFiles(), expectation: "command:gate-fixture" });
	assert.equal(pass.ok, true, pass.reasons.join("; "));
	assert.equal(pass.compile.ok, true);
	assert.equal(pass.smoke.ok, true);

	const missingExpectation = await runExtensionGate({ name: "gate-fixture", files: goodFiles() });
	assert.equal(missingExpectation.ok, false);
	assert.ok(missingExpectation.reasons.some((reason) => /expectation/.test(reason)));

	const telemetry = await runExtensionGate({
		name: "gate-fixture",
		files: { ...goodFiles(), "index.ts": `${goodSource()}\nconst p = "jev-decisions";\nvoid p;\n` },
		expectation: "command:gate-fixture",
	});
	assert.equal(telemetry.ok, false);
	assert.ok(telemetry.reasons.some((reason) => reason.startsWith("telemetry:")));

	const skipped = await runExtensionGate({
		name: "gate-fixture",
		files: goodFiles(),
		expectation: "command:gate-fixture",
		options: { skipCompile: true, skipSmoke: true },
	});
	assert.equal(skipped.ok, true);
	void telemetryGate;
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function isSpawnFailure(error: unknown): error is { status: number; stdout: string } {
	return typeof error === "object"
		&& error !== null
		&& "status" in error
		&& typeof error.status === "number"
		&& "stdout" in error
		&& typeof error.stdout === "string";
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "check-models.mjs");

const CATALOG = [
	"provider    model             context  max-out  thinking  images",
	"openrouter  acme/live-model   1.0M     128K     yes       yes",
	"openrouter  acme/other-model  1.0M     128K     yes       yes",
].join("\n");

type Workspace = { dir: string; bin: string; agent: string };

function workspace(settings: Record<string, string>): Workspace {
	const dir = mkdtempSync(join(tmpdir(), "check-models-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const pi = join(bin, "pi");
	writeFileSync(pi, `#!/bin/sh\nprintf '%s\\n' '${CATALOG}'\n`);
	chmodSync(pi, 0o755);
	const agent = join(dir, "agent");
	mkdirSync(agent);
	mkdirSync(join(dir, "repo"));
	writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
	return { dir, bin, agent };
}

function run({ dir, bin, agent }: Workspace): { code: number; output: string } {
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_AGENT_DIR: agent };
	try {
		const args = [script, "--root", join(dir, "repo"), "--agent", agent];
		return { code: 0, output: execFileSync("node", args, { env, encoding: "utf8" }) };
	} catch (error) {
		if (!isSpawnFailure(error)) throw error;
		return { code: error.status, output: error.stdout };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("check-models passes when every pinned id resolves", () => {
	const result = run(workspace({ smolModel: "openrouter/acme/live-model:max" }));
	assert.equal(result.code, 0);
	assert.match(result.output, /all \d+ pinned model ids resolve/);
});

test("check-models names a retired id and the setting that pins it", () => {
	const result = run(workspace({ designerModel: "openrouter/acme/retired-model:xhigh" }));
	assert.equal(result.code, 1);
	assert.match(result.output, /acme\/retired-model/);
	assert.match(result.output, /settings\.json/);
});

test("check-models ignores a provider prefix that is absent from the catalog", () => {
	const result = run(workspace({ defaultModel: "custom/acme/live-model" }));
	assert.equal(result.code, 0);
});

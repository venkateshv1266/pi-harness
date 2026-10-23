import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
	.split("\n")
	.filter(Boolean);

test("extensions resolve and call Jev through utils/jev-client.ts only", () => {
	const offenders = tracked
		.filter((path) => /^extensions\/.*\.ts$/.test(path))
		.filter((path) => !/(^|\/)tests?\//.test(path))
		.filter((path) => {
			const source = readFileSync(join(root, path), "utf8");
			return /"agent",\s*"auth\.json"/.test(source) || /\/v1\/systemone/.test(source);
		});

	assert.deepEqual(offenders, [], `these bypass the shared Jev client: ${offenders.join(", ")}`);
});

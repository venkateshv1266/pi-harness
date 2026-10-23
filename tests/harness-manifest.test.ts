import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "harness.json"), "utf8"));

const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
	.split("\n")
	.filter(Boolean);

const WATCHED = ["extensions", "rules", "agents", "skills", "themes", "utils"];

function under(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

test("every installable file is classified in harness.json", () => {
	const prefixes = [
		...manifest.groups.map((group: { dir: string }) => group.dir),
		...manifest.components.map((component: { path: string }) => component.path),
		...manifest.support.map((item: { path: string }) => item.path),
		...manifest.exclude.map((item: { path: string }) => item.path),
	];

	const uncovered = tracked
		.filter((path) => WATCHED.some((dir) => under(path, dir)))
		.filter((path) => !path.endsWith(".md"))
		.filter((path) => !prefixes.some((prefix: string) => under(path, prefix)));

	assert.deepEqual(uncovered, [], `unclassified files: ${uncovered.join(", ")}`);
});

test("every declared path exists", () => {
	for (const component of manifest.components) {
		assert.ok(existsSync(join(root, component.path)), `missing component: ${component.path}`);
	}
	for (const item of manifest.support) {
		assert.ok(existsSync(join(root, item.path)), `missing support path: ${item.path}`);
	}
});

test("component ids and paths are unique, tiers are declared", () => {
	const ids = new Set<string>();
	const paths = new Set<string>();
	const tiers = new Set<string>(manifest.tiers.map((tier: { id: string }) => tier.id));

	for (const component of manifest.components) {
		assert.ok(!ids.has(component.id), `duplicate id: ${component.id}`);
		assert.ok(!paths.has(component.path), `duplicate path: ${component.path}`);
		assert.ok(tiers.has(component.tier), `unknown tier ${component.tier} on ${component.id}`);
		ids.add(component.id);
		paths.add(component.path);
	}
});

test("README counts match the tree", () => {
	const extensions = manifest.components.filter(
		(component: { type: string }) => component.type === "extension",
	).length;
	const agents = tracked.filter((path) => /^agents\/[^/]+\.md$/.test(path) && !path.endsWith("README.md")).length;
	const rules = tracked.filter((path) => /^rules\/[^/]+\.md$/.test(path) && !path.endsWith("README.md")).length;
	const themes = tracked.filter((path) => /^themes\/[^/]+\.json$/.test(path)).length;
	const skills = readdirSync(join(root, "skills"), { withFileTypes: true }).filter(
		(entry) => entry.isDirectory() && existsSync(join(root, "skills", entry.name, "SKILL.md")),
	).length;

	const readme = readFileSync(join(root, "README.md"), "utf8");
	const match = readme.match(
		/(\d+) extensions · (\d+) subagent definitions · (\d+) generic TTSR rules · (\d+) skills · (\d+) themes/,
	);

	assert.ok(match, "README is missing the one-line count summary");
	assert.deepEqual(match.slice(1).map(Number), [extensions, agents, rules, skills, themes]);
});

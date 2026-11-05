#!/usr/bin/env node
// Model ids are pinned in settings, harness presets, and agent frontmatter.
// A catalog bump (models.dev majors move with pi minors) can retire an id and
// break the role that points at it, silently.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

function flag(name) {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : undefined;
}

const root = flag("root") ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = flag("agent") ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");

const SINGLE_KEYS = [
	"defaultModel",
	"smolModel",
	"slowModel",
	"planModel",
	"taskModel",
	"designerModel",
	"visionModel",
	"fastModel",
	"midModel",
	"deepModel",
];
const MAP_KEYS = ["modelFallback", "modelThinkingLevels", "modelRouter"];
const NON_MODEL_ROUTER_KEYS = new Set(["enabled", "threshold", "timeoutMs", "preferRoles"]);
const THINKING_SUFFIX = /:(low|medium|high|xhigh|max|minimal)$/;

const refs = new Map();

function add(reference, source) {
	if (typeof reference !== "string" || !reference.includes("/")) return;
	const trimmed = reference.trim();
	if (!refs.has(trimmed)) refs.set(trimmed, new Set());
	refs.get(trimmed).add(source);
}

function collectSettings(value, source) {
	for (const key of SINGLE_KEYS) add(value[key], source);
	for (const key of MAP_KEYS) {
		const map = value[key];
		if (map === null || typeof map !== "object") continue;
		for (const [entryKey, entryValue] of Object.entries(map)) {
			if (entryKey === "preferRoles") continue;
			add(entryKey, source);
			if (key === "modelRouter" && NON_MODEL_ROUTER_KEYS.has(entryKey)) continue;
			add(entryValue, source);
		}
	}
}

function collectAgents(dir, source) {
	if (!existsSync(dir)) return;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md")) continue;
		const content = readFileSync(join(dir, file), "utf8");
		for (const line of content.split("\n")) {
			const match = /^model:\s*(\S+)\s*$/.exec(line);
			if (match) add(match[1], `${source}${file}`);
		}
	}
}

function readCatalog() {
	const output = execFileSync("pi", ["--list-models"], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const providers = new Set();
	const models = new Map();
	for (const line of output.split("\n")) {
		if (!line.trim() || line.startsWith("provider")) continue;
		const [provider, model] = line.trim().split(/\s+/);
		if (!provider || !model) continue;
		const id = model.replace(/^~/, "");
		providers.add(provider);
		if (!models.has(id)) models.set(id, new Set());
		models.get(id).add(provider);
	}
	return { providers, models };
}

function missing(reference, providers, models) {
	const id = reference.replace(THINKING_SUFFIX, "");
	const slash = id.indexOf("/");
	if (slash === -1) return true;
	const provider = id.slice(0, slash);
	const model = id.slice(slash + 1);
	const candidates = models.get(model);
	if (!candidates) return !models.has(id);
	// pi's resolver falls back across providers, so only a known provider with a
	// missing sibling is a real break.
	return providers.has(provider) && !candidates.has(provider);
}

const settingsPath = join(agentDir, "settings.json");
if (existsSync(settingsPath)) {
	collectSettings(JSON.parse(readFileSync(settingsPath, "utf8")), "settings.json");
}

const harnessPath = join(root, "harness.json");
if (existsSync(harnessPath)) {
	const presets = JSON.parse(readFileSync(harnessPath, "utf8")).presets?.models?.settings;
	if (presets) collectSettings(presets, "harness.json presets");
}

collectAgents(join(root, "agents"), "");
collectAgents(join(agentDir, "agents"), "");

let catalog;
try {
	catalog = readCatalog();
} catch {
	console.log("check-models: pi is not on PATH, skipping");
	process.exit(0);
}

const broken = [];
for (const [reference, sources] of refs) {
	if (missing(reference, catalog.providers, catalog.models)) {
		broken.push({ reference, sources: [...sources] });
	}
}

if (broken.length === 0) {
	console.log(`check-models: all ${refs.size} pinned model ids resolve`);
	process.exit(0);
}

console.log(`check-models: ${broken.length} pinned model id${broken.length === 1 ? "" : "s"} missing from the catalog:`);
for (const { reference, sources } of broken) console.log(`  ${reference}  (${sources.join(", ")})`);
console.log("Fix: point the id at an existing model from `pi --list-models <query>`.");
process.exit(1);

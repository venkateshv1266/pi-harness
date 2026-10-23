#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const HARNESS = JSON.parse(readFileSync(join(REPO, "harness.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
const target = resolve(args.target || join(homedir(), ".pi", "agent"));
const manifestPath = join(target, ".pi-harness.json");

function parseArgs(argv) {
	const out = { tiers: [], only: [], skip: [], flags: new Set(), values: {} };
	for (let i = 0; i < argv.length; i += 1) {
		const item = argv[i];
		if (item === "--tier" || item === "--only" || item === "--skip" || item === "--add") {
			const key = item.slice(2);
			out[key] = (argv[i + 1] || "")
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
			i += 1;
		} else if (item === "--target" || item === "--repo") {
			out.values[item.slice(2)] = argv[i + 1];
			i += 1;
		} else if (item.startsWith("--")) {
			out.flags.add(item.slice(2));
		} else if (item.startsWith("-")) {
			out.flags.add(item.slice(1));
		}
	}
	return out;
}

function log(message = "") {
	process.stdout.write(`${message}\n`);
}

function fail(message) {
	process.stderr.write(`error: ${message}\n`);
	process.exit(1);
}

function which(command) {
	const probe = spawnSync("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" });
	return probe.status === 0 && probe.stdout.trim().length > 0;
}

function preflight(required) {
	const missing = required.filter((command) => !which(command));
	if (missing.length) {
		fail(`missing prerequisites: ${missing.join(", ")}. Install them and re-run.`);
	}
	if (Number(process.versions.node.split(".")[0]) < 22) {
		fail(`Node ${process.versions.node} is too old. Use Node >= 22.15.0.`);
	}
}

function hashFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
}

function walk(dir) {
	if (!existsSync(dir)) return [];
	const stat = statSync(dir);
	if (!stat.isDirectory()) return [dir];
	return readdirSync(dir)
		.filter((entry) => entry !== "node_modules" && entry !== ".DS_Store")
		.flatMap((entry) => walk(join(dir, entry)))
		.filter((path) => !isExcluded(relative(REPO, path)));
}

function isExcluded(path) {
	return (HARNESS.exclude || []).some(
		(item) => path === item.path || path.startsWith(`${item.path}/`),
	);
}

function readSettings() {
	const path = join(target, "settings.json");
	if (!existsSync(path)) return { path, data: {}, raw: "{}" };
	const raw = readFileSync(path, "utf8");
	try {
		return { path, data: JSON.parse(raw), raw };
	} catch (error) {
		if (!args.flags.has("force-settings")) {
			fail(
				`cannot parse ${path}: ${error.message}\n` +
					"Fix the file, or re-run with --force-settings to back it up and start from an empty object.",
			);
		}
		writeFileSync(`${path}.bak.${STAMP}`, raw);
		log(`  ! ${path} was not valid JSON; backed up to ${path}.bak.${STAMP}`);
		return { path, data: {}, raw };
	}
}

function writeSettings(settings, additions) {
	const added = Object.keys(additions).filter((key) => settings.data[key] === undefined);
	if (!added.length) {
		log("  = settings already contain the selected keys; left untouched");
		return [];
	}
	mkdirSync(dirname(settings.path), { recursive: true });
	writeFileSync(`${settings.path}.bak.${STAMP}`, `${JSON.stringify(settings.data, null, 2)}\n`);
	for (const key of added) settings.data[key] = additions[key];
	writeFileSync(settings.path, `${JSON.stringify(settings.data, null, 2)}\n`);
	log(`  + settings: ${added.join(", ")} (backup at settings.json.bak.${STAMP})`);
	return added;
}

function readManifest() {
	if (!existsSync(manifestPath)) return null;
	try {
		return JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		fail(`${manifestPath} is not valid JSON. Delete it and re-run.`);
	}
}

function writeManifest(manifest) {
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function expandRequires(ids) {
	const selected = new Set(ids);
	let changed = true;
	while (changed) {
		changed = false;
		for (const id of [...selected]) {
			const component = HARNESS.components.find((item) => item.id === id);
			for (const dependency of component?.requires || []) {
				if (!selected.has(dependency)) {
					selected.add(dependency);
					changed = true;
				}
			}
		}
	}
	return selected;
}

function defaultSelection() {
	const def = HARNESS.tiers.find((tier) => tier.default)?.id || "core";
	const ids = HARNESS.components.filter((component) => component.tier === def).map((component) => component.id);
	const subagents = HARNESS.components
		.filter((component) => component.tier === "subagents")
		.map((component) => component.id);
	return expandRequires([...ids, ...subagents]);
}

function componentDestination(component) {
	return join(target, component.path);
}

function groupSources(group) {
	const dir = join(REPO, group.dir);
	if (!existsSync(dir)) return [];
	return walk(dir)
		.filter((path) => statSync(path).isFile())
		.filter((path) => !group.exclude.includes(relative(dir, path)))
		.filter((path) => !path.includes("/node_modules/"));
}

function plan(selectionIds) {
	const jobs = [];
	const npmDirs = [];
	const addFile = (id, type, source, env = []) => {
		jobs.push({
			id,
			type,
			source,
			destination: join(target, relative(REPO, source)),
			env,
		});
	};

	for (const component of HARNESS.components) {
		if (!selectionIds.has(component.id)) continue;
		const source = join(REPO, component.path);
		if (!existsSync(source)) continue;
		if (statSync(source).isDirectory()) {
			for (const file of walk(source)) addFile(component.id, component.type, file, component.env || []);
			if (component.npm) npmDirs.push(componentDestination(component));
		} else {
			addFile(component.id, component.type, source, component.env || []);
		}
	}

	for (const group of HARNESS.groups) {
		if (!selectionIds.has(group.id)) continue;
		for (const source of groupSources(group)) addFile(group.id, group.type, source);
	}

	for (const item of HARNESS.support) {
		const source = join(REPO, item.path);
		if (!existsSync(source)) continue;
		if (statSync(source).isDirectory()) {
			for (const file of walk(source)) addFile(item.id, "support", file);
		} else {
			addFile(item.id, "support", source);
		}
	}

	return { jobs, npmDirs };
}

function copyJob(job, previous, dryRun) {
	const relativePath = relative(target, job.destination);
	const previousEntry = previous?.files?.find((file) => file.path === relativePath);
	const installed = {
		path: relativePath,
		created: previousEntry ? previousEntry.created : !existsSync(job.destination),
		hash: null,
		id: job.id,
	};
	if (!existsSync(job.source)) {
		log(`  ! missing source ${relative(REPO, job.source)}; skipped`);
		return null;
	}
	if (dryRun) {
		installed.hash = "dry-run";
		return installed;
	}
	mkdirSync(dirname(job.destination), { recursive: true });
	if (existsSync(job.destination)) {
		const currentHash = hashFile(job.destination);
		if (previousEntry?.hash && currentHash !== previousEntry.hash) {
			writeFileSync(`${job.destination}.bak.${STAMP}`, readFileSync(job.destination));
			installed.hash = currentHash;
			log(`  ! kept your edited ${relativePath} (backup written)`);
			return installed;
		}
		if (currentHash !== hashFile(job.source)) {
			writeFileSync(`${job.destination}.bak.${STAMP}`, readFileSync(job.destination));
		}
	}
	cpSync(job.source, job.destination, { recursive: false });
	installed.hash = hashFile(job.destination);
	return installed;
}

function installNpm(dirs, dryRun) {
	for (const dir of [...new Set(dirs)]) {
		if (!existsSync(join(dir, "package.json"))) continue;
		if (dryRun) {
			log(`  ~ would run npm install in ${relative(target, dir)}`);
			continue;
		}
		log(`  ~ npm install in ${relative(target, dir)}`);
		const silent = spawnSync("npm", ["install", "--silent", "--no-fund", "--no-audit"], {
			cwd: dir,
			stdio: "pipe",
			encoding: "utf8",
		});
		if (silent.status !== 0) {
			log(`  ! npm install failed in ${relative(target, dir)}; running verbosely`);
			const verbose = spawnSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: dir, stdio: "inherit" });
			if (verbose.status !== 0) fail(`npm install failed in ${dir}`);
		}
	}
}

function summarise(jobs, selectedIds, envMissing) {
	const count = (type) => jobs.filter((job) => job.type === type).length;
	const extensions = new Set(jobs.filter((job) => job.type === "extension").map((job) => job.id)).size;
	const skills = new Set(
		jobs
			.filter((job) => job.type === "skills")
			.map((job) => relative(join(target, "skills"), job.destination).split("/")[0]),
	);
	const parts = [
		`${extensions} extensions`,
		`${count("rules")} rules`,
		`${count("agents")} agents`,
		`${count("themes")} themes`,
		`${skills.size} skills`,
	].filter((part) => !part.startsWith("0 "));
	log(`  ✓ installed ${parts.join(", ")} → ${target}`);
	if (envMissing.length) {
		log(`\n  Set these before starting pi: ${envMissing.join(", ")}`);
	}
	log("\nNext: restart pi, then run /reload. See docs/install.md for flags and tiers.");
}

async function promptTiers(prompter) {
	log("\nWhat should I install?\n");
	const choices = [
		"Recommended — core + subagents (works immediately)",
		"Everything that fits this machine (checks your keys)",
		"Custom — choose tiers",
		"Inspect only — run checks, install nothing",
	];
	const index = await prompter.choose(choices, 0);
	if (index === 3) return { ids: new Set(), inspect: true };
	if (index === 1) {
		const ids = HARNESS.components.map((component) => component.id);
		return { ids: expandRequires(ids), inspect: false };
	}
	if (index === 2) {
		const ids = new Set();
		for (const tier of HARNESS.tiers) {
			if (tier.id === "core") {
				for (const component of HARNESS.components.filter((item) => item.tier === "core")) ids.add(component.id);
				continue;
			}
			const wanted = await prompter.confirm(`Include the ${tier.label} tier? (${tier.description})`, false);
			if (!wanted) continue;
			for (const component of HARNESS.components.filter((item) => item.tier === tier.id)) ids.add(component.id);
		}
		return { ids: expandRequires([...ids]), inspect: false };
	}
	return { ids: defaultSelection(), inspect: false };
}

const PROVIDER_ENV = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	gemini: "GEMINI_API_KEY",
	mistral: "MISTRAL_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	zai: "ZAI_API_KEY",
	fireworks: "FIREWORKS_API_KEY",
	together: "TOGETHER_API_KEY",
};

function readJsonIfPresent(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function configuredProviders() {
	const providers = new Map();
	const auth = readJsonIfPresent(join(target, "auth.json"));
	for (const name of Object.keys(auth || {})) providers.set(name, { source: "auth.json" });
	const store = readJsonIfPresent(join(target, "models-store.json"));
	for (const [name, entry] of Object.entries(store || {})) {
		const models = Array.isArray(entry?.models) ? entry.models : [];
		providers.set(name, { ...(providers.get(name) || {}), source: providers.get(name)?.source ?? "catalog", models });
	}
	for (const [name, envName] of Object.entries(PROVIDER_ENV)) {
		if (process.env[envName] && !providers.has(name)) providers.set(name, { source: "env" });
	}
	const settings = readJsonIfPresent(join(target, "settings.json"));
	if (settings?.defaultProvider && !providers.has(settings.defaultProvider)) {
		providers.set(settings.defaultProvider, { source: "settings" });
	}
	return providers;
}

function providerModels(name) {
	const store = readJsonIfPresent(join(target, "models-store.json"));
	const cached = store?.[name]?.models;
	if (Array.isArray(cached)) return cached.map((model) => ({ id: model.id, name: model.name || model.id }));
	const custom = readJsonIfPresent(join(target, "models.json"));
	const listed = custom?.providers?.[name]?.models;
	if (Array.isArray(listed)) {
		return listed.map((model) =>
			typeof model === "string" ? { id: model, name: model } : { id: model.id, name: model.name || model.id },
		);
	}
	return [];
}

function listModels() {
	const providers = configuredProviders();
	if (!providers.size) {
		log("No model providers detected. Run /login in pi, or set a provider API key, then retry.");
		return;
	}
	for (const name of providers.keys()) {
		const models = providerModels(name);
		log(`${name} — ${models.length} model(s) available`);
		for (const model of models.slice(0, 12)) log(`  ${model.id}`);
		if (models.length > 12) log(`  … ${models.length - 12} more`);
	}
}

async function pickModel(prompter, provider, label, current) {
	const models = providerModels(provider);
	if (!models.length) return prompter.ask(`${label} model id for ${provider}`, current || "");
	const filter = await prompter.ask(`Search ${provider} models for ${label} (Enter = all)`, "");
	const needle = filter.toLowerCase();
	const matches = (needle
		? models.filter((model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle))
		: models
	).slice(0, 10);
	if (!matches.length) return prompter.ask(`No matches. Enter the ${label} model id`, current || "");
	const options = matches.map((model) => `${model.id} — ${model.name}`);
	if (current) {
		const index = await prompter.choose([`Keep current: ${current}`, ...options], 0);
		return index === 0 ? current : matches[index - 1].id;
	}
	const index = await prompter.choose(options, 0);
	return matches[index].id;
}

async function configureModels(prompter) {
	const providers = configuredProviders();
	log("\nModel roles (@smol/@slow/@plan/@task) and the router tiers are optional.");
	if (!providers.size) {
		log("  = no provider detected; roles stay as they are. Run /login in pi, then /roles.");
		return {};
	}
	log(`  detected: ${[...providers.keys()].join(", ")}`);

	const choices = [];
	const actions = [];
	if (providers.has("openrouter") && HARNESS.presets?.models) {
		choices.push("Use the pi-harness OpenRouter preset");
		actions.push("preset");
	}
	for (const name of providers.keys()) {
		const count = providerModels(name).length;
		choices.push(`Pick models from ${name}${count ? ` (${count} available)` : ""}`);
		actions.push(name);
	}
	choices.push("Keep my current settings", "Skip model setup");
	const choice = await prompter.choose(choices, choices.length - 2);
	const action = actions[choice];
	if (!action) return {};
	if (action === "preset") return HARNESS.presets.models.settings;

	const current = readJsonIfPresent(join(target, "settings.json")) || {};
	const picks = {};
	for (const [key, label] of [
		["smolModel", "@smol (fast)"],
		["slowModel", "@slow (deep)"],
		["planModel", "@plan"],
		["taskModel", "@task"],
	]) {
		picks[key] = await pickModel(prompter, action, label, current[key]);
	}
	return {
		...picks,
		modelRouter: {
			enabled: true,
			threshold: 0.75,
			timeoutMs: 1500,
			fast: picks.smolModel,
			mid: picks.taskModel,
			deep: picks.slowModel,
		},
	};
}

function uninstall() {
	const manifest = readManifest();
	if (!manifest) fail(`${manifestPath} not found; nothing was installed by this script.`);
	let removed = 0;
	for (const file of manifest.files || []) {
		const path = join(target, file.path);
		if (!existsSync(path)) continue;
		if (!file.created && !args.flags.has("force")) continue;
		rmSync(path, { force: true });
		removed += 1;
		const parent = dirname(path);
		try {
			rmdirSync(parent);
		} catch {
			// Directory is not empty; leave it.
		}
	}
	const settingsPath = join(target, "settings.json");
	const settingsExisted = existsSync(settingsPath);
	const settings = readSettings();
	for (const key of manifest.settingsKeys || []) delete settings.data[key];
	if (settingsExisted) {
		writeFileSync(settingsPath, `${JSON.stringify(settings.data, null, 2)}\n`);
	}
	rmSync(manifestPath, { force: true });
	log(`Removed ${removed} file(s) and ${(manifest.settingsKeys || []).length} settings key(s).`);
}

async function main() {
	if (args.flags.has("help")) {
		log("Usage: ./install.sh [--yes] [--tier core,jev] [--only id] [--skip id] [--dry-run] [--uninstall] [--list-models]");
		return;
	}

	if (args.flags.has("list-models")) {
		listModels();
		return;
	}

	const previous = readManifest();
	if (args.flags.has("uninstall")) {
		preflight([]);
		uninstall();
		return;
	}

	if (args.flags.has("update")) {
		preflight(["node", "npm"]);
		const selected = new Set(previous?.components || []);
		if (args.add.length) for (const id of args.add) selected.add(id);
		if (!selected.size) fail("no previous install recorded; run ./install.sh first.");
		const ids = expandRequires([...selected]);
		const available = HARNESS.components.filter((component) => !selected.has(component.id));
		if (available.length) {
			const shown = available.slice(0, 8).map((component) => `${component.id} (${component.tier})`);
			const rest = available.length - shown.length;
			log(`\nNot installed: ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`);
			log("Add them with ./install.sh --add <id>.\n");
		}
		await apply(ids, previous, args.flags.has("dry-run"));
		return;
	}

	preflight(["node", "npm"]);

	const interactive = process.stdin.isTTY || existsSync("/dev/tty");
	const prompter = createPrompter(interactive && !args.flags.has("yes"));

	let selection;
	if (args.only.length) {
		selection = { ids: expandRequires(args.only), inspect: false };
	} else if (args.tiers.length) {
		const ids = HARNESS.components
			.filter((component) => args.tiers.includes(component.tier))
			.map((component) => component.id);
		selection = { ids: expandRequires(ids), inspect: false };
	} else if (args.flags.has("yes") || !prompter.interactive) {
		selection = { ids: defaultSelection(), inspect: false };
	} else {
		selection = await promptTiers(prompter);
	}

	for (const id of args.skip) selection.ids.delete(id);
	if (selection.inspect) {
		reportInspection(selection.ids);
		return;
	}
	if (!selection.ids.size) {
		log("Nothing selected.");
		return;
	}

	if (interactive && !args.flags.has("yes")) {
		selection.settings = await configureModels(prompter);
	}

	await apply(selection.ids, previous, args.flags.has("dry-run"), selection.settings);
}

function reportInspection(ids) {
	log("\nPreflight passed.");
	const env = new Set(HARNESS.components.filter((c) => ids.has(c.id)).flatMap((c) => c.env || []));
	const missing = [...env].filter((name) => !process.env[name]);
	log(`  target: ${target}`);
	log(`  components on disk: ${HARNESS.components.length}`);
	if (missing.length) log(`  credentials still needed: ${missing.join(", ")}`);
}

async function apply(ids, previous, dryRun, settingsAdditions) {
	log(`\nInstalling ${ids.size} component(s) into ${target}${dryRun ? " (dry run)" : ""}`);
	if (!dryRun) mkdirSync(target, { recursive: true });

	const { jobs, npmDirs } = plan(ids);
	const files = [];
	for (const job of jobs) {
		const result = copyJob(job, previous, dryRun);
		if (result) files.push(result);
	}
	installNpm(npmDirs, dryRun);

	const envMissing = [
		...new Set(jobs.flatMap((job) => job.env || []).filter((name) => !process.env[name])),
	];

	let settingsKeys = previous?.settingsKeys || [];
	if (settingsAdditions && Object.keys(settingsAdditions).length) {
		const settings = readSettings();
		settingsKeys = [...new Set([...settingsKeys, ...writeSettings(settings, settingsAdditions)])];
	}

	if (!dryRun) {
		writeManifest({
			version: HARNESS.version,
			installedAt: previous?.installedAt || new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			tiers: HARNESS.tiers.filter((tier) => HARNESS.components.some((c) => ids.has(c.id) && c.tier === tier.id)).map((tier) => tier.id),
			components: [...ids].sort(),
			files,
			settingsKeys,
		});
	}

	summarise(jobs, ids, envMissing);
}

function createPrompter(interactive) {
	if (!interactive) {
		return {
			interactive: false,
			ask: async (_question, fallback) => fallback,
			confirm: async (_question, fallback) => fallback,
			choose: async (_choices, fallback) => fallback,
			close() {},
		};
	}
	const input = process.stdin.isTTY ? process.stdin : openSync("/dev/tty", "r");
	const rl = createInterface({ input, output: process.stdout });
	return {
		interactive: true,
		async ask(question, fallback) {
			const answer = (await rl.question(`? ${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
			return answer || fallback;
		},
		async confirm(question, fallback) {
			const answer = (await rl.question(`? ${question} ${fallback ? "[Y/n]" : "[y/N]"}: `)).trim().toLowerCase();
			if (!answer) return fallback;
			return answer.startsWith("y");
		},
		async choose(choices, fallback) {
			process.stdout.write("\n");
			choices.forEach((choice, index) => {
				process.stdout.write(`  ${index + 1}. ${choice}\n`);
			});
			const answer = (await rl.question(`? Choose [1-${choices.length}] (${fallback + 1}): `)).trim();
			const index = Number(answer || fallback + 1) - 1;
			if (Number.isNaN(index) || index < 0 || index >= choices.length) return fallback;
			return index;
		},
		close() {
			rl.close();
		},
	};
}

main().catch((error) => {
	fail(error.stack || error.message);
});

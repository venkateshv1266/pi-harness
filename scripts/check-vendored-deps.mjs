#!/usr/bin/env node
// Extensions that vendor @earendil-works packages resolve those copies at
// runtime, so a stale copy silently overrides pi's own API and theme behaviour.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const roots = [
	["repo", join(root, "extensions")],
	["live", join(agentDir, "extensions")],
];

function readPiVersion() {
	try {
		return execFileSync("pi", ["--version"], { encoding: "utf8" }).trim().replace(/^v/, "");
	} catch {
		return null;
	}
}

function majorMinor(version) {
	const [major, minor] = version.split(".").map(Number);
	return { major, minor };
}

function sameMinor(left, right) {
	const a = majorMinor(left);
	const b = majorMinor(right);
	return a.major === b.major && a.minor === b.minor;
}

function rangeBase(range) {
	return range.replace(/^[~^]/, "").split("-")[0];
}

const piVersion = readPiVersion();
if (!piVersion) {
	console.log("check-vendored-deps: pi is not on PATH, skipping");
	process.exit(0);
}

const findings = [];

for (const [label, extensionsDir] of roots) {
	if (!existsSync(extensionsDir)) continue;
	for (const extension of readdirSync(extensionsDir)) {
		const nodeModules = join(extensionsDir, extension, "node_modules", "@earendil-works");
		if (existsSync(nodeModules)) {
			for (const name of readdirSync(nodeModules)) {
				const manifestPath = join(nodeModules, name, "package.json");
				if (!existsSync(manifestPath)) continue;
				const { version } = JSON.parse(readFileSync(manifestPath, "utf8"));
				if (typeof version === "string" && !sameMinor(version, piVersion)) {
					findings.push(`${label} ${extension}: installed @earendil-works/${name}@${version} (pi ${piVersion})`);
				}
			}
		}

		const packagePath = join(extensionsDir, extension, "package.json");
		if (!existsSync(packagePath)) continue;
		const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
		for (const field of ["dependencies", "devDependencies"]) {
			for (const [name, range] of Object.entries(manifest[field] ?? {})) {
				if (!name.startsWith("@earendil-works/") || typeof range !== "string") continue;
				const base = rangeBase(range);
				if (!sameMinor(base, piVersion)) {
					findings.push(`${label} ${extension}: ${field} ${name} "${range}" (pi ${piVersion})`);
				}
			}
		}
	}
}

if (findings.length === 0) {
	console.log(`check-vendored-deps: all vendored pi packages match ${piVersion}`);
	process.exit(0);
}

console.log(`check-vendored-deps: ${findings.length} stale vendored pi dependenc${findings.length === 1 ? "y" : "ies"} against pi ${piVersion}:`);
for (const finding of findings) console.log(`  ${finding}`);
console.log("Fix: bump the range and reinstall (npm install --prefix extensions/<name>), then re-run.");
process.exit(1);

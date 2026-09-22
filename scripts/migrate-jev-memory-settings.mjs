#!/usr/bin/env node
// jev-memory coexistence migration: pi loads settings.json `packages` BEFORE the
// extensions dir, so a leftover npm:pi-hermes-memory entry would win the memory_*
// tool names and silently shadow this extension. Removes exactly that one entry.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const home = process.env.HOME || os.homedir();
const p = `${home}/.pi/agent/settings.json`;
const LEGACY_PACKAGE = "npm:pi-hermes-memory";

let s = {};
try {
  s = JSON.parse(fs.readFileSync(p, "utf8"));
} catch {
  console.log(">> no settings.json — nothing to migrate");
  process.exit(0);
}

if (!Array.isArray(s.packages)) {
  console.log(">> no packages array — nothing to migrate");
  process.exit(0);
}

const had = s.packages.includes(LEGACY_PACKAGE);
if (!had) {
  console.log(">> no legacy memory package in settings.json — nothing to migrate");
  process.exit(0);
}

s.packages = s.packages.filter((entry) => entry !== LEGACY_PACKAGE);
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
console.log(
  ">> removed npm:pi-hermes-memory from settings.json packages (jev-memory replaces it;"
  + " your store auto-migrates to ~/.pi/agent/jev-memory on first pi start)",
);
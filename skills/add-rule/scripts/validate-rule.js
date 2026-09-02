#!/usr/bin/env node
/**
 * Validate a rule file for the pi TTSR rules engine before saving.
 *
 * Usage:
 *   node scripts/validate-rule.js <rule.md> [--sample "text the model would emit"]
 *
 * Bucket policy: TTSR is the only bucket that justifies a rule file.
 *   - TTSR (has condition/astCondition): valid.
 *   - always-apply: ERROR — perpetual token tax, belongs in CLAUDE.md/AGENTS.md.
 *   - rulebook: ERROR if it names a specific command/tool (convert to TTSR);
 *     WARN otherwise (belongs in CLAUDE.md's context tree — no advantage over it).
 *
 * Checks:
 *   - frontmatter parses; required fields present
 *   - bucket classification + policy enforcement (above)
 *   - every `condition` regex compiles
 *   - if --sample given, reports which conditions match (warns if NONE match
 *     for a single-condition TTSR rule — the trigger would never fire)
 *   - astCondition metavariable sanity (non-empty, repeated vars noted)
 *   - name is kebab-case
 *   - scope values are valid (text|thinking|tool)
 *   - body is non-empty
 *
 * Exits non-zero on hard errors (don't save), zero with warnings.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
	const out = { file: null, sample: null };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--sample") { out.sample = argv[++i] ?? ""; continue; }
		if (a.startsWith("--sample=")) { out.sample = a.slice("--sample=".length); continue; }
		if (!out.file) out.file = a;
	}
	return out;
}

function parseFrontmatter(text) {
	const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!m) return null;
	const fm = {};
	for (const line of m[1].split("\n")) {
		const mm = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (!mm) continue;
		const k = mm[1], v = mm[2].trim();
		if (v === "true" || v === "yes") { fm[k] = true; continue; }
		if (v === "false" || v === "no") { fm[k] = false; continue; }
		if (v.startsWith("[") && v.endsWith("]")) {
			fm[k] = parseList(v.slice(1, -1));
		} else {
			fm[k] = stripQuotes(v);
		}
	}
	return { fm, body: (m[2] || "").trim() };
}

// Parse a YAML-ish inline list, respecting single/double quotes so commas inside
// quoted strings (e.g. regex quantifiers `{0,4}`) are not split on. Handles
// YAML single-quote doubling (`''` -> `'`) and double-quote backslash escapes.
function parseList(inner) {
	const out = [];
	let cur = "";
	let q = null;
	let i = 0;
	while (i < inner.length) {
		const c = inner[i];
		if (q === "'") {
			if (c === "'") {
				if (inner[i + 1] === "'") { cur += "''"; i += 2; continue; }
				cur += "'"; q = null; i++; continue;
			}
			cur += c; i++;
		} else if (q === '"') {
			if (c === "\\" && i + 1 < inner.length) { cur += c + inner[i + 1]; i += 2; continue; }
			cur += c;
			if (c === '"') q = null;
			i++;
		} else {
			if (c === '"' || c === "'") { q = c; cur += c; i++; continue; }
			if (c === ",") { out.push(stripQuotes(cur.trim())); cur = ""; i++; continue; }
			cur += c; i++;
		}
	}
	if (cur.trim()) out.push(stripQuotes(cur.trim()));
	return out;
}

function stripQuotes(s) {
	if (s.startsWith('"') && s.endsWith('"')) {
		return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	if (s.startsWith("'") && s.endsWith("'")) {
		return s.slice(1, -1).replace(/''/g, "'");
	}
	return s;
}

function listScalar(v) {
	if (Array.isArray(v)) return v.map(String);
	if (typeof v === "string" && v) return [v];
	return [];
}

const errors = [];
const warnings = [];

function astGrepAvailable() {
	try {
		require.resolve("@ast-grep/napi", { paths: [path.join(process.env.HOME ?? "", ".pi/agent/extensions/ttsr")] });
		return true;
	} catch { return false; }
}

function main() {
	const { file, sample } = parseArgs(process.argv);
	if (!file) { console.error("Usage: validate-rule.js <rule.md> [--sample \"text\"]"); process.exit(2); }
	if (!fs.existsSync(file)) { console.error(`File not found: ${file}`); process.exit(2); }

	const raw = fs.readFileSync(file, "utf8");
	const parsed = parseFrontmatter(raw);
	if (!parsed) { errors.push("No valid YAML frontmatter (--- ... ---) found."); finish(); return; }
	const { fm, body } = parsed;

	const name = fm.name ? String(fm.name) : null;
	if (!name) errors.push("Missing required field: name");
	else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) errors.push(`name "${name}" is not kebab-case (a-z0-9, hyphens, no leading/trailing/consecutive hyphens).`);

	const conditions = listScalar(fm.condition ?? fm.ttsrTrigger ?? fm.ttsr_trigger);
	const astConditions = listScalar(fm.astCondition ?? fm.ast_condition);
	const alwaysApply = Boolean(fm.alwaysApply ?? fm.always_apply);
	const description = fm.description != null ? String(fm.description) : null;
	const flags = typeof fm.flags === "string" ? fm.flags : "";

	let bucket;
	if (alwaysApply) bucket = "always";
	else if (conditions.length || astConditions.length) bucket = "ttsr";
	else if (description) bucket = "rulebook";
	else { errors.push("Cannot classify: no condition/astCondition and no description. Add one."); bucket = "?"; }

	// Bucket policy: TTSR is the only bucket that justifies a rule file.
	// always-apply is unconditionally rejected (perpetual tax, belongs in CLAUDE.md).
	// rulebook is rejected if it names a specific command (convert to TTSR),
	// otherwise warned (belongs in CLAUDE.md's tree — no advantage over it).
	if (bucket === "always") {
		errors.push("always-apply is perpetual token tax with zero TTSR advantage — belongs in CLAUDE.md/AGENTS.md, not the rules system. The rules system is for dormant rules that cost nothing until they fire; always-apply is the opposite. Put it in CLAUDE.md or AGENTS.md.");
	}
	if (bucket === "rulebook") {
		// Check if the description names a specific command/tool — those are truly
		// convertible to TTSR tool-scope. Generic words like "before/when" alone
		// don't mean there's a single trigger (e.g. "before investigating stuck
		// items" is a multi-step symptom, not a command).
		const desc = (description || "").toLowerCase();
		const hasSpecificTrigger = /\b(kubectl|bga|git|npm|pnpm|yarn|grafana|redash|snowflake|linear|curl|docker|helm|terraform|ansible|ssh|scp|wget|pytest|jest|mocha|eslint|tsc|prettier|cargo|rustc)\b/.test(desc);
		const hasQuotedCommand = /`[^`]+`/.test(description || "");
		if (hasSpecificTrigger || hasQuotedCommand) {
			errors.push("This rulebook entry names a specific command/tool — it should be TTSR tool-scope non-interrupting, not rulebook. Convert to: scope=[tool], interrupt=false, condition=[<regex matching the command/tool name in the tool input>]. Rulebook is only for guidance with NO single-command trigger (e.g. multi-step symptom investigation).");
		} else {
			warnings.push("rulebook is a passive one-line description; the rules system only earns its keep with TTSR. If this has ANY detectable trigger (command, tool name, file path, output signal), make it TTSR instead. If it's genuinely un-triggerable contextual guidance, it belongs in CLAUDE.md's context tree — the rulebook bucket offers no advantage over that tree.");
		}
	}

	console.log(`File:     ${file}`);
	console.log(`Name:     ${name ?? "(missing)"}`);
	console.log(`Bucket:   ${bucket}`);
	if (description) console.log(`Desc:     ${description}`);
	console.log(`Scope:    ${listScalar(fm.scope).join(",") || "(default: text,thinking,tool)"}`);
	console.log(`Repeat:   ${fm.repeat || "once"}`);
	if (fm.flags) console.log(`Flags:    ${fm.flags}`);
	console.log(`Interrupt:${fm.interrupt ?? "(default for bucket)"}`);
	console.log("");

	if (conditions.length) {
		console.log("Regex conditions:");
		conditions.forEach((src, i) => {
			try {
				const re = new RegExp(src, flags);
				const match = sample ? re.test(sample) : null;
				const tag = match === null ? "" : match ? "  MATCH" : "  no-match";
				console.log(`  [${i}] /${src}/  OK${tag}`);
				if (sample && !match && conditions.length === 1) {
					warnings.push("The only condition does not match the provided sample. The trigger may never fire on the intended output.");
				}
			} catch (e) {
				errors.push(`Regex [${i}] /${src}/ failed to compile: ${e.message}`);
				console.log(`  [${i}] /${src}/  COMPILE ERROR: ${e.message}`);
			}
		});
	}

	if (astConditions.length) {
		console.log("astCondition patterns:");
		astConditions.forEach((p, i) => {
			const metavars = p.match(/\$[A-Za-z_][\w]*/g) ?? [];
			const repeated = metavars.filter((m, idx) => metavars.indexOf(m) !== idx);
			console.log(`  [${i}] "${p}"  metavars=[${[...new Set(metavars)].join(",")}] repeated=[${[...new Set(repeated)].join(",")}]`);
			if (metavars.length === 0) warnings.push(`astCondition [${i}] has no metavariables — it will only match that exact text.`);
		});
		if (!astGrepAvailable()) {
			warnings.push("@ast-grep/napi not installed in ~/.pi/agent/extensions/ttsr — astCondition rules will be ignored at runtime.");
		}
	}

	if (!body) errors.push("Rule body is empty — the reminder/injection must contain guidance.");
	else if (body.length < 20) warnings.push("Rule body is very short; consider adding what to do instead.");

	const scopes = listScalar(fm.scope);
	for (const s of scopes) {
		if (s !== "text" && s !== "thinking" && s !== "tool") errors.push(`Invalid scope value: "${s}" (must be text|thinking|tool)`);
	}

	if (bucket === "ttsr" && astConditions.length && scopes.length && !scopes.includes("tool")) {
		warnings.push("astCondition only evaluates on tool scope, but scope does not include 'tool'. AST matching will never run.");
	}

	finish();
}

function finish() {
	console.log("");
	if (warnings.length) { console.log("WARNINGS:"); warnings.forEach((w) => console.log("  - " + w)); }
	if (errors.length) { console.log("ERRORS:"); errors.forEach((e) => console.log("  - " + e)); process.exit(1); }
	console.log("OK — rule is valid.");
	process.exit(0);
}

main();

#!/usr/bin/env node
// ask-jev adoption report: per-tool Jev-call usage vs read-call volume, measured
// from real session files. Converts the ledger's ground truth (jev-decisions) and
// session toolCall records into an adoption-per-day table, so dead tool surfaces
// are visible by evidence, not by feel.
//
// Usage: node scripts/ask-jev-adoption.mjs [--days 7] [--pi-dir ~/.pi/agent]

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
	const i = args.indexOf(flag);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const DAYS = Math.max(1, Number(argVal("--days", 7)));
const PI_DIR = resolve(String(argVal("--pi-dir", join(os.homedir(), ".pi", "agent"))));
const cutoff = Date.now() - DAYS * 86_400_000;

const JEV_TOOLS = [
	"ask_jev",
	"ask_jev_file_bool",
	"ask_jev_file_choice",
	"ask_jev_file_score",
	"ask_jev_files",
	"ask_jev_extract",
	"pick_first_file",
	"triage_log",
	"triage_test_output",
	"review_diff",
];

const day = (ts) => String(ts).slice(0, 10);
const perDay = new Map(); // day -> { reads, tools: Map, errors }
const bucket = (ts) => {
	const d = day(ts);
	let b = perDay.get(d);
	if (!b) {
		b = { reads: 0, tools: new Map(), errors: 0 };
		perDay.set(d, b);
	}
	return b;
};

// 1) Ask-jev ledger: every Jev call, with the tool's own ground truth.
let ledgerLines = 0;
try {
	const ledger = readFileSync(join(PI_DIR, "jev-decisions", "ask-jev.jsonl"), "utf8");
	for (const line of ledger.split("\n")) {
		if (!line.trim()) continue;
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		if (rec.kind !== "event" || rec.summary) continue;
		ledgerLines++;
		if (!rec.ts || !rec.tool || !JEV_TOOLS.includes(rec.tool)) continue;
		if (new Date(rec.ts).getTime() < cutoff) continue;
		const b = bucket(rec.ts);
		if (rec.ok === false) b.errors++;
		else b.tools.set(rec.tool, (b.tools.get(rec.tool) ?? 0) + 1);
	}
} catch {
	console.error(`no ask-jev ledger at ${PI_DIR}/jev-decisions/ask-jev.jsonl`);
}

// toolCall records can be top-level lines or nested inside message records —
// collect every { type: "toolCall", name } regardless of nesting depth.
const collectToolCalls = (node, out) => {
	if (Array.isArray(node)) {
		for (const x of node) collectToolCalls(x, out);
		return;
	}
	if (node && typeof node === "object") {
		if (node.type === "toolCall" && typeof node.name === "string") out.push(node.name);
		for (const v of Object.values(node)) if (v && typeof v === "object") collectToolCalls(v, out);
	}
};

// 2) Session files: read-call volume (the adoption denominator) + cross-check calls.
// Real tool calls are records of type "toolCall" with a "name"; schema/listing
// mentions live in other record shapes and are deliberately not counted.
let sessionFiles = 0;
const sessionsDir = join(PI_DIR, "sessions");
try {
	for (const proj of readdirSync(sessionsDir)) {
		const projDir = join(sessionsDir, proj);
		let files = [];
		try {
			files = readdirSync(projDir);
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			const p = join(projDir, f);
			try {
				if (statSync(p).mtimeMs < cutoff) continue;
				const text = readFileSync(p, "utf8");
				sessionFiles++;
				const ts = f.slice(0, 10);
				const b = bucket(ts);
				for (const line of text.split("\n")) {
					if (!line.includes('"toolCall"')) continue;
					let rec;
					try {
						rec = JSON.parse(line);
					} catch {
						continue;
					}
					const names = [];
					collectToolCalls(rec, names);
					for (const name of names) {
						if (name === "read") b.reads++;
						else if (JEV_TOOLS.includes(name)) b.tools.set(name, (b.tools.get(name) ?? 0) + 1);
					}
				}
			} catch {
				// unreadable session files are skipped, never fatal
			}
		}
	}
} catch {
	console.error(`no sessions dir at ${sessionsDir}`);
}

// 3) TTSR gate tax for ask-jev rules (historical context for the retired rule).
let gateEvals = 0;
let gateFires = 0;
try {
	const ttsr = readFileSync(join(PI_DIR, "jev-decisions", "ttsr-jev.jsonl"), "utf8");
	for (const line of ttsr.split("\n")) {
		if (!line.trim()) continue;
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		if (!rec.rule || !String(rec.rule).includes("ask-jev")) continue;
		if (!rec.ts || new Date(rec.ts).getTime() < cutoff) continue;
		gateEvals++;
		if (rec.decision === "fired") gateFires++;
	}
} catch {
	// ttsr ledger absent is fine
}

const days = [...perDay.keys()].sort();
console.log(`ask-jev adoption — last ${DAYS} day(s), ${sessionFiles} session file(s), ${ledgerLines} ledger call(s)`);
console.log(`ask-jev TTSR gate: ${gateEvals} evals, ${gateFires} fired`);
console.log();
console.log("day        reads  " + JEV_TOOLS.map((t) => t.replace("ask_jev", "a_jev").slice(0, 10).padEnd(11)).join(""));
let totReads = 0;
const totTools = new Map();
for (const d of days) {
	const b = perDay.get(d);
	const row = JEV_TOOLS.map((t) => String(b.tools.get(t) ?? 0).padEnd(11)).join("");
	const reads = String(b.reads).padEnd(5);
	console.log(`${d}  ${reads}  ${row}${b.errors ? `  (${b.errors} errors)` : ""}`);
	totReads += b.reads;
	for (const [t, n] of b.tools) totTools.set(t, (totTools.get(t) ?? 0) + n);
}
const totJev = [...totTools.values()].reduce((a, b) => a + b, 0);
console.log();
console.log(`total: ${totReads} reads, ${totJev} ask-jev calls (${totReads ? ((totJev / totReads) * 100).toFixed(1) : "n/a"}% conversion)`);
for (const t of JEV_TOOLS) {
	const n = totTools.get(t) ?? 0;
	if (n > 0) console.log(`  ${t.padEnd(20)} ${n}`);
}
console.log("\nNotes: codemode-internal invocations are not toolCall records and are undercounted;");
console.log("the ledger column is the Jev-side ground truth, the session counts add read volume.");

#!/usr/bin/env node
/**
 * jev-ask — ask System One (Jev) a structured question from the CLI.
 *
 * Used by the add-rule skill to decide whether a new TTSR rule needs a
 * `verify:` gate; generic enough for any one-off adjudication.
 *
 * Usage:
 *   node jev-ask.mjs --noul "<question>" [--state "<context>"] [--state-file <path>]
 *                    [--threshold 0.6] [--timeout 8000] [--json]
 *   node jev-ask.mjs --request <request.json>   # {"state": "...", "questions": {...}}
 *   cat request.json | node jev-ask.mjs         # same, via stdin
 *
 * Env: JEV_API_KEY | OPENROUTER_API_KEY | ~/.pi/agent/auth.json (openrouter.key)
 *      JEV_BASE_URL (default https://openrouter.ai/api)
 *      JEV_MODEL    (default jev-latest)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const USAGE = `jev-ask — ask System One (Jev) a structured question

  node jev-ask.mjs --noul "<question>" [--state "<context>"] [--state-file <path>]
                   [--threshold 0.6] [--timeout 8000] [--json]
  node jev-ask.mjs --request <request.json>     # {"state": "...", "questions": {...}}
  cat request.json | node jev-ask.mjs

Options:
  --noul <text>       Ask a yes/no question; prints the calibrated probability.
  --state <text>      Evidence/context for the question.
  --state-file <p>    Read the state from a file (wins over --state).
  --request <p>       Full request JSON (wins over --noul).
  --threshold <n>     Recommendation cutoff for noul questions (default 0.6).
  --timeout <ms>      Request timeout (default 8000).
  --json              Print the raw answers JSON only.

Env: JEV_API_KEY | OPENROUTER_API_KEY | ~/.pi/agent/auth.json (openrouter.key);
     JEV_BASE_URL (default https://openrouter.ai/api); JEV_MODEL (default jev-latest).`;

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const flag = (name, def) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : def;
};

if (has("help") || args.length === 0) {
	console.log(USAGE);
	process.exit(0);
}

const SECRET_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\bsk-[A-Za-z0-9_-]{10,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
const scrub = (s) => SECRET_PATTERNS.reduce((out, re) => out.replace(re, "[redacted]"), s);

function jevKey() {
	if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
	if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
	try {
		const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"));
		return typeof auth?.openrouter?.key === "string" ? auth.openrouter.key : null;
	} catch {
		return null;
	}
}

function readStdin() {
	try {
		return fs.readFileSync(0, "utf8").trim();
	} catch {
		return "";
	}
}

let request = null;
const requestFile = flag("request");
const noul = flag("noul");
if (requestFile) {
	request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
} else if (noul) {
	const state = flag("state-file") ? fs.readFileSync(flag("state-file"), "utf8") : (flag("state") ?? "");
	request = { state, questions: { q: { type: "noul", instructions: noul } } };
} else if (!process.stdin.isTTY) {
	const raw = readStdin();
	if (raw) request = JSON.parse(raw);
}

if (!request || typeof request !== "object" || !request.questions || typeof request.questions !== "object") {
	console.error("jev-ask: no request — pass --noul/--state, --request <file>, or JSON on stdin");
	process.exit(1);
}

const key = jevKey();
if (!key) {
	console.error("jev-ask: no Jev key (JEV_API_KEY / OPENROUTER_API_KEY / ~/.pi/agent/auth.json openrouter.key)");
	process.exit(3);
}

const baseUrl = process.env.JEV_BASE_URL ?? "https://openrouter.ai/api";
const model = process.env.JEV_MODEL ?? "jev-latest";
const timeoutMs = Number(flag("timeout", "8000"));
const threshold = Number(flag("threshold", "0.6"));
const state = scrub(typeof request.state === "string" ? request.state : "");
const started = Date.now();

let res;
try {
	res = await fetch(`${baseUrl}/v1/systemone`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model, state, questions: request.questions }),
		signal: AbortSignal.timeout(timeoutMs),
	});
} catch (e) {
	console.error(`jev-ask: request failed (${e instanceof Error ? e.message : e})`);
	process.exit(2);
}
if (!res.ok) {
	console.error(`jev-ask: HTTP ${res.status}`);
	process.exit(2);
}

let answers;
try {
	answers = (await res.json())?.answers;
} catch (e) {
	console.error(`jev-ask: malformed response (${e instanceof Error ? e.message : e})`);
	process.exit(2);
}
if (!answers || typeof answers !== "object") {
	console.error("jev-ask: response had no answers");
	process.exit(2);
}

if (has("json")) {
	console.log(JSON.stringify(answers, null, 2));
	process.exit(0);
}

for (const [name, a] of Object.entries(answers)) {
	const answer = a && typeof a === "object" ? a : {};
	const confidence = typeof answer.confidence === "number" ? ` confidence=${answer.confidence.toFixed(2)}` : "";
	if (typeof answer.noul === "number") {
		const verdict = answer.noul >= threshold ? `YES (>= ${threshold})` : `NO (< ${threshold})`;
		console.log(`${name}: noul=${answer.noul.toFixed(2)}${confidence} → ${verdict}`);
	} else if (typeof answer.choice === "string") {
		console.log(`${name}: choice=${JSON.stringify(answer.choice)}${confidence} probabilities=${JSON.stringify(answer.probabilities ?? {})}`);
	} else if (typeof answer.score === "number") {
		console.log(`${name}: score=${answer.score}${confidence}`);
	} else {
		console.log(`${name}: ${JSON.stringify(answer)}`);
	}
}
console.log(`(${model}, ${Date.now() - started}ms)`);

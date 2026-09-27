/**
 * Standalone tests for the context registry → rule synthesis loader.
 * Run: node --experimental-strip-types registry.test.ts
 *
 * Uses temp fixtures (no machine-specific paths), so it stays portable in the
 * mirrored repo. Frontmatter parsing is emulated below with the engine's own
 * parseScalar/parseList/stripQuotes semantics; the E2E check is a headless pi
 * session that loads a synthesized rule through the real engine.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContextRules, contextListText, readContextDocs, writeContextIndex } from "./registry.ts";
import { globToRegex } from "./glob.ts";
import { noveltySatisfied, cacheKey } from "./ledger.ts";
import { contextStats, pruneCandidates, statsFor } from "./telemetry.ts";

function say(line: string): void {
	process.stdout.write(line + "\n");
}

// ─── Engine-parse emulation (mirrors index.ts) ──────────────────────────

function parseList(inner: string): string[] {
	const out: string[] = [];
	let cur = "";
	let q: string | null = null;
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

function stripQuotes(s: string): string {
	if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
	return s;
}

function engineParse(source: string): { fm: Record<string, unknown>; conditions: RegExp[]; verify: Record<string, unknown> | null } {
	const m = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!m) throw new Error("no frontmatter");
	const fm: Record<string, unknown> = {};
	for (const line of m[1].split("\n")) {
		const mm = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (!mm) continue;
		const v = mm[2].trim();
		if (v.startsWith("[") && v.endsWith("]")) fm[mm[1]] = parseList(v.slice(1, -1).trim());
		else if (v.startsWith("{") && v.endsWith("}")) fm[mm[1]] = JSON.parse(v);
		else if (v === "true" || v === "yes") fm[mm[1]] = true;
		else if (v === "false" || v === "no") fm[mm[1]] = false;
		else fm[mm[1]] = stripQuotes(v);
	}
	const conditions = (fm.condition as string[]).map((s) => new RegExp(s));
	return { fm, conditions, verify: (fm.verify as Record<string, unknown>) ?? null };
}

// ─── Fixtures ───────────────────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-reg-test-"));
const fakeHome = path.join(root, "home");
const fakeCwd = path.join(root, "repo");
const userDir = path.join(fakeHome, ".pi", "contexts");
const projDir = path.join(fakeCwd, "contexts");
fs.mkdirSync(userDir, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });

fs.writeFileSync(path.join(userDir, "alpha.md"), "# alpha\n");
fs.writeFileSync(path.join(userDir, "beta.md"), "# beta\n");
fs.writeFileSync(path.join(userDir, "gamma.md"), "# gamma\n");
fs.writeFileSync(path.join(projDir, "delta.md"), "# delta\n");
fs.writeFileSync(path.join(userDir, "registry.yaml"), `version: 1
digest:
  goalspecEntryType: test-goalspec
defaults:
  root: user
  tier: advisory
  onFail: suppress
  gate:
    mode: necessity
    threshold: 0.8
contexts:
  - id: alpha
    file: alpha.md
    when: "before alpha commands"
    triggers:
      - tool: '^bash$'
        match: '(^|[;&|\\n]\\s*)alpha(\\s|$)'
    reads: [alpha.md]
  - id: beta
    file: beta.md
    when: "before beta CLI"
    tier: gated
    onFail: fire
    subagents: true
    gate:
      mode: none
    triggers:
      - tool: '^beta$'
      - tool: '^(write|edit)$'
        globs: ['**/*.beta']
    reads: [beta.md]
  - id: gamma
    file: gamma.md
    when: "pull-only doc"
    tier: index-only
  - id: dead
    file: alpha.md
    when: "retired doc"
    status: retired
    triggers:
      - tool: '^dead$'
`);
fs.writeFileSync(path.join(projDir, "registry.yaml"), `version: 1
defaults:
  root: project
  tier: advisory
  gate:
    mode: necessity
    threshold: 0.8
contexts:
  - id: delta
    file: delta.md
    when: "project delta"
    triggers:
      - tool: '^bash$'
        match: 'delta-run'
  - id: alpha
    file: missing.md
    when: "project override of alpha"
    triggers:
      - tool: '^bash$'
        match: '(^|[;&|\\n]\\s*)alpha-override(\\s|$)'
`);

process.env.HOME = fakeHome;
const { rules, entries, warnings, digest } = buildContextRules(fakeCwd, true);

let fail = 0;
const check = (cond: boolean, msg: string): void => {
	if (!cond) { say(`FAIL: ${msg}`); fail++; }
};

// glob semantics: `**/` matches zero directories (root-level files included)
check(globToRegex("**/*.ts").test("x.ts"), "glob: **/*.ts matches root-level x.ts");
check(globToRegex("**/*.ts").test("src/x.ts"), "glob: **/*.ts matches nested src/x.ts");
check(!globToRegex("**/*.ts").test("x.tsx"), "glob: **/*.ts rejects x.tsx");
check(!globToRegex("**/*.ts").test("src/x.js"), "glob: **/*.ts rejects .js");
check(globToRegex("**/canton/**").test("canton/a.ts") && globToRegex("**/canton/**").test("src/canton/a.ts"), "glob: **/canton/** matches both depths");
check(!globToRegex("**/canton/**").test("src/notcanton/a.ts"), "glob: **/canton/** keeps segment boundaries");
check(globToRegex("**/SKILL.md").test("SKILL.md") && globToRegex("**/SKILL.md").test("skills/x/SKILL.md"), "glob: **/SKILL.md matches root and nested");

// ledger: read receipts and staleness
const ledgerDoc = path.join(root, "ledger-doc.md");
fs.writeFileSync(ledgerDoc, "v1");
const receipts = new Map([[ledgerDoc, { turn: 0, mtimeMs: fs.statSync(ledgerDoc).mtimeMs }]]);
check(noveltySatisfied([ledgerDoc], receipts), "ledger: unchanged doc is satisfied");
const bumped = new Date(Date.now() + 5000);
fs.utimesSync(ledgerDoc, bumped, bumped);
check(!noveltySatisfied([ledgerDoc], receipts), "ledger: changed doc is stale");
check(!noveltySatisfied([ledgerDoc], new Map()), "ledger: unread doc is not satisfied");
check(noveltySatisfied([path.join(root, "missing.md")], new Map()), "ledger: missing path ignored");
check(noveltySatisfied([], new Map()), "ledger: empty read list satisfied");
check(cacheKey("r", "a") === cacheKey("r", "a") && cacheKey("r", "a") !== cacheKey("r", "b"), "ledger: cacheKey deterministic and state-sensitive");

// telemetry aggregation for /contexts and /setup
const telFile = path.join(root, "telemetry.jsonl");
fs.writeFileSync(telFile, [
	JSON.stringify({ ts: "2026-09-01T01:00:00Z", rule: "ctx-beta", scope: "tool", decision: "fired", mode: "verified", prob: 0.9 }),
	...Array.from({ length: 5 }, (_, i) => JSON.stringify({ ts: `2026-09-01T0${i + 1}:30:00Z`, rule: "ctx-beta", scope: "tool", decision: "suppressed", mode: "verified", prob: 0.4 })),
	JSON.stringify({ kind: "decision", ts: "2026-09-01T05:45:00Z", rule: "ctx-beta", delivered: true }),
	JSON.stringify({ kind: "outcome", ts: "2026-09-01T06:00:00Z", verdict: "bad", detail: { rule: "ctx-beta" } }),
	JSON.stringify({ ts: "2026-09-01T07:00:00Z", rule: "ctxdelegate-beta", decision: "suppressed", mode: "verified" }),
	"not json",
].join("\n"));
const tel = contextStats(telFile);
check(tel.get("ctx-beta")?.fired === 1 && tel.get("ctx-beta")?.suppressed === 5, "telemetry: decision aggregation");
check(tel.get("ctx-beta")?.adverse === 1, "telemetry: outcome aggregation");
check(tel.get("ctx-beta")?.lastTs === "2026-09-01T06:00:00Z", "telemetry: last timestamp wins");
const betaEntry = entries.find((e) => e.id === "beta");
check(!!betaEntry && statsFor(betaEntry, tel).suppressed === 6, "telemetry: entry merges trigger + delegate stats");
check(pruneCandidates(entries, tel).some((c) => c.entry.id === "beta"), "telemetry: prune candidate detected");

check(entries.length === 5, `expected 5 entries, got ${entries.length} (${entries.map((e) => e.id).join(",")})`);
const alpha = entries.find((e) => e.id === "alpha");
check(alpha?.origin === "project", "project registry wins by id");
check(alpha?.when === "project override of alpha", "project override description wins");
const beta = entries.find((e) => e.id === "beta");
check(beta?.tier === "gated" && beta?.onFail === "fire", "entry tier/onFail overrides defaults");

check(rules.length === 5, `expected 5 rules, got ${rules.length} (${rules.map((r) => r.name).join(",")})`);
check(rules.some((r) => r.name === "ctx-beta-2"), "second globs group gets -2 suffix");

const alphaRule = rules.find((r) => r.name === "ctx-alpha");
check(!!alphaRule, "ctx-alpha exists");
if (alphaRule) {
	const p = engineParse(alphaRule.source);
	check(p.conditions.length === 1, "alpha: one condition");
	check(p.conditions[0].test("bash\nalpha-override now"), "alpha: matches command-position payload");
	check(p.conditions[0].test("bash\ncd x && alpha-override"), "alpha: matches after && separator");
	check(!p.conditions[0].test("bash\ncat alpha-override.md"), "alpha: no match when token is part of a path");
	check(!p.conditions[0].test("bash\ncat alpha.md"), "alpha: no match on doc mention");
	check(p.verify !== null && p.verify.type === "noul", "alpha: noul verify synthesized");
	check(p.fm.scope?.[0] === "tool" && p.fm.interrupt === false, "alpha: tool scope, non-interrupting");
}

const beta2 = rules.find((r) => r.name === "ctx-beta-2");
if (beta2) {
	const p = engineParse(beta2.source);
	check(Array.isArray(p.fm.globs) && (p.fm.globs as string[])[0] === "**/*.beta", "beta-2: globs passed through");
	check(p.verify === null, "beta-2: gate none, no verify");
	check(p.conditions[0].test("write\npath=/x/y.beta"), "beta-2: tool prefix matches");
	check(p.conditions[0].test("write\npath=/x/y.ts"), "beta-2: condition matches write tool (path gate is globs, not the regex)");
} else {
	say("FAIL: ctx-beta-2 missing");
	fail++;
}

check(warnings.some((w) => w.includes("alpha: doc not found")), "missing doc warning emitted");
check(digest.goalspecEntryType === "test-goalspec", "digest config read from registry");
check(digest.goalEntryType === "", "unwired digest entry types stay empty");

// delegate seeding rule (subagents: true)
const betaDeleg = rules.find((r) => r.name === "ctxdelegate-beta");
check(!!betaDeleg, "ctxdelegate-beta exists");
if (betaDeleg) {
	const p = engineParse(betaDeleg.source);
	check(p.fm.interrupt === true, "delegate rule blocks (interrupt true)");
	check(p.verify !== null && p.verify.type === "noul" && p.verify.onFail === "suppress", "delegate gate is noul/suppress");
	check(p.conditions[0].test("delegate\ntask=fix the beta thing"), "delegate rule matches delegate calls");
	check(p.conditions[0].test("subagent_spawn\ntask=x"), "delegate rule matches subagent_spawn");
	check(!p.conditions[0].test("mcp__linear__get_issue\nid=x"), "delegate rule excludes other tools");
}

const list = contextListText(entries);
check(list.includes("gamma") && list.includes("tier=index-only"), "context_list shows index-only entries");
const read = readContextDocs(entries, "beta,delta");
check(read.includes("# beta") && read.includes("# delta"), "read_context reads resolved docs");
check(readContextDocs(entries, "nope").includes('No context "nope"'), "read_context reports unknown id");

const idx = writeContextIndex(fakeCwd, true);
check(!!idx && fs.existsSync(idx), "INDEX.md written");

const untrusted = buildContextRules(fakeCwd, false);
check(!untrusted.entries.some((e) => e.id === "delta"), "untrusted session skips project registry");

// project registry is found from sub-repos and its docs resolve against its own dir
const deepCwd = path.join(fakeCwd, "sub", "deep");
fs.mkdirSync(deepCwd, { recursive: true });
const deep = buildContextRules(deepCwd, true);
check(deep.entries.some((e) => e.id === "delta"), "parent-walk finds workspace project registry");
const delta = deep.entries.find((e) => e.id === "delta");
check(delta?.resolvedReads[0] === path.join(projDir, "delta.md"), "project docs resolve from the registry dir, not cwd");
check(!buildContextRules(deepCwd, false).entries.some((e) => e.id === "delta"), "untrusted deep cwd skips parent registry");

// cwd under $HOME/.pi must not re-load the user registry as a project one
const underPi = path.join(fakeHome, ".pi", "agent", "extensions", "x");
fs.mkdirSync(underPi, { recursive: true });
const under = buildContextRules(underPi, true);
check(under.entries.every((e) => e.origin === "user"), "user registry is not double-loaded as project");

fs.rmSync(root, { recursive: true, force: true });
say(fail === 0 ? `REGISTRY TESTS OK (${rules.length} rules, ${entries.length} entries)` : `${fail} failures`);
process.exit(fail === 0 ? 0 : 1);

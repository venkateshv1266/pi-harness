/**
 * Behavioral tests for `coveredBy`.
 *
 * A rule whose subject matter is already stated by a doc the agent read (the
 * push-changes skill for the BitGo commit standard) must not interrupt: the
 * reminder repeats text that is already in context. Coverage is checked in
 * `canFire`, so the verify gate is not even called — but the skip is logged so
 * rule-noise audits can see why a rule went quiet.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const say = (msg: string): void => console.log(msg);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ttsr-covered-test-"));
const fakeHome = path.join(root, "home");
const fakeCwd = path.join(root, "repo");
const rulesDir = path.join(fakeHome, ".pi", "agent", "rules");
const skillPath = path.join(fakeCwd, "skills", "push-changes", "SKILL.md");
const otherPath = path.join(fakeCwd, "skills", "unrelated", "SKILL.md");
fs.mkdirSync(rulesDir, { recursive: true });
fs.mkdirSync(path.dirname(skillPath), { recursive: true });
fs.mkdirSync(path.dirname(otherPath), { recursive: true });
fs.writeFileSync(skillPath, "# push-changes\n\nconventional-commit standard\n");
fs.writeFileSync(otherPath, "# unrelated\n");

// Built from parts so this fixture's own source does not match the rule it declares.
const VERB = ["git", "commit"].join(" ");

fs.writeFileSync(
	path.join(rulesDir, "commit-guard.md"),
	`---
name: commit-guard
condition: ["\\\\bgit\\\\s+commit\\\\b"]
scope: [tool]
interrupt: true
repeat: once
coveredBy: ["**/push-changes/SKILL.md"]
---

# Commit standard

test fixture
`,
);

process.env.HOME = fakeHome;
process.env.TTSR_CONTEXT_REGISTRY = "0";

type Handler = (event: unknown, ctx: unknown) => unknown;
interface FakePi {
	on(ev: string, h: Handler): void;
	registerCommand(cmd: unknown): void;
	registerTool(tool: unknown): void;
	appendEntry(type: string, data: unknown): void;
	sendUserMessage(msg: string, opts?: unknown): void;
}
type EngineFactory = (api: FakePi) => Promise<void>;

async function boot(factory: EngineFactory) {
	const handlers: Record<string, Handler[]> = {};
	const pi: FakePi = {
		on: (ev, h) => {
			(handlers[ev] ??= []).push(h);
		},
		registerCommand: () => {},
		registerTool: () => {},
		appendEntry: () => {},
		sendUserMessage: () => {},
	};
	await factory(pi);
	const ctx = {
		hasUI: false,
		cwd: fakeCwd,
		isProjectTrusted: () => false,
		isIdle: () => true,
		abort: () => {},
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => "test-session", getBranch: () => [], getEntries: () => [] },
	};
	for (const h of handlers["session_start"] ?? []) await h({}, ctx);
	for (const h of handlers["turn_start"] ?? []) await h(undefined, ctx);
	const toolCall = handlers["tool_call"]?.[0];
	if (!toolCall) throw new Error("no tool_call handler registered");
	return { toolCall, ctx };
}

const commit = async (toolCall: Handler, ctx: unknown, id: string): Promise<boolean> => {
	const res = await toolCall({ toolName: "bash", input: { command: `${VERB} -m "${id}"` }, toolCallId: id }, ctx);
	return typeof res === "object" && res !== null && "block" in res && res.block === true;
};

const read = async (toolCall: Handler, ctx: unknown, absPath: string, id: string): Promise<void> => {
	await toolCall({ toolName: "read", input: { path: absPath }, toolCallId: id }, ctx);
};

const ledger = (): string => {
	const f = path.join(fakeHome, ".pi", "agent", "jev-decisions", "ttsr-jev.jsonl");
	return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
};

let fail = 0;
const check = (cond: boolean, msg: string): void => {
	if (!cond) {
		say(`FAIL: ${msg}`);
		fail++;
	}
};

const engineFactory = (await import("./index.ts")).default as unknown as EngineFactory;

// Control: the rule still blocks when nothing covers it.
{
	const { toolCall, ctx } = await boot(engineFactory);
	check(await commit(toolCall, ctx, "uncovered"), "uncovered commit blocks");
}

// The case under test: skill read first, then the commit is left alone.
{
	const { toolCall, ctx } = await boot(engineFactory);
	await read(toolCall, ctx, skillPath, "read-skill");
	check(!(await commit(toolCall, ctx, "covered")), "commit after reading the skill is not blocked");
	check(ledger().includes('"mode":"covered"'), "coverage skip is logged to the adjudication ledger");
}

// An unrelated read covers nothing.
{
	const { toolCall, ctx } = await boot(engineFactory);
	await read(toolCall, ctx, otherPath, "read-other");
	check(await commit(toolCall, ctx, "unrelated"), "unrelated read does not cover the rule");
}

// A covering doc that changed after the read is no longer coverage.
{
	const { toolCall, ctx } = await boot(engineFactory);
	await read(toolCall, ctx, skillPath, "read-skill-stale");
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(skillPath, future, future);
	check(await commit(toolCall, ctx, "stale"), "stale covering doc lets the rule fire");
	fs.writeFileSync(skillPath, "# push-changes\n\nconventional-commit standard\n");
	const now = new Date();
	fs.utimesSync(skillPath, now, now);
}

fs.rmSync(root, { recursive: true, force: true });
if (fail) {
	say(`COVERED TESTS: ${fail} failure(s)`);
	process.exit(1);
}
say("COVERED TESTS OK");

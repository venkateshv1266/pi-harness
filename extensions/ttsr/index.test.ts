/**
 * Behavioral tests for the TTSR engine's subagent-child policy.
 *
 * Reproduces the 2026-10-16 incident (session 01a14693): the text/thinking
 * rule `delegate-read-only-exploration` fired inside a spawned explorer child
 * — whose job announcement "I'll explore the repo" matches the rule — and
 * ctx.abort() killed the child mid-task with zero work done, surfacing to the
 * parent as "Subagent was aborted".
 *
 * Policy under test: subagent children (PI_SUBAGENT_CHILD=1, set by both
 * spawn engines) never enforce text/thinking-scope rules; tool-scope rules
 * (safety blocks, delegate seeding) still apply.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const say = (msg: string): void => console.log(msg);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ttsr-child-test-"));
const fakeHome = path.join(root, "home");
const fakeCwd = path.join(root, "repo");
const rulesDir = path.join(fakeHome, ".pi", "agent", "rules");
fs.mkdirSync(rulesDir, { recursive: true });

// Mirrors the real delegate-read-only-exploration rule that killed children.
fs.writeFileSync(
	path.join(rulesDir, "explore-guard.md"),
	`---
name: explore-guard
condition: ["(I'll|Let me|I will) explore the (repo|codebase|repository)"]
scope: [text, thinking]
interrupt: true
repeat: once
---

# Read-only repo exploration belongs in a subagent

test fixture
`,
);

// Tool-scope safety stand-in: must keep blocking even in child sessions.
fs.writeFileSync(
	path.join(rulesDir, "forbidden-path.md"),
	`---
name: forbidden-path
condition: ["FORBIDDEN-PATH"]
scope: [tool]
interrupt: true
repeat: once
---

# Forbidden path

test fixture
`,
);

// Must precede the dynamic import: jev-outcomes resolves its decisions dir
// from $HOME at module-load time.
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

// The real factory takes the full ExtensionAPI; the fake implements only the
// subset the engine uses, so the assignment needs one structural escape here.
type EngineFactory = (api: FakePi) => Promise<void>;

function makeFakePi() {
	const handlers: Record<string, Handler[]> = {};
	const sent: string[] = [];
	const pi: FakePi = {
		on: (ev, h) => {
			(handlers[ev] ??= []).push(h);
		},
		registerCommand: () => {},
		registerTool: () => {},
		appendEntry: () => {},
		sendUserMessage: (msg) => {
			sent.push(msg);
		},
	};
	return { pi, handlers, sent };
}

function makeCtx() {
	let aborts = 0;
	const ctx = {
		hasUI: false,
		cwd: fakeCwd,
		isProjectTrusted: () => false,
		isIdle: () => true,
		abort: () => {
			aborts++;
		},
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => "test-session", getBranch: () => [], getEntries: () => [] },
	};
	return { ctx, aborts: () => aborts };
}

async function boot(factory: EngineFactory, env: Record<string, string | undefined>) {
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	const { pi, handlers, sent } = makeFakePi();
	await factory(pi);
	const { ctx, aborts } = makeCtx();
	for (const h of handlers["session_start"] ?? []) await h({}, ctx);
	for (const h of handlers["turn_start"] ?? []) await h(undefined, ctx);
	return { handlers, ctx, aborts, sent };
}

let fail = 0;
const check = (cond: boolean, msg: string): void => {
	if (!cond) {
		say(`FAIL: ${msg}`);
		fail++;
	}
};

const engineFactory = (await import("./index.ts")).default as unknown as EngineFactory;

// Root session: the rule aborts the run on a thinking match — the exact
// mechanism that killed spawned children before the guard existed.
{
	const { handlers, ctx, aborts } = await boot(engineFactory, { PI_SUBAGENT_CHILD: undefined });
	const h = handlers["message_update"]?.[0];
	if (!h) throw new Error("no message_update handler registered");
	await h({ assistantMessageEvent: { type: "thinking_delta", delta: "I'll explore the repo to map the structure." } }, ctx);
	check(aborts() === 1, `root: thinking match must abort the run (got ${aborts()})`);
}

// Subagent child: the same thinking match must NOT abort — children run an
// assigned task and a mid-run abort loses their work irrecoverably
// (one-shot children exit; the parent sees "Subagent was aborted").
{
	const { handlers, ctx, aborts } = await boot(engineFactory, { PI_SUBAGENT_CHILD: "1" });
	const h = handlers["message_update"]?.[0];
	await h({ assistantMessageEvent: { type: "thinking_delta", delta: "I'll explore the repo to map the structure." } }, ctx);
	await new Promise((r) => setTimeout(r, 50));
	check(aborts() === 0, `child: thinking match must not abort the run (got ${aborts()})`);
}

// Child sessions keep tool-scope enforcement (safety blocks, delegate seeding).
{
	const { handlers, ctx } = await boot(engineFactory, { PI_SUBAGENT_CHILD: "1" });
	const h = handlers["tool_call"]?.[0];
	if (!h) throw new Error("no tool_call handler registered");
	const res = await h({ toolName: "read", input: { path: "/tmp/FORBIDDEN-PATH" }, toolCallId: "tc-child" }, ctx);
	check((res as { block?: boolean } | undefined)?.block === true, "child: tool-scope rule must still block");
}

// Root sessions keep tool-scope enforcement.
{
	const { handlers, ctx } = await boot(engineFactory, { PI_SUBAGENT_CHILD: undefined });
	const h = handlers["tool_call"]?.[0];
	const res = await h({ toolName: "read", input: { path: "/tmp/FORBIDDEN-PATH" }, toolCallId: "tc-root" }, ctx);
	check((res as { block?: boolean } | undefined)?.block === true, "root: tool-scope rule must still block");
}

fs.rmSync(root, { recursive: true, force: true });
if (fail) {
	say(`CHILD-POLICY TESTS: ${fail} failure(s)`);
	process.exit(1);
}
say("CHILD-POLICY TESTS OK");

/**
 * Persistent Subagents — named, steering-able, resumable child sessions.
 *
 * Unlike the one-shot `subagent` tool (spawn `pi --mode json -p --no-session`,
 * block until exit), children here run as `pi --mode rpc` processes with a
 * dedicated `--session-dir` per name:
 *
 *   - subagent_spawn { tasks | agent+task+name } → spawns concurrently and
 *     BLOCKS until the children settle, returning all results in the same call
 *     (wait:false returns handles immediately for mid-flight steering).
 *   - subagent_send  { name, message }     → steer a running child mid-flight
 *     (RPC `steer`), queue after its current run (`followUp`), or start a new
 *     turn on an idle child. A stopped child is resumed from its session file
 *     on disk (`--continue`) with full retained context — no re-read from
 *     scratch.
 *   - subagent_wait  { name }              → block until the current run
 *     settles and return the final assistant output. Waiting on an aborted
 *     child auto-resumes it.
 *   - subagent_list                       → registry + live status.
 *
 * Persistence: each child's session JSONL lives under
 * `~/.pi/agent/subagents/<hash-of-root-session>/sessions/<name>/`, so children
 * survive parent restarts and idle unload. The registry is scoped to the root
 * session (the "nuclear family"): different root sessions get different dirs
 * and cannot see or message each other's children.
 *
 * Idle children are unloaded (SIGTERM) after 30 minutes of inactivity and
 * transparently reloaded from disk on the next send. Live processes are
 * killed on `session_shutdown`.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	formatOutputSchemaPrompt,
} from "../subagent/agents.ts";
import { resolveModelRole } from "../../utils/model-role.ts";
import { getPiInvocation } from "../subagent/index.ts";
import {
	renderCall as renderSubagentCall,
	renderResult as renderSubagentResult,
	agentTypeBadge,
	type RenderSingleResult,
	type RenderSubagentDetails,
	type TaskParamsLike,
} from "../subagent/render.ts";
import { SYMBOLS, styledSymbol, type ThemeLike } from "../subagent/symbols.ts";
import { CIRCLE_SPINNER_FRAMES, formatCircleStatusIcon, previewLine } from "../subagent/render-utils.ts";
import { framedBlock, renderStatusLine, type FramedBlockComponent, type State } from "../subagent/tui.ts";
import { Text } from "@earendil-works/pi-tui";

const REGISTRY_ROOT = path.join(getAgentDir(), "subagents");
const IDLE_UNLOAD_MS = 30 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;
const ADMISSION_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_PARALLEL_TASKS = 8;

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface RpcUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

interface RpcMessage {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	usage?: RpcUsage;
	stopReason?: string;
}

interface RegistryEntry {
	name: string;
	agent: string;
	sessionDir: string;
	spawnedAt: number;
	lastActiveAt: number;
	model?: string;
	modelRole?: string;
}

interface Waiter {
	resolve: (result: WaitResult) => void;
	reject: (err: Error) => void;
	timer?: NodeJS.Timeout;
}

interface WaitResult {
	output: string;
	usage: UsageStats;
	note?: string;
}

interface PendingRun {
	waiters: Waiter[];
	finalText?: string;
	usage: UsageStats;
}

interface Ack {
	ok: (data: unknown) => void;
	fail: (err: string) => void;
}

/** pi's tool-update callback shape, narrowed to our details type. */
type UpdateSink = (partial: AgentToolResult<RenderSubagentDetails>) => void;

/** Compact admission receipt: who was spawned, nothing else. Output belongs
 *  in the subagent_wait result frame, not repeated here. Bullets show live
 *  child status (spinner → ✔/✘) via receiptChildren; the details themselves
 *  stay JSON-serializable for session persistence. */
interface SpawnReceiptDetails {
	kind: "spawn-receipt";
	children: Array<{ name: string; agent: string; brief: string; sessionDir: string; pid?: number }>;
}

const receiptChildren = new WeakMap<SpawnReceiptDetails, LiveChild[]>();

/** One-line ack for fire-and-forget sends. */
interface SendAckDetails {
	kind: "send-ack";
	name: string;
	behavior: string;
	streaming: boolean;
}

/** Compact status board for subagent_list: one line per child, no outputs. */
interface RosterEntry {
	name: string;
	agent: string;
	status: "running" | "idle" | "stopped";
	idleMs: number;
	model?: string;
	modelRole?: string;
	costUsd: number;
}

interface RosterDetails {
	kind: "roster";
	entries: RosterEntry[];
}

type PersistentDetails = RenderSubagentDetails | SpawnReceiptDetails | SendAckDetails | RosterDetails;

function isReceipt(details: PersistentDetails | undefined): details is SpawnReceiptDetails | SendAckDetails | RosterDetails {
	return typeof details === "object" && details !== null && "kind" in details;
}

interface LiveChild {
	proc: ChildProcessWithoutNullStreams;
	scopeKey: string;
	entry: RegistryEntry;
	streaming: boolean;
	currentRun: PendingRun | null;
	lastOutput: string;
	stdoutBuf: string;
	stderrTail: string;
	acks: Map<string, Ack>;
	exited: boolean;
	/** Increments per run; used to deliver full output only once per run. */
	runSeq: number;
	deliveredRunSeq: number;
	/** Set once the parent has collected this child's result via subagent_wait
	 *  (or an equivalent blocking wait). */
	collected: boolean;
	/** Mutable render view shared with the TUI renderer; mutated by event handlers. */
	view: RenderSingleResult;
	/** Set while a tool call is in-flight to push live partial results. */
	onUpdate?: () => void;
}

interface SpawnOptions {
	scopeKey: string;
	cwd: string;
	agent: AgentConfig;
	name: string;
	toolsOverride?: string[];
	modelOverride?: string;
	resume: boolean;
}

const live = new Map<string, LiveChild>();
const scopeHashCache = new Map<string, string>();
let nextCmdId = 0;
let reaperTimer: NodeJS.Timeout | undefined;

function hashScope(scopeKey: string): string {
	const cached = scopeHashCache.get(scopeKey);
	if (cached) return cached;
	const hash = crypto.createHash("sha256").update(scopeKey).digest("hex").slice(0, 16);
	scopeHashCache.set(scopeKey, hash);
	return hash;
}

function scopeDir(scopeKey: string): string {
	return path.join(REGISTRY_ROOT, hashScope(scopeKey));
}

function registryPath(scopeKey: string): string {
	return path.join(scopeDir(scopeKey), "registry.json");
}

function childKey(scopeKey: string, name: string): string {
	return `${hashScope(scopeKey)}::${name}`;
}

function readRegistry(scopeKey: string): RegistryEntry[] {
	try {
		const raw = JSON.parse(fs.readFileSync(registryPath(scopeKey), "utf-8"));
		return Array.isArray(raw) ? raw : [];
	} catch {
		return [];
	}
}

function writeRegistry(scopeKey: string, entries: RegistryEntry[]): void {
	fs.mkdirSync(scopeDir(scopeKey), { recursive: true });
	const tmp = `${registryPath(scopeKey)}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
	fs.renameSync(tmp, registryPath(scopeKey));
}

function upsertEntry(scopeKey: string, entry: RegistryEntry): void {
	const entries = readRegistry(scopeKey).filter((e) => e.name !== entry.name);
	entries.push(entry);
	writeRegistry(scopeKey, entries);
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function isRpcMessage(v: unknown): v is RpcMessage {
	return typeof v === "object" && v !== null && "role" in v;
}

function finalTextOf(msg: RpcMessage): string | undefined {
	if (!Array.isArray(msg.content)) return undefined;
	for (let i = msg.content.length - 1; i >= 0; i--) {
		const part = msg.content[i];
		if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) return part.text;
	}
	return undefined;
}

function sendCommand(child: LiveChild, cmd: Record<string, unknown>): void {
	child.proc.stdin.write(JSON.stringify(cmd) + "\n");
}

function touch(child: LiveChild): void {
	child.entry.lastActiveAt = Date.now();
	upsertEntry(child.scopeKey, child.entry);
}

function beginRun(child: LiveChild): PendingRun {
	if (!child.currentRun) child.currentRun = { waiters: [], usage: emptyUsage() };
	// Reset the run-scoped render fields; messages stay cumulative so the
	// activity scan (current tool, recent tools) spans the child's whole life.
	child.runSeq++;
	child.view.exitCode = -1;
	child.view.aborted = false;
	child.view.stopReason = undefined;
	child.view.endMs = undefined;
	child.view.error = undefined;
	child.view.description = undefined;
	child.view.startMs = Date.now();
	child.view.usage = { ...emptyUsage(), contextTokens: 0 };
	return child.currentRun;
}

function finalizeViewSuccess(child: LiveChild): void {
	child.view.exitCode = 0;
	if (child.view.aborted) child.view.stopReason = "aborted";
	child.view.endMs = Date.now();
	if (child.view.description === undefined && child.lastOutput) {
		child.view.description = child.lastOutput.split("\n").map((l) => l.trim()).find(Boolean);
	}
}

function finalizeViewCrash(child: LiveChild, code: number | null | undefined): void {
	child.view.exitCode = code ?? 1;
	child.view.endMs = Date.now();
	child.view.error = child.stderrTail || `process exited (code ${code ?? "?"})`;
}

function settleRun(child: LiveChild): void {
	child.streaming = false;
	touch(child);
	const run = child.currentRun;
	if (!run) return;
	child.currentRun = null;
	if (run.finalText) child.lastOutput = run.finalText;
	finalizeViewSuccess(child);
	for (const w of run.waiters.splice(0)) {
		clearTimeout(w.timer);
		w.resolve({ output: run.finalText ?? "(no assistant output)", usage: run.usage });
	}
	child.onUpdate?.();
}

function failRun(child: LiveChild, reason: string): void {
	const run = child.currentRun;
	child.currentRun = null;
	if (!run) return;
	for (const w of run.waiters.splice(0)) {
		clearTimeout(w.timer);
		w.reject(new Error(`subagent "${child.entry.name}": ${reason}`));
	}
}

function failAcks(child: LiveChild, reason: string): void {
	for (const ack of child.acks.values()) ack.fail(reason);
	child.acks.clear();
}

function killChild(child: LiveChild, graceful: boolean): void {
	if (child.exited) return;
	child.proc.kill("SIGTERM");
	if (!graceful) return;
	setTimeout(() => {
		if (!child.exited) child.proc.kill("SIGKILL");
	}, 3000);
}

function handleChildLine(child: LiveChild, line: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	let obj: unknown;
	try {
		obj = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (typeof obj !== "object" || obj === null) return;
	const rec = obj as Record<string, unknown>;

	if (rec.type === "response") {
		const id = typeof rec.id === "string" ? rec.id : undefined;
		if (!id) return;
		const ack = child.acks.get(id);
		if (!ack) return;
		child.acks.delete(id);
		if (rec.success === false) {
			ack.fail(typeof rec.error === "string" ? rec.error : JSON.stringify(rec.error ?? "command rejected"));
		} else {
			ack.ok(rec.data);
		}
		return;
	}

	if (rec.type === "agent_start") {
		child.streaming = true;
		return;
	}

	if (rec.type === "message_end" && isRpcMessage(rec.message)) {

		const msg = rec.message;
		child.view.messages.push(msg as unknown as Message);
		if (msg.role === "assistant") {
			const run = child.currentRun;
			if (run) {
				run.usage.turns++;
				run.usage.input += msg.usage?.input ?? 0;
				run.usage.output += msg.usage?.output ?? 0;
				run.usage.cacheRead += msg.usage?.cacheRead ?? 0;
				run.usage.cacheWrite += msg.usage?.cacheWrite ?? 0;
				run.usage.cost += msg.usage?.cost?.total ?? 0;
				const text = finalTextOf(msg);
				if (msg.stopReason === "aborted") child.view.aborted = true;
				if (text) {
					run.finalText = text;
					child.view.description = text.split("\n").map((l) => l.trim()).find(Boolean);
				}
				child.view.usage = { ...run.usage, contextTokens: msg.usage?.totalTokens ?? child.view.usage.contextTokens };
			}
		}
		child.onUpdate?.();
		return;
	}

	if (rec.type === "agent_settled") {
		settleRun(child);
		return;
	}
}

function wireChild(child: LiveChild): void {
	child.proc.stdout.on("data", (data: string) => {
		child.stdoutBuf += data;
		const lines = child.stdoutBuf.split("\n");
		child.stdoutBuf = lines.pop() ?? "";
		for (const line of lines) handleChildLine(child, line);
	});
	child.proc.stderr.on("data", (data: string) => {
		child.stderrTail = (child.stderrTail + data).slice(-4000);
	});
	child.proc.on("error", (err) => {
		child.exited = true;
		live.delete(childKey(child.scopeKey, child.entry.name));
		failAcks(child, `process error: ${err.message}`);
		failRun(child, `process error: ${err.message}`);
	});
	child.proc.on("close", (code) => {
		child.exited = true;
		live.delete(childKey(child.scopeKey, child.entry.name));
		if (child.stdoutBuf.trim()) handleChildLine(child, child.stdoutBuf);
		child.stdoutBuf = "";
		const crashed = child.currentRun !== null;
		failAcks(child, `process exited (code ${code ?? "?"})`);
		if (crashed) {
			finalizeViewCrash(child, code);
			child.onUpdate?.();
			failRun(child, `process exited before settling (code ${code ?? "?"}). stderr: ${child.stderrTail || "(none)"}`);
		}
		child.onUpdate = undefined;
	});
}

function startChild(opts: SpawnOptions): LiveChild {
	const sessionDir = path.join(scopeDir(opts.scopeKey), "sessions", opts.name);
	if (opts.resume) {
		const hasSession = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
		if (!hasSession) throw new Error(`no saved session for "${opts.name}" in ${sessionDir}`);
	} else {
		fs.rmSync(sessionDir, { recursive: true, force: true });
		fs.mkdirSync(sessionDir, { recursive: true });
	}

	const { resolvedModel, role } = resolveModelRole(opts.modelOverride || opts.agent.model);
	const args: string[] = ["--mode", "rpc", "--session-dir", sessionDir, "--name", opts.name];
	if (opts.resume) args.push("--continue");
	if (resolvedModel) args.push("--model", resolvedModel);
	if (!opts.resume && opts.agent.thinking) args.push("--thinking", opts.agent.thinking);
	const effectiveTools = opts.toolsOverride && opts.toolsOverride.length > 0 ? opts.toolsOverride : opts.agent.tools;
	if (effectiveTools && effectiveTools.length > 0) args.push("--tools", effectiveTools.join(","));

	if (!opts.resume && opts.agent.systemPrompt.trim()) {
		let systemPrompt = opts.agent.systemPrompt.trim();
		if (opts.agent.output) systemPrompt += formatOutputSchemaPrompt(opts.agent.output);
		const promptFile = path.join(sessionDir, ".system-prompt.md");
		fs.writeFileSync(promptFile, systemPrompt, { mode: 0o600 });
		args.push("--append-system-prompt", promptFile);
	}

	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd: opts.cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, CMUX_PI_HOOKS_DISABLED: "1" },
	}) as ChildProcessWithoutNullStreams;

	const entry: RegistryEntry = {
		name: opts.name,
		agent: opts.agent.name,
		sessionDir,
		spawnedAt: Date.now(),
		lastActiveAt: Date.now(),
		model: resolvedModel,
		modelRole: role,
	};
	const view: RenderSingleResult = {
		agent: opts.agent.name,
		agentSource: opts.agent.source,
		task: "",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resolvedModel,
		modelRole: role,
		id: opts.name,
		index: 0,
		startMs: Date.now(),
	};
	const child: LiveChild = {
		proc,
		scopeKey: opts.scopeKey,
		entry,
		streaming: false,
		currentRun: null,
		lastOutput: "",
		stdoutBuf: "",
		stderrTail: "",
		acks: new Map(),
		exited: false,
		runSeq: 0,
		deliveredRunSeq: -1,
		collected: false,
		view,
	};
	live.set(childKey(opts.scopeKey, opts.name), child);
	wireChild(child);
	upsertEntry(opts.scopeKey, entry);
	return child;
}

function sendCommandAwaitAck(child: LiveChild, cmd: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
	const id = `cmd-${nextCmdId++}`;
	return new Promise<unknown>((resolve, reject) => {
		const ack: Ack = {
			ok: (data) => {
				clearTimeout(timer);
				resolve(data);
			},
			fail: (err) => {
				clearTimeout(timer);
				reject(new Error(`subagent "${child.entry.name}": ${String(cmd.type)} rejected: ${err}`));
			},
		};
		const timer = setTimeout(() => {
			child.acks.delete(id);
			reject(new Error(`subagent "${child.entry.name}": no ack for ${String(cmd.type)} within ${timeoutMs}ms`));
		}, timeoutMs);
		child.acks.set(id, ack);
		try {
			sendCommand(child, { ...cmd, id });
		} catch (e) {
			clearTimeout(timer);
			child.acks.delete(id);
			reject(e instanceof Error ? e : new Error(String(e)));
		}
	});
}

function awaitRun(child: LiveChild, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
	if (!child.currentRun && !child.streaming) {
		return Promise.resolve({
			output: child.lastOutput || "(no output yet)",
			usage: emptyUsage(),
			note: "child is idle; showing last settled output",
		});
	}
	const run = child.currentRun ?? beginRun(child);
	return new Promise<WaitResult>((resolve, reject) => {
		const waiter: Waiter = { resolve, reject };
		const remove = () => {
			const i = run.waiters.indexOf(waiter);
			if (i >= 0) run.waiters.splice(i, 1);
		};
		if (timeoutMs > 0) {
			waiter.timer = setTimeout(() => {
				remove();
				reject(new Error(`timed out after ${timeoutMs}ms waiting for "${child.entry.name}" (run still in flight)`));
			}, timeoutMs);
		}
		if (signal) {
			if (signal.aborted) {
				remove();
				reject(new Error("wait aborted"));
				return;
			}
			signal.addEventListener(
				"abort",
				() => {
					remove();
					reject(new Error("wait aborted"));
				},
				{ once: true },
			);
		}
		run.waiters.push(waiter);
	});
}

function readLastAssistantOutput(sessionDir: string): string | undefined {
	try {
		const files = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => ({ f, m: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
			.sort((a, b) => b.m - a.m);
		if (files.length === 0) return undefined;
		const content = fs.readFileSync(path.join(sessionDir, files[0].f), "utf-8");
		let last: string | undefined;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				const msg = (entry.message ?? entry) as unknown;
				if (isRpcMessage(msg) && msg.role === "assistant") {
					const text = finalTextOf(msg);
					if (text) last = text;
				}
			} catch {
				continue;
			}
		}
		return last;
	} catch {
		return undefined;
	}
}

function ensureReaper(): void {
	if (reaperTimer) return;
	reaperTimer = setInterval(() => {
		const now = Date.now();
		for (const child of live.values()) {
			if (!child.streaming && now - child.entry.lastActiveAt > IDLE_UNLOAD_MS) {
				killChild(child, true);
			}
		}
	}, REAP_INTERVAL_MS);
	reaperTimer.unref();
}

function fmtAge(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.round(ms / 3_600_000)}h`;
}

function statusOf(child: LiveChild | undefined): "running" | "idle" | "stopped" {
	if (!child) return "stopped";
	return child.streaming ? "running" : "idle";
}

function emptyDetails(): RenderSubagentDetails {
	return { mode: "single", agentScope: "user", projectAgentsDir: null, results: [], totalDurationMs: 0 };
}

function childDetails(child: LiveChild): RenderSubagentDetails {
	return {
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		results: [child.view],
		totalDurationMs: Math.max(0, (child.view.endMs ?? Date.now()) - child.view.startMs),
	};
}

function watchChild(child: LiveChild, onUpdate?: UpdateSink): void {
	child.onUpdate = onUpdate
		? () => onUpdate({ content: [{ type: "text", text: child.view.description ?? "(running…)" }], details: childDetails(child) })
		: undefined;
}

const RECEIPT_HINT = "collect → subagent_wait · steering → subagent_send";

const CONTINUATION_PROMPT =
	"You were interrupted mid-task. Continue from exactly where you left off and complete the task.";

/** Full output is loaded into the parent context at most once per run. Repeat
 *  requests for the same run get a one-line pointer instead. An aborted run
 *  with no output is never marked delivered — subagent_wait auto-resumes it. */
function deliverResult(child: LiveChild, result: WaitResult): string {
	const output = result.output ?? "";
	if (child.view.aborted && !output.trim()) {
		return "The run was aborted before producing any output. Waiting again resumes it automatically.";
	}
	if (!output.trim()) {
		return "The run finished without producing any output.";
	}
	if (child.deliveredRunSeq === child.runSeq) {
		const first = output.split("\n").map((l) => l.trim()).find(Boolean) ?? "(no output)";
		return `${first}\n(full output for this run was already delivered above — do not re-request it)`;
	}
	child.deliveredRunSeq = child.runSeq;
	return output;
}

function renderSpawnReceipt(details: SpawnReceiptDetails, theme: ThemeLike): FramedBlockComponent {
	const count = details.children.length;
	const header = renderStatusLine(
		{ iconOverride: styledSymbol("⇶", "accent", theme), title: "Spawn", meta: [`${count} ${count === 1 ? "agent" : "agents"}`] },
		theme,
	);
	return framedBlock(theme, (width) => {
		const live = receiptChildren.get(details);
		const spinnerFrame = Math.floor(Date.now() / 80) % CIRCLE_SPINNER_FRAMES.length;
		const bullet = theme.fg("dim", SYMBOLS.format.bullet);
		const lines = details.children.map((c) => {
			const child = live?.find((l) => l.entry.name === c.name);
			let icon = bullet;
			let errorSuffix = "";
			if (child) {
				const failed = child.view.exitCode !== -1 && (child.view.exitCode !== 0 || !!child.view.error);
				const done = child.view.exitCode !== -1 && !failed;
				if (child.view.aborted) {
					// Aborted: filled square in error red — neither done nor failed.
					icon = `${theme.fg("error", "▪")} `;
				} else if (failed) {
					icon = formatCircleStatusIcon("failed", theme);
					errorSuffix = ` ${theme.fg("error", previewLine(child.view.error ?? "failed", 40))}`;
				} else if (done) {
					icon = formatCircleStatusIcon("completed", theme);
				} else {
					icon = formatCircleStatusIcon("running", theme, spinnerFrame);
				}
			}
			let line = `${icon}${theme.fg("accent", theme.bold(c.name))}`;
			if (c.brief) line += `${theme.fg("accent", ":")} ${theme.fg("muted", previewLine(c.brief, 56))}`;
			line += agentTypeBadge(c.agent, theme);
			line += errorSuffix;
			return line;
		});
		lines.push(theme.fg("dim", RECEIPT_HINT));
		return { header, sections: [{ separator: true, lines }], state: "success" as State, borderColor: "borderMuted" as const, width };
	});
}

function renderSendAck(details: SendAckDetails, theme: ThemeLike): FramedBlockComponent {
	const header = renderStatusLine(
		{ iconOverride: styledSymbol("⇶", "accent", theme), title: "Send", description: details.name },
		theme,
	);
	return framedBlock(theme, (width) => {
		const suffix = details.streaming ? " — child still running, collect with subagent_wait" : "";
		const line = `${theme.fg("dim", SYMBOLS.format.bullet)} ${theme.fg("dim", `delivered (${details.behavior})${suffix}`)}`;
		return { header, sections: [{ separator: true, lines: [line] }], state: "success" as State, borderColor: "borderMuted" as const, width };
	});
}

function renderRoster(details: RosterDetails, theme: ThemeLike): FramedBlockComponent {
	const header = renderStatusLine(
		{ iconOverride: styledSymbol(SYMBOLS.status.done, "accent", theme), title: "Subagents", meta: [`${details.entries.length} agents`] },
		theme,
	);
	return framedBlock(theme, (width) => {
		const lines = details.entries.map((e) => {
			const icon = e.status === "running" ? formatCircleStatusIcon("running", theme) : formatCircleStatusIcon("pending", theme);
			let line = `${icon}${theme.fg("text", theme.bold(e.name))}${agentTypeBadge(e.agent, theme)}`;
			line += `${SYMBOLS.sep.dot}${theme.fg(e.status === "running" ? "accent" : "dim", e.status === "stopped" ? "stopped · resumable" : e.status)}`;
			line += `${SYMBOLS.sep.dot}${theme.fg("dim", `idle ${fmtAge(e.idleMs)}`)}`;
			const model = e.model ?? e.modelRole;
			if (model) line += `${SYMBOLS.sep.dot}${theme.fg("dim", model)}`;
			if (e.costUsd > 0) line += `${SYMBOLS.sep.dot}${theme.fg("dim", `$${e.costUsd.toFixed(e.costUsd < 0.01 ? 4 : 2)}`)}`;
			return line;
		});
		return { header, sections: [{ separator: true, lines }], state: "success" as State, borderColor: "borderMuted" as const, width };
	});
}

function renderPersistentResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	options: { expanded: boolean; isPartial: boolean },
	theme: ThemeLike,
	args?: TaskParamsLike,
): FramedBlockComponent {
	const details = result.details as PersistentDetails | undefined;
	if (isReceipt(details)) {
		if (details.kind === "spawn-receipt") return renderSpawnReceipt(details, theme);
		if (details.kind === "send-ack") return renderSendAck(details, theme);
		return renderRoster(details, theme);
	}
	return renderSubagentResult(
		{ content: result.content, details: result.details as RenderSubagentDetails | undefined },
		options,
		theme,
		args,
	);
}

const ToolsParam = Type.Optional(
	Type.Array(Type.String(), {
		minItems: 1,
		description:
			"Optional tool allowlist for this invocation, overriding the agent definition's `tools` frontmatter. Omit to use the agent's declared tools.",
	}),
);

const AgentScopeSchema = Type.Optional(
	Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
		description: 'Which agent directories to use. Default: "user".',
		default: "user",
	}),
);

const BehaviorSchema = Type.Optional(
	Type.Union([Type.Literal("auto"), Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("prompt")], {
		description:
			'How to deliver the message: "auto" (default) steers if the child is mid-run, otherwise starts a new turn; "steer" delivers between tool calls of the current run; "followUp" queues until the current run finishes; "prompt" forces a new turn.',
		default: "auto",
	}),
);

export default function (pi: ExtensionAPI) {
	ensureReaper();

	const resolveScopeKey = (ctx: { sessionManager: { getSessionFile(): string | undefined; getSessionId(): string } }): string => {
		const file = ctx.sessionManager.getSessionFile();
		if (file) return `file:${file}`;
		return `id:${ctx.sessionManager.getSessionId()}`;
	};

	const findAgent = (ctx: { cwd: string }, agentName: string, agentScope: AgentScope): AgentConfig | undefined =>
		discoverAgents(ctx.cwd, agentScope).agents.find((a) => a.name === agentName);

	pi.registerTool({
		name: "subagent_spawn",
		label: "Subagent Spawn",
		description:
			"Spawn NAMED persistent subagents (optionally a `tasks` batch that runs concurrently) and BLOCK until they " +
			"settle — results come back in this call, so there is nothing to collect afterwards. Children run as long-lived " +
			"`pi --mode rpc` processes with persistent sessions scoped to this root session, so they can be steered mid-flight " +
			"(subagent_send) or given follow-up turns later in their retained sessions. " +
			"Set wait:false to return handles immediately without results (advanced: mid-flight steering pattern) — then " +
			"collect with subagent_wait. " +
			"ONLY use this when children must outlive a single call: long-running tasks you will poll or steer, or iterative " +
			"work with follow-up turns (e.g. parallel researchers, a writer a verifier sends fix requests to). " +
			"If the parent aborts, the children stop gracefully (sessions retained) - waiting on them again resumes them automatically. " +
			"For one-shot, parallel-batch, or chain delegation that just returns a result, use the plain `subagent` tool instead.",
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Name of the agent definition to invoke (single form)" })),
			task: Type.Optional(Type.String({ description: "Initial task for the agent (single form)" })),
			name: Type.Optional(
				Type.String({
					description: "Persistent handle name for this child (single form). Pattern: [a-zA-Z0-9][a-zA-Z0-9_-]*",
				}),
			),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						agent: Type.String({ description: "Name of the agent definition to invoke" }),
						task: Type.String({ description: "Initial task for this child" }),
						name: Type.String({ description: "Persistent handle name for this child" }),
						cwd: Type.Optional(Type.String({ description: "Working directory for this child" })),
						tools: ToolsParam,
						model: Type.Optional(Type.String({ description: "Optional model ID or role alias (@smol, @slow, @task, @plan)" })),
						wait: Type.Optional(
							Type.Boolean({
								description: "Block until this child settles and include its result. Default: true.",
								default: true,
							}),
						),
					}),
					{
						description:
							"Batch: spawn several persistent subagents concurrently in ONE call. Prefer this over multiple separate spawn calls.",
					},
				),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single form)" })),
			tools: ToolsParam,
			model: Type.Optional(Type.String({ description: "Optional model ID or role alias (@smol, @slow, @task, @plan)" })),
			wait: Type.Optional(
				Type.Boolean({
					description:
						"Block until every child settles and return all results in this call (default). Set false to return handles immediately for mid-flight steering — collect later with subagent_wait.",
					default: true,
				}),
			),
			agentScope: AgentScopeSchema,
		}),
		renderShell: "self",

		renderCall(args, theme, context) {
			return renderSubagentCall(args, { argsComplete: context.argsComplete, executionStarted: context.executionStarted }, theme);
		},

		renderResult(result, options, theme, context) {
			return renderPersistentResult(result, options, theme, context.args);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope = params.agentScope ?? "user";
			const hasSingle = Boolean(params.agent && params.task && params.name);
			const hasBatch = (params.tasks?.length ?? 0) > 0;
			if (hasSingle === hasBatch) {
				return { details: emptyDetails(), content: [{ type: "text", text: "Provide exactly one form: `tasks` (batch) or agent+task+name (single)." }] };
			}
			const specs = hasSingle
				? [{ agent: params.agent!, task: params.task!, name: params.name!, cwd: params.cwd, tools: params.tools, model: params.model, wait: params.wait }]
				: params.tasks!;
			if (specs.length > MAX_PARALLEL_TASKS) {
				return { details: emptyDetails(), content: [{ type: "text", text: `Too many tasks (${specs.length}). Max is ${MAX_PARALLEL_TASKS}.` }] };
			}

			const scopeKey = resolveScopeKey(ctx);
			const failures: string[] = [];
			for (const s of specs) {
				const name = s.name.trim();
				if (!NAME_PATTERN.test(name)) failures.push(`invalid name "${s.name}"`);
				else if (live.has(childKey(scopeKey, name))) failures.push(`"${name}" is already live`);
				else if (!findAgent(ctx, s.agent, agentScope)) {
					const available = discoverAgents(ctx.cwd, agentScope).agents.map((a) => a.name).join(", ") || "none";
					failures.push(`unknown agent "${s.agent}" (available: ${available})`);
				}
			}
			if (failures.length > 0) {
				return { details: emptyDetails(), content: [{ type: "text", text: `Cannot spawn: ${failures.join("; ")}.` }] };
			}

			const spawned: Array<{ child: LiveChild; task: string }> = [];
			const admissions = specs.map(async (s) => {
				const name = s.name.trim();
				const agent = findAgent(ctx, s.agent, agentScope)!;
				const child = startChild({
					scopeKey,
					cwd: s.cwd ?? ctx.cwd,
					agent,
					name,
					toolsOverride: s.tools,
					modelOverride: s.model,
					resume: false,
				});
				spawned.push({ child, task: s.task });
				child.view.task = s.task;
				beginRun(child);
				try {
					await sendCommandAwaitAck(child, { type: "prompt", message: s.task }, ADMISSION_ACK_TIMEOUT_MS);
				} catch (e) {
					killChild(child, false);
					throw new Error(`"${name}": ${e instanceof Error ? e.message : String(e)}\nstderr: ${child.stderrTail || "(none)"}`);
				}
				return child;
			});

			const results = await Promise.allSettled(admissions);
			const reasons = results
				.filter((r): r is PromiseRejectedResult => r.status === "rejected")
				.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
			if (reasons.length > 0) {
				for (const { child } of spawned) killChild(child, false);
				return { details: emptyDetails(), content: [{ type: "text", text: `Spawn failed: ${reasons.join("; ")}` }] };
			}
			// Wait phase (default): keep the tool call open until every waited
			// child settles — the turn cannot end before results exist. Children
			// run concurrently; live progress streams via onUpdate.
			const waiting = spawned.filter(({ child }, i) => specs[i].wait !== false && child.view.exitCode === -1);
			if (waiting.length > 0) {
				// Parent abort (esc) gracefully stops the children's current runs —
				// sessions stay retained; waiting on them again resumes them.
				const abortRuns = () => {
					for (const { child } of waiting) {
						if (!child.streaming) continue;
						child.view.aborted = true;
						sendCommand(child, { type: "abort" });
					}
				};
				if (signal) {
					if (signal.aborted) abortRuns();
					else signal.addEventListener("abort", abortRuns, { once: true });
				}
				// Partials carry ALL spawned children's views so the frame shows the
				// whole batch with per-row spinners (one-shot parallel-progress look),
				// not just whichever child emitted the last event.
				const allViews = (): RenderSubagentDetails => ({
					mode: "parallel",
					agentScope: "user",
					projectAgentsDir: null,
					results: spawned.map((s) => s.child.view),
					totalDurationMs: Math.max(0, Date.now() - Math.min(...spawned.map((s) => s.child.view.startMs))),
				});
				const doneCount = () => spawned.filter((s) => s.child.view.exitCode !== -1).length;
				for (const { child } of waiting) {
					child.onUpdate = onUpdate
						? () => onUpdate({ content: [{ type: "text", text: `${doneCount()}/${spawned.length} done` }], details: allViews() })
						: undefined;
				}
				// Emit one partial up front so the batch frame (all rows, spinners
				// running) is on screen immediately — no empty-frame flicker.
				onUpdate?.({ content: [{ type: "text", text: `0/${spawned.length} done` }], details: allViews() });
				try {
					const outcomes = await Promise.all(
						waiting.map(async ({ child }) => {
							try {
								const r = await awaitRun(child, 0, signal);
								return { child, output: r.output, error: undefined as string | undefined };
							} catch (e) {
								return { child, output: undefined as string | undefined, error: e instanceof Error ? e.message : String(e) };
							}
						}),
					);
					const failures = outcomes.filter((o) => o.error);
					if (failures.length === outcomes.length && outcomes.length > 0) {
						return {
							details: { mode: "parallel", agentScope: "user", projectAgentsDir: null, results: spawned.map((s) => s.child.view), totalDurationMs: 0 },
							content: [{ type: "text", text: `All spawned subagents failed:\n${failures.map((f) => `- ${f.child.entry.name}: ${f.error}`).join("\n")}` }],
						};
					}
					const summary = outcomes
						.map(({ child, output, error }) => {
							const first = (error ?? output ?? "(no output)").split("\n").map((l) => l.trim()).find(Boolean);
							return `- ${child.entry.name}: ${first}`;
						})
						.join("\n");
					const waitedLabel = outcomes.length === spawned.length ? `all ${outcomes.length}` : `${outcomes.length}/${spawned.length} waited`;
					return {
						details: {
							mode: "parallel",
							agentScope: "user",
							projectAgentsDir: null,
							results: spawned.map((s) => s.child.view),
							totalDurationMs: Math.max(0, Date.now() - Math.min(...spawned.map((s) => s.child.view.startMs))),
						},
						content: [{ type: "text", text: `${waitedLabel} persistent subagent(s) finished:\n${summary}\nHandles remain resumable: steer with subagent_send, follow up later.` }],
					};
				} finally {
					for (const { child } of waiting) child.onUpdate = undefined;
				}
			}

			const receipt: SpawnReceiptDetails = {
				kind: "spawn-receipt",
				children: spawned.map(({ child, task }) => ({
					name: child.entry.name,
					agent: child.entry.agent,
					brief: task.split("\n").map((l) => l.trim()).find(Boolean) ?? "",
					sessionDir: child.entry.sessionDir,
					pid: child.proc.pid,
				})),
			};
			receiptChildren.set(receipt, spawned.map((s) => s.child));
			const summary = spawned
				.map(({ child }) => `- ${child.entry.name} (pid ${child.proc.pid}) → ${child.entry.sessionDir}`)
				.join("\n");
			return {
				details: receipt,
				content: [{ type: "text", text: `Spawned ${spawned.length} persistent subagent(s); tasks admitted and running.\n${summary}\nCollect with subagent_wait / steer with subagent_send.` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Subagent Send",
		description:
			"Send a message to a named persistent subagent (spawned via subagent_spawn). If the child is mid-run the message " +
			"steers it (delivered between tool calls); if idle it starts a new turn in the same retained session. If the child's " +
			"process was unloaded (idle timeout, restart) it is transparently resumed from disk with full prior context. " +
			"Set wait=true to block until the child settles and get its final output (e.g. a verifier telling a warm writer " +
			"'fix findings #2 and #5' and getting the diff back). " +
			"If the user wants an interrupted/aborted child to finish its work (\"continue\", \"resume\", \"carry on\"), use " +
			"subagent_wait instead — it auto-resumes aborted children. Not this tool.",
		parameters: Type.Object({
			name: Type.String({ description: "Handle name of the subagent (from subagent_spawn)" }),
			message: Type.String({ description: "Message / follow-up instruction for the child" }),
			behavior: BehaviorSchema,
			wait: Type.Optional(
				Type.Boolean({
					description: "Block until the child settles and return its final output. Default: false (fire-and-forget).",
					default: false,
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description: `Timeout for wait in ms (default ${DEFAULT_WAIT_TIMEOUT_MS}; 0 = wait forever).`,
					default: DEFAULT_WAIT_TIMEOUT_MS,
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory used when resuming a stopped child" })),
		}),
		renderShell: "self",

		renderCall(args, theme, context) {
			// The message reads like the one-shot tool's task brief in the call preview.
			return renderSubagentCall({ ...args, task: args.message }, { argsComplete: context.argsComplete, executionStarted: context.executionStarted }, theme);
		},

		renderResult(result, options, theme, context) {
			return renderPersistentResult(result, options, theme, context.args);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const scopeKey = resolveScopeKey(ctx);
			const name = params.name.trim();
			let child = live.get(childKey(scopeKey, name));

			if (!child) {
				const entry = readRegistry(scopeKey).find((e) => e.name === name);
				if (!entry) {
					const names = readRegistry(scopeKey).map((e) => e.name).join(", ") || "none";
					return { details: emptyDetails(), content: [{ type: "text", text: `No subagent named "${name}" in this session. Known: ${names}.` }] };
				}
				const agent = findAgent(ctx, entry.agent, "both") ?? {
					name: entry.agent,
					description: "",
					systemPrompt: "",
					source: "user" as const,
					filePath: "",
				};
				try {
					child = startChild({
						scopeKey,
						cwd: params.cwd ?? ctx.cwd,
						agent,
						name,
						modelOverride: entry.model,
						resume: true,
					});
				} catch (e) {
					return { details: emptyDetails(), content: [{ type: "text", text: `Failed to resume "${name}": ${e instanceof Error ? e.message : String(e)}` }] };
				}
			}

			const streaming = child.streaming;
			const behavior = params.behavior ?? "auto";
			const effective: "steer" | "followUp" | "prompt" =
				behavior === "auto" ? (streaming ? "steer" : "prompt") : behavior;
			const cmdType = effective === "steer" ? "steer" : effective === "followUp" ? "follow_up" : "prompt";

			watchChild(child, onUpdate);
			try {
				beginRun(child);
				await sendCommandAwaitAck(child, { type: cmdType, message: params.message }, ADMISSION_ACK_TIMEOUT_MS);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { details: emptyDetails(), content: [{ type: "text", text: `Failed to deliver message to "${name}": ${msg}` }] };
			}

			if (params.wait) {
				try {
					const result = await awaitRun(child, params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, signal);
					child.collected = true;
					return {
						details: childDetails(child),
						content: [
							{
								type: "text",
								text: deliverResult(child, result),
							},
						],
					};
				} catch (e) {
					return { details: emptyDetails(), content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
				} finally {
					child.onUpdate = undefined;
				}
			}

			child.onUpdate = undefined;
			return {
				details: { kind: "send-ack", name, behavior: effective, streaming } as SendAckDetails,
				content: [
					{
						type: "text",
						text: `Delivered (${effective}) to "${name}". Status: ${streaming ? "steered mid-run" : "new turn started"}. Use subagent_wait to collect output.`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description:
			"Block until a named persistent subagent finishes its current run and return its final assistant output. " +
			"Needed after subagent_spawn with wait:false or after steering (subagent_send without wait). " +
			"If the child's last run was aborted before producing output, this automatically resumes it " +
			"(continues from where it stopped) and blocks until it finishes. If the child is idle, returns its last " +
			"settled output. If the child's process is gone, reads the last assistant message from its session file on disk.",
		parameters: Type.Object({
			name: Type.String({ description: "Handle name of the subagent (from subagent_spawn)" }),
			timeoutMs: Type.Optional(
				Type.Number({
					description: `Timeout in ms (default ${DEFAULT_WAIT_TIMEOUT_MS}; 0 = wait forever). On timeout the child keeps running.`,
					default: DEFAULT_WAIT_TIMEOUT_MS,
				}),
			),
		}),
		renderShell: "self",

		renderCall(args, theme, context) {
			return renderSubagentCall(args, { argsComplete: context.argsComplete, executionStarted: context.executionStarted }, theme);
		},

		renderResult(result, options, theme, context) {
			return renderPersistentResult(result, options, theme, context.args);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const scopeKey = resolveScopeKey(ctx);
			const name = params.name.trim();
			const child = live.get(childKey(scopeKey, name));

			if (child) {
				watchChild(child, onUpdate);
				try {
					if (child.view.aborted && !child.lastOutput.trim()) {
						// Aborted before producing output: auto-resume instead of
						// returning a hint — waiting on an interrupted child just
						// finishes the work.
						beginRun(child);
						await sendCommandAwaitAck(child, { type: "prompt", message: CONTINUATION_PROMPT }, ADMISSION_ACK_TIMEOUT_MS);
					}
					const result = await awaitRun(child, params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, signal);
					child.collected = true;
					return { details: childDetails(child), content: [{ type: "text", text: deliverResult(child, result) }] };
				} catch (e) {
					return { details: emptyDetails(), content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
				} finally {
					child.onUpdate = undefined;
				}
			}

			const entry = readRegistry(scopeKey).find((e) => e.name === name);
			if (!entry) {
				const names = readRegistry(scopeKey).map((e) => e.name).join(", ") || "none";
				return { details: emptyDetails(), content: [{ type: "text", text: `No subagent named "${name}" in this session. Known: ${names}.` }] };
			}
			const fromDisk = readLastAssistantOutput(entry.sessionDir);
			return {
				details: emptyDetails(),
				content: [
					{
						type: "text",
						text: fromDisk
							? `(child "${name}" is not running; last output read from its session file)\n\n${fromDisk}`
							: `Child "${name}" is not running and no output was found in ${entry.sessionDir}. Use subagent_send to resume it (waiting again also resumes aborted children).`
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description: "List persistent subagents for the current root session with live status (running/idle/stopped).",
		parameters: Type.Object({}),
		renderShell: "self",

		renderCall(args, theme, context) {
			return renderSubagentCall(args, { argsComplete: context.argsComplete, executionStarted: context.executionStarted }, theme);
		},

		renderResult(result, options, theme, context) {
			return renderPersistentResult(result, options, theme, context.args);
		},

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const scopeKey = resolveScopeKey(ctx);
			const entries = readRegistry(scopeKey);
			if (entries.length === 0) {
				return { details: emptyDetails(), content: [{ type: "text", text: "No persistent subagents in this session. Spawn one with subagent_spawn." }] };
			}
			const roster: RosterEntry[] = entries.map((e) => {
				const child = live.get(childKey(scopeKey, e.name));
				return {
					name: e.name,
					agent: e.agent,
					status: statusOf(child),
					idleMs: Math.max(0, Date.now() - e.lastActiveAt),
					model: e.model,
					modelRole: e.modelRole,
					costUsd: child?.view.usage.cost ?? 0,
				};
			});
			return {
				details: { kind: "roster", entries: roster } as RosterDetails,
				content: [{ type: "text", text: roster.map((e) => `${e.name}: ${e.status}`).join("\n") }],
			};
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const scopeKey = resolveScopeKey(ctx);
		for (const child of [...live.values()]) {
			if (child.scopeKey === scopeKey) killChild(child, true);
		}
	});


}

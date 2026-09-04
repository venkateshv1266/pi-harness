/**
 * Subagent Tool — Delegate tasks to specialized agents (hybrid Pi + Ralph engine).
 *
 * Spawns an isolated `pi --mode json` process per subagent invocation.
 *
 * Engine features:
 *   - Semantic model role resolution (@smol, @slow, @plan, @task, @designer) via settings.json / env
 *   - Per-agent output schema extraction & validation (JSON/JTD)
 *   - Optional process timeout watchdog (disabled by default; timeoutMs: 0 = infinite)
 *   - Dynamic per-call tool allowlists
 *   - Unified parallel task batching in a single widget
 *   - Sequential chain with {previous} placeholder
 *
 * TUI: omp-style framed block + tree rows, ported in `render.ts` and rendered
 * flush via `renderShell: "self"` (earendil's equivalent of omp's
 * `markFramedBlockComponent`).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	extractStructuredOutput,
	formatOutputSchemaPrompt,
	resolveModelRole,
} from "./agents.ts";
import {
	renderCall as renderCallImpl,
	renderResult as renderResultImpl,
	type RenderSingleResult,
	type RenderSubagentDetails,
} from "./render.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 0; // 0 = no wall-clock timeout
const PER_TASK_OUTPUT_CAP = 50 * 1024;

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult extends RenderSingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	modelRole?: string;
	stopReason?: string;
	errorMessage?: string;
	structuredData?: unknown;
	schemaError?: string;
	timedOut?: boolean;
	step?: number;
	id: string;
	index: number;
	startMs: number;
	endMs?: number;
	description?: string;
	aborted?: boolean;
	abortReason?: string;
	error?: string;
	truncated?: boolean;
}

interface SubagentDetails extends RenderSubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	totalDurationMs: number;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant") {
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const part = msg.content[j];
				if (part?.type === "text" && part.text.trim()) return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	if (!result || result.exitCode === -1) return false;
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		!!result.timedOut
	);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	// Only treat argv[1] as a JS entrypoint if it really is one. A launcher may
	// run `node /path/to/pi` where `pi` is a shell wrapper (e.g. the
	// fix-pi-zstd-node-crash zsh shim) rather than cli.js; feeding that to node
	// as a script fails with a SyntaxError on the wrapper's comments. In that
	// case fall through to the `pi` PATH lookup, whose shebang re-execs node
	// against the real cli.js.
	const isJsEntry =
		!!currentScript &&
		!isBunVirtualScript &&
		fs.existsSync(currentScript) &&
		/\.(?:m|c)?js$/i.test(currentScript);
	if (isJsEntry) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function makeAgentId(agent: string, index: number, duplicateCount: number): string {
	return duplicateCount > 1 ? `${agent}-${index + 1}` : agent;
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	id: string,
	index: number,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	toolsOverride?: string[],
	modelOverride?: string,
	timeoutOverride?: number,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	const startMs = Date.now();

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		const res: SingleResult = {
			agent: agentName, agentSource: "unknown", task, exitCode: 1, messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			id, index, startMs, endMs: startMs, step,
			error: `Unknown agent: "${agentName}". Available agents: ${available}.`,
		};
		return res;
	}

	const { resolvedModel, role } = resolveModelRole(modelOverride || agent.model);
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (resolvedModel) args.push("--model", resolvedModel);
	if (agent.thinking) args.push("--thinking", agent.thinking);

	const effectiveTools = toolsOverride && toolsOverride.length > 0 ? toolsOverride : agent.tools;
	if (effectiveTools && effectiveTools.length > 0) args.push("--tools", effectiveTools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let timeoutTimer: NodeJS.Timeout | undefined;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resolvedModel,
		modelRole: role,
		id,
		index,
		startMs,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		let systemPrompt = agent.systemPrompt.trim();
		if (agent.output) systemPrompt += formatOutputSchemaPrompt(agent.output);

		if (systemPrompt) {
			const tmp = await writePromptToTempFile(agent.name, systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		const effectiveTimeout = timeoutOverride ?? agent.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const childEnv = { ...process.env, CMUX_PI_HOOKS_DISABLED: "1" };
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});
			let buffer = "";

			if (effectiveTimeout > 0) {
				timeoutTimer = setTimeout(() => {
					currentResult.timedOut = true;
					currentResult.stopReason = "aborted";
					currentResult.aborted = true;
					currentResult.abortReason = `Subagent timed out after ${effectiveTimeout}ms`;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 3000);
				}, effectiveTimeout);
			}

			const stashNestedResults = (toolCallId: string, results: unknown[]) => {
				currentResult.nestedResults = [
					...(currentResult.nestedResults ?? []).filter((n) => n.toolCallId !== toolCallId),
					{ toolCallId, results },
				];
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "toolResult" && msg.toolName === "subagent" && Array.isArray(msg.details?.results)) {
						stashNestedResults(msg.toolCallId, msg.details.results);
					}

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = (msg as any).usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && (msg as any).model) currentResult.model = (msg as any).model;
						if ((msg as any).stopReason) currentResult.stopReason = (msg as any).stopReason;
						if ((msg as any).errorMessage) currentResult.errorMessage = (msg as any).errorMessage;
					}
					emitUpdate();
				}

				// Live + final `details` of nested subagent calls, for the parent widget's nested rows.
				if ((event.type === "tool_execution_update" || event.type === "tool_execution_end") && event.toolName === "subagent") {
					const payload = event.type === "tool_execution_update" ? event.partialResult : event.result;
					const nested = payload?.details?.results;
					if (Array.isArray(nested)) {
						stashNestedResults(event.toolCallId, nested);
						emitUpdate();
					}
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				clearTimeout(timeoutTimer);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				clearTimeout(timeoutTimer);
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					clearTimeout(timeoutTimer);
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.endMs = Date.now();

		// Derive display fields for the renderer.
		const finalText = getFinalOutput(currentResult.messages);
		const firstLine = finalText.split("\n").map((l) => l.trim()).find(Boolean);
		if (firstLine) currentResult.description = firstLine;

		if (wasAborted) {
			currentResult.aborted = true;
			currentResult.abortReason = currentResult.abortReason ?? "Subagent was aborted";
			currentResult.stopReason = "aborted";
		}
		if (isFailedResult(currentResult) && !currentResult.error) {
			currentResult.error = currentResult.errorMessage || currentResult.stderr || currentResult.abortReason || undefined;
		}

		if (agent.output) {
			const structured = extractStructuredOutput(finalText);
			if (structured.data !== undefined) {
				currentResult.structuredData = structured.data;
			} else {
				currentResult.schemaError = structured.error;
			}
		}

		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		clearTimeout(timeoutTimer);
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const ToolsParam = Type.Optional(
	Type.Array(Type.String(), {
		minItems: 1,
		description:
			"Optional tool allowlist for this invocation, overriding the agent definition's `tools` frontmatter. Non-empty array of built-in/extension/custom tool names (e.g. ['read','grep','find','ls']). Omit to use the agent's declared tools.",
	}),
);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	tools: ToolsParam,
	model: Type.Optional(Type.String({ description: "Optional model ID or role alias (@smol, @slow, @task, @plan)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	tools: ToolsParam,
	model: Type.Optional(Type.String({ description: "Optional model ID or role alias (@smol, @slow, @task, @plan)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description:
				"Array of {agent, task} for parallel execution. ALWAYS use a single subagent call with this `tasks` array when running multiple tasks in parallel so they execute as a grouped batch.",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution with {previous} placeholder.",
		}),
	),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single task mode only)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single task mode only)" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	tools: ToolsParam,
	model: Type.Optional(Type.String({ description: "Optional model ID or role alias (@smol, @slow, @task, @plan)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds" })),
});

function computeTotalDurationMs(results: SingleResult[]): number {
	if (results.length === 0) return 0;
	let minStart = Infinity;
	let maxEnd = 0;
	for (const r of results) {
		if (r.startMs < minStart) minStart = r.startMs;
		const end = r.endMs ?? Date.now();
		if (end > maxEnd) maxEnd = end;
	}
	return Math.max(0, maxEnd - minStart);
}

export default function (pi: ExtensionAPI) {
	const regDiscovery = discoverAgents(process.cwd(), "both");
	const userRoster =
		regDiscovery.agents
			.filter((a) => a.source === "user")
			.map((a) => `${a.name}: ${a.description}`)
			.join("; ") || "none";
	const projectAgentsAtReg = regDiscovery.agents.filter((a) => a.source === "project");
	const projectRoster =
		projectAgentsAtReg.length > 0
			? projectAgentsAtReg.map((a) => `${a.name}: ${a.description}`).join("; ")
			: null;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Use this for one-shot delegation where you wait for the full result — including parallel batches and chains. " +
			"If the child must outlive a single call (long-running work you will poll or steer, iterative follow-up turns), " +
			"use subagent_spawn/subagent_send/subagent_result instead.",
			"MODES (choose exactly one):",
			"- PARALLEL: { tasks: [{ agent, task }, { agent, task }, ...] } — Spawns multiple subagents concurrently in a single grouped batch. ALWAYS use this shape instead of emitting multiple separate tool calls.",
			"- CHAIN: { chain: [{ agent, task }, { agent, task: '... {previous}' }] } — Sequential pipeline.",
			"- SINGLE: { agent, task } — Single standalone subagent.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
			`Available user-scope agents: ${userRoster}.`,
			...(projectRoster ? [`Project-scope agents (require agentScope: "both"): ${projectRoster}.`] : []),
		].join(" "),
		parameters: SubagentParams,
		// Render flush (no outer box/padding/bg) so the vendored framed block in
		// render.ts draws its own omp-style border. Earendil's equivalent of
		// omp's `markFramedBlockComponent`.
		renderShell: "self",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					totalDurationMs: computeTotalDurationMs(results),
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentDirs.join(", ") || "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						step.agent,
						i,
						signal,
						chainUpdate,
						makeDetails("chain"),
						step.tools,
						step.model,
						step.timeoutMs,
					);
					results.push(result);

					if (isFailedResult(result)) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = truncateOutput(getFinalOutput(result.messages));
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Disambiguate duplicate agent names with an index suffix (omp-style ids).
				const nameCounts = new Map<string, number>();
				for (const t of params.tasks) nameCounts.set(t.agent, (nameCounts.get(t.agent) ?? 0) + 1);

				const allResults: SingleResult[] = new Array(params.tasks.length);
				for (let i = 0; i < params.tasks.length; i++) {
					const t = params.tasks[i];
					allResults[i] = {
						agent: t.agent,
						agentSource: "unknown",
						task: t.task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						id: makeAgentId(t.agent, i, nameCounts.get(t.agent) ?? 1),
						index: i,
						startMs: Date.now(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: `Parallel batch: ${allResults.filter((r) => r.exitCode !== -1).length}/${allResults.length} done` }],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};
				emitParallelUpdate();

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						makeAgentId(t.agent, index, nameCounts.get(t.agent) ?? 1),
						index,
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0] as SingleResult;
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						t.tools,
						t.model,
						t.timeoutMs,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					params.agent,
					0,
					signal,
					onUpdate,
					makeDetails("single"),
					params.tools,
					params.model,
					params.timeoutMs,
				);
				if (isFailedResult(result)) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, context) {
			return renderCallImpl(args, { argsComplete: context.argsComplete, executionStarted: context.executionStarted }, theme);
		},

		renderResult(result, options, theme, context) {
			return renderResultImpl(
				{ content: result.content, details: result.details as RenderSubagentDetails | undefined },
				options,
				theme,
				context.args,
			);
		},
	});
}

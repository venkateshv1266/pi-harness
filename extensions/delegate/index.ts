/**
 * Delegate — the unified entry point for spawning subagents.
 *
 * One tool, two engines:
 *   - one-shot   → `executeSubagent`         (pi --mode json -p --no-session; child exits after)
 *   - persistent → `executePersistentSpawn`  (pi --mode rpc; retained, steerable, resumable)
 *
 * `mode: "auto"` (default) asks the Jev classifier whether the work will
 * plausibly be revisited — follow-up turns, steering, iteration — and routes
 * accordingly. Every decision is appended to
 * ~/.pi/agent/jev-decisions/subagent-router.jsonl for auditing.
 *
 * Raw spawn tools (`subagent`, `subagent_spawn`) are hidden from the model in
 * root sessions so this is the only spawn door. Children keep them (they carry
 * PI_SUBAGENT_CHILD=1) so nested fan-out still works, and DELEGATE_RAW_TOOLS=1
 * disables hiding entirely.
 */

import { Type, type Static } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../subagent/agents.ts";
import { executeSubagent, type SubagentExecContext } from "../subagent/index.ts";
import {
	executePersistentSpawn,
	isNameLive,
	renderPersistentResult,
	resolveScopeKey,
	type PersistentExecContext,
	type PersistentSpawnParams,
} from "../persistent-subagent/index.ts";
import { renderCall as renderSubagentCall, type RenderSubagentDetails } from "../subagent/render.ts";
import { CallBudget, jevCall } from "../jev-memory/src/jev/client.ts";
import { appendDecision, newId } from "../../utils/jev-outcomes.ts";

const ROUTER_LOG = "subagent-router.jsonl";
const RAW_SPAWN_TOOLS = ["subagent", "subagent_spawn"];
const MAX_PARALLEL_TASKS = 8;

const PERSIST_THRESHOLD = (() => {
	const raw = Number(process.env.DELEGATE_PERSIST_THRESHOLD ?? "0.7");
	return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.7;
})();

const CLASSIFY_TIMEOUT_MS = (() => {
	const raw = Number(process.env.DELEGATE_CLASSIFY_TIMEOUT_MS ?? "2500");
	return Number.isFinite(raw) ? Math.max(500, raw) : 2500;
})();

// The classifier prompt mirrors the persistent-subagent TTSR rule's verify
// question so the two layers agree on what "will be revisited" means.
const CLASSIFY_QUESTION = {
	persistent: {
		type: "noul" as const,
		instructions:
			"Does this delegation describe work that will very likely be followed by another turn in this session — a writer/verifier fix loop, iterative implementation, a long-running pass that may be steered or re-collected, or a task whose context must survive for follow-up — rather than self-contained single-consumption work: a one-time lookup or research, an independent parallel batch, a chain step, or a read-only review whose findings the caller will triage? If the task text does not make foreseeable follow-up clear, answer no.",
	},
};

type Shape = "single" | "batch" | "chain";
type RequestedMode = "auto" | "oneshot" | "persistent";

interface RouteDecision {
	route: "oneshot" | "persistent";
	reason: string;
	prob: number | null;
	confidence: number | null;
	latencyMs: number;
	degraded: boolean;
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
		description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
		default: "user",
	}),
);

const DelegateParams = Type.Object({
	mode: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("oneshot"), Type.Literal("persistent")], {
			description:
				'Routing: "auto" (default) lets the Jev classifier decide by whether the work is likely to be revisited; ' +
				'"oneshot" forces the blocking engine whose child exits after returning its result; "persistent" forces a ' +
				"retained, steerable child (single or tasks batch only — chains are always one-shot).",
			default: "auto",
		}),
	),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single form)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single form)" })),
	name: Type.Optional(
		Type.String({
			description:
				"Persistent handle name for this child (single form; auto-generated when omitted and the persistent engine is chosen). Pattern: [a-zA-Z0-9][a-zA-Z0-9_-]*",
		}),
	),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String({ description: "Name of the agent to invoke" }),
				task: Type.String({ description: "Task to delegate to this child" }),
				name: Type.Optional(
					Type.String({
						description: "Persistent handle name (used only when routed to the persistent engine; auto-generated when omitted)",
					}),
				),
				cwd: Type.Optional(Type.String({ description: "Working directory for this child" })),
				tools: ToolsParam,
				model: Type.Optional(Type.String({ description: "Optional model ID or role alias (@smol, @slow, @task, @plan)" })),
				timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds (one-shot engine)" })),
				wait: Type.Optional(
					Type.Boolean({ description: "Persistent engine: block until this child settles and include its result. Default: true.", default: true }),
				),
			}),
			{
				description:
					"Batch: run several subagents concurrently in ONE call (max 8). ALWAYS use this shape instead of multiple separate calls for parallel work.",
			},
		),
	),
	chain: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String({ description: "Name of the agent to invoke" }),
				task: Type.String({ description: "Task with optional {previous} placeholder for the prior step's output" }),
				cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
				tools: ToolsParam,
				model: Type.Optional(Type.String({ description: "Optional model ID or role alias (@smol, @slow, @task, @plan)" })),
				timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds" })),
			}),
			{ description: "Sequential pipeline; {previous} is replaced with the prior step's output. Always one-shot." },
		),
	),
	agentScope: AgentScopeSchema,
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents (one-shot engine). Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	tools: ToolsParam,
	model: Type.Optional(Type.String({ description: "Optional model ID or role alias (@smol, @slow, @task, @plan)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds (one-shot single mode)" })),
	wait: Type.Optional(
		Type.Boolean({
			description:
				"Persistent engine: block until every child settles and return all results in this call (default true). Set false to get handles immediately for mid-flight steering — collect later with subagent_wait.",
			default: true,
		}),
	),
});

type DelegateParamsType = Static<typeof DelegateParams>;

function detectShape(params: DelegateParamsType): Shape | null {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasBatch = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const count = Number(hasChain) + Number(hasBatch) + Number(hasSingle);
	if (count !== 1) return null;
	return hasChain ? "chain" : hasBatch ? "batch" : "single";
}

async function decideRoute(mode: RequestedMode, shape: Shape, texts: string[], agents: string[]): Promise<RouteDecision> {
	const started = Date.now();
	const base = (
		route: "oneshot" | "persistent",
		reason: string,
		prob: number | null = null,
		confidence: number | null = null,
		degraded = false,
	): RouteDecision => ({ route, reason, prob, confidence, latencyMs: Date.now() - started, degraded });

	if (mode === "oneshot") return base("oneshot", "explicit");
	if (mode === "persistent") return base("persistent", "explicit");
	if (shape === "chain") return base("oneshot", "chain");
	if (process.env.DELEGATE_JEV === "0") return base("oneshot", "jev-disabled", null, null, true);

	const answers = await jevCall(
		{ tool: "delegate", shape, agents, tasks: texts.map((t) => t.slice(0, 800)) },
		CLASSIFY_QUESTION,
		{ budget: new CallBudget(1, Date.now() + CLASSIFY_TIMEOUT_MS), timeoutMs: CLASSIFY_TIMEOUT_MS },
	);
	const answer = answers?.persistent as { noul?: number; confidence?: number } | undefined;
	const prob = typeof answer?.noul === "number" ? answer.noul : null;
	if (prob === null) return base("oneshot", "jev-unavailable", null, null, true);
	return base(prob >= PERSIST_THRESHOLD ? "persistent" : "oneshot", "classifier", prob, answer?.confidence ?? null);
}

function allocateNames(scopeKey: string, bases: Array<string | undefined>): string[] {
	const used = new Set<string>();
	const out: string[] = [];
	for (const base of bases) {
		const sanitized = (base ?? "agent").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 48) || "agent";
		let candidate = sanitized;
		for (let n = 2; used.has(candidate) || isNameLive(scopeKey, candidate); n++) {
			candidate = `${sanitized}-${n}`;
		}
		used.add(candidate);
		out.push(candidate);
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	const regDiscovery = discoverAgents(process.cwd(), "both");
	const userRoster =
		regDiscovery.agents
			.filter((a) => a.source === "user")
			.map((a) => `${a.name}: ${a.description}`)
			.join("; ") || "none";
	const projectAgents = regDiscovery.agents.filter((a) => a.source === "project");
	const projectRoster = projectAgents.length > 0 ? projectAgents.map((a) => `${a.name}: ${a.description}`).join("; ") : null;

	const hideRawSpawnTools = () => {
		if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.DELEGATE_RAW_TOOLS === "1") return;
		const active = pi.getActiveTools();
		const next = active.filter((name) => !RAW_SPAWN_TOOLS.includes(name));
		if (next.length !== active.length) pi.setActiveTools(next);
	};
	pi.on("session_start", () => hideRawSpawnTools());
	pi.on("before_agent_start", () => hideRawSpawnTools());

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate work to a subagent. This is the single spawn entry point — it routes automatically between the one-shot engine " +
				"(blocking; the child exits after returning its result) and the persistent engine (retained session; steerable and " +
				"resumable afterwards with subagent_send / subagent_wait / subagent_list). Set `mode` to override the classifier.",
			"MODES (choose exactly one):",
			"- SINGLE: { agent, task, name? } — one child.",
			"- PARALLEL: { tasks: [{ agent, task, name? }, ...] } — concurrent batch (max 8). ALWAYS use this shape instead of emitting multiple separate tool calls.",
			"- CHAIN: { chain: [{ agent, task }, { agent, task: '... {previous}' }] } — sequential pipeline; always one-shot.",
			`Default agent scope is "user" (from ${getAgentDir()}/agents).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
			`Available user-scope agents: ${userRoster}.`,
			...(projectRoster ? [`Project-scope agents (require agentScope: "both"): ${projectRoster}.`] : []),
			"When routed persistent, the child handles are printed in the result — steer with subagent_send, collect with subagent_wait, list with subagent_list.",
		].join(" "),
		parameters: DelegateParams,
		renderShell: "self",

		renderCall(args, theme, context) {
			return renderSubagentCall(args, { argsComplete: context.argsComplete, executionStarted: context.executionStarted }, theme);
		},

		renderResult(result, options, theme, context) {
			return renderPersistentResult(result, options, theme, context.args);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const shape = detectShape(params);
			if (!shape) {
				const available = discoverAgents(ctx.cwd, params.agentScope ?? "user").agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Provide exactly one form: chain, tasks, or agent+task. Available agents: ${available}.` }],
					details: {},
				};
			}
			if (shape === "chain" && params.mode === "persistent") {
				return {
					content: [{ type: "text", text: 'Chains are always one-shot; mode "persistent" supports `tasks` (batch) or agent+task (single).' }],
					details: {},
				};
			}

			const requestedAgents =
				shape === "chain" ? params.chain!.map((s) => s.agent) : shape === "batch" ? params.tasks!.map((t) => t.agent) : [params.agent!];
			const texts =
				shape === "chain" ? params.chain!.map((s) => s.task) : shape === "batch" ? params.tasks!.map((t) => t.task) : [params.task!];

			const decision = await decideRoute(params.mode ?? "auto", shape, texts, requestedAgents);
			appendDecision(ROUTER_LOG, {
				routeId: newId(),
				session: ctx.sessionManager.getSessionId(),
				requested: params.mode ?? "auto",
				decided: decision.route,
				reason: decision.reason,
				prob: decision.prob,
				confidence: decision.confidence,
				threshold: PERSIST_THRESHOLD,
				latencyMs: decision.latencyMs,
				degraded: decision.degraded,
				shape,
				agents: requestedAgents,
				tasks: texts.length,
				preview: (texts[0] ?? "").replace(/\s+/g, " ").slice(0, 140),
			});

			if (decision.route === "oneshot") {
				return executeSubagent(params, ctx as SubagentExecContext, signal, onUpdate);
			}

			const scopeKey = resolveScopeKey(ctx);
			const names = allocateNames(
				scopeKey,
				shape === "batch" ? params.tasks!.map((t) => t.name ?? t.agent) : [params.name ?? params.agent],
			);
			const spawnParams: PersistentSpawnParams =
				shape === "batch"
					? {
							tasks: params.tasks!.slice(0, MAX_PARALLEL_TASKS).map((t, i) => ({
								agent: t.agent,
								task: t.task,
								name: names[i],
								cwd: t.cwd,
								tools: t.tools,
								model: t.model,
								wait: t.wait,
							})),
							agentScope: params.agentScope,
						}
					: {
							agent: params.agent,
							task: params.task,
							name: names[0],
							cwd: params.cwd,
							tools: params.tools,
							model: params.model,
							wait: params.wait,
							agentScope: params.agentScope,
						};
			return executePersistentSpawn(spawnParams, ctx as PersistentExecContext, signal, onUpdate);
		},
	});
}

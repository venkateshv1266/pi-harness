/**
 * One adapter per harness subsystem that writes a JSONL decision log.
 * Field names are taken from the live logs (see docs/observatory-plan.md §1.3);
 * unknown fields still ride along in `data` so schema drift degrades to
 * "renders as generic row", never a crash.
 */
import { decisionsDir } from "../config";
import * as path from "node:path";
import {
	type Adapter,
	type EventDraft,
	type RawRecord,
	type Severity,
	arr,
	info,
	jsonlAdapter,
	num,
	tailModel,
	truncate,
	tsMsOf,
	worst,
} from "./define";

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

interface Base {
	ts?: string;
	session?: string;
	turn?: number;
	kind?: string;
	id?: string;
}

function draft(base: Base, kind: string, severity: Severity, data: RawRecord, title?: string, summary?: string): EventDraft {
	const ts = base.ts ?? new Date(0).toISOString();
	// Outcome records point at the decision they judged via `ref`; decision
	// records carry their own id. Prefer `ref` so a fate join can find the pair.
	const dataRef = typeof data.ref === "string" ? data.ref : undefined;
	return {
		ts,
		tsMs: tsMsOf(ts),
		kind,
		severity,
		sessionId: info(base.session),
		turn: num(base.turn),
		ref: dataRef ?? info(base.id),
		title,
		summary,
		data,
	};
}

// ---------------------------------------------------------------- curator

const curatorMap = (o: RawRecord): EventDraft => {
	const b = o as Base & { decision?: string; tool?: string; sourceType?: string; role?: string; verifierVerdict?: string; verifierReason?: string; chars?: number; turn?: number; entryId?: string; contextPct?: number; goalspecVersion?: number; outcome?: string; model?: string };
	const decision = b.decision ?? b.kind ?? "event";
	const verdict = info(b.verifierVerdict);
	const severity: Severity = verdict === "retainFull" ? "info" : verdict ? "ok" : "info";
	const title =
		decision === "shadow"
			? `${b.tool ?? "?"} · ${b.sourceType ?? "?"} → ${b.role ?? "?"}`
			: decision === "verifier-batch"
				? `verifier batch ×${num((o as RawRecord).count) ?? "?"}`
				: decision === "distill"
					? `seed distill · ${b.outcome ?? "?"}${b.model ? ` · ${b.model}` : ""}`
					: decision;
	const summaryParts = [
		verdict ? `verdict ${verdict}` : null,
		num(b.chars) !== undefined ? `${b.chars} chars` : null,
		num(b.contextPct) !== undefined ? `ctx ${b.contextPct}%` : null,
		truncate(info(b.verifierReason), 120),
	].filter(Boolean);
	return draft(
		{ ts: b.ts, session: (o as RawRecord).session as string, turn: b.turn, id: b.entryId },
		decision,
		severity,
		o,
		title,
		summaryParts.join(" · "),
	);
};

const curatorVerifyMap = (o: RawRecord): EventDraft => {
	const b = o as Base & { decision?: string; verdict?: string; verdictScore?: number };
	const lost = typeof o.verdict === "string" && !["good", "useExtract", "indexOnly", "retainFull"].includes(o.verdict);
	const severity: Severity = lost ? "warn" : "ok";
	return draft(
		{ ts: b.ts, session: o.session as string, turn: b.turn as number, id: (o.entryId ?? b.id) as string },
		b.decision ?? b.kind ?? "event",
		severity,
		o,
		b.decision === "jev-verify" ? `verify ${b.verdict ?? ""}` : (b.decision ?? b.kind ?? "event"),
		truncate(info(o.verifierReason) ?? `score ${num(b.verdictScore) ?? ""}`, 140),
	);
};

// ---------------------------------------------------------------- ttsr

const ttsrMap = (o: RawRecord): EventDraft => {
	const b = o as Base & { rule?: string; decision?: string; delivered?: boolean; mode?: string; scope?: string; outcome?: string; verdict?: string; turnsAfter?: number; err?: string };
	const isOutcome = b.kind === "outcome";
	const severity: Severity = isOutcome
		? b.verdict === "bad"
			? "warn"
			: b.verdict === "good"
				? "ok"
				: "info"
		: b.decision === "fired"
			? "ok"
			: "info";
	const title = isOutcome
		? `${b.outcome ?? "outcome"} · ${b.rule ?? "?"}`
		: `${b.decision === "fired" ? "fired" : "gate"} · ${b.rule ?? "?"}`;
	const summary = isOutcome
		? `${b.turnsAfter !== undefined ? `${b.turnsAfter} turns after` : ""}${b.verdict ? ` · ${b.verdict}` : ""}`
		: `scope ${b.scope ?? "?"} · mode ${b.mode ?? "?"}${b.delivered !== undefined ? ` · delivered ${b.delivered}` : ""}`;
	return draft(o as Base, `ttsr.${b.kind ?? "gate"}`, severity, o, title, summary);
};

// ---------------------------------------------------------------- router

const routerMap = (o: RawRecord): EventDraft => {
	const b = o as Base & { tier?: string; from?: string; to?: string; p?: number; confidence?: number; acted?: boolean; reason?: string; verdict?: string; outcome?: string; newTaskP?: number };
	const isOutcome = b.kind === "outcome";
	const severity: Severity = isOutcome
		? b.verdict === "bad" || b.outcome === "user_corrected"
			? "warn"
			: "ok"
		: b.acted
			? "ok"
			: "info";
	const title = isOutcome
		? `${b.outcome ?? "outcome"}`
		: `${b.tier ?? "keep"} · ${tailModel(b.from)} → ${tailModel(b.to)}`;
	const summary = isOutcome
		? (truncate(info(b.reason), 140) ?? "")
		: `p ${fmt(b.p)} · conf ${fmt(b.confidence)} · newTask ${fmt(b.newTaskP)}${b.reason ? ` · ${b.reason}` : ""}`;
	const d = draft(o as Base, `router.${b.kind ?? "decision"}`, severity, o, title, summary);
	d.costUsd = num(o.cost_usd) ?? d.costUsd;
	d.latencyMs = num(o.latencyMs);
	// Outcome records point at their decision via ref — do not clobber it with id.
	d.ref = info(o.ref) ?? info(b.id);
	return d;
};

const fmt = (v?: number | null): string => (v === undefined || v === null ? "—" : v.toFixed(2));

// ---------------------------------------------------------------- guard

const guardMap = (o: RawRecord): EventDraft => {
	const b = o as Base & { hook?: string; verdict?: string; tool?: string; command?: string; destructive?: number; effect?: string; cached?: boolean };
	const severity: Severity =
		b.verdict === "blocked" ? "error" : b.verdict === "flagged" || b.verdict === "confirmed" ? "warn" : b.verdict === "allowed" ? "ok" : "info";
	const title = `${b.hook ?? "screen"} · ${truncate(b.command ?? b.tool ?? "", 60) ?? ""}`;
	const summary = [
		`verdict ${b.verdict ?? "?"}`,
		num(b.destructive) !== undefined ? `destructive ${b.destructive}` : null,
		info(b.effect) !== undefined ? `effect ${b.effect}` : null,
		b.cached ? "cached" : null,
	]
		.filter(Boolean)
		.join(" · ");
	const d = draft(o as Base, `guard.${b.hook ?? "screen"}`, severity, o, title, summary);
	d.costUsd = num(o.cost_usd);
	return d;
};

// ---------------------------------------------------------------- memory

const memoryMap = (o: RawRecord): EventDraft => {
	const b = o as Base & { decision?: string; outcome?: string; target?: string; latency_ms?: number; degraded?: boolean; scores?: RawRecord };
	const severity: Severity = b.outcome === "degraded" || b.degraded ? "warn" : b.outcome === "block" ? "info" : "ok";
	const scores = (b.scores ?? {}) as Record<string, unknown>;
	const summaryParts = [
		`outcome ${b.outcome ?? "?"}`,
		b.target ? `target ${b.target}` : null,
		...Object.entries(scores)
			.slice(0, 4)
			.map(([k, v]) => `${k} ${typeof v === "number" ? v : String(v)}`),
	].filter(Boolean);
	const d = draft(o as Base, `memory.${b.decision ?? "event"}`, severity, o, `${b.decision ?? "event"}${b.target ? ` · ${b.target}` : ""}`, summaryParts.join(" · "));
	d.latencyMs = num(b.latency_ms);
	return d;
};

// ---------------------------------------------------------------- course check

const courseMap = (o: RawRecord): EventDraft => {
	const b = o as Base & { verdict?: string; p?: number; why?: string; consecutive?: number; turnsAfter?: number; userSteered?: boolean };
	const severity: Severity = b.verdict === "off_track" ? "warn" : b.verdict === "goal_met" || b.verdict === "good" ? "ok" : "info";
	const d = draft(o as Base, `course.${o.kind === "outcome" ? "outcome" : o.kind === "decision" ? "decision" : "check"}`, severity, o, `${b.verdict ?? "?"}${b.turn !== undefined ? ` @t${b.turn}` : ""}`, [fmt(b.p) !== "—" ? `p ${fmt(b.p)}` : null, info(b.why), b.userSteered ? "user steered" : null].filter(Boolean).join(" · "));
	d.ref = info(o.ref) ?? info((o as RawRecord).id as string);
	return d;
};

// ---------------------------------------------------------------- subagent router

const subagentMap = (o: RawRecord): EventDraft => {
	const b = { routeId: info(o.routeId), requested: info(o.requested), decided: info(o.decided), reason: info(o.reason), prob: num(o.prob), degraded: o.degraded === true } as const;
	const severity: Severity = b.degraded ? "warn" : "ok";
	const d = draft({ ts: info(o.ts), session: info(o.session), id: b.routeId }, b.degraded ? "router.degraded" : "router.decision", severity, o, `${b.requested ?? "?"} → ${b.decided ?? "?"}`, [fmt(b.prob) !== "—" ? `p ${fmt(b.prob)}` : null, info(b.reason)].filter(Boolean).join(" · "));
	d.latencyMs = num(o.latencyMs);
	return d;
};

// ---------------------------------------------------------------- ask-jev

const askJevMap = (o: RawRecord): EventDraft => {
	const okValue = o.ok;
	const severity: Severity = okValue === false ? "warn" : "ok";
	const target = info(o.tool) ?? info(o.path) ?? (arr(o.files).length ? `${arr(o.files).length} files` : "ask");
	const summary = [`${num(o.elapsed_ms) ?? "?"}ms`, num(o.cost_usd) !== undefined ? `$${Number(o.cost_usd).toFixed(6)}` : null, info(o.summary)].filter(Boolean).join(" · ");
	const d = draft({ ts: info(o.ts) }, "ask-jev", severity, o, `ask · ${truncate(target, 70)}`, summary);
	d.costUsd = num(o.cost_usd);
	d.latencyMs = num(o.elapsed_ms);
	return d;
};

// ---------------------------------------------------------------- refine

const refineMap = (o: RawRecord): EventDraft => {
	const b = { stage: info(o.stage), decision: info(o.decision), trigger: info(o.trigger), name: info(o.name), kind: info(o.kind), score: num(o.score), err: info(o.err), tier: info(o.tier) };
	const parts = (o.parts ?? {}) as Record<string, unknown>;
	const partText = ["evidence", "novelty", "trigger"]
		.filter((part) => typeof parts[part] === "number")
		.map((part) => `${part.slice(0, 2)} ${Number(parts[part]).toFixed(2)}`)
		.join(" · ");
	const severity: Severity = b.decision === "degraded" || b.err ? "warn" : b.decision === "applied" || b.decision === "armed" ? "ok" : "info";
	const d = draft({ ts: info(o.ts), session: info(o.session) }, `refine.${b.decision ?? "event"}`, severity, o, `${b.stage ?? "refine"}${b.name ? ` · ${b.name}` : b.trigger ? ` · ${b.trigger}` : ""}${b.tier ? ` (${b.tier})` : ""}`, [`decision ${b.decision ?? "?"}`, b.kind, fmt(b.score) !== "—" ? `score ${fmt(b.score)}` : null, truncate(b.err, 90), partText].filter(Boolean).join(" · "));
	d.latencyMs = num(o.latencyMs);
	return d;
};

const refineHistoryMap = (o: RawRecord): EventDraft => {
	const ts = info(o.timestamp) ?? new Date(0).toISOString();
	const severity: Severity = "ok";
	return {
		ts,
		tsMs: tsMsOf(ts),
		kind: `refine.${info(o.kind) ?? "artifact"}`,
		severity,
		ref: info(o.id),
		title: `${info(o.kind) ?? "artifact"} · ${info(o.name) ?? "?"}`,
		summary: truncate(info(o.evidence), 160),
		data: o,
	};
};

// ---------------------------------------------------------------- decision tuner

const tunerProposalsMap = (o: RawRecord): EventDraft => {
	const status = info(o.status) ?? "open";
	const severity: Severity = status === "dismissed" ? "info" : status === "applied" ? "ok" : "info";
	return draft(
		{ ts: info(o.createdAt), id: info(o.id) },
		`tuner.proposal.${status}`,
		severity,
		o,
		`${info(o.kind) ?? "proposal"} · ${info(o.system) ?? "?"}`,
		[info(o.target), truncate(info(o.evidence), 110)].filter(Boolean).join(" · "),
	);
};

const tunerMap = (o: RawRecord): EventDraft => {
	const severity: Severity = "info";
	return draft({ ts: info(o.ts), id: info(o.id) }, `tuner.${info(o.event) ?? "event"}`, severity, o, info(o.event) ?? "tuner", [info(o.target), num(o.proposals) !== undefined ? `${num(o.proposals)} proposals` : null, num(o.days) !== undefined ? `${num(o.days)}d window` : null].filter(Boolean).join(" · "));
};

// ---------------------------------------------------------------- registry

const tablePanel = (id: string, title: string): Adapter["panels"] => [{ id, title, kind: "table", query: "ledger" }];

export function decisionAdapters(): Adapter[] {
	const file = (rel: string) => path.join(decisionsDir(), rel);
	void file;
	return [
		jsonlAdapter({
			id: "curator",
			extension: "jev-context-curator",
			title: "Context Curator",
			description: "V3 role classification, extraction proposals, verifier verdicts, GoalSpec, emissions and recall.",
			file: "jev-curator.jsonl",
			map: curatorMap,
			panels: [
				{ id: "curator-fates", title: "Candidate fates", kind: "sankey", query: "curator.fates" },
				{ id: "curator-timeline", title: "Curator activity", kind: "timeseries", query: "curator.timeseries" },
				{ id: "curator-verdicts", title: "Verifier verdicts", kind: "table", query: "curator.verdicts" },
			],
		}),
		jsonlAdapter({
			id: "curator-v2",
			extension: "jev-context-curator",
			title: "Context Curator V2",
			description: "Recency judge verdicts (keep/stub/truncate), cap-at-rest, batch hold/emit and cache-cost probes.",
			file: "jev-curator-v2.jsonl",
			map: curatorVerifyMap,
			panels: tablePanel("curator-v2", "V2 verdicts"),
		}),
		jsonlAdapter({
			id: "curator-v3-shadow",
			extension: "jev-context-curator",
			title: "Curator V3 shadow",
			description: "Shadow-quality comparison arm: classifies and verifies without editing context.",
			file: "jev-curator-v3-shadow.jsonl",
			map: curatorMap,
			panels: tablePanel("curator-shadow", "Shadow verdicts"),
		}),
		jsonlAdapter({
			id: "ttsr",
			title: "TTSR Rules",
			description: "Rule gate telemetry, deliveries, blocks and post-hoc outcome verdicts.",
			file: "ttsr-jev.jsonl",
			map: ttsrMap,
			panels: [
				{ id: "ttsr-outcomes", title: "Rule outcomes", kind: "table", query: "ttsr.outcomes" },
				{ id: "ttsr-fires", title: "Rule fires", kind: "bar", query: "ttsr.fires" },
			],
		}),
		jsonlAdapter({
			id: "router",
			extension: "model-router",
			title: "Model Router",
			description: "Tier decisions (keep/mid/deep/fast) with probability, confidence and outcomes.",
			file: "model-router.jsonl",
			map: routerMap,
			panels: [
				{ id: "router-tiers", title: "Tier mix", kind: "bar", query: "router.tiers" },
				{ id: "router-decisions", title: "Router decisions", kind: "table", query: "ledger" },
			],
		}),
		jsonlAdapter({
			id: "guard",
			extension: "jev-guard",
			title: "Jev Guard",
			description: "Pre-tool screening: clean/flagged/blocked verdicts with destructive-effect scoring.",
			file: "jev-guard.jsonl",
			map: guardMap,
			panels: [
				{ id: "guard-verdicts", title: "Guard verdicts", kind: "bar", query: "guard.verdicts" },
				{ id: "guard-events", title: "Screens", kind: "table", query: "ledger" },
			],
		}),
		jsonlAdapter({
			id: "memory",
			extension: "jev-memory",
			title: "Jev Memory",
			description: "Admission, pregate, rerank, correction and consolidation decisions with scores.",
			file: "jev-memory.jsonl",
			map: memoryMap,
			panels: [{ id: "memory-outcomes", title: "Memory outcomes", kind: "bar", query: "memory.outcomes" }],
		}),
		jsonlAdapter({
			id: "course-check",
			title: "Course Check",
			description: "Goal-loop verdicts: on_track / off_track / goal_met with probability and rationale.",
			file: "course-check.jsonl",
			map: courseMap,
			panels: [{ id: "course-verdicts", title: "Course verdicts", kind: "bar", query: "course.verdicts" }],
		}),
		jsonlAdapter({
			id: "subagent-router",
			extension: "delegate",
			title: "Subagent Router",
			description: "Delegate routing: requested vs decided engine with probability and degradation flags.",
			file: "subagent-router.jsonl",
			map: subagentMap,
			panels: tablePanel("subagent", "Routing decisions"),
		}),
		jsonlAdapter({
			id: "ask-jev",
			title: "Ask-Jev",
			description: "Typed Jev decisions — file judgments, log/test-output triage, pre-commit diff review, big-file extraction — with latency and cost.",
			file: "ask-jev.jsonl",
			map: askJevMap,
			panels: tablePanel("ask-jev", "Judgments"),
		}),
		jsonlAdapter({
			id: "refine",
			title: "Refine",
			description: "Rule/note refinement pipeline: staged, applied, suppressed and degraded outcomes.",
			file: "refine/auto-refine.jsonl",
			map: refineMap,
			panels: tablePanel("refine", "Refinements"),
		}),
		jsonlAdapter({
			id: "refine-history",
			extension: "refine",
			title: "Refine history",
			description: "Applied refinements with evidence and target files.",
			file: "refine/history.jsonl",
			map: refineHistoryMap,
			panels: tablePanel("refine-history", "Applied artifacts"),
		}),
		jsonlAdapter({
			id: "tuner-proposals",
			extension: "decision-tuner",
			title: "Decision Tuner proposals",
			description: "Prune/config proposals from the periodic tuner, with their review status.",
			file: "decision-tuner/proposals.jsonl",
			map: tunerProposalsMap,
			panels: tablePanel("tuner-proposals", "Proposals"),
		}),
		jsonlAdapter({
			id: "tuner",
			extension: "decision-tuner",
			title: "Decision Tuner",
			description: "Periodic tuning passes and prune/config proposals.",
			file: "decision-tuner/tuner.jsonl",
			map: tunerMap,
			panels: tablePanel("tuner", "Tuning passes"),
		}),
	];
}

export const severityRank = (a: Severity, b: Severity): Severity => worst(a, b);
export const sumNumbers = sum;

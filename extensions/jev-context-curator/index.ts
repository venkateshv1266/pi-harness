/**
 * Jev Context Curator — System One attention routing for pi.
 *
 * A cheap classifier (Jev, a System One model) decides which past tool
 * outputs still earn a place in model context; the frontier model only ever
 * sees a curated transcript. Three curation mechanisms, ordered by economics:
 *
 *   1. cap-at-rest    — outputs >25k chars are excerpted (head+tail) BEFORE
 *                       first model exposure, so the full bulk is never billed
 *                       and no prefix-cache reset is ever paid for them.
 *   2. truncate       — middle-band verdicts (p≥0.60): head/tail excerpt
 *                       replaces the full output; gist stays in context.
 *   3. stub           — p≥0.85: one-line stub; raw recoverable via jev_recall.
 *
 * All edits are append-only `context_edit` entries — raw history stays intact
 * and everything is recoverable with `jev_recall` (offset/limit paging), so
 * curation is advisory, never destructive. Truncate/stub verdicts are held in
 * a ready batch and emitted only when the combined SAVED mass clears the batch
 * floor (a context_edit resets the provider prefix cache; small edits lose
 * more to the reset than they save), when context usage is high, or when aged
 * out. Under context pressure the gates escalate, because selective
 * truncation beats a lossy full compaction.
 *
 * Verdicts are median-of-3 parallel Jev samples (calibration showed p swings
 * of 0.53–0.85 on borderline content) and judged with an enriched state:
 * goal + tool input + recent activity fingerprint + output excerpt.
 *
 * Goal pinning: seeded from the user's first prompt verbatim; re-pinnable by
 * the model (`pin_goal`) or manually (`/goal`). Latest pin wins.
 *
 * V3 shadow-quality mode (`JEVCURATOR_MODE=shadow-quality`) layers the
 * goal-quality-first pipeline of tasks/jev-curator-v3-goal-quality.md on top
 * without issuing any context edits of its own: a versioned GoalSpec
 * (user objective + success criteria + constraints + plan + facts + open
 * questions, persisted as a custom entry), Jev evidence-role classification
 * (active/evidence/background/irrelevant) with type-aware extract proposals
 * (log line-scoring, code ranges, listing matches), and a batched frontier
 * verifier at turn_end that would approve retainFull/useExtract/indexOnly.
 * Every would-be decision is logged to jev-curator-v3-shadow.jsonl for human
 * review; V2 keeps running unmodified so both streams stay comparable.
 *
 * V3 evidence mode (`JEVCURATOR_MODE=evidence`) additionally ACTIVATES the
 * verifier-approved useExtract/indexOnly replacements for log and listing
 * sources only (code/doc stay verbatim until Phase 3). Each replacement
 * lands in an evidence ledger (persisted custom entry) searchable via the
 * `curator_find` tool, which Jev-reranks ledger sources against the GoalSpec;
 * `jev_recall` remains the exact paged raw-recovery path.
 *
 * V3 quality mode (`JEVCURATOR_MODE=quality`) is the full Phase 3 state:
 * extraction additionally covers code and doc sources, and pi compaction
 * is replaced by a frontier-generated summary that MUST carry the complete
 * GoalSpec and the evidence ledger verbatim, so goal state and condensed-
 * source ids survive every compaction. On any failure the default
 * compaction runs unchanged.
 *
 * Kill switch: JEVCURATOR=0. Tunables: JEVCURATOR_MIN_CHARS (1500),
 * JEVCURATOR_RECENCY_TURNS (3), JEVCURATOR_STUB_PROB (0.85),
 * JEVCURATOR_TRUNC_PROB (0.60), JEVCURATOR_MIN_CONF (0.65),
 * JEVCURATOR_MAX_STUBS (150), JEVCURATOR_MIN_BATCH_SAVED (3000),
 * JEVCURATOR_CONTEXT_FLOOR_PCT (70), JEVCURATOR_CRITICAL_PCT (85),
 * JEVCURATOR_MAX_HOLD_TURNS (10), JEVCURATOR_INGEST_CAP (25000),
 * JEVCURATOR_SAMPLES (3).
 */

import { Type, uuidv7 } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	defineTool,
	type ContextEditEntryDraft,
	type CustomEntryDraft,
	type ExtensionAPI,
	type ExtensionContext,
	serializeConversation,
	type SessionBeforeCompactEvent,
	type SessionEntry,
	type SessionMessageEntry,
	type ToolCallEvent,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GOAL_TYPE = "jev-curator-goal";
const GOALSPEC_TYPE = "jev-curator-goalspec";
const LEDGER_TYPE = "jev-curator-ledger";
const AUDIT_TYPE = "jev-curator-stubs";

// v3 pipeline activation. "v2" keeps the file's pre-V3 behavior exactly;
// "shadow-quality" runs V2 unmodified plus the no-edit V3 shadow pipeline;
// "evidence" additionally activates verifier-approved edits for log/listing
type CuratorMode = "v2" | "shadow-quality" | "evidence" | "quality";
const MODE: CuratorMode =
	process.env.JEVCURATOR_MODE === "shadow-quality" ||
	process.env.JEVCURATOR_MODE === "evidence" ||
	process.env.JEVCURATOR_MODE === "quality"
		? (process.env.JEVCURATOR_MODE as CuratorMode)
		: "v2";
const V3 = MODE !== "v2";
const SHADOW_LOG_FILE = "jev-curator-v3-shadow.jsonl";
// evidence mode: sources whose replacement is active (Phase 2 scope);
// quality mode extends the same gate to code/doc reads (Phase 3 scope)
const EVIDENCE_SCOPE: ReadonlySet<string> =
	MODE === "quality" ? new Set(["log", "listing", "code", "doc"]) : new Set(["log", "listing"]);
const VERIFIER_TIMEOUT_MS = Number(process.env.JEVCURATOR_VERIFIER_TIMEOUT_MS ?? 90000);
const SHADOW_JEV_TIMEOUT_MS = Number(process.env.JEVCURATOR_SHADOW_JEV_TIMEOUT_MS ?? 8000);
const SCORE_JEV_TIMEOUT_MS = Number(process.env.JEVCURATOR_SCORE_JEV_TIMEOUT_MS ?? 25000);
const SHADOW_MAX_PER_TURN = Number(process.env.JEVCURATOR_SHADOW_MAX_PER_TURN ?? 10);
// the verifier must be able to confirm losslessness; give it the full raw
// below this size and an excerpt above it (those are cap-at-rest'd anyway)
const VERIFY_RAW_CAP = Number(process.env.JEVCURATOR_VERIFY_RAW_CAP ?? 60000);
// line-scoring shape mirrors the proven jev_triage_log defaults
const SCORE_CHUNK_LINES = 150;
const SCORE_CHUNK_CHARS = 48000;
const SCORE_MAX_LINES = 3000;
const SCORE_MIN = 0.5;
const SCORE_TOP_K = 40;
// extracts scale with the source (30%, clamped) — a fixed budget cut JSON-heavy
// logs to a handful of lines, which the verifier correctly kept rejecting
const extractBudget = (chars: number): number => Math.min(12000, Math.max(2500, Math.round(chars * 0.3)));

// `read` is deliberately prunable: superseded file reads are the biggest
// source of stale bloat, and re-reading is always cheap.
// `jev_recall` results are exempt or the curator would re-curate the very
// content the model just explicitly asked back into context (churn loop).
const NEVER_PRUNE = new Set(["edit", "write", "todo", "jev_recall"]);

const CFG = {
	on: process.env.JEVCURATOR !== "0",
	minChars: Number(process.env.JEVCURATOR_MIN_CHARS ?? 1500),
	recencyTurns: Number(process.env.JEVCURATOR_RECENCY_TURNS ?? 3),
	stubProb: Number(process.env.JEVCURATOR_STUB_PROB ?? 0.85),
	truncProb: Number(process.env.JEVCURATOR_TRUNC_PROB ?? 0.6),
	minConf: Number(process.env.JEVCURATOR_MIN_CONF ?? 0.65),
	maxStubs: Number(process.env.JEVCURATOR_MAX_STUBS ?? 150),
	minBatchSaved: Number(process.env.JEVCURATOR_MIN_BATCH_SAVED ?? 3000),
	contextFloorPct: Number(process.env.JEVCURATOR_CONTEXT_FLOOR_PCT ?? 70),
	criticalPct: Number(process.env.JEVCURATOR_CRITICAL_PCT ?? 85),
	maxHoldTurns: Number(process.env.JEVCURATOR_MAX_HOLD_TURNS ?? 10),
	// verifier model: "provider/model", defaults to the session model (same
	// quality tier as the main task model per the V3 design)
	verifierModel: process.env.JEVCURATOR_VERIFIER_MODEL ?? process.env.PI_MODEL ?? null,
	ingestCap: Number(process.env.JEVCURATOR_INGEST_CAP ?? 25000),
	capHead: Number(process.env.JEVCURATOR_CAP_HEAD ?? 15000),
	capTail: Number(process.env.JEVCURATOR_CAP_TAIL ?? 5000),
	truncHead: Number(process.env.JEVCURATOR_TRUNC_HEAD ?? 600),
	truncTail: Number(process.env.JEVCURATOR_TRUNC_TAIL ?? 600),
	samples: Math.max(1, Number(process.env.JEVCURATOR_SAMPLES ?? 3)),
};

const JEV_BASE_URL = process.env.JEV_BASE_URL ?? "https://openrouter.ai/api";
const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest";
const JEV_TIMEOUT_MS = Number(process.env.JEVCURATOR_JEV_TIMEOUT_MS ?? 2500);

type AgentMessage = SessionMessageEntry["message"];
type RoleMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" | "custom" }>;

function isRoleMessage(msg: AgentMessage): msg is RoleMessage {
	return (
		"role" in msg &&
		(msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult" || msg.role === "custom")
	);
}

type CurKind = "stub" | "truncate" | "cap";

interface CurRecord {
	entryId: string;
	toolName: string;
	turn: number;
	chars: number;
	prob: number;
	conf: number;
	kind: CurKind;
	replacementLen: number;
}

// a verdict ready for the batch queue (kind still pending emission)
interface ReadyRec extends CurRecord {}

interface Verdict {
	kind: "keep" | "stub" | "truncate";
	prob: number;
	conf: number;
	degraded: boolean;
}

interface JevChoiceAnswer {
	choice?: unknown;
	probabilities?: Record<string, unknown>;
	confidence?: unknown;
	noul?: unknown;
}

interface JevResponse {
	answers?: Record<string, JevChoiceAnswer>;
}

let goal: string | null = null;
// set by the pin_goal tool, flushed to a session entry at the next turn_end
let pendingGoal: string | null = null;

// ─── V3 GoalSpec (shadow-quality + evidence modes) ────────────────────

interface GoalSpecFact {
	fact: string;
	sourceIds: string[];
}

interface GoalSpec {
	userObjective: string; // immutable unless the user changes it via /goal
	objectiveRefinements: string[]; // pin_goal proposals; never replace the objective
	successCriteria: string[];
	constraints: string[];
	currentPlan: string[];
	knownFacts: GoalSpecFact[];
	openQuestions: string[];
	version: number;
}

const SPEC_CAPS = { refinements: 20, criteria: 30, constraints: 30, plan: 25, facts: 50, questions: 25 };

let spec: GoalSpec | null = null;
// amendment applied in-memory by a tool, flushed to a GOALSPEC_TYPE entry at the next turn_end
let specDirty = false;
const shadowJudged = new Set<string>();

const shadowStats = { classified: 0, roles: { active: 0, evidence: 0, background: 0, irrelevant: 0 }, retainFull: 0, useExtract: 0, indexOnly: 0, degraded: 0 };

function trimList<T>(list: T[], cap: number): T[] {
	return list.length > cap ? list.slice(list.length - cap) : list;
}

function isGoalSpecData(data: unknown): data is GoalSpec {
	if (typeof data !== "object" || data === null) return false;
	const d = data as Record<string, unknown>;
	return (
		typeof d.userObjective === "string" &&
		Array.isArray(d.objectiveRefinements) &&
		Array.isArray(d.successCriteria) &&
		Array.isArray(d.constraints) &&
		Array.isArray(d.currentPlan) &&
		Array.isArray(d.knownFacts) &&
		Array.isArray(d.openQuestions) &&
		typeof d.version === "number"
	);
}

// Like ensureGoal: retry until found — at the first turn_start the user entry
// may not be in the session yet, so never memoize a failed lookup.
function ensureGoalSpec(ctx: ExtensionContext) {
	if (spec) return;
	let entries: readonly SessionEntry[];
	try {
		entries = ctx.sessionManager.getEntries();
	} catch {
		return; // unreadable session: retry next boundary
	}
	let latest: GoalSpec | null = null;
	for (const e of entries) {
		if (e.type === "custom" && e.customType === GOALSPEC_TYPE && isGoalSpecData(e.data)) {
			latest = e.data; // multiple flushes over a session: latest wins
		}
	}
	if (latest) {
		spec = latest;
		return;
	}
	// seed: user objective = the user's own words (first user prompt verbatim);
	// model goal pins are derived refinements, never the objective itself
	let objective: string | null = null;
	const refinements: string[] = [];
	for (const e of entries) {
		if (objective === null && messageEntry(e) && isRoleMessage(e.message) && e.message.role === "user") {
			const text = messageText(e.message).trim();
			if (text) objective = text;
		} else if (e.type === "custom" && e.customType === GOAL_TYPE && e.data && typeof (e.data as { goal?: unknown }).goal === "string") {
			refinements.push((e.data as { goal: string }).goal);
		}
	}
	if (objective === null) return; // no user prompt yet: retry next boundary
	spec = {
		userObjective: objective,
		objectiveRefinements: trimList(refinements, SPEC_CAPS.refinements),
		successCriteria: [],
		constraints: [],
		currentPlan: [],
		knownFacts: [],
		openQuestions: [],
		version: 1,
	};
}

function amendSpec(fn: (s: GoalSpec) => void): void {
	if (!spec) return;
	fn(spec);
	spec.objectiveRefinements = trimList(spec.objectiveRefinements, SPEC_CAPS.refinements);
	spec.successCriteria = trimList(spec.successCriteria, SPEC_CAPS.criteria);
	spec.constraints = trimList(spec.constraints, SPEC_CAPS.constraints);
	spec.currentPlan = trimList(spec.currentPlan, SPEC_CAPS.plan);
	spec.knownFacts = trimList(spec.knownFacts, SPEC_CAPS.facts);
	spec.openQuestions = trimList(spec.openQuestions, SPEC_CAPS.questions);
	specDirty = true;
}

function specFactFrom(raw: unknown): GoalSpecFact | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.fact !== "string" || !r.fact.trim()) return null;
	const ids = Array.isArray(r.source_ids) ? r.source_ids.filter((s): s is string => typeof s === "string") : [];
	return { fact: r.fact.trim(), sourceIds: ids };
}

function goalspecSummary(): string {
	if (!spec) return "(no goalspec yet)";
	const s = spec;
	const out = [`USER OBJECTIVE: ${s.userObjective}`];
	if (s.objectiveRefinements.length) out.push(`Refinements: ${s.objectiveRefinements.join(" | ")}`);
	if (s.successCriteria.length) out.push(`Success criteria:\n${s.successCriteria.map((c, i) => `  c${i + 1}. ${c}`).join("\n")}`);
	if (s.constraints.length) out.push(`Constraints:\n${s.constraints.map((c, i) => `  k${i + 1}. ${c}`).join("\n")}`);
	if (s.currentPlan.length) out.push(`Current plan:\n${s.currentPlan.map((p, i) => `  p${i + 1}. ${p}`).join("\n")}`);
	if (s.knownFacts.length) out.push(`Known facts:\n${s.knownFacts.map((f, i) => `  f${i + 1}. ${f.fact}${f.sourceIds.length ? ` [sources: ${f.sourceIds.join(",")}]` : ""}`).join("\n")}`);
	if (s.openQuestions.length) out.push(`Open questions:\n${s.openQuestions.map((q, i) => `  q${i + 1}. ${q}`).join("\n")}`);
	return out.join("\n");
}

// ─── V3 evidence ledger (evidence mode) ───────────────────────────────

interface LedgerItem {
	entryId: string; // source entry id — the jev_recall handle
	toolName: string;
	sourceType: SourceType;
	role: string;
	links: string[];
	verdict: "useExtract" | "indexOnly";
	extract: string; // the replacement the model now sees
	turn: number;
	chars: number; // original raw size
	inputShape: string;
}

// entryId → item; hydrated from LEDGER_TYPE custom entries (union, unlike
// the latest-wins GoalSpec) and appended per turn_end in evidence mode
const ledger = new Map<string, LedgerItem>();
let ledgerHydrated = false;

interface RawLedgerItem {
	entryId: string;
	extract: string;
	verdict: "useExtract" | "indexOnly";
	toolName?: unknown;
	sourceType?: unknown;
	role?: unknown;
	links?: unknown;
	turn?: unknown;
	chars?: unknown;
	inputShape?: unknown;
}

function isLedgerItem(r: Record<string, unknown>): r is RawLedgerItem & Record<string, unknown> {
	return typeof r.entryId === "string" && typeof r.extract === "string" && (r.verdict === "useExtract" || r.verdict === "indexOnly");
}

function hydrateLedger(ctx: ExtensionContext) {
	if (ledgerHydrated) return;
	let entries: readonly SessionEntry[];
	try {
		entries = ctx.sessionManager.getEntries();
	} catch {
		return; // unreadable session: retry on the next boundary
	}
	ledgerHydrated = true;
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== LEDGER_TYPE) continue;
		const items = (e.data as { items?: unknown } | undefined)?.items;
		if (!Array.isArray(items)) continue;
		for (const it of items) {
			if (typeof it !== "object" || it === null) continue;
			const r = it as Record<string, unknown>;
			if (!isLedgerItem(r)) continue;
			ledger.set(r.entryId, {
				entryId: r.entryId,
				toolName: typeof r.toolName === "string" ? r.toolName : "(tool)",
				sourceType: (typeof r.sourceType === "string" ? r.sourceType : "other") as SourceType,
				role: typeof r.role === "string" ? r.role : "evidence",
				links: Array.isArray(r.links) ? r.links.filter((l): l is string => typeof l === "string") : [],
				verdict: r.verdict as "useExtract" | "indexOnly",
				extract: r.extract,
				turn: typeof r.turn === "number" ? r.turn : 0,
				chars: typeof r.chars === "number" ? r.chars : 0,
				inputShape: typeof r.inputShape === "string" ? r.inputShape : "",
			});
		}
	}
}

const pending = new Map<string, { toolName: string; turn: number; text: string; toolCallId: string }>();
const judged = new Set<string>();
const curated: CurRecord[] = [];
// truncate/stub verdicts held until the batch floor is met (cache economics)
const ready = new Map<string, ReadyRec>();
// In-memory raw copies so recall stays fast; bounded so long sessions can't
// grow it unbounded. The session entry is the durable fallback.
const rawStore = new Map<string, string>();
const RAW_STORE_CAP = 300;
// toolCallId → "name(input-shape)"; recent activity fingerprint for judging
const toolInputs = new Map<string, string>();
const recentTools: string[] = [];
const RECENT_CAP = 10;
// the turn right after a batch emission, for cache-reset cost accounting
let costProbeTurn: number | null = null;

function messageText(msg: RoleMessage): string {
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
		.filter(Boolean)
		.join("\n");
}

function excerpt(text: string, head = 4000, tail = 1000): string {
	if (text.length <= head + tail) return text;
	return `${text.slice(0, head)}\n[... ${text.length - head - tail} chars omitted ...]\n${text.slice(-tail)}`;
}

// ─── V3 shadow pipeline (shadow-quality mode; logs only, no context edits) ───

// count/summary lines carry the exact numbers the design says extracts must keep
const SUMMARY_LINE = /\b(summary|totals|aggregates?)\b/i;
// deterministic det-marking must be a LEVEL token, not any mention of "error"
// (a WARN line saying "retryable error" is not an error line); plain-style
// level tokens are uppercase-standalone, JSON style uses level:"error"
const ERROR_LEVEL_TOKEN = /\b(ERROR|FATAL|PANIC)\b/;
const JSON_ERROR_LEVEL = /"level"\s*:\s*"(error|fatal|panic|critical)"/i;
const isErrorLevelLine = (l: string): boolean => ERROR_LEVEL_TOKEN.test(l) || JSON_ERROR_LEVEL.test(l);

type ShadowRole = "active" | "evidence" | "background" | "irrelevant";
type SourceType = "log" | "code" | "listing" | "doc" | "other";

interface ShadowCandidate {
	entryId: string;
	toolName: string;
	toolCallId: string;
	inputShape: string;
	turn: number;
	text: string;
}

interface RoleVerdict {
	role: ShadowRole;
	prob: number;
	conf: number;
	sourceType: SourceType;
	links: string[];
	degraded: boolean;
	demoted: boolean;
}

interface Proposal {
	text: string;
	method: string;
}

const ROLE_QUESTION =
	"The assistant is running a coding session. The tool output below is already " +
	"in its context. The context curator either keeps outputs in full, replaces " +
	"them with a goal-cited extract or compact source card, or omits them from " +
	"working context (raw always stays recoverable). Judge the output's ROLE for " +
	"the session goal stated in the state — what future model turns can plausibly " +
	"build on. Judge only future utility against the GoalSpec.";

const ROLE_CRITERIA = {
	active:
		"Directly needed now: content the current plan, active edit, or test is built on — the file being edited, the error being fixed, the output being iterated on, a result later turns will quote verbatim. Keep in full.",
	evidence:
		"Contains specific facts needed to satisfy a success criterion, constraint, or open question — exact errors, ids, timestamps, counts, signatures, API shapes — while the rest of the output is not needed. A cited extract of the key lines suffices.",
	background:
		"Useful provenance only: where something came from, what was already checked or ruled out. No specific content will plausibly be quoted or reused. A one-line source card suffices.",
	irrelevant:
		"Cannot affect the session goal: fully consumed listings, duplicate or superseded reads, unrelated output. Choose ONLY at very high confidence (≥0.95); when unsure choose evidence or background.",
};

const SOURCE_TYPE_CRITERIA = {
	log: "Structured service/application logs: timestamped lines, log levels, request ids, stack traces (kubectl/docker/Loki/CI output).",
	code: "Source code or config file content from a file read (functions, classes, imports, JSON/YAML/TS).",
	listing: "Directory listings or file-search results (ls/find/grep/rg output, path lists).",
	doc: "Prose documentation: markdown design docs, tickets, README, specifications.",
	other: "None of the above: mixed output, command results, prose+code mixtures.",
};

function shadowState(c: ShadowCandidate): string {
	return scrubSecrets(
		`SESSION GOAL (GoalSpec):\n${goalspecSummary()}\n\nTOOL CALL: ${c.inputShape}\n\n` +
			`RECENT ACTIVITY (oldest→newest): ${recentTools.join(" → ")}\n\n` +
			`OUTPUT EXCERPT (${c.text.length} chars total):\n${excerpt(c.text)}`,
	);
}

function linkCriteria(): Record<string, string> | null {
	if (!spec) return null;
	const crit: Record<string, string> = { objective: `The top-level user objective itself: ${spec.userObjective}` };
	spec.successCriteria.slice(0, 10).forEach((s, i) => (crit[`criterion-${i + 1}`] = `Success criterion c${i + 1}: ${s}`));
	spec.constraints.slice(0, 10).forEach((s, i) => (crit[`constraint-${i + 1}`] = `Constraint k${i + 1}: ${s}`));
	spec.currentPlan.slice(0, 8).forEach((s, i) => (crit[`plan-${i + 1}`] = `Active plan step p${i + 1}: ${s}`));
	spec.openQuestions.slice(0, 10).forEach((s, i) => (crit[`question-${i + 1}`] = `Open question q${i + 1}: ${s}`));
	if (spec.knownFacts.length) crit["fact"] = `A known fact already established (see state).`;
	crit["none"] = "No GoalSpec item — situational only.";
	return crit;
}

async function shadowClassify(c: ShadowCandidate): Promise<RoleVerdict> {
	const state = shadowState(c);
	const roleQ = { type: "choice", instructions: ROLE_QUESTION, criteria: ROLE_CRITERIA };
	const roleQuestions: Record<string, unknown> = {};
	for (let i = 0; i < CFG.samples; i++) roleQuestions[`role${i}`] = roleQ;
	const shapeQuestions: Record<string, unknown> = {
		sourceType: { type: "choice", instructions: "What kind of source is this tool output?", criteria: SOURCE_TYPE_CRITERIA },
	};
	const links = linkCriteria();
	if (links) {
		shapeQuestions["links"] = {
			type: "choice",
			instructions: "Which GoalSpec item does this output most support or bear on?",
			criteria: links,
		};
	}
	const [roleAnswers, shapeAnswers] = await Promise.all([
		jevAsk(state, roleQuestions, SHADOW_JEV_TIMEOUT_MS),
		jevAsk(state, shapeQuestions, SHADOW_JEV_TIMEOUT_MS),
	]);

	const samples: { choice: string; prob: number; conf: number }[] = [];
	for (let i = 0; i < CFG.samples; i++) {
		const a = roleAnswers?.[`role${i}`];
		if (a && typeof a.choice === "string" && typeof a.probabilities === "object" && a.probabilities !== null) {
			samples.push({ choice: a.choice, prob: Number(a.probabilities[a.choice] ?? 0), conf: Number(a.confidence ?? 1) });
		}
	}
	if (samples.length < Math.ceil(CFG.samples / 2)) {
		// fail-safe: an unclassified source stays in full — uncertainty preserves evidence
		return { role: "active", prob: 0, conf: 0, sourceType: "other", links: [], degraded: true, demoted: false };
	}
	const counts = new Map<string, number>();
	for (const s of samples) counts.set(s.choice, (counts.get(s.choice) ?? 0) + 1);
	const choice = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
	const matching = samples.filter((s) => s.choice === choice);
	const prob = median(matching.map((s) => s.prob));
	const conf = median(matching.map((s) => s.conf));

	let role: ShadowRole;
	let demoted = false;
	if (choice === "active" || choice === "evidence" || choice === "background" || choice === "irrelevant") {
		role = choice;
	} else {
		role = "active"; // unrecognized choice: keep in full
	}
	// irrelevant demands near-certainty; anything less demotes to a source card
	if (role === "irrelevant" && (prob < 0.95 || conf < CFG.minConf)) {
		role = "background";
		demoted = true;
	}

	const st = shapeAnswers?.["sourceType"]?.choice;
	const sourceType: SourceType = st === "log" || st === "code" || st === "listing" || st === "doc" ? st : "other";
	const linkChoice = shapeAnswers?.["links"]?.choice;
	const linkSet = links ? Object.keys(links) : [];
	const linkList = typeof linkChoice === "string" && linkSet.includes(linkChoice) && linkChoice !== "none" ? [linkChoice] : [];
	return { role, prob, conf, sourceType, links: linkList, degraded: false, demoted };
}

interface ScoredLine {
	n: number;
	score: number;
	text: string;
}

// The proven jev_triage_log pattern: chunk lines, one noul relevance question
// per line against the goal, keep top-k above the cutoff.
async function scoreLines(text: string, lineQuestion: string): Promise<ScoredLine[]> {
	const lines = text
		.split(/\r?\n/)
		.slice(0, SCORE_MAX_LINES)
		.map((t, i) => ({ n: i + 1, text: t }))
		.filter((l) => l.text.trim());
	const chunks: { n: number; text: string }[][] = [];
	let cur: { n: number; text: string }[] = [];
	let curChars = 0;
	for (const l of lines) {
		if (cur.length >= SCORE_CHUNK_LINES || (cur.length > 0 && curChars + l.text.length > SCORE_CHUNK_CHARS)) {
			chunks.push(cur);
			cur = [];
			curChars = 0;
		}
		cur.push(l);
		curChars += l.text.length;
	}
	if (cur.length > 0) chunks.push(cur);
	const goalLine = `SESSION GOAL (relevance question):\n${goalspecSummary()}`;
	const perChunk = await Promise.all(
		chunks.map(async (chunk) => {
			const state = scrubSecrets(
				`${goalLine}\n\nSOURCE (numbers on the left are line numbers):\n` +
					chunk.map((l) => `${l.n}| ${l.text}`).join("\n"),
			);
			const questions: Record<string, unknown> = {};
			for (const l of chunk) questions[`L${l.n}`] = { type: "noul", instructions: `${lineQuestion} (line ${l.n})` };
			const answers = await jevAsk(state, questions, SCORE_JEV_TIMEOUT_MS);
			if (!answers) return [];
			const out: ScoredLine[] = [];
			for (const l of chunk) {
				const val = answers[`L${l.n}`]?.noul;
				if (typeof val === "number" && Number.isFinite(val)) out.push({ n: l.n, score: val, text: l.text });
			}
			return out;
		}),
	);
	const flat = perChunk.flat().filter((l) => l.score >= SCORE_MIN);
	flat.sort((a, b) => b.score - a.score || a.n - b.n);
	return flat.slice(0, SCORE_TOP_K).sort((a, b) => a.n - b.n);
}

function renderLineNums(text: string, nums: number[]): string {
	const lines = text.split(/\r?\n/);
	return nums
		.filter((n) => n >= 1 && n <= lines.length)
		.map((n) => `  L${n}| ${lines[n - 1]}`)
		.join("\n");
}

// trailing newlines would inflate split() by one empty element and misstate
// counts in extract headers — the verifier flagged exactly that
function countLines(text: string): number {
	return text.replace(/\s+$/, "").length === 0 ? 0 : text.replace(/\s+$/, "").split(/\r?\n/).length;
}

// Fit a scored-line extract to the char budget by dropping the LOWEST-scored
// lines first — a hard cut always loses the tail, where summary/count lines
// live. Deterministic (ERROR) lines are never dropped.
function fitToBudget(
	items: { n: number; score: number; det: boolean }[],
	render: (ns: number[]) => string,
	budget: number,
): string {
	const cur = [...items];
	let out = render(cur.map((p) => p.n));
	while (out.length > budget) {
		let worst = -1;
		for (let i = 0; i < cur.length; i++) {
			if (!cur[i].det && (worst === -1 || cur[i].score < cur[worst].score)) worst = i;
		}
		if (worst === -1 || cur.length <= 1) {
			return `${out.slice(0, budget)}\n  [... extract cut at budget; full raw via jev_recall]`;
		}
		cur.splice(worst, 1);
		out = render(cur.map((p) => p.n));
	}
	return out;
}

function pathFromInput(shape: string): string {
	const m = /"(?:path|file)"\s*:\s*"([^"]+)"/.exec(shape);
	return m ? m[1] : shape.slice(0, 120);
}

const LINE_QUESTIONS: Record<SourceType, string> = {
	log: "Is this log line evidence for the session goal — an error, stack frame, requestId, timestamp, count, signature, or decision the goal's criteria/questions could depend on?",
	code: "Would a later turn working toward the session goal need this line — a definition, signature, call site, invariant comment, or config value tied to the goal, criteria, plan, or open questions?",
	doc: "Is this line an acceptance criterion, constraint, API contract, explicit non-goal, decision, or fact the session goal depends on?",
	listing: "Is this listing/search line one the session goal's plan plausibly builds on — a path, match, or count that matters?",
	other: "Is this line needed as evidence for the session goal?",
};

async function buildProposal(c: ShadowCandidate, role: RoleVerdict): Promise<Proposal> {
	if (role.role === "background" || role.role === "irrelevant") {
		let card = `[Source card: ${c.toolName} (${c.text.length} chars, turn ${c.turn}) — ${role.role}: p=${role.prob.toFixed(2)};${
			role.links.length ? ` supports ${role.links.join(",")};` : ""
		} raw recoverable via jev_recall "${c.entryId}"]`;
		if (role.sourceType === "listing") {
			// per the V3 design, listings keep query + matched paths + count even
			// as source cards — a card with no paths kept getting vetoed
			const heads = c.text
				.split(/\r?\n/)
				.filter((l) => l.trim())
				.slice(0, 8);
			card = `${card}\n${countLines(c.text)} result lines; top entries:\n${heads
				.map((l) => `  ${l}`)
				.join("\n")}`;
		}
		return {
			text: card,
			method: role.role === "irrelevant" ? "card-omit" : "card",
		};
	}
	const supports = role.links.length ? `Supports: ${role.links.join(", ")}` : "Supports: session goal";
	const src = role.sourceType === "code" || role.sourceType === "doc" ? pathFromInput(c.inputShape) : c.inputShape.slice(0, 120);
	const picked = await scoreLines(c.text, LINE_QUESTIONS[role.sourceType]);
	if (picked.length === 0) {
		// generic head/tail is the fallback only when line scoring found nothing
		return {
			text: `[Source: ${c.toolName} — ${role.sourceType}, ${c.text.length} chars; ${supports}; raw via jev_recall "${c.entryId}"]\n${excerpt(c.text, 1200, 600)}`,
			method: "headtail-fallback",
		};
	}
	if (role.sourceType === "log") {
		// deterministic passthrough: error lines always survive the filter —
		// Jev narrows, it does not conclude (jev_triage_log semantics)
		const allLines = c.text.split(/\r?\n/).slice(0, SCORE_MAX_LINES);
		const chosen = new Set(picked.map((l) => l.n));
		// error/summary lines are deterministic evidence whether or not Jev picked
		// them — picked error lines must not be droppable by the budget trim
		const items: { n: number; score: number; det: boolean }[] = picked.map((l) => ({
			n: l.n,
			score: l.score,
			det: isErrorLevelLine(l.text) || SUMMARY_LINE.test(l.text),
		}));
		let det = 0;
		for (let i = 0; i < allLines.length && det < 100; i++) {
			const line = allLines[i];
			if (!chosen.has(i + 1) && line.trim() && (isErrorLevelLine(line) || SUMMARY_LINE.test(line))) {
				items.push({ n: i + 1, score: -1, det: true });
				chosen.add(i + 1);
				det++;
			}
		}
		const header = `[Source: ${c.toolName} — log output, ${countLines(c.text)} lines; ${supports}; key lines below with original line numbers; raw via jev_recall "${c.entryId}"]`;
		const render = (ns: number[]): string => {
			// ±1 neighbors keep stack/context lines with their trigger line
			const withNb = new Set<number>();
			for (const n of ns) {
				if (n > 1) withNb.add(n - 1);
				withNb.add(n);
				withNb.add(n + 1);
			}
			return `${header}\n${renderLineNums(c.text, [...withNb].sort((a, b) => a - b))}`;
		};
		return { text: fitToBudget(items, render, extractBudget(c.text.length)), method: "log-lines" };
	}
	if (role.sourceType === "listing") {
		const header = `[Source: listing/search — ${src}; ${countLines(c.text)} result lines; ${supports}; plan-relevant matches below (L# = original line numbers); raw via jev_recall "${c.entryId}"]`;
		const render = (ns: number[]): string => `${header}\n${renderLineNums(c.text, ns)}`;
		return {
			text: fitToBudget(
				picked.map((l) => ({ n: l.n, score: l.score, det: false })),
				render,
				extractBudget(c.text.length),
			),
			method: "listing-matches",
		};
	}
	// code/doc: merge picked lines into contiguous ranges (gap ≤ 3)
	picked.sort((a, b) => a.n - b.n);
	const render = (ns: number[]): string => {
		const ranges: { start: number; end: number }[] = [];
		for (const n of ns) {
			const last = ranges[ranges.length - 1];
			if (last && n - last.end <= 3) last.end = n;
			else ranges.push({ start: n, end: n });
		}
		const rangeStr = ranges.map((r) => `L${r.start}${r.end !== r.start ? `-L${r.end}` : ""}`).join(", ");
		const nums: number[] = [];
		for (const r of ranges) for (let n = r.start; n <= r.end; n++) nums.push(n);
		return `[Source: ${role.sourceType} read — ${src}; ${countLines(c.text)} lines; ${supports}; ranges for current plan: ${rangeStr}; raw via jev_recall "${c.entryId}"]\n${renderLineNums(c.text, nums)}`;
	};
	return {
		text: fitToBudget(
			picked.map((l) => ({ n: l.n, score: l.score, det: false })),
			render,
			extractBudget(c.text.length),
		),
		method: role.sourceType === "code" ? "code-ranges" : "doc-ranges",
	};
}

interface VerifyItem {
	cand: ShadowCandidate;
	role: RoleVerdict;
	proposal: Proposal;
}

interface VerifierDecision {
	id: string;
	verdict: "retainFull" | "useExtract" | "indexOnly";
	reason: string;
}

function parseVerifierJson(text: string): VerifierDecision[] | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const decisions = (parsed as Record<string, unknown>).decisions;
	if (!Array.isArray(decisions)) return null;
	const out: VerifierDecision[] = [];
	for (const d of decisions) {
		if (typeof d !== "object" || d === null) continue;
		const r = d as Record<string, unknown>;
		if (typeof r.id !== "string") continue;
		if (r.verdict !== "retainFull" && r.verdict !== "useExtract" && r.verdict !== "indexOnly") continue;
		out.push({ id: r.id, verdict: r.verdict, reason: typeof r.reason === "string" ? r.reason : "" });
	}
	return out.length > 0 ? out : null;
}

function verifierModelRef(): { provider: string; modelId: string } | null {
	const explicit = process.env.JEVCURATOR_VERIFIER_MODEL;
	if (explicit && explicit.includes("/")) {
		const i = explicit.indexOf("/");
		return { provider: explicit.slice(0, i), modelId: explicit.slice(i + 1) };
	}
	const provider = process.env.PI_PROVIDER ?? "openrouter";
	const modelId = process.env.PI_MODEL;
	if (!modelId) return null;
	return { provider, modelId };
}

function verifierPrompt(batch: VerifyItem[]): string {
	const blocks = batch
		.map((b) => {
			const st = b.role.sourceType;
			return (
				`<candidate id="${b.cand.entryId}" tool="${b.cand.toolName}" type="${st}" chars="${b.cand.text.length}">\n` +
				`Classifier: role=${b.role.role} (p=${b.role.prob.toFixed(2)}, conf=${b.role.conf.toFixed(2)}); supports: ${
					b.role.links.join(", ") || "none"
			}\n` +
				`Proposed replacement (${b.proposal.method}):\n${b.proposal.text}\n\n` +
				`Raw source${b.cand.text.length <= VERIFY_RAW_CAP ? " (complete)" : " (excerpted)"}:\n${
				b.cand.text.length <= VERIFY_RAW_CAP ? b.cand.text : excerpt(b.cand.text, 4000, 1500)
			}\n` +
				`</candidate>`
			);
		})
		.join("\n\n");
	return (
		`You are the quality gate of a context-curation system for a coding session. The raw sources below always remain recoverable via a recall tool, so nothing is lost — but only what stays in working context can be used without an explicit recall call.\n\n` +
		`SESSION GOAL STATE:\n${goalspecSummary()}\n\n` +
		`For each candidate a fast classifier proposed replacing the full output with the shown replacement. Decide per candidate:\n` +
		`- "retainFull": replacing the full source could plausibly remove information needed to satisfy a success criterion, constraint, active plan step, or open question; or the proposed replacement misses any goal-relevant claim from the raw source; or you are uncertain.\n` +
		`- "useExtract": the proposed replacement preserves every goal-relevant fact (exact ids, numbers, errors, decisions, code) from the raw source; the full raw adds nothing plausibly needed.\n` +
		`- "indexOnly": the source cannot plausibly affect the goal now or later (high confidence only).\n\n` +
		`When uncertain, retainFull.\n\n${blocks}\n\n` +
		`Respond with ONLY a JSON object, no prose:\n` +
		`{"decisions":[{"id":"<candidate id>","verdict":"retainFull|useExtract|indexOnly","reason":"<=25 words"}]}`
	);
}

interface VerifyResult {
	verdicts: Map<string, VerifierDecision>;
	model: string;
	ok: boolean;
	error: string;
	usage?: { input?: number; output?: number; cacheRead?: number };
}

async function frontierVerify(ctx: ExtensionContext, batch: VerifyItem[]): Promise<VerifyResult> {
	const ref = verifierModelRef();
	const fail = (error: string): VerifyResult => ({ verdicts: new Map(), model: ref ? `${ref.provider}/${ref.modelId}` : "(unset)", ok: false, error });
	if (!ref) return fail("no verifier model configured");
	const model = ctx.modelRegistry.find(ref.provider, ref.modelId);
	if (!model) return fail(`model ${ref.provider}/${ref.modelId} not found in registry`);
	// parse a decision list out of a response body (or null if unusable)
	const responseText = (r: { content: { type: string; text?: string }[] }): string =>
		r.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("\n");
	try {
		// one retry: reasoning-heavy models occasionally spend the whole token
		// budget thinking and emit no text; a fresh request usually succeeds
		let decisions: VerifierDecision[] | null = null;
		let usage: { input?: number; output?: number; cacheRead?: number } | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			const r = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: verifierPrompt(batch) }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: 16384, signal: AbortSignal.timeout(VERIFIER_TIMEOUT_MS), cacheRetention: "none", sessionId: uuidv7() },
			);
			const text = responseText(r);
			decisions = parseVerifierJson(text);
			usage = { input: r.usage?.input, output: r.usage?.output, cacheRead: r.usage?.cacheRead };
			if (decisions !== null) break;
			if (attempt === 0) continue;
			return fail(`unparseable verifier response (${text.length} chars)`);
		}
		if (!decisions) return fail("no verifier response");
		const verdicts = new Map<string, VerifierDecision>();
		for (const d of decisions) verdicts.set(d.id, d);
		return { verdicts, model: `${ref.provider}/${ref.modelId}`, ok: true, error: "", usage };
	} catch (e) {
		return fail(`verifier call failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}


function logShadowLine(obj: Record<string, unknown>) {
	try {
		const dir = path.join(os.homedir(), ".pi", "agent", "jev-decisions");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, SHADOW_LOG_FILE), JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
	} catch {
		// log loss must never break curation; shadow jsonl is a review aid only
	}
}

interface ShadowResult {
	cand: ShadowCandidate;
	role: RoleVerdict;
	proposal: Proposal | null;
	verdict: "retainFull" | "useExtract" | "indexOnly";
	verifierReason: string;
}

async function runShadow(
	_ctx: ExtensionContext,
	_event: TurnEndEvent,
	cands: ShadowCandidate[],
	v2Outcome: Map<string, string>,
	pct: number,
): Promise<ShadowResult[]> {
	if (cands.length === 0) return [];
	const over = cands.slice(SHADOW_MAX_PER_TURN);
	for (const c of over) {
		logShadowLine({ decision: "skipped-over-limit", entryId: c.entryId, tool: c.toolName, chars: c.text.length, turn: c.turn });
	}
	const batch = cands.slice(0, SHADOW_MAX_PER_TURN);
	const classified = await Promise.all(
		batch.map(async (c) => {
			const role = await shadowClassify(c);
			// active needs no replacement proposal; degraded means keep-in-full
			const proposal = role.role === "active" || role.degraded ? null : await buildProposal(c, role);
			return { c, role, proposal };
		}),
	);
	const needVerify = classified.filter(
		(x): x is { c: ShadowCandidate; role: RoleVerdict; proposal: Proposal } => x.proposal !== null,
	);
	let verify: VerifyResult | null = null;
	if (needVerify.length > 0) {
		verify = await frontierVerify(
			_ctx,
			needVerify.map((x) => ({ cand: x.c, role: x.role, proposal: x.proposal })),
		);
		logShadowLine({
			decision: "verifier-batch",
			count: needVerify.length,
			model: verify.model,
			ok: verify.ok,
			error: verify.error || undefined,
			usage: verify.usage,
		});
	}
	const results: ShadowResult[] = [];
	for (const { c, role, proposal } of classified) {
		shadowStats.classified++;
		shadowStats.roles[role.role]++;
		let verdict: "retainFull" | "useExtract" | "indexOnly" = "retainFull";
		let verifierReason = role.degraded ? "jev classification degraded — fail-safe retainFull" : "active — no replacement proposed";
		let verifierModel = "";
		let verifierDegraded = false;
		if (proposal && verify) {
			const d = verify.verdicts.get(c.entryId);
			if (d) {
				verdict = d.verdict;
				verifierReason = d.reason;
			} else {
				verifierDegraded = true;
			verifierReason = verify.ok ? "verifier omitted candidate — fail-safe retainFull" : `verifier failed (${verify.error}) — fail-safe retainFull`;
			}
			verifierModel = verify.model;
		}
		if (verdict === "retainFull") shadowStats.retainFull++;
		if (verdict === "useExtract") shadowStats.useExtract++;
		if (verdict === "indexOnly") shadowStats.indexOnly++;
		if (verifierDegraded || role.degraded) shadowStats.degraded++;
		logShadowLine({
			decision: "shadow",
			entryId: c.entryId,
			tool: c.toolName,
			toolCall: c.inputShape,
			turn: c.turn,
			chars: c.text.length,
			sourceType: role.sourceType,
			role: role.role,
			roleProb: Number(role.prob.toFixed(3)),
			roleConf: Number(role.conf.toFixed(3)),
			roleDemoted: role.demoted || undefined,
			links: role.links.length ? role.links : undefined,
			extractMethod: proposal?.method,
			proposedExtract: proposal?.text,
			verifierVerdict: verdict,
			verifierReason,
			verifierModel: verifierModel || undefined,
			verifierDegraded: verifierDegraded || undefined,
			goalspecVersion: spec?.version ?? 0,
			contextPct: Number(pct.toFixed(1)),
			v2: v2Outcome.get(c.entryId) ?? "not-judged",
		});
		results.push({ cand: c, role, proposal, verdict, verifierReason });
	}
	return results;
}

// Evidence mode: activate the verifier-approved replacement for log/listing
// sources. V3 supersedes V2 for these sources — a V3 edit removes the entry
// from V2's pending/ready queues and marks it judged so V2 never overwrites
// the richer extract with a generic stub/truncate.
function emitEvidence(
	event: TurnEndEvent,
	results: ShadowResult[],
	v2Outcome: Map<string, string>,
	drafts: (ContextEditEntryDraft | CustomEntryDraft)[],
): void {
	// "evidence" = log/listing scope; "quality" extends to code/doc
	if (MODE !== "evidence" && MODE !== "quality") return;
	const emitted: LedgerItem[] = [];
	for (const r of results) {
		if (r.verdict !== "useExtract" && r.verdict !== "indexOnly") continue;
		if (!r.proposal || !EVIDENCE_SCOPE.has(r.role.sourceType)) continue;
		// raw copy must exist for recall; rawStore holds it from collection
		if (rawStore.get(r.cand.entryId) === undefined) continue;
		// operational sanity, not a quality gate: when line scoring kept nearly
		// everything, the "extract" is the source plus overhead — replacing it
		// is a strictly worse representation with a cache-reset cost
		const saved = r.cand.text.length - r.proposal.text.length;
		if (saved < Math.max(500, r.cand.text.length * 0.2)) {
			logShadowLine({
				decision: "evidence-skip",
				entryId: r.cand.entryId,
				tool: r.cand.toolName,
				sourceType: r.role.sourceType,
				chars: r.cand.text.length,
				replacementLen: r.proposal.text.length,
				reason: "replacement not meaningfully smaller — keep full",
			});
			continue;
		}
		const v2 = v2Outcome.get(r.cand.entryId) ?? "not-judged";
		if (v2 === "cap" || v2.startsWith("emitted-")) {
			// V2 already replaced this entry this turn (cap-at-rest or batch
			// emission); a second context_edit on the same target is undefined,
			// so V3 stands down and the V2 representation stays
			logShadowLine({ decision: "evidence-skip", entryId: r.cand.entryId, tool: r.cand.toolName, v2, reason: "v2 already edited this turn" });
			continue;
		}
		// supersede V2's pending/ready plans for this source
		pending.delete(r.cand.entryId);
		ready.delete(r.cand.entryId);
		judged.add(r.cand.entryId);
		drafts.push({
			type: "context_edit",
			targetId: r.cand.entryId,
			replacement: { content: [{ type: "text", text: r.proposal.text }] },
		});
		const item: LedgerItem = {
			entryId: r.cand.entryId,
			toolName: r.cand.toolName,
			sourceType: r.role.sourceType,
			role: r.role.role,
			links: r.role.links,
			verdict: r.verdict,
			extract: r.proposal.text,
			turn: event.turnIndex,
			chars: r.cand.text.length,
			inputShape: r.cand.inputShape,
		};
		ledger.set(item.entryId, item);
		emitted.push(item);
		logShadowLine({
			decision: "emit-evidence",
			entryId: r.cand.entryId,
			tool: r.cand.toolName,
			sourceType: r.role.sourceType,
			verdict: r.verdict,
			chars: r.cand.text.length,
			replacementLen: r.proposal.text.length,
			v2,
		});
	}
	if (emitted.length > 0) {
		drafts.push({ type: "custom", customType: LEDGER_TYPE, data: { turn: event.turnIndex, items: emitted } });
	}
}

// ─── Jev client (same shape as ttsr / jev-mcp) ──────────────────────

let jevKeyCache: string | null | undefined;

function jevKey(): string | null {
	if (jevKeyCache !== undefined) return jevKeyCache;
	jevKeyCache = process.env.JEV_API_KEY ?? process.env.OPENROUTER_API_KEY ?? null;
	if (!jevKeyCache) {
		try {
			const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8")) as {
				openrouter?: { key?: string };
			};
			jevKeyCache = typeof auth.openrouter?.key === "string" ? auth.openrouter.key : null;
		} catch {
			// unreadable auth file is expected on fresh machines; curator fails open
			jevKeyCache = null;
		}
	}
	return jevKeyCache;
}

const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\bsk-[A-Za-z0-9_-]{10,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

function scrubSecrets(s: string): string {
	let out = s;
	for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
	return out;
}

async function jevAsk(
	state: string,
	questions: Record<string, unknown>,
	timeoutMs: number = JEV_TIMEOUT_MS,
): Promise<Record<string, JevChoiceAnswer> | null> {
	const key = jevKey();
	if (!key) return null;
	// one retry with backoff: a transient 429/5xx should not silently degrade a verdict
	for (let attempt = 0; attempt < 2; attempt++) {
		let res: Response;
		try {
			res = await fetch(`${JEV_BASE_URL}/v1/systemone`, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: JEV_MODEL, state, questions }),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			await new Promise((r) => setTimeout(r, 600));
			continue;
		}
		if (!res.ok) {
			if (res.status === 429 || res.status >= 500) {
				await new Promise((r) => setTimeout(r, 600));
				continue;
			}
			return null;
		}
		try {
			const j = (await res.json()) as JevResponse;
			return j.answers ?? null;
		} catch {
			// non-JSON body only happens on provider-side faults; fail open
			return null;
		}
	}
	return null;
}

// ─── Verdict ─────────────────────────────────────────────────────────

const QUESTION =
	"The assistant is running a coding session. The tool output below is " +
	"already in its context. Future model requests may shrink it — to a " +
	"head/tail excerpt if only fragments will be needed (truncate), or to a " +
	"one-line stub if nothing further is needed (stub) — unless it must stay " +
	"in full (keep). Judge only future utility.";

const CRITERIA = {
	keep: "Output the model may still need in later turns: file contents in the area the session goal targets (later edits or reasoning are often built directly on them), errors under investigation, test output still being iterated on, results that took effort to obtain, reference material the session consults repeatedly, or data that cannot be re-fetched cheaply. When unsure, keep.",
	truncate: "Output the model may still need parts of but not in full: large log/query/read results where only specific fragments (signatures, counts, ids, paths) will be referenced, or partially superseded investigation output. The head/tail excerpt keeps the gist in context.",
	stub: "Output whose value was fully consumed in the turn it arrived: directory or tool listings, package.json/config dumps, exploratory greps or finds that were only used to locate something, verbose logs already triaged, boilerplate, or superseded duplicate reads. Re-fetchable exploration noise.",
};

interface Gates {
	stub: number;
	trunc: number;
	floor: number;
}

function median(nums: number[]): number {
	const s = [...nums].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

async function judge(toolName: string, text: string, toolCallId: string, gates: Gates): Promise<Verdict> {
	const inputShape = toolInputs.get(toolCallId) ?? "(input unavailable)";
	const activity = recentTools.join(" → ");
	const state = scrubSecrets(
		`SESSION GOAL:\n${goal ?? "(unpinned)"}\n\nTOOL CALL: ${inputShape}\n\n` +
			`RECENT ACTIVITY (oldest→newest): ${activity}\n\n` +
			`OUTPUT EXCERPT (${text.length} chars total):\n${excerpt(text)}`,
	);
	const q = { type: "choice", instructions: QUESTION, criteria: CRITERIA };
	const questions: Record<string, unknown> = {};
	for (let i = 0; i < CFG.samples; i++) questions[`v${i}`] = q;
	const answers = await jevAsk(state, questions);

	const samples: { choice: string; prob: number; conf: number }[] = [];
	for (let i = 0; i < CFG.samples; i++) {
		const a = answers?.[`v${i}`];
		if (a && typeof a.choice === "string" && typeof a.probabilities === "object" && a.probabilities !== null) {
			samples.push({ choice: a.choice, prob: Number(a.probabilities[a.choice] ?? 0), conf: Number(a.confidence ?? 1) });
		}
	}
	if (samples.length < Math.ceil(CFG.samples / 2)) {
		return { kind: "keep", prob: 0, conf: 0, degraded: true };
	}
	const counts = new Map<string, number>();
	for (const s of samples) counts.set(s.choice, (counts.get(s.choice) ?? 0) + 1);
	const choice = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
	const matching = samples.filter((s) => s.choice === choice);
	const prob = median(matching.map((s) => s.prob));
	const conf = median(matching.map((s) => s.conf));
	// ladder: stub needs its own gate; a stub-short verdict can still truncate
	if (choice === "stub" && prob >= gates.stub && conf >= CFG.minConf) {
		return { kind: "stub", prob, conf, degraded: false };
	}
	if ((choice === "stub" || choice === "truncate") && prob >= gates.trunc && conf >= CFG.minConf) {
		return { kind: "truncate", prob, conf, degraded: false };
	}
	return { kind: "keep", prob, conf, degraded: false };
}

// ─── Goal pinning ────────────────────────────────────────────────────

function messageEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function ensureGoal(ctx: ExtensionContext) {
	// No memoized "attempted" flag: at the first turn_start the user entry
	// may not be in the session yet, so retry until a goal is actually found.
	if (goal) return;
	let entries: readonly SessionEntry[];
	try {
		entries = ctx.sessionManager.getEntries();
	} catch {
		// unreadable session keeps the goal unpinned; the curator stays inert
		return;
	}
	let latestGoal: string | null = null;
	for (const e of entries) {
		if (e.type === "custom" && e.customType === GOAL_TYPE && e.data && typeof (e.data as { goal?: unknown }).goal === "string") {
			// multiple writers over a session (pin_goal, /goal): latest pin wins
			latestGoal = (e.data as { goal: string }).goal;
		}
	}
	if (latestGoal !== null) {
		goal = latestGoal;
		return;
	}
	for (const e of entries) {
		if (messageEntry(e) && isRoleMessage(e.message) && e.message.role === "user") {
			goal = messageText(e.message).trim() || null;
			return;
		}
	}
}

// ─── Replacement text builders ─────────────────────────────────────────

function recallHint(entryId: string): string {
	return `call jev_recall with entry_id "${entryId}" (optional offset/limit) to read any part verbatim`;
}

function capText(toolName: string, entryId: string, chars: number): string {
	return (
		`[curated by jev] ${toolName} output (${chars} chars) exceeded the single-output cap (${CFG.ingestCap}) — ` +
		`first ${CFG.capHead} and last ${CFG.capTail} chars kept; the full output is intact in session history — ` +
		`${recallHint(entryId)}.`
	);
}

function truncateText(toolName: string, entryId: string, chars: number, prob: number): string {
	return (
		`[curated by jev] ${toolName} output (${chars} chars) was judged fragment-level relevant (p=${prob.toFixed(2)}) — ` +
		`a head/tail excerpt is kept; the full output is intact in session history — ${recallHint(entryId)}.`
	);
}

function stubText(toolName: string, entryId: string, chars: number, prob: number): string {
	return (
		`[curated by jev] ${toolName} output (${chars} chars) was judged not needed for the session goal ` +
		`(p=${prob.toFixed(2)}). The raw content is intact in session history — ${recallHint(entryId)}. ` +
		`If this judgment looks wrong because the pinned goal is stale, refine it with pin_goal.`
	);
}

function logLine(obj: Record<string, unknown>) {
	try {
		const dir = path.join(os.homedir(), ".pi", "agent", "jev-decisions");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "jev-curator.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
	} catch {
		// log loss must never break curation; jsonl is a tuning aid only
	}
}

function logDecision(d: CurRecord, decision: string) {
	logLine({ decision, ...d });
}

function logBatch(decision: string, count: number, saved: number, reason: string) {
	logLine({ decision: `batch-${decision}`, count, saved, reason });
}

// V2 due-judge-emit flow, extracted so the shadow pipeline can run after V2's
// per-turn outcomes are known. Behavior is byte-identical to the pre-V3
// inline code; returns only the drafts it produced.
async function v2DueAndEmit(
	event: TurnEndEvent,
	gates: Gates,
	pct: number,
	v2Outcome: Map<string, string>,
): Promise<(ContextEditEntryDraft | CustomEntryDraft)[]> {
	const out: (ContextEditEntryDraft | CustomEntryDraft)[] = [];
	const due = [...pending.entries()].filter(([, c]) => event.turnIndex - c.turn >= CFG.recencyTurns);
	if (due.length > 0) {
		const verdicts = await Promise.all(
			due.map(([entryId, c]) => judge(c.toolName, c.text, c.toolCallId, gates).then((v) => [entryId, c, v] as const)),
		);
		for (const [entryId, c, v] of verdicts) {
			judged.add(entryId);
			pending.delete(entryId);
			const decision = v.degraded ? "degraded" : v.kind;
			v2Outcome.set(entryId, decision);
			logDecision({ entryId, toolName: c.toolName, turn: c.turn, chars: c.text.length, prob: v.prob, conf: v.conf, kind: "stub", replacementLen: 0 }, decision);
			if (v.kind === "keep" || curated.length + ready.size >= CFG.maxStubs) continue;
			const replacementLen = v.kind === "stub" ? 0 : CFG.truncHead + CFG.truncTail + 400;
			ready.set(entryId, { entryId, toolName: c.toolName, turn: c.turn, chars: c.text.length, prob: v.prob, conf: v.conf, kind: v.kind, replacementLen });
		}
	}
	if (ready.size === 0) return out;
	const savedTotal = [...ready.values()].reduce((n, r) => n + Math.max(r.chars - r.replacementLen, 0), 0);
	const oldestTurn = Math.min(...[...ready.values()].map((r) => r.turn));
	const agedOut = event.turnIndex - oldestTurn >= CFG.maxHoldTurns;
	if (!(savedTotal >= gates.floor || agedOut)) {
		logBatch("hold", ready.size, savedTotal, `turn=${event.turnIndex} pct=${pct.toFixed(1)}`);
		return out;
	}
	const emitted: CurRecord[] = [];
	for (const [entryId, rec] of ready) {
		if (rawStore.get(entryId) === undefined) {
			// raw copy evicted; can't build a faithful replacement — keep
			ready.delete(entryId);
			continue;
		}
		const text =
			rec.kind === "stub"
				? stubText(rec.toolName, entryId, rec.chars, rec.prob)
				: truncateText(rec.toolName, entryId, rec.chars, rec.prob);
		out.push({ type: "context_edit", targetId: entryId, replacement: { content: [{ type: "text", text }] } });
		v2Outcome.set(entryId, `emitted-${rec.kind}`);
		emitted.push({ ...rec, replacementLen: text.length });
	}
	ready.clear();
	if (emitted.length === 0) return out;
	costProbeTurn = event.turnIndex + 1;
	curated.push(...emitted);
	logBatch("emit", emitted.length, savedTotal, agedOut ? "aged" : pct >= CFG.criticalPct ? "critical" : "batch-floor");
	out.push({ type: "custom", customType: AUDIT_TYPE, data: { turn: event.turnIndex, emitted } });
	return out;
}

// ─── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("turn_start", (_event, ctx) => {
		ensureGoal(ctx);
	});

	pi.on("tool_call", (event: ToolCallEvent) => {
		try {
			const shape = `${event.toolName}(${scrubSecrets(JSON.stringify(event.input ?? {})).slice(0, 160)})`;
			toolInputs.set(event.toolCallId, shape);
			recentTools.push(shape);
			if (recentTools.length > RECENT_CAP) recentTools.shift();
			if (toolInputs.size > 400) {
				const oldest = toolInputs.keys().next().value;
				if (oldest !== undefined) toolInputs.delete(oldest);
			}
		} catch {
			// input tracking is advisory; never block a tool call
		}
	});

	pi.registerTool(
		defineTool({
			name: "pin_goal",
			label: "Pin session goal",
			description:
				"Update the pinned session goal used by the context curator. Call when your understanding of the session's goal materially improves — right after reading a linked ticket or issue, when the user adds or changes direction, or once the real success criterion is clear. One or two sentences, self-contained (no pronouns), specific: the derived intent (e.g. the ticket's actual defect and fix criterion), not a link. The current pin is visible via /goal.",
			parameters: Type.Object({
				goal: Type.String({ description: "The refined session goal, one or two sentences, no pronouns, ≤400 chars" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const text = params.goal.trim().slice(0, 400);
				if (!text) throw new Error("goal must be non-empty");
				// flushed to a GOAL_TYPE custom entry at the turn boundary —
				// appendEntry is command-only, so the tool defers persistence
				pendingGoal = text;
				if (V3) {
					// V3: a model pin is a derived refinement; the user's own
					// objective is never silently replaced by it
					ensureGoalSpec(ctx);
					if (spec) amendSpec((s) => s.objectiveRefinements.push(text));
				}
				return { content: [{ type: "text", text: `Session goal pinned: ${text}` }], details: undefined };
			},
		}),
	);

	if (V3) {
		pi.registerTool(
			defineTool({
				name: "amend_goalspec",
				label: "Amend session GoalSpec",
					description:
					"Record a discovery into the session GoalSpec used by the context curator to judge evidence relevance. Call when material information appears: acceptance criteria or constraints from a ticket/spec/API contract you just read (add_success_criteria / add_constraints), a change in the approach (set_plan / add_plan_steps), a confirmed fact with its source entry ids (add_facts), or a new blocking question / a resolved one (add_open_questions / resolve_open_questions). The full spec is visible via /goal.",
				parameters: Type.Object({
					add_success_criteria: Type.Optional(Type.Array(Type.String({ description: "A success criterion to satisfy (observable behavior, acceptance condition)" }))),
					add_constraints: Type.Optional(Type.Array(Type.String({ description: "A constraint to respect (must-not, scope limit, read-only prod, etc.)" }))),
					set_plan: Type.Optional(Type.Array(Type.String({ description: "Replace the current plan with these ordered steps (use when direction changed)" }))),
					add_plan_steps: Type.Optional(Type.Array(Type.String({ description: "Append steps to the current plan" }))),
					add_facts: Type.Optional(
						Type.Array(
							Type.Object({
								fact: Type.String({ description: "A confirmed fact worth remembering, self-contained" }),
								source_ids: Type.Optional(Type.Array(Type.String({ description: "Entry ids / paths this fact came from" }))),
							}),
						),
					),
					add_open_questions: Type.Optional(Type.Array(Type.String({ description: "A question that still blocks or shapes completion" }))),
					resolve_open_questions: Type.Optional(Type.Array(Type.String({ description: "Open questions to drop (by index, 1-based, or their text)" }))),
				}),
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				ensureGoalSpec(ctx); // seed from the session before refusing — the
				// first user prompt exists mid-turn even if no boundary ran yet
				if (!spec) throw new Error("GoalSpec not seeded yet (no user prompt seen)");
				const changes: string[] = [];
				if (params.add_success_criteria && params.add_success_criteria.length > 0) {
					const items = params.add_success_criteria.map((s) => s.trim()).filter(Boolean);
					if (items.length > 0) amendSpec((s) => s.successCriteria.push(...items));
					changes.push(`+${items.length} criteria`);
				}
				if (params.add_constraints && params.add_constraints.length > 0) {
					const items = params.add_constraints.map((s) => s.trim()).filter(Boolean);
					if (items.length > 0) amendSpec((s) => s.constraints.push(...items));
					changes.push(`+${items.length} constraints`);
				}
				if (params.set_plan && params.set_plan.length > 0) {
					const items = params.set_plan.map((s) => s.trim()).filter(Boolean);
					if (items.length > 0) amendSpec((s) => (s.currentPlan = items));
					changes.push(`plan → ${items.length} steps`);
				}
				if (params.add_plan_steps && params.add_plan_steps.length > 0) {
					const items = params.add_plan_steps.map((s) => s.trim()).filter(Boolean);
					if (items.length > 0) amendSpec((s) => s.currentPlan.push(...items));
					changes.push(`+${items.length} plan steps`);
				}
				if (params.add_facts && params.add_facts.length > 0) {
					const facts = params.add_facts.map(specFactFrom).filter((f): f is GoalSpecFact => f !== null);
					if (facts.length > 0) amendSpec((s) => s.knownFacts.push(...facts));
					changes.push(`+${facts.length} facts`);
				}
				if (params.add_open_questions && params.add_open_questions.length > 0) {
					const items = params.add_open_questions.map((s) => s.trim()).filter(Boolean);
					if (items.length > 0) amendSpec((s) => s.openQuestions.push(...items));
					changes.push(`+${items.length} questions`);
				}
				if (params.resolve_open_questions && params.resolve_open_questions.length > 0) {
					const specRef = spec;
					const before = specRef.openQuestions.length;
					for (const q of params.resolve_open_questions) {
						const idx = Number(q);
						specRef.openQuestions = specRef.openQuestions.filter((o, i) => !(Number.isFinite(idx) && String(i + 1) === q) && o !== q);
					}
					if (specRef.openQuestions.length !== before) {
						changes.push(`-${before - specRef.openQuestions.length} questions`);
						specDirty = true;
					}
				}
				if (changes.length === 0) return { content: [{ type: "text", text: "GoalSpec unchanged (nothing to amend)." }], details: undefined };
				logShadowLine({
					decision: "goalspec-amended",
					fields: changes.join(", "),
					goalspecVersion: spec.version + 1,
					userObjective: spec.userObjective,
				});
				return {
					content: [{ type: "text", text: `GoalSpec amended: ${changes.join(", ")} — flushed at the next turn boundary. Current spec:
${goalspecSummary()}` }],
					details: undefined,
				};
			},
			}),
		);
	}

	pi.on("turn_end", async (event: TurnEndEvent, ctx): Promise<{ entries: (ContextEditEntryDraft | CustomEntryDraft)[] } | void> => {
		const drafts: (ContextEditEntryDraft | CustomEntryDraft)[] = [];
		if (pendingGoal !== null) {
			goal = pendingGoal;
			drafts.push({ type: "custom", customType: GOAL_TYPE, data: { goal: pendingGoal } });
			pendingGoal = null;
		}
		if (V3) {
			ensureGoalSpec(ctx);
			// amendments applied in-memory by tools; persisted here — appendEntry
			// is command-only, so the GoalSpec flushes like the goal pin
			if (specDirty && spec) {
				spec.version++;
				drafts.push({ type: "custom", customType: GOALSPEC_TYPE, data: { ...spec } });
				specDirty = false;
			}
		}
		if (!CFG.on) {
			return drafts.length > 0 ? { entries: drafts } : undefined;
		}
		ensureGoal(ctx);
		if (!goal) return;

		// cache-reset cost accounting: the request right after an emit reveals
		// whether the prefix was re-billed (input spike, cacheRead collapse)
		if (costProbeTurn === event.turnIndex) {
			const u = isRoleMessage(event.message) && event.message.role === "assistant" ? event.message.usage : undefined;
			if (u) {
				logBatch("cost", 1, 0, `input=${u.input ?? 0} cacheRead=${u.cacheRead ?? 0} after-emit`);
			}
			costProbeTurn = null;
		}

		const usage = ctx.getContextUsage();
		const pct = usage?.percent ?? 0;
		const gates: Gates = { stub: CFG.stubProb, trunc: CFG.truncProb, floor: CFG.minBatchSaved };
		if (pct >= CFG.criticalPct) {
			// critical: selective truncation beats a lossy full compaction
			gates.stub = Math.min(gates.stub, 0.7);
			gates.trunc = Math.min(gates.trunc, 0.5);
			gates.floor = 0;
		} else if (pct >= CFG.contextFloorPct) {
			gates.trunc = Math.min(gates.trunc, 0.5);
		}

		// shadow candidates are collected before V2's cap pass so the same
		// tool results feed both pipelines; classification runs after V2's
		// turn outcomes are known, and never issues context edits
		const v2Outcome = new Map<string, string>();
		const shadowCands: ShadowCandidate[] = [];
		if (V3 && spec) {
			for (const entryId of event.toolResultEntryIds) {
				let entry: SessionEntry | undefined;
				try {
					entry = ctx.sessionManager.getEntry(entryId);
				} catch {
					continue;
			}
				if (!entry || !messageEntry(entry)) continue;
				const msg = entry.message;
				if (!isRoleMessage(msg) || msg.role !== "toolResult" || msg.isError) continue;
				if (NEVER_PRUNE.has(msg.toolName) || msg.toolName.startsWith("mcp__jev")) continue;
				if (shadowJudged.has(entryId)) continue;
				const text = messageText(msg);
				if (text.length < CFG.minChars) continue;
				shadowJudged.add(entryId);
				shadowCands.push({
					entryId,
					toolName: msg.toolName,
					toolCallId: msg.toolCallId,
					inputShape: toolInputs.get(msg.toolCallId) ?? "(input unavailable)",
					turn: event.turnIndex,
					text,
				});
			}
		}

		for (const entryId of event.toolResultEntryIds) {
			let entry: SessionEntry | undefined;
			try {
				entry = ctx.sessionManager.getEntry(entryId);
			} catch {
				continue;
			}
			if (!entry || !messageEntry(entry)) continue;
			const msg = entry.message;
			if (!isRoleMessage(msg) || msg.role !== "toolResult" || msg.isError) continue;
			if (NEVER_PRUNE.has(msg.toolName) || msg.toolName.startsWith("mcp__jev")) continue;
			if (judged.has(entryId)) continue;
			const text = messageText(msg);

			// cap-at-rest: excerpt extreme outputs before first exposure. The
			// full bulk is never billed and no cache reset is ever paid; the
			// entry is marked judged so a later verdict cannot re-count it.
			if (text.length > CFG.ingestCap) {
				const replacement = capText(msg.toolName, entryId, text.length);
				rawStore.set(entryId, text);
				if (rawStore.size > RAW_STORE_CAP) {
					const oldest = rawStore.keys().next().value;
					if (oldest !== undefined) rawStore.delete(oldest);
				}
				drafts.push({ type: "context_edit", targetId: entryId, replacement: { content: [{ type: "text", text: replacement }] } });
				judged.add(entryId);
				v2Outcome.set(entryId, "cap");
				const rec: CurRecord = { entryId, toolName: msg.toolName, turn: event.turnIndex, chars: text.length, prob: 1, conf: 1, kind: "cap", replacementLen: replacement.length };
				curated.push(rec);
				logDecision(rec, "cap");
				continue;
			}
			if (text.length < CFG.minChars) continue;
			pending.set(entryId, { toolName: msg.toolName, turn: event.turnIndex, text, toolCallId: msg.toolCallId });
			rawStore.set(entryId, text);
			if (rawStore.size > RAW_STORE_CAP) {
				const oldest = rawStore.keys().next().value;
				if (oldest !== undefined) rawStore.delete(oldest);
			}
		}

		drafts.push(...(await v2DueAndEmit(event, gates, pct, v2Outcome)));

		// V3 pipeline: classify, propose, verify, log; evidence mode additionally
		// activates the verifier-approved replacements for log/listing sources
		if (V3 && spec && shadowCands.length > 0) {
			const results = await runShadow(ctx, event, shadowCands, v2Outcome, pct);
			emitEvidence(event, results, v2Outcome, drafts);
		}
		if (V3) hydrateLedger(ctx);
		return drafts.length > 0 ? { entries: drafts } : undefined;
	});

	// quality mode: compaction must never lose goal state or the evidence index.
	// The frontier summary carries the complete GoalSpec + ledger verbatim;
	// on any failure the default compaction runs unchanged.
	if (MODE === "quality") {
		pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
			ensureGoalSpec(ctx);
			hydrateLedger(ctx);
			const { preparation, signal } = event;
			const ref = verifierModelRef();
			if (!ref) return;
			const model = ctx.modelRegistry.find(ref.provider, ref.modelId);
			if (!model) return;
			const allMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
			if (allMessages.length === 0) return;
			const ledgerIndex =
				[...ledger.values()]
					.map(
						(l) =>
							`- ${l.entryId} · ${l.toolName} · ${l.sourceType}/${l.role} · ${l.chars} chars condensed (${l.verdict}) · raw via jev_recall "${l.entryId}" (offset/limit)\n  extract head: ${l.extract.slice(0, 400).replace(/\n/g, " | ")}`,
					)
					.join("\n") || "(no sources condensed yet)";
			const previous = preparation.previousSummary
				? `\nPrevious session summary (merge it; keep every still-relevant part):\n${preparation.previousSummary}\n`
				: "";
			const prompt =
				`You are compacting a coding session. Your summary REPLACES the older conversation (recent messages stay verbatim after it), so it must let the assistant continue the task with no loss of goal-relevant information.\n\n` +
				`MANDATORY sections, in order:\n` +
				`## SESSION GOAL (GoalSpec)\nReproduce the structured goal state below COMPLETELY, field by field — the user objective is authoritative and must never be dropped or paraphrased into loss:\n${goalspecSummary()}\n\n` +
				`## EVIDENCE LEDGER\nThese sources were condensed out of working context this session. The assistant pages raw content back with the jev_recall tool by entry id, so the ids must survive verbatim:\n${ledgerIndex}\n\n` +
				`## SUMMARY\nFrom the conversation below: goals discussed, decisions and their rationale, code changes and technical details, current state of ongoing work, blockers/open questions, planned next steps. Include every fact, id, file path, error signature, and constraint later turns could need.${previous}\n\n` +
				`<conversation>\n${serializeConversation(convertToLlm(allMessages))}\n</conversation>`;
			try {
				const response = await ctx.modelRegistry.complete(
					model,
					{
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: prompt }],
								timestamp: Date.now(),
							},
						],
					},
					{ maxTokens: 16384, signal, cacheRetention: "none", sessionId: uuidv7() },
				);
				const summary = response.content
					.filter((b): b is { type: "text"; text: string } => b.type === "text")
					.map((b) => b.text)
					.join("\n");
				if (!summary.trim() || signal.aborted) return;
				logShadowLine({
					decision: "compaction",
					reason: event.reason,
					tokensBefore: preparation.tokensBefore,
					summaryLen: summary.length,
					goalspecVersion: spec?.version ?? 0,
					ledgerSources: ledger.size,
					model: `${ref.provider}/${ref.modelId}`,
					usage: { input: response.usage?.input, output: response.usage?.output, cacheRead: response.usage?.cacheRead },
				});
				return {
					compaction: {
						summary,
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						usage: response.usage,
					},
				};
			} catch {
				// compaction is too critical to fail hard; default path runs
				return;
			}
		});
	}

	pi.on("session_compact", () => {
		// entries before the compaction point are gone from model context;
		// raw session history remains the durable recall fallback
		pending.clear();
		ready.clear();
		judged.clear();
		rawStore.clear();
		// shadow dedup is per-model-context lifetime; the GoalSpec itself is
		// durable state and deliberately survives compaction in memory
		shadowJudged.clear();
	});

	pi.registerTool(
		defineTool({
			name: "jev_recall",
			label: "Recall curated output",
			description:
				"Restore a tool output that the context curator stubbed or truncated. Call with no arguments to list curated outputs; pass entry_id to read the raw content (use offset/limit to page through large outputs).",
			parameters: Type.Object({
				entry_id: Type.Optional(Type.String({ description: "Entry id of the curated output (from its notice or the listing)" })),
				offset: Type.Optional(Type.Number({ description: "Start reading the raw content at this character offset" })),
				limit: Type.Optional(Type.Number({ description: "Read at most this many characters from the offset" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!params.entry_id) {
					if (curated.length === 0 && ledger.size === 0) {
						return { content: [{ type: "text", text: "No outputs have been curated in this session." }], details: undefined };
					}
					const parts: string[] = [];
					if (curated.length > 0) {
						parts.push(
							`Curated outputs (oldest first):\n${curated
								.map(
									(s) =>
										`${s.entryId}  ${s.kind}  ${s.toolName}  ${s.chars} chars  p=${s.prob.toFixed(2)}  (turn ${s.turn})`,
								)
								.join("\n")}`,
						);
					}
					if (ledger.size > 0) {
						parts.push(
							`Evidence-extracted sources (search with curator_find, page raw with jev_recall):\n${[...ledger.values()]
								.map((l) => `${l.entryId}  ${l.sourceType}  ${l.toolName}  ${l.chars} chars → ${l.extract.length}-char ${l.verdict}  (turn ${l.turn})`)
								.join("\n")}`,
						);
					}
					return { content: [{ type: "text", text: parts.join("\n\n") }], details: undefined };
				}
				let raw = rawStore.get(params.entry_id);
				if (raw === undefined) {
					const entry = ctx.sessionManager.getEntry(params.entry_id);
					raw = entry && messageEntry(entry) && isRoleMessage(entry.message) ? messageText(entry.message) : undefined;
				}
				if (raw === undefined || raw === "") {
					throw new Error(`No raw content found for entry ${params.entry_id}`);
				}
				let out = raw;
				if (params.offset !== undefined || params.limit !== undefined) {
					const start = Math.max(0, params.offset ?? 0);
					const end = params.limit !== undefined ? Math.min(start + params.limit, raw.length) : raw.length;
					out = `[recall slice: chars ${start}..${end} of ${raw.length}]\n${raw.slice(start, end)}`;
				}
				return { content: [{ type: "text", text: out }], details: undefined };
			},
		}),
	);

	if (MODE === "evidence" || MODE === "quality") {
		pi.registerTool(
			defineTool({
				name: "curator_find",
				label: "Search curated evidence",
				description:
					"Search the context curator's evidence ledger for a condensed source relevant to a question — e.g. 'where did we see the kafka broker timeouts' or 'which log showed the 429 rate limits'. Returns matching source cards with their goal-relevant extracts and the raw entry ids; page the raw content with jev_recall. Use when you need a fact you remember seeing earlier but which is no longer visible in full.",
				parameters: Type.Object({
					query: Type.String({ description: "What you are looking for, in natural language" }),
				limit: Type.Optional(Type.Number({ description: "Max sources to return (default 5)" })),
				}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				hydrateLedger(ctx);
				if (ledger.size === 0) {
					return { content: [{ type: "text", text: "Evidence ledger is empty (nothing extracted yet)." }], details: undefined };
				}
				const limit = Math.max(1, Math.min(20, params.limit ?? 5));
				const query = params.query.trim();
				// lexical prefilter/sort key: token overlap over extract + tool + input
				const tokens = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
				const scoreLexical = (l: LedgerItem): number => {
					const hay = `${l.extract}\n${l.toolName}\n${l.inputShape}\n${l.links.join(" ")}`.toLowerCase();
					return tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
				};
				const items = [...ledger.values()];
				// Jev rerank against the GoalSpec; lexical order is the fail-open fallback
				const state = scrubSecrets(
					`SESSION GOAL (GoalSpec):\n${goalspecSummary()}\n\nSEARCH QUERY: ${query}\n\nEVIDENCE LEDGER SOURCES:\n${items
						.map((l, i) => `C${i + 1} [${l.sourceType}/${l.role}, turn ${l.turn}, ${l.chars} chars, tool ${l.toolName}]\n${l.extract.slice(0, 600)}`)
						.join("\n\n")}`,
				);
				const questions: Record<string, unknown> = {};
				items.forEach((_, i) => {
					questions[`C${i + 1}`] = {
						type: "noul",
					instructions: `Does ledger source C${i + 1} answer the search query? (1 = directly, 0 = not at all)`,
					};
				});
				let ranked: LedgerItem[];
				const answers = await jevAsk(state, questions, SHADOW_JEV_TIMEOUT_MS);
				if (answers) {
						const scored = items.map((l, i) => ({ l, s: Number((answers[`C${i + 1}`] as { noul?: unknown } | undefined)?.noul ?? -1) }));
						ranked = scored
							.filter((x) => x.s >= 0.4)
							.sort((a, b) => b.s - a.s || scoreLexical(b.l) - scoreLexical(a.l))
							.map((x) => x.l);
						if (ranked.length === 0) ranked = items.slice().sort((a, b) => scoreLexical(b) - scoreLexical(a));
				} else {
						// Jev unavailable: pure lexical order
					ranked = items.slice().sort((a, b) => scoreLexical(b) - scoreLexical(a));
				}
				const out = ranked.slice(0, limit).map((l, i) => {
					const head = l.extract.length > 900 ? `${l.extract.slice(0, 900)}\n  [... extract continues — jev_recall "${l.entryId}" for raw ...]` : l.extract;
					return `#${i + 1} [${l.sourceType} · ${l.role} · turn ${l.turn} · ${l.chars} chars condensed to ${l.extract.length}]\n${head}\nRaw paging: jev_recall entry_id "${l.entryId}" with offset/limit`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Evidence ledger search for "${query}" (${ranked.length} match${ranked.length === 1 ? "" : "es"}, showing ${Math.min(limit, out.length)}):\n\n${out.join("\n\n")}`,
						},
					],
					details: undefined,
				};
			},
		}),
		);
	}

	pi.registerCommand("goal", {
		description: "Show or set the session goal used by the context curator",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				if (V3) {
					ensureGoalSpec(ctx);
					ctx.ui.notify(spec ? `GoalSpec v${spec.version}:\n${goalspecSummary()}` : "No GoalSpec yet (first user prompt seeds it).", "info");
					return;
				}
				ctx.ui.notify(goal ? `Session goal: ${goal}` : "No goal pinned yet (first user prompt becomes the goal).", "info");
				return;
			}
			pi.appendEntry(GOAL_TYPE, { goal: text });
			goal = text;
			if (V3) {
				// the user is the only writer allowed to replace the objective
				ensureGoalSpec(ctx);
				if (spec) {
					spec.userObjective = text;
					spec.version++;
					specDirty = false;
					pi.appendEntry(GOALSPEC_TYPE, { ...spec });
				}
			}
			ctx.ui.notify(`Session goal pinned: ${text}`, "info");
		},
	});

	pi.registerCommand("curator", {
		description: "Show curator stats; pass off/on to toggle",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off" || arg === "on") {
				CFG.on = arg === "on";
				ctx.ui.notify(`Curator ${CFG.on ? "enabled" : "disabled"}.`, "info");
				return;
			}
			const savedChars = curated.reduce((n, s) => n + Math.max(s.chars - s.replacementLen, 0), 0);
			const byKind = { stub: 0, truncate: 0, cap: 0 };
			for (const s of curated) byKind[s.kind]++;
			const shadow =
				V3
					? ` · shadow: classified=${shadowStats.classified} roles(a/e/b/i)=${shadowStats.roles.active}/${shadowStats.roles.evidence}/${
							shadowStats.roles.background
						}/${shadowStats.roles.irrelevant} verdicts(R/U/X)=${shadowStats.retainFull}/${shadowStats.useExtract}/${shadowStats.indexOnly} degraded=${shadowStats.degraded} goalspec=v${
						spec?.version ?? 0
					}`
				: "";
			ctx.ui.notify(
				`curator: ${CFG.on ? "on" : "off"} · caps=${byKind.cap} truncs=${byKind.truncate} stubs=${byKind.stub} · ` +
					`~${Math.round(savedChars / 1000)}k chars saved · pending=${pending.size} held=${ready.size} · ` +
					`goal=${goal ? "pinned" : "none"}${shadow}`,
				"info",
			);
		},
	});
}

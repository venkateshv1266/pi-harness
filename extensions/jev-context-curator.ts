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
 * Kill switch: JEVCURATOR=0. Tunables: JEVCURATOR_MIN_CHARS (1500),
 * JEVCURATOR_RECENCY_TURNS (3), JEVCURATOR_STUB_PROB (0.85),
 * JEVCURATOR_TRUNC_PROB (0.60), JEVCURATOR_MIN_CONF (0.65),
 * JEVCURATOR_MAX_STUBS (150), JEVCURATOR_MIN_BATCH_SAVED (3000),
 * JEVCURATOR_CONTEXT_FLOOR_PCT (70), JEVCURATOR_CRITICAL_PCT (85),
 * JEVCURATOR_MAX_HOLD_TURNS (10), JEVCURATOR_INGEST_CAP (25000),
 * JEVCURATOR_SAMPLES (3).
 */

import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ContextEditEntryDraft,
	type CustomEntryDraft,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type SessionMessageEntry,
	type ToolCallEvent,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GOAL_TYPE = "jev-curator-goal";
const AUDIT_TYPE = "jev-curator-stubs";

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
}

interface JevResponse {
	answers?: Record<string, JevChoiceAnswer>;
}

let goal: string | null = null;
// set by the pin_goal tool, flushed to a session entry at the next turn_end
let pendingGoal: string | null = null;
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

async function jevAsk(state: string, questions: Record<string, unknown>): Promise<Record<string, JevChoiceAnswer> | null> {
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
				signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
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
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const text = params.goal.trim().slice(0, 400);
				if (!text) throw new Error("goal must be non-empty");
				// flushed to a GOAL_TYPE custom entry at the turn boundary —
				// appendEntry is command-only, so the tool defers persistence
				pendingGoal = text;
				return { content: [{ type: "text", text: `Session goal pinned: ${text}` }], details: undefined };
			},
		}),
	);

	pi.on("turn_end", async (event: TurnEndEvent, ctx): Promise<{ entries: (ContextEditEntryDraft | CustomEntryDraft)[] } | void> => {
		const drafts: (ContextEditEntryDraft | CustomEntryDraft)[] = [];
		if (pendingGoal !== null) {
			goal = pendingGoal;
			drafts.push({ type: "custom", customType: GOAL_TYPE, data: { goal: pendingGoal } });
			pendingGoal = null;
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

		const due = [...pending.entries()].filter(([, c]) => event.turnIndex - c.turn >= CFG.recencyTurns);
		if (due.length === 0) {
			return drafts.length > 0 ? { entries: drafts } : undefined;
		}

		const verdicts = await Promise.all(
			due.map(([entryId, c]) => judge(c.toolName, c.text, c.toolCallId, gates).then((v) => [entryId, c, v] as const)),
		);

		for (const [entryId, c, v] of verdicts) {
			judged.add(entryId);
			pending.delete(entryId);
			const decision = v.degraded ? "degraded" : v.kind;
			logDecision({ entryId, toolName: c.toolName, turn: c.turn, chars: c.text.length, prob: v.prob, conf: v.conf, kind: "stub", replacementLen: 0 }, decision);
			if (v.kind === "keep" || curated.length + ready.size >= CFG.maxStubs) continue;
			const replacementLen = v.kind === "stub" ? 0 : CFG.truncHead + CFG.truncTail + 400;
			ready.set(entryId, { entryId, toolName: c.toolName, turn: c.turn, chars: c.text.length, prob: v.prob, conf: v.conf, kind: v.kind, replacementLen });
		}
		if (ready.size === 0) {
			return drafts.length > 0 ? { entries: drafts } : undefined;
		}

		const savedTotal = [...ready.values()].reduce((n, r) => n + Math.max(r.chars - r.replacementLen, 0), 0);
		const oldestTurn = Math.min(...[...ready.values()].map((r) => r.turn));
		const agedOut = event.turnIndex - oldestTurn >= CFG.maxHoldTurns;
		if (!(savedTotal >= gates.floor || agedOut)) {
			logBatch("hold", ready.size, savedTotal, `turn=${event.turnIndex} pct=${pct.toFixed(1)}`);
			return drafts.length > 0 ? { entries: drafts } : undefined;
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
			drafts.push({ type: "context_edit", targetId: entryId, replacement: { content: [{ type: "text", text }] } });
			emitted.push({ ...rec, replacementLen: text.length });
		}
		ready.clear();
		if (emitted.length === 0) {
			return drafts.length > 0 ? { entries: drafts } : undefined;
		}
		costProbeTurn = event.turnIndex + 1;
		curated.push(...emitted);
		logBatch("emit", emitted.length, savedTotal, agedOut ? "aged" : pct >= CFG.criticalPct ? "critical" : "batch-floor");
		drafts.push({ type: "custom", customType: AUDIT_TYPE, data: { turn: event.turnIndex, emitted } });
		return { entries: drafts };
	});

	pi.on("session_compact", () => {
		// entries before the compaction point are gone from model context;
		// raw session history remains the durable recall fallback
		pending.clear();
		ready.clear();
		judged.clear();
		rawStore.clear();
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
					if (curated.length === 0) {
						return { content: [{ type: "text", text: "No outputs have been curated in this session." }], details: undefined };
					}
					const listing = curated
						.map(
							(s) =>
								`${s.entryId}  ${s.kind}  ${s.toolName}  ${s.chars} chars  p=${s.prob.toFixed(2)}  (turn ${s.turn})`,
						)
						.join("\n");
					return { content: [{ type: "text", text: `Curated outputs (oldest first):\n${listing}` }], details: undefined };
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

	pi.registerCommand("goal", {
		description: "Show or set the session goal used by the context curator",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify(goal ? `Session goal: ${goal}` : "No goal pinned yet (first user prompt becomes the goal).", "info");
				return;
			}
			pi.appendEntry(GOAL_TYPE, { goal: text });
			goal = text;
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
			ctx.ui.notify(
				`curator: ${CFG.on ? "on" : "off"} · caps=${byKind.cap} truncs=${byKind.truncate} stubs=${byKind.stub} · ` +
					`~${Math.round(savedChars / 1000)}k chars saved · pending=${pending.size} held=${ready.size} · ` +
					`goal=${goal ? "pinned" : "none"}`,
				"info",
			);
		},
	});
}

/**
 * Jev Context Curator — System One attention routing for pi.
 *
 * A cheap classifier (Jev, a System One model) decides which past tool
 * outputs still earn a place in model context; the frontier model only ever
 * sees a curated transcript. Pruning is done via append-only `context_edit`
 * entries — raw history stays intact and every stub is recoverable with the
 * `jev_recall` tool, so curation is advisory, never destructive.
 *
 * Goal pinning: the session goal is the user's first prompt, verbatim (Jev
 * judges against a goal; it cannot author one). Amendable via `/goal <text>`.
 *
 * Kill switch: JEVCURATOR=0. Tunables (defaults calibrated 2026-09-24 on 90
 * real session tool results): JEVCURATOR_MIN_CHARS (1500),
 * JEVCURATOR_RECENCY_TURNS (2), JEVCURATOR_STUB_PROB (0.85),
 * JEVCURATOR_MIN_CONF (0.65), JEVCURATOR_MAX_STUBS (150). The 0.85/0.65
 * gate fired only on unambiguous junk in calibration; everything borderline
 * stays — recall makes false-keeps cheap and false-stubs risky.
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
	recencyTurns: Number(process.env.JEVCURATOR_RECENCY_TURNS ?? 2),
	stubProb: Number(process.env.JEVCURATOR_STUB_PROB ?? 0.85),
	minConf: Number(process.env.JEVCURATOR_MIN_CONF ?? 0.65),
	maxStubs: Number(process.env.JEVCURATOR_MAX_STUBS ?? 150),
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

interface StubRecord {
	entryId: string;
	toolName: string;
	turn: number;
	chars: number;
	prob: number;
	conf: number;
}

interface Verdict {
	stub: boolean;
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
const pending = new Map<string, { toolName: string; turn: number; text: string }>();
const judged = new Set<string>();
const stubs: StubRecord[] = [];
// In-memory raw copies so recall stays fast; bounded so long sessions can't
// grow it unbounded. The session entry is the durable fallback.
const rawStore = new Map<string, string>();
const RAW_STORE_CAP = 300;

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

async function jevChoice(state: string, instructions: string, criteria: Record<string, string>): Promise<JevChoiceAnswer | null> {
	const key = jevKey();
	if (!key) return null;
	// one retry with backoff: a transient 429/5xx should not silently degrade a verdict
	for (let attempt = 0; attempt < 2; attempt++) {
		let res: Response;
		try {
			res = await fetch(`${JEV_BASE_URL}/v1/systemone`, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: JEV_MODEL, state, questions: { verdict: { type: "choice", instructions, criteria } } }),
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
			return j.answers?.verdict ?? null;
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
	"already in its context. Future model requests will replace it with a " +
	"one-line stub unless it may still be needed. Judge only future utility.";

const CRITERIA = {
	keep: "Output the model may still need in later turns: file contents in the area the session goal targets (later edits or reasoning are often built directly on them), errors under investigation, test output still being iterated on, results that took effort to obtain, reference material the session consults repeatedly, or data that cannot be re-fetched cheaply. When unsure, keep.",
	stub: "Output whose value was fully consumed in the turn it arrived: directory or tool listings, package.json/config dumps, exploratory greps or finds that were only used to locate something, verbose logs already triaged, boilerplate, or superseded duplicate reads. Re-fetchable exploration noise.",
};

async function judge(toolName: string, text: string): Promise<Verdict> {
	const state = scrubSecrets(
		`SESSION GOAL:\n${goal ?? "(unpinned)"}\n\nTOOL: ${toolName}\nOUTPUT EXCERPT (${text.length} chars total):\n${excerpt(text)}`,
	);
	const a = await jevChoice(state, QUESTION, CRITERIA);
	if (!a || typeof a.choice !== "string" || typeof a.probabilities !== "object" || a.probabilities === null) {
		return { stub: false, prob: 0, conf: 0, degraded: true };
	}
	const prob = Number(a.probabilities[a.choice] ?? 0);
	const conf = Number(a.confidence ?? 1);
	return { stub: a.choice === "stub" && prob >= CFG.stubProb && conf >= CFG.minConf, prob, conf, degraded: false };
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
	for (const e of entries) {
		if (e.type === "custom" && e.customType === GOAL_TYPE && e.data && typeof (e.data as { goal?: unknown }).goal === "string") {
			goal = (e.data as { goal: string }).goal;
			return;
		}
	}
	for (const e of entries) {
		if (messageEntry(e) && isRoleMessage(e.message) && e.message.role === "user") {
			goal = messageText(e.message).trim() || null;
			return;
		}
	}
}

// ─── Extension ───────────────────────────────────────────────────────

function stubText(toolName: string, entryId: string, chars: number, prob: number): string {
	return (
		`[curated by jev] ${toolName} output (${chars} chars) was judged not needed for the session goal ` +
		`(p=${prob.toFixed(2)}). The raw content is intact in session history — call jev_recall with ` +
		`entry_id "${entryId}" to restore it verbatim.`
	);
}

function logDecision(d: StubRecord, decision: string) {
	try {
		const dir = path.join(os.homedir(), ".pi", "agent", "jev-decisions");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "jev-curator.jsonl"), JSON.stringify({ ts: new Date().toISOString(), decision, ...d }) + "\n");
	} catch {
		// log loss must never break curation; jsonl is a tuning aid only
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("turn_start", (_event, ctx) => {
		ensureGoal(ctx);
	});

	pi.on("turn_end", async (event: TurnEndEvent, ctx): Promise<{ entries: (ContextEditEntryDraft | CustomEntryDraft)[] } | void> => {
		if (!CFG.on) return;
		ensureGoal(ctx);
		if (!goal) return;

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
			if (text.length < CFG.minChars) continue;
			pending.set(entryId, { toolName: msg.toolName, turn: event.turnIndex, text });
			rawStore.set(entryId, text);
			if (rawStore.size > RAW_STORE_CAP) {
				const oldest = rawStore.keys().next().value;
				if (oldest !== undefined) rawStore.delete(oldest);
			}
		}

		const due = [...pending.entries()].filter(([, c]) => event.turnIndex - c.turn >= CFG.recencyTurns);
		if (due.length === 0) return;

		const verdicts = await Promise.all(
			due.map(([entryId, c]) => judge(c.toolName, c.text).then((v) => [entryId, c, v] as const)),
		);

		const drafts: (ContextEditEntryDraft | CustomEntryDraft)[] = [];
		const stubbed: StubRecord[] = [];
		for (const [entryId, c, v] of verdicts) {
			judged.add(entryId);
			pending.delete(entryId);
			logDecision({ entryId, toolName: c.toolName, turn: c.turn, chars: c.text.length, prob: v.prob, conf: v.conf }, v.degraded ? "degraded" : v.stub ? "stub" : "keep");
			if (!v.stub || stubs.length + stubbed.length >= CFG.maxStubs) continue;
			const rec: StubRecord = { entryId, toolName: c.toolName, turn: c.turn, chars: c.text.length, prob: v.prob, conf: v.conf };
			drafts.push({ type: "context_edit", targetId: entryId, replacement: { content: [{ type: "text", text: stubText(c.toolName, entryId, c.text.length, v.prob) }] } });
			stubbed.push(rec);
		}

		if (drafts.length === 0) return;
		stubs.push(...stubbed);
		drafts.push({ type: "custom", customType: AUDIT_TYPE, data: { turn: event.turnIndex, stubbed } });
		return { entries: drafts };
	});

	pi.registerTool(
		defineTool({
			name: "jev_recall",
			label: "Recall curated output",
			description:
				"Restore a tool output that the context curator stubbed out. Call with no arguments to list stubbed outputs; pass entry_id to receive the raw content verbatim.",
			parameters: Type.Object({
				entry_id: Type.Optional(Type.String({ description: "Entry id of the stubbed output (from the stub text or the listing)" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!params.entry_id) {
					if (stubs.length === 0) {
						return { content: [{ type: "text", text: "No outputs have been curated in this session." }], details: undefined };
					}
					const listing = stubs
						.map((s) => `${s.entryId}  ${s.toolName}  ${s.chars} chars  p=${s.prob.toFixed(2)}  (turn ${s.turn})`)
						.join("\n");
					return { content: [{ type: "text", text: `Stubbed outputs (oldest first):\n${listing}` }], details: undefined };
				}
				let raw = rawStore.get(params.entry_id);
				if (raw === undefined) {
					const entry = ctx.sessionManager.getEntry(params.entry_id);
					raw = entry && messageEntry(entry) && isRoleMessage(entry.message) ? messageText(entry.message) : undefined;
				}
				if (raw === undefined || raw === "") {
					throw new Error(`No raw content found for entry ${params.entry_id}`);
				}
				return { content: [{ type: "text", text: raw }], details: undefined };
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
			const charsSaved = stubs.reduce((n, s) => n + s.chars, 0);
			ctx.ui.notify(
				`curator: ${CFG.on ? "on" : "off"} · stubs=${stubs.length} · ~${Math.round(charsSaved / 1000)}k chars pruned · ` +
					`pending=${pending.size} · goal=${goal ? "pinned" : "none"}`,
				"info",
			);
		},
	});
}

/**
 * Session JSONL parsing. A session file is a tree of entries; we walk it
 * linearly (files are written in order) and emit:
 *   - modelCalls: assistant messages with usage/cost (deduped by entry id)
 *   - messages: user/assistant previews for the turn timeline
 *   - events: harness-relevant entries (context edits, curator ledgers,
 *     model/thinking switches, custom messages, non-message usage records)
 * Turn numbering follows user messages: each user message starts a turn.
 */
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { EventDraft, RawRecord } from "./define";

export interface ModelCallRow {
	msgId: string;
	sessionId: string;
	project: string;
	tsMs: number;
	ts: string;
	model?: string;
	provider?: string;
	api?: string;
	thinkingLevel?: string;
	turn: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	cost: number;
	toolCount: number;
	tools?: string;
	stopReason?: string;
}

export interface MessageRow {
	msgId: string;
	sessionId: string;
	project: string;
	tsMs: number;
	role: string;
	turn: number;
	chars: number;
	preview: string;
	model?: string;
}

export interface SessionScan {
	sessionId: string;
	project: string;
	path: string;
	cwd?: string;
	parentSession?: string;
	startedTs?: string;
	lastTs?: string;
	turns: number;
	/** Replayed size of the always-on system prompt (sections + tool declarations). */
	systemChars: number;
	calls: ModelCallRow[];
	messages: MessageRow[];
	events: Array<EventDraft & { fingerprint: string }>;
}

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const b = block as ContentBlock;
			return b?.type === "text" && typeof b.text === "string" ? b.text : "";
		})
		.join("\n");
}

export function fingerprintOf(origin: string, key: string): string {
	return createHash("sha1").update(`${origin}|${key}`).digest("hex").slice(0, 32);
}

function tallyStrings(items: Array<Record<string, unknown>>, key: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const item of items) {
		const value = item[key];
		if (typeof value === "string") out[value] = (out[value] ?? 0) + 1;
	}
	return out;
}

function normalizeStem(file: string): string {
	return path.basename(file, ".jsonl");
}

export function scanSessionFile(file: string, raw: string): SessionScan {
	const project = projectOf(file);
	let sessionId = normalizeStem(file).split("_").pop() ?? normalizeStem(file);
	let cwd: string | undefined;
	let parentSession: string | undefined;
	let startedTs: string | undefined;
	let lastTs: string | undefined;
	let turn = 0;

	const calls: ModelCallRow[] = [];
	const messages: MessageRow[] = [];
	const events: Array<EventDraft & { fingerprint: string }> = [];
	// System messages persist the prompt as sections and patch them by name, so the
	// always-on size is a replay: latest value per section, plus declared tools.
	const sectionsState = new Map<string, string>();
	const toolsState = new Map<string, number>();

	const pushEvent = (e: EventDraft & { key: string }) => {
		const { key, ...draft } = e;
		events.push({ ...draft, fingerprint: fingerprintOf("session", `${sessionId}|${key}`) });
	};

	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: RawRecord;
		try {
			entry = JSON.parse(line) as RawRecord;
		} catch {
			continue;
		}
		const type = entry.type;
		const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
		if (ts) {
			if (!startedTs) startedTs = ts;
			lastTs = ts;
		}
		if (type === "session") {
			sessionId = typeof entry.id === "string" ? entry.id : sessionId;
			cwd = typeof entry.cwd === "string" ? entry.cwd : undefined;
			parentSession = typeof entry.parentSession === "string" ? entry.parentSession : undefined;
			continue;
		}
		if (type === "model_change") {
			pushEvent({
				key: `mc:${entry.id ?? ts}`,
				ts: ts ?? new Date(0).toISOString(),
				tsMs: ts ? Date.parse(ts) : undefined,
				kind: "model.switch",
				severity: "info",
				sessionId,
				turn,
				ref: typeof entry.id === "string" ? entry.id : undefined,
				title: `model → ${String(entry.modelId ?? entry.provider ?? "?")}`,
				summary: String(entry.provider ?? ""),
				data: entry,
			});
			continue;
		}
		if (type === "thinking_level_change") {
			pushEvent({
				key: `tl:${entry.id ?? ts}`,
				ts: ts ?? new Date(0).toISOString(),
				tsMs: ts ? Date.parse(ts) : undefined,
				kind: "model.thinking",
				severity: "info",
				sessionId,
				turn,
				ref: typeof entry.id === "string" ? entry.id : undefined,
				title: `thinking → ${String(entry.thinkingLevel ?? "?")}`,
				data: entry,
			});
			continue;
		}
		if (type === "context_edit") {
			const replacement = (entry.replacement ?? {}) as { content?: unknown };
			const chars = textOf(replacement.content).length;
			pushEvent({
				key: `ce:${entry.id ?? ts}`,
				ts: ts ?? new Date(0).toISOString(),
				tsMs: ts ? Date.parse(ts) : undefined,
				kind: "curator.context_edit",
				severity: "ok",
				sessionId,
				turn,
				ref: typeof entry.targetId === "string" ? entry.targetId : (entry.id as string),
				title: "context edit",
				summary: chars > 0 ? `${chars} chars replacement` : "empty replacement",
				data: { targetId: entry.targetId ?? null, chars },
			});
			continue;
		}
		if (type === "custom") {
			const customType = String(entry.customType ?? "custom");
			const data = (entry.data ?? {}) as RawRecord;
			const rawItems = Array.isArray(data.items) ? data.items : [];
			const stripped = rawItems.slice(0, 100).map((item) => {
				const it = (item ?? {}) as RawRecord;
				return {
					entryId: it.entryId ?? null,
					tool: typeof it.toolName === "string" ? it.toolName : null,
					sourceType: typeof it.sourceType === "string" ? it.sourceType : null,
					role: typeof it.role === "string" ? it.role : null,
					verdict: typeof it.verdict === "string" ? it.verdict : null,
					chars: typeof it.chars === "number" ? it.chars : null,
					extractChars: typeof it.extract === "string" ? it.extract.length : null,
					inputShape: typeof it.inputShape === "string" ? it.inputShape.slice(0, 160) : null,
					links: Array.isArray(it.links) ? it.links : [],
				};
			});
			const ledger = customType === "jev-curator-ledger";
			const verdicts = tallyStrings(stripped, "verdict");
			pushEvent({
				key: `cu:${entry.id ?? ts}`,
				ts: ts ?? new Date(0).toISOString(),
				tsMs: ts ? Date.parse(ts) : undefined,
				kind: ledger ? "curator.ledger" : `harness.${customType}`,
				severity: "info",
				sessionId,
				turn: typeof data.turn === "number" ? data.turn : turn,
				ref: typeof entry.id === "string" ? entry.id : undefined,
				title: ledger ? `curator ledger · ${stripped.length} items` : customType,
				summary: Object.entries(verdicts)
					.map(([k, v]) => `${k} ${v}`)
					.join(" · "),
				data: ledger
					? {
						turn: typeof data.turn === "number" ? data.turn : turn,
						itemCount: stripped.length,
						verdicts,
						roles: tallyStrings(stripped, "role"),
						sourceTypes: tallyStrings(stripped, "sourceType"),
						items: stripped,
					}
					: entry,
			});
			continue;
		}
		if (type === "custom_message") {
			pushEvent({
				key: `cm:${entry.id ?? ts}`,
				ts: ts ?? new Date(0).toISOString(),
				tsMs: ts ? Date.parse(ts) : undefined,
				kind: `harness.${String(entry.customType ?? "custom_message")}`,
				severity: "info",
				sessionId,
				turn,
				ref: typeof entry.id === "string" ? entry.id : undefined,
				title: String(entry.customType ?? "custom message"),
				data: entry,
			});
			continue;
		}
		if (type === "usage") {
			const usage = (entry.usage ?? {}) as RawRecord;
			const cost = ((usage.cost ?? {}) as RawRecord).total;
			pushEvent({
				key: `us:${entry.id ?? ts}`,
				ts: ts ?? new Date(0).toISOString(),
				tsMs: ts ? Date.parse(ts) : undefined,
				kind: `usage.${String(entry.kind ?? "usage")}`,
				severity: "info",
				sessionId,
				turn,
				costUsd: typeof cost === "number" ? cost : undefined,
				ref: typeof entry.id === "string" ? entry.id : undefined,
				title: `usage · ${String(entry.kind ?? "usage")}`,
				summary: typeof entry.model === "string" ? entry.model : undefined,
				data: entry,
			});
			continue;
		}
		if (type !== "message") continue;

		const msg = (entry.message ?? {}) as RawRecord;
		const role = String(msg.role ?? "");
		const entryId = typeof entry.id === "string" ? entry.id : randomUUID();
		const msgTsMs = typeof msg.timestamp === "number" ? msg.timestamp : ts ? Date.parse(ts) : Date.now();
		const msgTs = new Date(msgTsMs).toISOString();

		if (role === "system") {
			const sections = (msg.sections ?? {}) as Record<string, string | null>;
			for (const [name, text] of Object.entries(sections)) {
				if (text == null) sectionsState.delete(name);
				else sectionsState.set(name, text);
			}
			for (const tool of Array.isArray(msg.toolsAdded) ? (msg.toolsAdded as Array<{ name?: string }>) : []) {
				if (tool?.name) toolsState.set(tool.name, JSON.stringify(tool).length);
			}
			for (const tool of Array.isArray(msg.toolsRemoved) ? (msg.toolsRemoved as Array<{ name?: string }>) : []) {
				if (tool?.name) toolsState.delete(tool.name);
			}
			continue;
		}
		if (role === "user") {
			turn += 1;
			const text = textOf(msg.content);
			messages.push({
				msgId: entryId,
				sessionId,
				project,
				tsMs: msgTsMs,
				role,
				turn,
				chars: text.length,
				preview: text.replace(/\s+/g, " ").trim().slice(0, 240),
			});
			continue;
		}
		if (role !== "assistant") continue;

		const usage = (msg.usage ?? {}) as RawRecord;
		const cost = ((usage.cost ?? {}) as RawRecord).total;
		const content = Array.isArray(msg.content) ? (msg.content as ContentBlock[]) : [];
		const toolNames = content.filter((b) => b?.type === "toolCall" && typeof b.name === "string").map((b) => b.name as string);
		const text = textOf(msg.content);
		calls.push({
			msgId: entryId,
			sessionId,
			project,
			tsMs: msgTsMs,
			ts: msgTs,
			model: typeof msg.model === "string" ? msg.model : undefined,
			provider: typeof msg.provider === "string" ? msg.provider : undefined,
			api: typeof msg.api === "string" ? msg.api : undefined,
			thinkingLevel: typeof msg.thinkingLevel === "string" ? msg.thinkingLevel : undefined,
			turn,
			input: numberOr(usage.input),
			output: numberOr(usage.output),
			cacheRead: numberOr(usage.cacheRead),
			cacheWrite: numberOr(usage.cacheWrite),
			reasoning: numberOr(usage.reasoning),
			totalTokens: numberOr(usage.totalTokens),
			cost: typeof cost === "number" ? cost : 0,
			toolCount: toolNames.length,
			tools: toolNames.length ? JSON.stringify(toolNames) : undefined,
			stopReason: typeof msg.stopReason === "string" ? msg.stopReason : undefined,
		});
		messages.push({
			msgId: entryId,
			sessionId,
			project,
			tsMs: msgTsMs,
			role,
			turn,
			chars: text.length,
			preview: text.replace(/\s+/g, " ").trim().slice(0, 240),
			model: typeof msg.model === "string" ? msg.model : undefined,
		});
	}

	return {
		sessionId,
		project,
		path: file,
		cwd,
		parentSession,
		startedTs,
		lastTs,
		turns: turn,
		systemChars:
			[...sectionsState.values()].reduce((total, text) => total + text.length, 0) + [...toolsState.values()].reduce((total, chars) => total + chars, 0),
		calls,
		messages,
		events,
	};
}

function numberOr(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Project label from a session dir name like `--Users-me-code-repo--`. */
export function projectOf(file: string): string {
	const dir = path.basename(path.dirname(file));
	const trimmed = dir.replace(/^-+|-+$/g, "");
	const parts = trimmed.split("-").filter(Boolean);
	return parts.length ? (parts[parts.length - 1] as string) : trimmed;
}

import { StringEnum, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type ProposalKind = "rule" | "note";

type Proposal = {
	kind: ProposalKind;
	name: string;
	title: string;
	evidence: string;
	content: string;
};

type HistoryEntry = {
	id: string;
	timestamp: string;
	kind: ProposalKind;
	name: string;
	path: string;
	focus?: string;
	evidence: string;
	source?: "auto" | "manual";
	rolledBack?: boolean;
};

type JevAnswer = { noul?: number; confidence?: number };
type JevAnswers = Record<string, JevAnswer | undefined>;
type CoverageBody = { name: string; body: string };
type JevParts = { evidence: number; trigger: number; novelty: number };
type StagedMeta = {
	name: string;
	title: string;
	evidence: string;
	score: number;
	parts: JevParts;
	session: string;
	stagedAt: string;
	trigger: string;
	tier?: "ready" | "near-miss";
};

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type Coverage = { rules: string[]; notes: string[] };

const REFINE_DIR = join(homedir(), ".pi", "agent", "jev-decisions", "refine");
const NOTES_DIR = join(REFINE_DIR, "notes");
const HISTORY_FILE = join(REFINE_DIR, "history.jsonl");
const RULES_DIR = join(homedir(), ".pi", "agent", "rules");
const HERMES_FAILURES = join(homedir(), ".pi", "agent", "pi-hermes-memory", "failures.md");
const STAGING_DIR = join(REFINE_DIR, "rules-staging");
const AUDIT_FILE = join(REFINE_DIR, "auto-refine.jsonl");
const REJECTED_FILE = join(REFINE_DIR, "rejected.jsonl");

const MAX_TRAJECTORY_CHARS = 60_000;
const MAX_LESSON_CHARS = 8_000;
const MAX_LESSONS = 12;

const RULE_FORMAT = `
TTSR rule files live in ~/.pi/agent/rules/ and are DORMANT until the agent's live
output stream matches their trigger; then a reminder is injected. Zero token cost
until match. Frontmatter schema:

---
name: kebab-case-name                        # required
condition: ["regex1", "regex2"]              # regex(es) matched against the agent's text/thinking output stream, OR'd
astCondition: ["if ($X) clearTimeout($X)"]   # ast-grep pattern(s), tool scope only, OR'd
scope: [text, thinking, tool]                # which streams to watch; default all three
globs: ["src/**/*.ts"]                       # optional path gate (tool scope only)
interrupt: true                              # default true for text/thinking, false for tool
repeat: once                                 # "once" or "after-gap:N"
flags: i                                     # optional regex flags
verify: {type: noul, instructions: "...", threshold: 0.7, minConfidence: 0.5, onFail: suppress}
                                             # optional Jev intent-gate: regex stays the free
                                             # pre-filter, Jev adjudicates on match. Prefer including
                                             # it so the rule does not hard-fire on lookalike output.
---
Reminder body (what the agent sees on match). Keep it short and directive.

A rule is ONLY justified when the failure has a detectable signature in the
agent's own output (a text pattern it emits, or a code shape it writes).
If you cannot write a precise condition/astCondition, use kind "note" instead.
Never write always-apply guidance as a rule.
`.trim();

const buildProposalPrompt = (trajectory: string, lessons: string[], coverage: Coverage, bodies?: { rules: CoverageBody[]; notes: CoverageBody[] }, focus?: string): string =>
	[
		"You are a refinement planner for a coding agent. Analyze the session trajectory below and propose the SMALLEST possible harness edit(s) that would measurably improve future sessions.",
		"",
		"Look ONLY for:",
		'1. The user correcting the agent (explicitly: "no", "don\'t", "stop doing X", or a rework demand).',
		"2. The same failure occurring 2+ times (repeated tool errors, repeated lint/test failures from the same cause).",
		"3. A non-obvious workaround or environment quirk the agent discovered by trial and error.",
		"4. A multi-step workflow that clearly succeeded and is likely to recur verbatim.",
		"",
		"Propose AT MOST 2 edits. Prefer 0 or 1. Return {\"proposals\": []} if nothing clears this bar — single one-off events do NOT qualify.",
		"",
		"Each proposal has kind:",
		'- "rule": a stream-triggered TTSR rule (format below). Choose ONLY when the anti-pattern has a precise trigger signature in agent output AND the trajectory shows the failure recurring 2+ times. Prefer astCondition (tool scope, mechanical patterns) over text regex — intent-level behavior has no reliable stream signature and belongs in a note.',
		'- "note": a passive markdown note for observations with NO stream-matchable signature (environment facts, workflows, preferences). Content is plain markdown.',
		"",
		'For "rule", content MUST be the complete file including frontmatter. For "note", content is the markdown body.',
		'"name" is a kebab-case slug used as the filename. "title" is a one-line summary. "evidence" MUST quote the exact trajectory line(s) that justify the edit plus one sentence on why it will recur.',
		"",
		"Respond with ONLY a JSON object, no markdown fences, in this exact shape:",
		'{"proposals": [{"kind": "rule" | "note", "name": "...", "title": "...", "evidence": "...", "content": "..."}]}',
		"",
		"Rule file format:",
		RULE_FORMAT,
		"",
		"Lessons already captured in persistent memory (hermes). Do NOT re-propose these as-is — memory alone already covers them. Propose an enforced TTSR rule ONLY when the evidence shows a lesson RECURRED across sessions (or recurred again this session); promoting a recurring memory lesson into a rule is exactly the goal:",
		"<memory-lessons>",
		...(lessons.length > 0 ? lessons : ["(none)"]),
		"</memory-lessons>",
		"",
		`Existing refine coverage (do NOT duplicate): rules: [${coverage.rules.join(", ") || "none"}]; notes: [${coverage.notes.join(", ") || "none"}]`,
		"Existing notes are passive records, not enforcement. If the trajectory shows one of those lessons being violated AGAIN, propose its rule version — promotion is expected, not duplication (the rule still needs a precise trigger).",
		"Reminder bodies of the existing rules/notes (overlap check — never re-propose what an existing RULE already enforces; note bodies double as promotion candidates):",
		bodies
			? [...bodies.rules.map((r) => `- rule ${r.name}: ${r.body}`), ...bodies.notes.map((n) => `- note ${n.name}: ${n.body}`)].join("\n") || "(none)"
			: "(none)",
		"",
		focus ? `User focus for this run: ${focus}` : "",
		"",
		"<trajectory>",
		trajectory,
		"</trajectory>",
	]
		.filter((line) => line !== undefined)
		.join("\n");

const readHermesLessons = async (): Promise<string[]> => {
	try {
		const raw = await readFile(HERMES_FAILURES, "utf8");
		const entries = raw
			.split(/^§$/m)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 20)
			.map((entry) => ({ text: entry, last: /last=(\d{4}-\d{2}-\d{2})/.exec(entry)?.[1] ?? "" }));
		return entries
			.sort((a, b) => b.last.localeCompare(a.last))
			.slice(0, MAX_LESSONS)
			.map((entry) => entry.text)
			.join("\n§\n")
			.slice(0, MAX_LESSON_CHARS)
			.split("\n§\n");
	} catch (error) {
		// expected: hermes not installed or failures file not created yet
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
};

const listCoverage = async (): Promise<Coverage> => {
	const mdNames = async (dir: string): Promise<string[]> => {
		try {
			return (await readdir(dir)).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
		} catch (error) {
			// expected: directory does not exist yet
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	};
	return { rules: await mdNames(RULES_DIR), notes: await mdNames(NOTES_DIR) };
};

const readCoverageBodies = async (): Promise<{ rules: CoverageBody[]; notes: CoverageBody[] }> => {
	const read = async (dir: string): Promise<CoverageBody[]> => {
		try {
			const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort().slice(0, 30);
			const out: CoverageBody[] = [];
			for (const f of files) {
				const raw = await readFile(join(dir, f), "utf8");
				out.push({ name: f.replace(/\.md$/, ""), body: raw.replace(/\s+/g, " ").trim().slice(0, 300) });
			}
			return out;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	};
	return { rules: await read(RULES_DIR), notes: await read(NOTES_DIR) };
};

const toProposal = (input: unknown): Proposal | null => {
	if (!input || typeof input !== "object") return null;
	const p = input as Partial<Proposal>;
	if (p.kind !== "rule" && p.kind !== "note") return null;
	if (typeof p.name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.name)) return null;
	if (typeof p.content !== "string" || !p.content.trim()) return null;
	if (p.kind === "rule" && !p.content.includes("condition") && !p.content.includes("astCondition")) return null;
	return {
		kind: p.kind,
		name: p.name,
		title: typeof p.title === "string" ? p.title : p.name,
		evidence: typeof p.evidence === "string" ? p.evidence : "(no evidence provided)",
		content: p.content.trim(),
	};
};

export const dedupeProposals = (proposals: Proposal[], coverage: Coverage): Proposal[] =>
	proposals.filter((p) => !coverage.rules.includes(p.name) && !coverage.notes.includes(p.name));

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as ContentBlock;
		if (typed.type === "text" && typeof typed.text === "string") {
			parts.push(typed.text);
		}
	}
	return parts;
};

const buildTrajectoryText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;

		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const lines: string[] = [];
		const text = extractTextParts(entry.message.content).join("\n").trim();
		if (text) lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);

		if (role === "assistant" && Array.isArray(entry.message.content)) {
			for (const block of entry.message.content as ContentBlock[]) {
				if (block?.type === "toolCall" && typeof block.name === "string") {
					lines.push(`Assistant tool call: ${block.name} ${JSON.stringify(block.arguments ?? {})}`);
				}
			}
		}

		if (lines.length > 0) sections.push(lines.join("\n"));
	}

	return sections.join("\n\n").slice(-MAX_TRAJECTORY_CHARS);
};

export const parseProposals = (raw: string): Proposal[] => {
	const jsonText = raw.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
	const start = jsonText.indexOf("{");
	const end = jsonText.lastIndexOf("}");
	if (start === -1 || end <= start) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText.slice(start, end + 1));
	} catch (error) {
		if (error instanceof SyntaxError) return [];
		throw error;
	}

	const proposals = (parsed as { proposals?: unknown }).proposals;
	if (!Array.isArray(proposals)) return [];

	const valid: Proposal[] = [];
	for (const item of proposals) {
		const proposal = toProposal(item);
		if (proposal) valid.push(proposal);
	}
	return valid;
};

const proposalTargetPath = (proposal: Proposal): string =>
	proposal.kind === "rule" ? join(RULES_DIR, `${proposal.name}.md`) : join(NOTES_DIR, `${proposal.name}.md`);

const readHistory = async (): Promise<HistoryEntry[]> => {
	try {
		const raw = await readFile(HISTORY_FILE, "utf8");
		return raw
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as HistoryEntry);
	} catch (error) {
		// expected: ENOENT before the first refinement has been applied
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
};

type ProposalOutcome = "apply" | "skip";

const showProposalUi = async (proposal: Proposal, ctx: ExtensionContext): Promise<ProposalOutcome> => {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Refine: proposal "${proposal.name}" requires interactive TUI review — skipped`, "warning");
		return "skip";
	}

	return ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const mdTheme = getMarkdownTheme();

		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold(`Refine proposal [${proposal.kind}]: ${proposal.title}`)), 1, 0));
		container.addChild(new Text(theme.fg("dim", `evidence: ${proposal.evidence}`), 1, 1));
		container.addChild(new Markdown(proposal.content, 1, 1, mdTheme));
		container.addChild(new Text(theme.fg("dim", "Enter = apply, Esc = skip"), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter")) done("apply");
				if (matchesKey(data, "escape")) done("skip");
			},
		};
	});
};

const fmtPart = (n: unknown): string => (typeof n === "number" ? n.toFixed(2) : "—");

type ReviewItem = { name: string; title: string; evidence: string; content: string; meta: StagedMeta | null };

const buildReviewDoc = (item: ReviewItem): string => {
	const backtickRuns = item.content.match(/`+/g) ?? [];
	const fence = "`".repeat(Math.max(3, ...backtickRuns.map((r) => r.length + 1)));
	const evidence = item.evidence
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	const metaLines: string[] = [];
	if (item.meta && typeof item.meta.score === "number" && item.meta.parts) {
		metaLines.push(
			`score ${item.meta.score.toFixed(2)} · evidence ${fmtPart(item.meta.parts.evidence)} · novelty ${fmtPart(item.meta.parts.novelty)} · trigger ${fmtPart(item.meta.parts.trigger)}`,
		);
		metaLines.push(`tier ${item.meta.tier ?? "—"} · loop trigger ${item.meta.trigger} · staged ${item.meta.stagedAt}`);
	}
	return [`## ${item.title}`, "", evidence, "", ...metaLines, "", `${fence}md`, item.content, fence].join("\n");
};

// Persistent two-panel review session: a capped list panel on top, the selected
// rule's evidence, gate scores and verbatim content in the large panel below.
// One overlay lives for the whole session — ↑/↓ re-render in place instead of
// closing and reopening (which flickered) — and arm/reject run synchronously
// through the handler-provided actions before the list is updated.
const showReviewSession = (
	items: ReviewItem[],
	ctx: ExtensionContext,
	actions: { arm: (item: ReviewItem) => boolean; reject: (item: ReviewItem) => boolean },
): Promise<{ keptStaged: { name: string; meta: StagedMeta | null }[] }> => {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Refine: ${items.length} staged auto-refine rule(s) need interactive TUI review — skipped`, "warning");
		return Promise.resolve({ keptStaged: [] });
	}

	return ctx.ui.custom(
		(tui, theme, _kb, done) => {
			const list = items.slice();
			let sel = 0;
			let listStart = 0;
			let listCap = 1;
			let contentMd = new Markdown(buildReviewDoc(list[0]), 1, 1, getMarkdownTheme());
			let contentTop = 0;
			let contentTotal = 0;
			let contentPage = 1;
			let pendingReject = false;
			const viewed = new Map<string, StagedMeta | null>();
			viewed.set(list[0].name, list[0].meta);

			const horizontalChrome = 4;

			const dim = (s: string) => theme.fg("dim", s);
			const accent = (s: string) => theme.fg("accent", s);
			const visibleLength = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
			// Rendered markdown can emit lines wider than the viewport (unbreakable
			// tokens), which would push the right border out of alignment.
			const clip = (s: string, max: number): string => {
				if (visibleLength(s) <= max) return s;
				let out = "";
				let vis = 0;
				let i = 0;
				while (i < s.length && vis < max) {
					const escape = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
					if (escape) {
						out += escape[0];
						i += escape[0].length;
						continue;
					}
					out += s[i];
					vis++;
					i++;
				}
				return s.includes("\x1b") ? `${out}\x1b[0m` : out;
			};

			const close = () => {
				const keptStaged: { name: string; meta: StagedMeta | null }[] = [];
				for (const [name, meta] of viewed) {
					if (list.some((item) => item.name === name)) keptStaged.push({ name, meta });
				}
				done({ keptStaged });
			};
			const scroll = (delta: number) => {
				contentTop = Math.max(0, Math.min(contentTop + delta, Math.max(0, contentTotal - contentPage)));
			};
			const showItem = (index: number) => {
				sel = index;
				viewed.set(list[sel].name, list[sel].meta);
				contentMd = new Markdown(buildReviewDoc(list[sel]), 1, 1, getMarkdownTheme());
				contentTop = 0;
			};
			const decide = (applied: boolean) => {
				if (!applied) return;
				list.splice(sel, 1);
				if (list.length === 0) {
					close();
					return;
				}
				showItem(Math.min(sel, list.length - 1));
			};
			const arm = () => decide(actions.arm(list[sel]));
			const reject = () => decide(actions.reject(list[sel]));

			const gutterBar = (row: number, viewport: number, total: number, offset: number): string => {
				if (total <= viewport) return " ";
				const thumbSize = Math.max(1, Math.round((viewport / total) * viewport));
				const thumbStart = Math.round((offset / (total - viewport)) * (viewport - thumbSize));
				return row >= thumbStart && row < thumbStart + thumbSize ? accent("█") : dim("│");
			};

			return {
				render(width: number): string[] {
					const rows = tui.terminal.rows;
					listCap = Math.max(1, Math.min(8, Math.floor((rows - 6) / 3), list.length));
					if (sel < listStart) listStart = sel;
					if (sel >= listStart + listCap) listStart = sel - listCap + 1;
					listStart = Math.max(0, Math.min(listStart, Math.max(0, list.length - listCap)));

					const innerWidth = Math.max(1, width - horizontalChrome - 2);
					contentPage = Math.max(1, rows - listCap - 4);

					const lines = contentMd.render(innerWidth);
					contentTotal = lines.length;
					contentTop = Math.max(0, Math.min(contentTop, Math.max(0, contentTotal - contentPage)));
					const body = lines.slice(contentTop, contentTop + contentPage);

					const hint = pendingReject
						? " d again to reject this rule · any other key cancels "
						: " PgUp/PgDn scroll · ↑/↓ select · Enter arm · d reject · Esc close ";
					const scrollLabel = dim(contentTotal > contentPage ? ` ${contentTop + 1}-${Math.min(contentTop + body.length, contentTotal)}/${contentTotal} ` : " ");
					const hintText = (pendingReject ? accent : dim)(hint.slice(0, Math.max(0, width - 4 - visibleLength(scrollLabel))));

					const selected = list[sel];
					const title = accent(theme.bold(` Refine review: ${selected ? selected.name : "—"} `.slice(0, Math.max(0, width - 4))));
					const listHeader = dim(` Staged rules (${list.length}) `);
					const listPosition = dim(` ${sel + 1}/${list.length} `);

					const out: string[] = [];
					out.push(accent("╭─") + title + accent("─".repeat(Math.max(0, width - 4 - visibleLength(title)))) + accent("╮"));
					const headerText = listHeader + " ".repeat(Math.max(0, innerWidth - visibleLength(listHeader) - visibleLength(listPosition))) + listPosition;
					out.push(accent("│") + " " + headerText + " ".repeat(Math.max(0, innerWidth - visibleLength(headerText))) + "  " + accent("│"));
					for (let r = 0; r < listCap; r++) {
						const idx = listStart + r;
						if (idx >= list.length) {
							out.push(accent("│") + " ".repeat(innerWidth + 3) + accent("│"));
							continue;
						}
						const item = list[idx];
						const isSelected = idx === sel;
						const avail = Math.max(0, innerWidth - 3);
						const nameText = item.name.slice(0, avail);
						const tagText = `${item.meta?.tier ? ` · ${item.meta.tier}` : ""}${typeof item.meta?.score === "number" ? ` ${item.meta.score.toFixed(2)}` : ""}`.slice(0, Math.max(0, avail - nameText.length));
						const marker = isSelected ? accent("▸") : " ";
						const namePart = isSelected ? theme.bold(nameText) : nameText;
						const row = `${marker} ${namePart}${dim(tagText)}`;
						out.push(accent("│") + " " + row + " ".repeat(Math.max(0, innerWidth - visibleLength(row))) + " " + gutterBar(r, listCap, list.length, listStart) + accent("│"));
					}
					out.push(accent("├─") + accent("─".repeat(Math.max(0, width - 4))) + accent("┤"));
					for (let i = 0; i < contentPage; i++) {
						const line = clip(body[i] ?? "", innerWidth);
						out.push(accent("│") + " " + line + " ".repeat(Math.max(0, innerWidth - visibleLength(line))) + " " + gutterBar(i, contentPage, contentTotal, contentTop) + accent("│"));
					}
					out.push(
						accent("╰─") +
							scrollLabel +
							accent("─".repeat(Math.max(0, width - 4 - visibleLength(scrollLabel) - visibleLength(hintText)))) +
							hintText +
							accent("╯"),
					);
					return out;
				},
				invalidate() {
					contentMd.invalidate();
				},
				handleInput(data: string) {
					if (pendingReject) {
						pendingReject = false;
						if (matchesKey(data, "d")) reject();
						return;
					}
					if (matchesKey(data, "escape")) {
						close();
					} else if (matchesKey(data, "enter")) {
						arm();
					} else if (matchesKey(data, "d")) {
						pendingReject = true;
					} else if (matchesKey(data, "down")) {
						if (sel < list.length - 1) showItem(sel + 1);
					} else if (matchesKey(data, "up")) {
						if (sel > 0) showItem(sel - 1);
					} else if (matchesKey(data, "pageUp")) {
						scroll(-contentPage);
					} else if (matchesKey(data, "pageDown") || data === " ") {
						scroll(contentPage);
					} else if (matchesKey(data, "home") || data === "g") {
						contentTop = 0;
					} else if (matchesKey(data, "end") || data === "G") {
						contentTop = Number.MAX_SAFE_INTEGER;
					} else if (data === "j") {
						scroll(1);
					} else if (data === "k") {
						scroll(-1);
					}
				},
				handleMouse(event: TuiMouseEvent) {
					if (event.type === "wheel" && event.wheelDelta) {
						scroll(event.wheelDelta);
						return { handled: true };
					}
					return undefined;
				},
			};
		},
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0 } },
	);
};

const appendHistory = (entry: HistoryEntry): void => {
	mkdirSync(REFINE_DIR, { recursive: true });
	appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`, "utf8");
};

const applyProposal = async (proposal: Proposal, focus: string | undefined, ctx: ExtensionContext, source: "auto" | "manual" = "manual"): Promise<void> => {
	const targetPath = proposalTargetPath(proposal);

	try {
		await readFile(targetPath, "utf8");
		ctx.ui.notify(`Skipped "${proposal.name}" — ${targetPath} already exists`, "warning");
		return;
	} catch (error) {
		// expected: ENOENT means the target path is free to write
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	await mkdir(proposal.kind === "rule" ? RULES_DIR : NOTES_DIR, { recursive: true });
	await writeFile(targetPath, `${proposal.content}\n`, "utf8");

	const entry: HistoryEntry = {
		id: uuidv7(),
		timestamp: new Date().toISOString(),
		kind: proposal.kind,
		name: proposal.name,
		path: targetPath,
		focus,
		evidence: proposal.evidence,
		source,
	};
	appendHistory(entry);

	ctx.ui.notify(
		proposal.kind === "rule" ? `Applied rule → ${targetPath} (verify with /ttsr)` : `Applied note → ${targetPath}`,
		"info",
	);
};

// ─── Auto-refine: background Jev-gated self-improvement loop ────────────────

const AUTO_ENABLED = process.env.REFINE_AUTO !== "0";
const AUTO_JEV_KILL = process.env.REFINE_JEV === "0";
const AUTO_TURNS = Math.max(1, Number(process.env.REFINE_AUTO_TURNS ?? "10"));
const AUTO_HEADLESS = process.env.REFINE_AUTO_HEADLESS === "1";

const clamp01 = (raw: string | undefined, fallback: number): number => {
	const n = Number(raw ?? fallback);
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};
const AUTO_NOTE_THRESHOLD = clamp01(process.env.REFINE_AUTO_NOTE_THRESHOLD, 0.6);
const AUTO_RULE_EVIDENCE_FLOOR = clamp01(process.env.REFINE_AUTO_RULE_EVIDENCE_FLOOR, 0.6);
const AUTO_RULE_NOVELTY_FLOOR = clamp01(process.env.REFINE_AUTO_RULE_NOVELTY_FLOOR, 0.6);
const AUTO_RULE_TRIGGER_FLOOR = clamp01(process.env.REFINE_AUTO_RULE_TRIGGER_FLOOR, 0.5);
const AUTO_NEAR_MISS_FLOOR = clamp01(process.env.REFINE_AUTO_NEAR_MISS_FLOOR, 0.4);

// Free pre-filter before the planner: user corrections and repeated identical
// tool failures are the only signals worth spending a planning call on.
const CORRECTION_RE =
	/\b(don'?t|do not|stop doing|not what (i|we) (asked|wanted|meant)|that'?s (wrong|incorrect)|wrong (file|approach|direction|thing)|revert (that|this|it)|undo (that|this)|redo)\b/i;

const JEV_BASE_URL = process.env.JEV_BASE_URL ?? "https://openrouter.ai/api";
const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest";
const JEV_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? "2000");

let jevKeyCache: string | null | undefined;

const jevKey = (): string | null => {
	if (jevKeyCache !== undefined) return jevKeyCache;
	jevKeyCache = process.env.JEV_API_KEY ?? process.env.OPENROUTER_API_KEY ?? null;
	if (!jevKeyCache) {
		try {
			const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as { openrouter?: { key?: string } };
			jevKeyCache = typeof auth.openrouter?.key === "string" ? auth.openrouter.key : null;
		} catch {
			jevKeyCache = null;
		}
	}
	return jevKeyCache;
};

const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\bsk-[A-Za-z0-9_-]{10,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

const scrubSecrets = (s: string): string => {
	let out = s;
	for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
	return out;
};

const jevCall = async (state: string, questions: Record<string, unknown>): Promise<JevAnswers | null> => {
	const key = jevKey();
	if (!key) return null;
	let res: Response;
	try {
		res = await fetch(`${JEV_BASE_URL}/v1/systemone`, {
			method: "POST",
			headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model: JEV_MODEL, state, questions }),
			signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
	if (!res.ok) return null;
	try {
		const j = (await res.json()) as { answers?: JevAnswers };
		return j.answers ?? null;
	} catch {
		return null;
	}
};

const answerNoul = (answers: JevAnswers | null, key: string): number | null => {
	const a = answers?.[key];
	return a && typeof a.noul === "number" ? a.noul : null;
};

const normalizeContent = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const hashContent = (s: string): string => createHash("sha256").update(normalizeContent(s)).digest("hex");

const collectHashes = async (): Promise<Set<string>> => {
	const hashes = new Set<string>();
	for (const dir of [RULES_DIR, NOTES_DIR, STAGING_DIR]) {
		try {
			for (const f of await readdir(dir)) {
				if (!f.endsWith(".md")) continue;
				hashes.add(hashContent(await readFile(join(dir, f), "utf8")));
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	try {
		const raw = await readFile(REJECTED_FILE, "utf8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			const parsed = JSON.parse(line) as { hash?: string };
			if (typeof parsed.hash === "string") hashes.add(parsed.hash);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return hashes;
};

// A rejected draft is remembered by content hash so the auto loop cannot re-stage it.
const recordRejected = (name: string, content: string): void => {
	mkdirSync(REFINE_DIR, { recursive: true });
	appendFileSync(REJECTED_FILE, `${JSON.stringify({ name, hash: hashContent(content), rejectedAt: new Date().toISOString() })}\n`, "utf8");
};

const buildJevState = (proposals: Proposal[], trajectory: string, bodies: { rules: CoverageBody[]; notes: CoverageBody[] }): Record<string, unknown> => ({
	proposals: proposals.map((p) => ({ kind: p.kind, name: p.name, title: p.title, evidence: p.evidence, content: p.content.slice(0, 4000) })),
	trajectory: trajectory.slice(-12_000),
	existing_rules: bodies.rules.map((r) => ({ name: r.name, body: r.body.slice(0, 300) })),
	existing_notes: bodies.notes.map((n) => ({ name: n.name, body: n.body.slice(0, 300) })),
});

const buildJevQuestions = (proposals: Proposal[]): Record<string, unknown> => {
	const questions: Record<string, unknown> = {};
	for (const [i, p] of proposals.entries()) {
		questions[`p${i}_evidence`] = {
			type: "noul",
			instructions: "Does `evidence` quote trajectory lines that genuinely show the user correcting the agent, the agent reworking output after a user demand, or the same failure recurring 2+ times? Judge from `trajectory`.",
		};
		if (p.kind === "rule") {
			questions[`p${i}_trigger`] = {
				type: "noul",
				instructions: "Given the proposed rule's condition/astCondition and the assistant output visible in `trajectory`, is the trigger precise enough to fire on genuine future instances of the anti-pattern while rarely firing on unrelated output?",
			};
		}
		questions[`p${i}_redundant`] = {
			type: "noul",
			instructions: "Is all guidance in the proposal's `content` already enforced or recorded by `existing_rules` or `existing_notes`? A shared topic alone does not imply redundancy.",
		};
	}
	return questions;
};

// Weakest-link score is recorded for the audit/calibration trail; rule gating is per-part floors.
const scoreProposal = (p: Proposal, answers: JevAnswers | null, i: number): { score: number; parts: JevParts } | null => {
	if (!answers) return null;
	const evidence = answerNoul(answers, `p${i}_evidence`);
	const trigger = p.kind === "rule" ? answerNoul(answers, `p${i}_trigger`) : 1;
	const redundant = answerNoul(answers, `p${i}_redundant`);
	if (evidence === null || trigger === null || redundant === null) return null;
	return { score: Math.min(evidence, trigger, 1 - redundant), parts: { evidence, trigger, novelty: 1 - redundant } };
};

// Two-band rule gate: trigger parts empirically cap below a 0.8 weakest-link bar, so
// per-part floors stage "ready" drafts and a lower band stages near-misses for review.
export const ruleTier = (parts: JevParts): "ready" | "near-miss" | null => {
	if (parts.evidence >= AUTO_RULE_EVIDENCE_FLOOR && parts.novelty >= AUTO_RULE_NOVELTY_FLOOR && parts.trigger >= AUTO_RULE_TRIGGER_FLOOR) return "ready";
	if (Math.min(parts.evidence, parts.novelty) >= AUTO_NEAR_MISS_FLOOR) return "near-miss";
	return null;
};

const auditAuto = (entry: Record<string, unknown>): void => {
	try {
		mkdirSync(REFINE_DIR, { recursive: true });
		appendFileSync(AUDIT_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
	} catch {
		/* audit must never break the loop */
	}
};

const stageRule = (p: Proposal, v: { score: number; parts: JevParts }, session: string, trigger: string, tier: "ready" | "near-miss"): boolean => {
	mkdirSync(STAGING_DIR, { recursive: true });
	const target = join(STAGING_DIR, `${p.name}.md`);
	if (existsSync(target)) return false;
	writeFileSync(target, `${p.content}\n`, "utf8");
	const meta: StagedMeta = {
		name: p.name,
		title: p.title,
		evidence: p.evidence,
		score: v.score,
		parts: v.parts,
		session,
		stagedAt: new Date().toISOString(),
		trigger,
		tier,
	};
	writeFileSync(join(STAGING_DIR, `${p.name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
	return true;
};

export default function (pi: ExtensionAPI) {
	// ─── Background auto-refine loop state (per session) ───────────────
	let autoTurnCount = 0;
	let autoScanLen = 0;
	let autoProcessedLen = 0;
	let autoCorrections = 0;
	let autoRunning = false;
	let autoDegradedNotified = false;
	const autoToolErrors = new Map<string, number>();

	const runAutoRefine = async (ctx: ExtensionContext, windowEntries: SessionEntry[], trigger: string): Promise<void> => {
		const sessionId = ctx.sessionManager.getSessionId();
		const trajectory = buildTrajectoryText(windowEntries).slice(-30_000);
		if (!trajectory.trim()) return;
		const model = ctx.model;
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			auditAuto({ session: sessionId, stage: "plan", decision: "skipped", err: "no-model", trigger });
			return;
		}
		const [lessons, coverage, bodies] = await Promise.all([readHermesLessons(), listCoverage(), readCoverageBodies()]);

		// Jev is the sole write gate: on degrade, skip the planner entirely — nothing can be written.
		if (AUTO_JEV_KILL || !jevKey()) {
			auditAuto({ session: sessionId, stage: "jev", decision: "degraded", err: "unavailable", trigger });
			if (ctx.hasUI && !autoDegradedNotified) {
				autoDegradedNotified = true;
				ctx.ui.notify("Refine auto: Jev unavailable — background proposals disabled this session", "warning");
			}
			return;
		}

		let response;
		try {
			response = await ctx.modelRegistry.complete(
				model,
				{ messages: [{ role: "user", content: [{ type: "text", text: buildProposalPrompt(trajectory, lessons, coverage, bodies) }], timestamp: Date.now() }] },
				{ reasoningEffort: "high", cacheRetention: "none", sessionId: uuidv7() },
			);
		} catch (error) {
			auditAuto({ session: sessionId, stage: "plan", decision: "error", err: error instanceof Error ? error.message : String(error), trigger });
			return;
		}
		const raw = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const proposals = dedupeProposals(parseProposals(raw), coverage).slice(0, 3);
		const hashes = await collectHashes();
		const fresh = proposals.filter((p) => !hashes.has(hashContent(p.content)));
		if (fresh.length === 0) {
			auditAuto({ session: sessionId, stage: "plan", decision: "no-proposals", trigger });
			return;
		}

		const t0 = Date.now();
		const answers = await jevCall(scrubSecrets(JSON.stringify(buildJevState(fresh, trajectory, bodies))), buildJevQuestions(fresh));
		const latencyJev = Date.now() - t0;

		const applied: string[] = [];
		for (const [i, p] of fresh.entries()) {
			const v = scoreProposal(p, answers, i);
			if (!v) {
				auditAuto({ session: sessionId, stage: "jev", kind: p.kind, name: p.name, decision: "suppressed", mode: "degraded", err: answers ? "malformed-answer" : "call-failed", latencyMs: latencyJev, trigger });
				continue;
			}
			const tier = p.kind === "rule" ? ruleTier(v.parts) : null;
			if (p.kind === "rule" && tier) {
				if (stageRule(p, v, sessionId, trigger, tier)) {
					applied.push(`rule "${p.name}" staged (${tier})`);
					auditAuto({ session: sessionId, stage: "apply", kind: "rule", name: p.name, score: v.score, parts: v.parts, tier, decision: "staged", mode: "verified", latencyMs: latencyJev, trigger });
				} else {
					auditAuto({ session: sessionId, stage: "apply", kind: "rule", name: p.name, decision: "duplicate", trigger });
				}
			} else if (p.kind === "note" && v.score >= AUTO_NOTE_THRESHOLD) {
				await applyProposal(p, undefined, ctx, "auto");
				applied.push(`note "${p.name}" applied`);
				auditAuto({ session: sessionId, stage: "apply", kind: "note", name: p.name, score: v.score, parts: v.parts, decision: "applied", mode: "verified", latencyMs: latencyJev, trigger });
			} else {
				auditAuto({ session: sessionId, stage: "jev", kind: p.kind, name: p.name, score: v.score, parts: v.parts, decision: "suppressed", mode: "verified", latencyMs: latencyJev, trigger });
			}
		}
		if (applied.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Refine auto: ${applied.join(", ")} — /refine-review to arm staged rules`, "info");
		}
	};

	pi.on("tool_execution_end", (event) => {
		if (!event.isError) return;
		const sig = `${event.toolName}:${JSON.stringify(event.result)?.slice(0, 120) ?? "?"}`;
		autoToolErrors.set(sig, (autoToolErrors.get(sig) ?? 0) + 1);
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!AUTO_ENABLED) return;
		autoTurnCount++;
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		for (let i = autoScanLen; i < branch.length; i++) {
			const e = branch[i];
			if (e.type !== "message" || e.message?.role !== "user") continue;
			if (CORRECTION_RE.test(extractTextParts(e.message.content).join("\n"))) autoCorrections++;
		}
		autoScanLen = branch.length;
		if (autoTurnCount < AUTO_TURNS || autoRunning) return;
		const toolErrSignal = [...autoToolErrors.values()].some((n) => n >= 2);
		if (autoCorrections === 0 && !toolErrSignal) return;
		if (!(ctx.mode === "tui" || AUTO_HEADLESS)) return;
		const trigger = [autoCorrections > 0 ? "correction" : null, toolErrSignal ? "tool-errors" : null].filter(Boolean).join("+") || "signal";
		autoTurnCount = 0;
		autoCorrections = 0;
		autoToolErrors.clear();
		const window = branch.slice(autoProcessedLen);
		autoProcessedLen = branch.length;
		autoRunning = true;
		void runAutoRefine(ctx, window, trigger)
			.catch((error) => {
				auditAuto({ session: ctx.sessionManager.getSessionId(), stage: "plan", decision: "error", err: error instanceof Error ? error.message : String(error), trigger });
			})
			.finally(() => {
				autoRunning = false;
			});
	});

	pi.registerCommand("refine", {
		description: "Review this session's trajectory and propose the smallest harness improvements (rules/notes)",
		handler: async (args, ctx) => {
			const focus = args?.trim() || undefined;
			const trajectory = buildTrajectoryText(ctx.sessionManager.getBranch() as SessionEntry[]);

			if (!trajectory.trim()) {
				ctx.ui.notify("No conversation to refine", "warning");
				return;
			}

			const model = ctx.model;
			if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
				ctx.ui.notify("No authenticated model available for refinement planning", "warning");
				return;
			}

			ctx.ui.notify("Refine: analyzing trajectory...", "info");

			const [lessons, coverage, bodies] = await Promise.all([readHermesLessons(), listCoverage(), readCoverageBodies()]);

			let response;
			try {
				response = await ctx.modelRegistry.complete(
					model,
					{ messages: [{ role: "user", content: [{ type: "text", text: buildProposalPrompt(trajectory, lessons, coverage, bodies, focus) }], timestamp: Date.now() }] },
					{ reasoningEffort: "high", cacheRetention: "none", sessionId: uuidv7() },
				);
			} catch (error) {
				ctx.ui.notify(`Refine planning failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const raw = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const proposals = dedupeProposals(parseProposals(raw), coverage);

			if (proposals.length === 0) {
				ctx.ui.notify("Refine: nothing met the evidence bar — no edits proposed", "info");
				return;
			}

			for (const proposal of proposals) {
				const outcome = await showProposalUi(proposal, ctx);
				if (outcome === "apply") await applyProposal(proposal, focus, ctx);
			}
		},
	});

	pi.registerCommand("refine-history", {
		description: "List applied refinements and optionally roll one back",
		handler: async (_args, ctx) => {
			const history = await readHistory();
			const active = history.filter((entry) => !entry.rolledBack);

			if (active.length === 0) {
				ctx.ui.notify("No refinements applied yet", "info");
				return;
			}

			const selected = await ctx.ui.select(
				"Refinement history (select to roll back):",
				active.map((entry) => `${entry.kind} ${entry.name} — ${entry.timestamp}`),
			);
			if (!selected) return;

			const entry = active.find((e) => `${e.kind} ${e.name} — ${e.timestamp}` === selected);
			if (!entry) return;

			const confirmed = await ctx.ui.confirm("Roll back refinement?", `${entry.kind} "${entry.name}" — delete ${entry.path}?`);
			if (!confirmed) return;

			try {
				await unlink(entry.path);
			} catch (error) {
				// expected: the file was already removed out-of-band
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				ctx.ui.notify(`File already gone: ${entry.path}`, "warning");
			}

			entry.rolledBack = true;
			await writeFile(
				HISTORY_FILE,
				`${history.map((e) => JSON.stringify(e)).join("\n")}\n`,
				"utf8",
			);
			ctx.ui.notify(`Rolled back "${entry.name}"`, "info");
		},
	});

	pi.registerCommand("refine-review", {
		description: "Review staged auto-refine rules in a two-panel reader — select with ↑/↓, arm, reject, or close; 'discard' arg rejects directly",
		handler: async (args, ctx) => {
			const discard = args?.trim().toLowerCase() === "discard";
			const staged = (await readdir(STAGING_DIR).catch(() => [] as string[])).filter((f) => f.endsWith(".md")).sort();
			if (staged.length === 0) {
				ctx.ui.notify("No staged auto-refine rules to review", "info");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId();

			if (discard) {
				const selected = await ctx.ui.select("Discard which staged rule?", staged);
				if (!selected) return;
				const confirmed = await ctx.ui.confirm("Discard staged rule?", `"${selected}" will be deleted without arming.`);
				if (!confirmed) return;
				const name = selected.replace(/\.md$/, "");
				const content = await readFile(join(STAGING_DIR, selected), "utf8").catch(() => "");
				if (content) recordRejected(name, content);
				await unlink(join(STAGING_DIR, selected)).catch(() => {});
				await unlink(join(STAGING_DIR, `${name}.meta.json`)).catch(() => {});
				auditAuto({ session: sessionId, stage: "review", kind: "rule", name, decision: "discarded" });
				ctx.ui.notify(`Discarded "${name}"`, "info");
				return;
			}

			const items: ReviewItem[] = [];
			for (const file of staged) {
				const name = file.replace(/\.md$/, "");
				let meta: StagedMeta | null = null;
				try {
					meta = JSON.parse(await readFile(join(STAGING_DIR, `${name}.meta.json`), "utf8")) as StagedMeta;
				} catch {
					meta = null;
				}
				items.push({
					name,
					title: `${meta?.tier === "near-miss" ? "[near-miss] " : ""}${meta?.title ?? name}`,
					evidence: meta?.evidence ?? "(staged by background auto-refine)",
					content: (await readFile(join(STAGING_DIR, file), "utf8")).trim(),
					meta,
				});
			}

			const outcome = await showReviewSession(items, ctx, {
				arm: (item) => {
					const target = join(RULES_DIR, `${item.name}.md`);
					if (existsSync(target)) {
						ctx.ui.notify(`Skipped "${item.name}" — ${target} already exists`, "warning");
						auditAuto({ session: sessionId, stage: "review", kind: "rule", name: item.name, decision: "duplicate" });
						return false;
					}
					mkdirSync(RULES_DIR, { recursive: true });
					renameSync(join(STAGING_DIR, `${item.name}.md`), target);
					const metaPath = join(STAGING_DIR, `${item.name}.meta.json`);
					if (existsSync(metaPath)) unlinkSync(metaPath);
					appendHistory({
						id: uuidv7(),
						timestamp: new Date().toISOString(),
						kind: "rule",
						name: item.name,
						path: target,
						evidence: item.evidence,
						source: "auto",
					});
					auditAuto({ session: sessionId, stage: "review", kind: "rule", name: item.name, decision: "armed", score: item.meta?.score ?? null, parts: item.meta?.parts ?? null, tier: item.meta?.tier ?? null });
					ctx.ui.notify(`Armed "${item.name}" → ${target} — run /ttsr-reload to activate`, "info");
					return true;
				},
				reject: (item) => {
					recordRejected(item.name, item.content);
					const stagedPath = join(STAGING_DIR, `${item.name}.md`);
					if (existsSync(stagedPath)) unlinkSync(stagedPath);
					const metaPath = join(STAGING_DIR, `${item.name}.meta.json`);
					if (existsSync(metaPath)) unlinkSync(metaPath);
					auditAuto({ session: sessionId, stage: "review", kind: "rule", name: item.name, decision: "discarded", score: item.meta?.score ?? null, parts: item.meta?.parts ?? null, tier: item.meta?.tier ?? null });
					ctx.ui.notify(`Rejected "${item.name}"`, "info");
					return true;
				},
			});
			// Rules viewed but left undecided stay staged; audit each once.
			for (const kept of outcome.keptStaged) {
				auditAuto({ session: sessionId, stage: "review", kind: "rule", name: kept.name, decision: "kept-staged", score: kept.meta?.score ?? null, parts: kept.meta?.parts ?? null, tier: kept.meta?.tier ?? null });
			}
		},
	});

	pi.registerTool({
		name: "refine_propose",
		label: "Refine Propose",
		description: "Queue a harness improvement draft (TTSR rule or memory note) when you notice a recurring failure or a user correction. The user reviews and approves it via an overlay before anything is written.",
		promptSnippet: "Queue a rule/note draft from an observed recurring failure or correction; user approves via overlay",
		promptGuidelines: [
			"Use refine_propose when the same failure occurs 2+ times in this session or the user corrects an anti-pattern that is likely to recur. Supply a complete draft: for kind=rule, content must be a full TTSR rule file including frontmatter with a precise condition or astCondition; for kind=note, content is plain markdown. Do not propose one-off events or anything without a matchable signature (use kind=note for those).",
		],
		parameters: Type.Object({
			kind: StringEnum(["rule", "note"] as const),
			name: Type.String({ description: "kebab-case slug used as the filename" }),
			title: Type.String({ description: "one-line summary" }),
			evidence: Type.String({ description: "quoted trajectory line(s) justifying this edit plus why it will recur" }),
			content: Type.String({ description: "full file content: frontmatter + body for rule, markdown body for note" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const proposal = toProposal(params);
			if (!proposal) {
				throw new Error(
					'Invalid proposal: kind must be "rule"|"note", name must be kebab-case, content must be non-empty, and rule content must include a condition or astCondition in frontmatter.',
				);
			}
			const coverage = await listCoverage();
			const stagedNames = await readdir(STAGING_DIR)
				.then((files) => files.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")))
				.catch(() => [] as string[]);
			if (coverage.rules.includes(proposal.name) || coverage.notes.includes(proposal.name) || stagedNames.includes(proposal.name)) {
				return {
					content: [{ type: "text", text: `Skipped: "${proposal.name}" already exists in refine coverage. Nothing queued.` }],
					details: { queued: false, reason: "duplicate" },
				};
			}
			const approved = await showProposalUi(proposal, ctx);
			if (!approved) {
				return {
					content: [{ type: "text", text: `Proposal "${proposal.name}" skipped by user.` }],
					details: { queued: false, reason: "user-declined" },
				};
			}
			await applyProposal(proposal, undefined, ctx);
			return {
				content: [{ type: "text", text: `Applied "${proposal.name}" (${proposal.kind}).` }],
				details: { queued: true, applied: true },
			};
		},
	});
}

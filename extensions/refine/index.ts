import { StringEnum, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
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
	rolledBack?: boolean;
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

const REFINE_DIR = join(homedir(), ".pi", "agent", "refine");
const NOTES_DIR = join(REFINE_DIR, "notes");
const HISTORY_FILE = join(REFINE_DIR, "history.jsonl");
const RULES_DIR = join(homedir(), ".pi", "agent", "rules");
const HERMES_FAILURES = join(homedir(), ".pi", "agent", "pi-hermes-memory", "failures.md");

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
---
Reminder body (what the agent sees on match). Keep it short and directive.

A rule is ONLY justified when the failure has a detectable signature in the
agent's own output (a text pattern it emits, or a code shape it writes).
If you cannot write a precise condition/astCondition, use kind "note" instead.
Never write always-apply guidance as a rule.
`.trim();

const buildProposalPrompt = (trajectory: string, lessons: string[], coverage: Coverage, focus?: string): string =>
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
		'- "rule": a stream-triggered TTSR rule (format below). Choose ONLY when the anti-pattern has a precise trigger signature in agent output.',
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

const showProposalUi = async (proposal: Proposal, ctx: ExtensionContext): Promise<boolean> => {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Refine: proposal "${proposal.name}" requires interactive TUI review — skipped`, "warning");
		return false;
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
				if (matchesKey(data, "enter")) done(true);
				if (matchesKey(data, "escape")) done(false);
			},
		};
	});
};

const applyProposal = async (proposal: Proposal, focus: string | undefined, ctx: ExtensionContext): Promise<void> => {
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
	};
	await mkdir(REFINE_DIR, { recursive: true });
	await appendFile(HISTORY_FILE, `${JSON.stringify(entry)}\n`, "utf8");

	ctx.ui.notify(
		proposal.kind === "rule" ? `Applied rule → ${targetPath} (verify with /ttsr)` : `Applied note → ${targetPath}`,
		"info",
	);
};

export default function (pi: ExtensionAPI) {
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

			const [lessons, coverage] = await Promise.all([readHermesLessons(), listCoverage()]);

			let response;
			try {
				response = await ctx.modelRegistry.complete(
					model,
					{ messages: [{ role: "user", content: [{ type: "text", text: buildProposalPrompt(trajectory, lessons, coverage, focus) }], timestamp: Date.now() }] },
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
				const apply = await showProposalUi(proposal, ctx);
				if (apply) await applyProposal(proposal, focus, ctx);
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
			if (coverage.rules.includes(proposal.name) || coverage.notes.includes(proposal.name)) {
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

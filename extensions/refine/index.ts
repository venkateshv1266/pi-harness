import { StringEnum, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { KIND_SPECS, PROPOSABLE_KINDS, harnessDigest, type HarnessKind, type StagedManifest } from "../../utils/harness-surface.ts";
import {
	armProposal,
	aggregateProposals,
	contentHash,
	dedupeProposals,
	describeArm,
	listCoverage,
	listStaged,
	migrateLegacyStaging,
	parseProposals,
	proposalContent,
	proposalHash,
	readCoverageBodies,
	rollbackArm,
	stageProposal,
	toProposal,
	updateStagedProbe,
	type ArmResult,
	type ArmTarget,
	type Coverage,
	type CoverageBodies,
	type Proposal,
	type StagedItem,
} from "./harness.ts";
import { runExtensionGate, type ExtensionGateResult } from "./extension-gate.ts";
import { logProbe, markProbeSweep, probeLine, probeOne, probeStaged, probeSweepDue, type RuleProbe } from "./probe.ts";
import { recallLibraryText, runExperiencePass } from "./library.ts";
import { applyProposal as applyTunerProposal, readProposals as readTunerProposals } from "../decision-tuner/index.ts";

type HistoryEntry = {
	id: string;
	timestamp: string;
	kind: HarnessKind;
	name: string;
	path: string;
	armed?: ArmTarget[];
	focus?: string;
	evidence: string;
	source?: "auto" | "manual";
	rolledBack?: boolean;
	digest?: string;
	expectation?: string;
};

type JevAnswer = { noul?: number; confidence?: number };
type JevAnswers = Record<string, JevAnswer | undefined>;
type JevParts = { evidence: number; trigger: number; novelty: number };

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

const AGENT_ROOT = join(homedir(), ".pi", "agent");
const REFINE_DIR = join(AGENT_ROOT, "jev-decisions", "refine");
const NOTES_DIR = join(REFINE_DIR, "notes");
const HISTORY_FILE = join(REFINE_DIR, "history.jsonl");
const RULES_DIR = join(AGENT_ROOT, "rules");
const HERMES_FAILURES = join(AGENT_ROOT, "pi-hermes-memory", "failures.md");
const AUDIT_FILE = join(REFINE_DIR, "auto-refine.jsonl");
const REJECTED_FILE = join(REFINE_DIR, "rejected.jsonl");
const DECISIONS_ROOT = join(AGENT_ROOT, "jev-decisions");
const LIBRARY_ROOT = join(AGENT_ROOT, "harness-library");

const MAX_TRAJECTORY_CHARS = 60_000;
const MAX_LESSON_CHARS = 8_000;
const MAX_LESSONS = 12;
const MAX_LIBRARY_CHARS = 4_000;

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

const buildProposalPrompt = (trajectory: string, lessons: string[], coverage: Coverage, bodies?: CoverageBodies, focus?: string, library: string[] = []): string =>
	[
		"You are a refinement planner for a coding agent. Analyze the session trajectory below and propose the SMALLEST possible harness edit(s) that would measurably improve future sessions.",
		"",
		"Look ONLY for:",
		'1. The user correcting the agent (explicitly: "no", "don\'t", "stop doing X", or a rework demand).',
		"2. The same failure occurring 2+ times (repeated tool errors, repeated lint/test failures from the same cause).",
		"3. A non-obvious workaround or environment quirk the agent discovered by trial and error.",
		"4. A multi-step workflow that clearly succeeded and is likely to recur verbatim.",
		"",
		"Propose AT MOST 3 edits and label each with \"dimension\": \"inv\" or \"dom\". The loop keeps at most 3 and interleaves the two dimensions, so do not spend every slot on one: one INV + one DOM beats three of either. Prefer fewer when the evidence is thin; return {\"proposals\": []} if nothing clears this bar — single one-off events do NOT qualify.",
		"",
		"Two dimensions, kept separate so proposals do not overlap — label every proposal with one:",
		"- INV (how the agent works): procedure, tool use, sequencing, completion discipline.",
		"- DOM (what a practitioner knows): verified workspace facts, project conventions, infrastructure quirks. Prefer a named component (context entry, skill, agent) over prose.",
		"",
		"Kinds (pick the smallest one that carries the edit):",
		'- "rule": a stream-triggered TTSR rule (format below). ONLY when the anti-pattern has a precise trigger signature in agent output AND it recurred 2+ times. Prefer astCondition over text regex; intent-level behavior belongs in a note.',
		'- "note": passive markdown record for observations with no stream-matchable signature.',
		'- "context": a doc plus a registry fragment entry.yaml (id, file, tier, triggers) that makes it fire when relevant.',
		'- "agent": a subagent definition with frontmatter name/description/tools/model/thinking. Use when delegation divides labor cleanly.',
		'- "skill": a SKILL.md with frontmatter name/description and structured procedure steps. Use for a repeatable multi-step workflow.',
		'- "settings": a narrow settings patch (patch.json) for modelRouter/courseCheck/decisionTuner/refine keys only; primitives only.',
		'- "extension": a NEW pi extension bundle that gives agents a better tool. Requires "index.ts" (default-exported factory), "README.md", and a pairing trigger — either "pairing.md" (a TTSR rule that fires when the tool is relevant) or "pairing.md" + "pairing.yaml" (a context doc + registry fragment). Also requires "expectation": "tool:<name>" or "command:<name>" — the observable call that proves adoption. Never edit an existing extension; propose a note instead. The bundle is gated on compile + fake-pi smoke + safety scan before arming.',
		"",
		'"name" is a kebab-case slug. "title" is one-line. "evidence" MUST quote the exact trajectory line(s) plus one sentence on why it will recur.',
		'"files" maps a RELATIVE path to full file content. rule/note/agent: one "<name>.md". context: "<name>.md" + "entry.yaml". skill: "SKILL.md". settings: "patch.json". extension: "index.ts" + "README.md" + "pairing.md" (+ "pairing.yaml" for a context pairing).',
		"",
		"Respond with ONLY a JSON object, no markdown fences, in this exact shape:",
		'{"proposals": [{"kind": "rule|note|context|agent|skill|settings|extension", "name": "...", "title": "...", "dimension": "inv|dom", "evidence": "...", "files": {"...": "..."}, "expectation": "tool:<name> (extension only)"}]}',
		"",
		"Rule file format:",
		RULE_FORMAT,
		"",
		"Lessons already captured in persistent memory (hermes). Do NOT re-propose these as-is — memory alone already covers them. Propose an enforced TTSR rule ONLY when the evidence shows a lesson RECURRED across sessions (or recurred again this session); promoting a recurring memory lesson into a rule is exactly the goal:",
		"<memory-lessons>",
		...(lessons.length > 0 ? lessons : ["(none)"]),
		"</memory-lessons>",
		"",
		"Lessons from the harness library, grouped by domain. These are past PROPOSAL outcomes, not trajectory facts — treat them as priors. Do not re-propose what a lesson records as rolled back, gate-blocked, pruned, or measured with false positives; propose around that shape instead:",
		"<harness-library>",
		...(library.length > 0 ? library : ["(none)"]),
		"</harness-library>",
		"",
		`Existing refine coverage (do NOT duplicate): rules: [${coverage.rules.join(", ") || "none"}]; notes: [${coverage.notes.join(", ") || "none"}]; contexts: [${coverage.contexts.join(", ") || "none"}]; agents: [${coverage.agents.join(", ") || "none"}]; skills: [${coverage.skills.join(", ") || "none"}]; extensions: [${coverage.extensions.join(", ") || "none"}]`,
		"Existing notes are passive records, not enforcement. If the trajectory shows one of those lessons being violated AGAIN, propose its rule version — promotion is expected, not duplication (the rule still needs a precise trigger).",
		"Existing bodies (overlap check — never re-propose what an existing RULE already enforces; note bodies double as promotion candidates):",
		bodies
			? [...bodies.rules.map((r) => `- rule ${r.name}: ${r.body}`), ...bodies.others.map((o) => `- other ${o.name}: ${o.body}`)].join("\n") || "(none)"
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
		container.addChild(new Text(theme.fg("accent", theme.bold(`Refine proposal [${KIND_SPECS[proposal.kind].label}]: ${proposal.title}`)), 1, 0));
		container.addChild(new Text(theme.fg("dim", `evidence: ${proposal.evidence}`), 1, 1));
		if (proposal.expectation) container.addChild(new Text(theme.fg("dim", `expectation: ${proposal.expectation}`), 1, 0));
		container.addChild(new Text(theme.fg("dim", `files: ${Object.keys(proposal.files).sort().join(", ")}`), 1, 0));
		container.addChild(new Markdown(proposalContent(proposal), 1, 1, mdTheme));
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

type ReviewItem = {
	kind: HarnessKind;
	name: string;
	title: string;
	evidence: string;
	files: Record<string, string>;
	content: string;
	meta: StagedManifest | null;
	armHint?: string[];
	gate?: ExtensionGateResult;
	/** Measured corpus result for rule/context items (paper score stays in meta.parts). */
	probe?: RuleProbe;
};

const buildReviewDoc = (item: ReviewItem): string => {
	const evidence = item.evidence
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	const metaLines: string[] = [`kind ${KIND_SPECS[item.kind].label}`];
	if (item.meta && typeof item.meta.score === "number" && item.meta.parts) {
		metaLines.push(
			`score ${item.meta.score.toFixed(2)} · evidence ${fmtPart(item.meta.parts.evidence)} · novelty ${fmtPart(item.meta.parts.novelty)} · kind-signal ${fmtPart(item.meta.parts.trigger)}`,
		);
		metaLines.push(`tier ${item.meta.tier ?? "—"} · loop trigger ${item.meta.trigger} · staged ${item.meta.stagedAt}`);
	}
	if (item.armHint && item.armHint.length > 0) metaLines.push(`arm: ${item.armHint.join(" · ")}`);
	if (item.probe) metaLines.push(probeLine(item.probe));

	const gateLines = item.gate
		? [
			"",
			"### Validation gate",
			"",
			`- compile: ${item.gate.compile.ok ? "pass" : "FAIL"} — ${item.gate.compile.detail}`,
			`- fake-pi smoke: ${item.gate.smoke.ok ? "pass" : "FAIL"} — ${item.gate.smoke.detail}`,
			`- safety: ${item.gate.safety.ok ? "pass" : "FAIL"} — ${item.gate.safety.detail}`,
			...(item.gate.warnings.length > 0 ? ["", ...item.gate.warnings.map((warning) => `  - warning: ${warning}`)] : []),
			...(item.gate.reasons.length > 0 ? ["", ...item.gate.reasons.map((reason) => `  - blocker: ${reason}`)] : []),
		]
		: [];

	const blocks = Object.keys(item.files)
		.sort()
		.map((rel) => {
			const content = item.files[rel];
			const backtickRuns = content.match(/`+/g) ?? [];
			const fence = "`".repeat(Math.max(3, ...backtickRuns.map((r) => r.length + 1)));
			return `### \`${rel}\`\n\n${fence}md\n${content}\n${fence}`;
		});

	return [`## ${item.title}`, "", evidence, "", ...metaLines, ...gateLines, "", ...blocks].join("\n");
};

// Persistent two-panel review session: a capped list panel on top, the selected
// rule's evidence, gate scores and verbatim content in the large panel below.
// One overlay lives for the whole session — ↑/↓ re-render in place instead of
// closing and reopening (which flickered) — and arm/reject run synchronously
// through the handler-provided actions before the list is updated.
const showReviewSession = (
	items: ReviewItem[],
	ctx: ExtensionContext,
	actions: { arm: (item: ReviewItem) => Promise<boolean>; reject: (item: ReviewItem) => Promise<boolean> },
): Promise<{ keptStaged: { kind: HarnessKind; name: string; meta: StagedManifest | null }[] }> => {
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
			let pendingAction = false;
			const viewed = new Map<string, StagedManifest | null>();
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
				const keptStaged: { kind: HarnessKind; name: string; meta: StagedManifest | null }[] = [];
				for (const [key, meta] of viewed) {
					const kept = list.find((item) => `${item.kind}:${item.name}` === key);
					if (kept) keptStaged.push({ kind: kept.kind, name: kept.name, meta });
				}
				done({ keptStaged });
			};
			const scroll = (delta: number) => {
				contentTop = Math.max(0, Math.min(contentTop + delta, Math.max(0, contentTotal - contentPage)));
			};
			const showItem = (index: number) => {
				sel = index;
				viewed.set(`${list[sel].kind}:${list[sel].name}`, list[sel].meta);
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
			const run = async (action: (item: ReviewItem) => Promise<boolean>) => {
				if (pendingAction) return;
				pendingAction = true;
				try {
					decide(await action(list[sel]));
				} finally {
					pendingAction = false;
				}
			};
			const arm = () => void run(actions.arm);
			const reject = () => void run(actions.reject);

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

// Observatory's daily snapshot is a materialized view over the streams appended
// below, so every harness change invalidates the day. One shared import promise:
// concurrent callers join it, and a failed load clears it so a later call retries
// instead of inheriting a permanently rejected promise.
let snapshotModule: Promise<typeof import("../observatory/server/snapshots.ts")> | null = null;
const refreshSnapshot = (force = false): void => {
	snapshotModule ??= import("../observatory/server/snapshots.ts");
	void snapshotModule
		.then((module) => {
			module.ensureSnapshot(undefined, undefined, { force });
		})
		.catch(() => {
			// expected: observatory is not installed alongside refine
			snapshotModule = null;
		});
};

const appendHistory = (entry: HistoryEntry): void => {
	mkdirSync(REFINE_DIR, { recursive: true });
	appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`, "utf8");
	refreshSnapshot(true);
};

const armDirect = async (proposal: Proposal): Promise<ArmResult> => {
	const item: StagedItem = {
		kind: proposal.kind,
		name: proposal.name,
		title: proposal.title,
		evidence: proposal.evidence,
		files: proposal.files,
		content: proposalContent(proposal),
		dir: "",
		meta: {
			kind: proposal.kind,
			name: proposal.name,
			title: proposal.title,
			evidence: proposal.evidence,
			files: proposal.files,
			score: 0,
			parts: {},
			session: "manual",
			stagedAt: new Date().toISOString(),
			trigger: "manual",
		},
	};
	return armProposal({ agentRoot: AGENT_ROOT, refineRoot: REFINE_DIR, item });
};

const applyProposal = async (proposal: Proposal, focus: string | undefined, ctx: ExtensionContext, source: "auto" | "manual" = "manual", recalled: string[] = []): Promise<void> => {
	const result = await armDirect(proposal);
	if (!result.ok) {
		ctx.ui.notify(`Skipped "${proposal.name}" — ${result.reason}`, "warning");
		return;
	}

	const primary = result.targets[0];
	appendHistory({
		id: uuidv7(),
		timestamp: new Date().toISOString(),
		kind: proposal.kind,
		name: proposal.name,
		path: primary,
		armed: result.armed,
		focus,
		evidence: proposal.evidence,
		source,
		digest: harnessDigest(AGENT_ROOT),
		expectation: proposal.expectation,
		...(recalled.length > 0 ? { recalled } : {}),
	});

	const hint =
		proposal.kind === "rule"
			? " — run /ttsr-reload to activate"
			: proposal.kind === "context"
				? " — run /ttsr-reload to activate"
				: proposal.kind === "settings"
					? " — applies from the next session"
					: "";
	ctx.ui.notify(`Applied ${KIND_SPECS[proposal.kind].label} "${proposal.name}" → ${primary}${hint}`, "info");
	void runExperiencePass({ refineRoot: REFINE_DIR, libraryRoot: LIBRARY_ROOT, decisionsRoot: DECISIONS_ROOT, trigger: "arm" }).catch(() => {
		// expected: the lesson pass is best-effort and must never break an arm
	});
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

const collectHashes = async (): Promise<Set<string>> => {
	const hashes = new Set<string>();
	for (const dir of [RULES_DIR, NOTES_DIR]) {
		try {
			for (const f of await readdir(dir)) {
				if (!f.endsWith(".md")) continue;
				hashes.add(contentHash(await readFile(join(dir, f), "utf8")));
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	for (const item of await listStaged(REFINE_DIR)) {
		hashes.add(proposalHash({ kind: item.kind, name: item.name, title: item.title, evidence: item.evidence, files: item.files }));
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

// A rejected draft is remembered by bundle hash so the auto loop cannot re-stage it.
const recordRejected = (kind: HarnessKind, name: string, proposal: Proposal): void => {
	mkdirSync(REFINE_DIR, { recursive: true });
	appendFileSync(REJECTED_FILE, `${JSON.stringify({ kind, name, hash: proposalHash(proposal), rejectedAt: new Date().toISOString() })}\n`, "utf8");
};

const buildJevState = (proposals: Proposal[], trajectory: string, bodies: CoverageBodies): Record<string, unknown> => ({
	proposals: proposals.map((p) => ({
		kind: p.kind,
		name: p.name,
		title: p.title,
		evidence: p.evidence,
		expectation: p.expectation ?? null,
		files: Object.fromEntries(Object.entries(p.files).map(([rel, content]) => [rel, content.slice(0, 4000)])),
		content: proposalContent(p).slice(0, 4000),
	})),
	trajectory: trajectory.slice(-12_000),
	existing_rules: bodies.rules.map((r) => ({ name: r.name, body: r.body.slice(0, 300) })),
	existing_other: bodies.others.map((n) => ({ name: n.name, body: n.body.slice(0, 300) })),
});

const KIND_QUESTION: Record<HarnessKind, string> = {
	rule: "Given the proposed rule's condition/astCondition and the assistant output visible in `trajectory`, is the trigger precise enough to fire on genuine future instances of the anti-pattern while rarely firing on unrelated output?",
	note: "",
	context: "Is the registry fragment's trigger precise enough that the doc is read when it is relevant, and rarely otherwise?",
	agent: "Does this subagent definition have a distinct role, a clear scope, and a tool allowlist narrow enough to be safe?",
	skill: "Is this a repeatable multi-step workflow whose steps are concrete enough to follow without re-deriving them?",
	settings: "Is this settings change narrowly scoped, reversible, and unlikely to degrade behavior if the assumption is wrong?",
	extension: "Given the proposed extension source and its pairing artifact, is the trigger precise enough to surface the tool when it is genuinely useful, and does the expectation name the observable tool/command call that proves adoption?",
};

const buildJevQuestions = (proposals: Proposal[]): Record<string, unknown> => {
	const questions: Record<string, unknown> = {};
	for (const [i, p] of proposals.entries()) {
		questions[`p${i}_evidence`] = {
			type: "noul",
			instructions: "Does `evidence` quote trajectory lines that genuinely show the user correcting the agent, the agent reworking output after a user demand, or the same failure recurring 2+ times? Judge from `trajectory`.",
		};
		const kindQuestion = KIND_QUESTION[p.kind];
		if (kindQuestion) questions[`p${i}_trigger`] = { type: "noul", instructions: kindQuestion };
		questions[`p${i}_redundant`] = {
			type: "noul",
			instructions: "Is all guidance in the proposal's `content`/`files` already enforced or recorded by `existing_rules` or `existing_other`? A shared topic alone does not imply redundancy.",
		};
	}
	return questions;
};

// Weakest-link score is recorded for the audit/calibration trail; gating is per-part floors.
const scoreProposal = (p: Proposal, answers: JevAnswers | null, i: number): { score: number; parts: JevParts } | null => {
	if (!answers) return null;
	const evidence = answerNoul(answers, `p${i}_evidence`);
	const trigger = p.kind === "note" ? 1 : answerNoul(answers, `p${i}_trigger`);
	const redundant = answerNoul(answers, `p${i}_redundant`);
	if (evidence === null || trigger === null || redundant === null) return null;
	return { score: Math.min(evidence, trigger, 1 - redundant), parts: { evidence, trigger, novelty: 1 - redundant } };
};

const floorFor = (kind: HarnessKind, part: "evidence" | "trigger" | "novelty"): number => {
	if (kind === "rule") {
		if (part === "evidence") return AUTO_RULE_EVIDENCE_FLOOR;
		if (part === "novelty") return AUTO_RULE_NOVELTY_FLOOR;
		if (part === "trigger") return AUTO_RULE_TRIGGER_FLOOR;
	}
	const env = process.env[`REFINE_AUTO_${kind.toUpperCase()}_${part.toUpperCase()}_FLOOR`];
	return clamp01(env, KIND_SPECS[kind].floors[part] ?? 0.6);
};

const NOVELTY_EXEMPT: ReadonlySet<string> = new Set(["note"]);

// Two-band gate: trigger parts empirically cap below a 0.8 weakest-link bar, so
// per-part floors stage "ready" drafts and a lower band stages near-misses for review.
export const kindTier = (kind: HarnessKind, parts: JevParts): "ready" | "near-miss" | null => {
	if (NOVELTY_EXEMPT.has(kind)) {
		if (parts.evidence >= floorFor(kind, "evidence")) return "ready";
	} else {
		const ready = KIND_SPECS[kind].parts.every((part) => parts[part] >= floorFor(kind, part));
		if (ready) return "ready";
	}
	if (Math.min(parts.evidence, parts.novelty) >= AUTO_NEAR_MISS_FLOOR) return "near-miss";
	return null;
};

export const ruleTier = (parts: JevParts): "ready" | "near-miss" | null => kindTier("rule", parts);

const auditAuto = (entry: Record<string, unknown>): void => {
	try {
		mkdirSync(REFINE_DIR, { recursive: true });
		appendFileSync(AUDIT_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
	} catch {
		/* audit must never break the loop */
	}
};

const stageKind = async (p: Proposal, v: { score: number; parts: JevParts }, session: string, trigger: string, tier: "ready" | "near-miss", recalled: string[] = []): Promise<boolean> =>
	stageProposal(REFINE_DIR, p, {
		kind: p.kind,
		name: p.name,
		title: p.title,
		evidence: p.evidence,
		files: p.files,
		score: v.score,
		parts: v.parts,
		session,
		stagedAt: new Date().toISOString(),
		trigger,
		tier,
		...(recalled.length > 0 ? { recalled } : {}),
	});

export default function (pi: ExtensionAPI) {
	// One-time move of the pre-wave-1 rules-staging layout; staged items are inert either way.
	void migrateLegacyStaging(REFINE_DIR).catch((error: unknown) => {
		process.stderr.write(`[refine] legacy staging migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
	});

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
		const [lessons, coverage, bodies, library] = await Promise.all([
			readHermesLessons(),
			listCoverage(AGENT_ROOT, REFINE_DIR),
			readCoverageBodies(AGENT_ROOT, REFINE_DIR),
			recallLibraryText(LIBRARY_ROOT, { text: trajectory.slice(-4_000), maxChars: MAX_LIBRARY_CHARS }),
		]);
		const recalled = library.entries.map((entry) => entry.id);

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
				{ messages: [{ role: "user", content: [{ type: "text", text: buildProposalPrompt(trajectory, lessons, coverage, bodies, undefined, library.lines) }], timestamp: Date.now() }] },
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
		const proposals = aggregateProposals(parseProposals(raw), coverage, 3);
		const hashes = await collectHashes();
		const fresh = proposals.filter((p) => !hashes.has(proposalHash(p)));
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
			const tier = p.kind === "note" ? null : kindTier(p.kind, v.parts);
			if (p.kind !== "note" && tier) {
				if (await stageKind(p, v, sessionId, trigger, tier, recalled)) {
					let gateSummary: Record<string, unknown> | undefined;
					let probeSummary: Record<string, unknown> | undefined;
					if (p.kind === "extension") {
						const gate = await runExtensionGate({ name: p.name, files: p.files, expectation: p.expectation });
						await updateStagedProbe(REFINE_DIR, p.kind, p.name, { gate });
						gateSummary = { ok: gate.ok, reasons: gate.reasons, warnings: gate.warnings };
						applied.push(`extension "${p.name}" staged (${tier}, gate ${gate.ok ? "pass" : "fail"})`);
					} else if (p.kind === "rule" || p.kind === "context") {
						const probe = await probeOne(REFINE_DIR, p.kind, p.name);
						if (probe) {
							probeSummary = { verdict: probe.verdict, hits: probe.hits, misses: probe.misses, falsePositives: probe.falsePositives, passRate: probe.passRate, astSkipped: probe.astSkipped };
							applied.push(`${p.kind} "${p.name}" staged (${tier}, probe ${probe.verdict})`);
						} else {
							applied.push(`${p.kind} "${p.name}" staged (${tier})`);
						}
					} else {
						applied.push(`${p.kind} "${p.name}" staged (${tier})`);
					}
					auditAuto({ session: sessionId, stage: "apply", kind: p.kind, name: p.name, score: v.score, parts: v.parts, tier, decision: "staged", mode: "verified", latencyMs: latencyJev, trigger, ...(gateSummary ? { gate: gateSummary } : {}), ...(probeSummary ? { probe: probeSummary } : {}), ...(recalled.length > 0 ? { recalled } : {}) });
				} else {
					auditAuto({ session: sessionId, stage: "apply", kind: p.kind, name: p.name, decision: "duplicate", trigger });
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

	// Cheap on every turn: ensureSnapshot recomputes only when an input stream is
	// newer than the day's file, so steady state is a handful of stat calls.
	const maybeDailySnapshot = (): void => {
		refreshSnapshot();
	};

	let probeDay = "";
	const maybeProbeSweep = (): void => {
		const day = new Date().toISOString().slice(0, 10);
		if (probeDay === day) return;
		probeDay = day;
		void (async () => {
			if (!(await probeSweepDue(REFINE_DIR, day))) return;
			const { report } = await probeStaged(REFINE_DIR);
			logProbe(report, "sweep");
			await runExperiencePass({ refineRoot: REFINE_DIR, libraryRoot: LIBRARY_ROOT, decisionsRoot: DECISIONS_ROOT, trigger: "nightly" });
			await markProbeSweep(REFINE_DIR, day);
		})().catch(() => {
			// expected: probing is best-effort and must never break the turn
		});
	};

	pi.on("turn_end", (_event, ctx) => {
		maybeDailySnapshot();
		maybeProbeSweep();
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

	// Extension prunes are detected by the tuner (single owner); the review flow
	// surfaces the open ones so a silent tool can be disabled from here too.
	const reviewExtensionPrunes = async (ctx: ExtensionContext): Promise<void> => {
		const prunes = readTunerProposals().filter((proposal) => proposal.status === "open" && proposal.system === "extensions" && proposal.kind === "prune");
		for (const prune of prunes.slice(0, 3)) {
			const confirmed = await ctx.ui.confirm(
				"Disable a silent extension?",
				`${prune.target} — ${prune.evidence}. The directory is renamed to .disabled; rename it back to re-enable.`,
			);
			if (!confirmed) continue;
			ctx.ui.notify(applyTunerProposal(prune.id), "info");
		}
	};

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

			const [lessons, coverage, bodies, library] = await Promise.all([
				readHermesLessons(),
				listCoverage(AGENT_ROOT, REFINE_DIR),
				readCoverageBodies(AGENT_ROOT, REFINE_DIR),
				recallLibraryText(LIBRARY_ROOT, { text: `${focus ?? ""}\n${trajectory.slice(-4_000)}`, maxChars: MAX_LIBRARY_CHARS }),
			]);
			const recalled = library.entries.map((entry) => entry.id);

			let response;
			try {
				response = await ctx.modelRegistry.complete(
					model,
					{ messages: [{ role: "user", content: [{ type: "text", text: buildProposalPrompt(trajectory, lessons, coverage, bodies, focus, library.lines) }], timestamp: Date.now() }] },
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
				if (outcome === "apply") await applyProposal(proposal, focus, ctx, "manual", recalled);
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

			const confirmed = await ctx.ui.confirm("Roll back refinement?", `${entry.kind} "${entry.name}" — restore or remove the files armed from ${entry.path}?`);
			if (!confirmed) return;

			const rollback = await rollbackArm(entry);
			if (!rollback.ok) {
				ctx.ui.notify(`Rollback failed: ${rollback.reason ?? "unknown reason"}`, "warning");
				return;
			}

			entry.rolledBack = true;
			await writeFile(
				HISTORY_FILE,
				`${history.map((e) => JSON.stringify(e)).join("\n")}\n`,
				"utf8",
			);
			ctx.ui.notify(`Rolled back "${entry.name}"`, "info");
			void runExperiencePass({ refineRoot: REFINE_DIR, libraryRoot: LIBRARY_ROOT, decisionsRoot: DECISIONS_ROOT, trigger: "rollback" }).catch(() => {
				// expected: the lesson pass is best-effort and must never break a rollback
			});
		},
	});

	pi.registerCommand("refine-probe", {
		description: "Measure staged rules and context entries against the probe corpus",
		handler: async (_args, ctx) => {
			const { report, items } = await probeStaged(REFINE_DIR);
			logProbe(report, "command");
			if (items.length === 0) {
				ctx.ui.notify("No staged rules or context entries to probe", "info");
				return;
			}
			const lines = items.map((item) => `${item.kind} ${item.name}: ${probeLine(item.probe)}`);
			const rate = report.summary.passRate === null ? "—" : `${Math.round(report.summary.passRate * 100)}%`;
			lines.push(`summary: ${rate} over ${report.corpusSize} fixtures · ${report.summary.falsePositives} false-pos`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("refine-review", {
		description: "Review staged harness edits in a two-panel reader — select with ↑/↓, arm, reject, or close; 'discard' arg rejects directly",
		handler: async (args, ctx) => {
			const discard = args?.trim().toLowerCase() === "discard";
			if (!discard) await reviewExtensionPrunes(ctx);
			const staged = await listStaged(REFINE_DIR);
			if (staged.length === 0) {
				ctx.ui.notify("No staged harness edits to review", "info");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId();

			if (discard) {
				const labels = staged.map((s) => `${s.kind} ${s.name}`);
				const selected = await ctx.ui.select("Discard which staged edit?", labels);
				if (!selected) return;
				const item = staged.find((s) => `${s.kind} ${s.name}` === selected);
				if (!item) return;
				const confirmed = await ctx.ui.confirm("Discard staged edit?", `"${item.kind} ${item.name}" will be deleted without arming.`);
				if (!confirmed) return;
				recordRejected(item.kind, item.name, { kind: item.kind, name: item.name, title: item.title, evidence: item.evidence, files: item.files });
				await rm(item.dir, { recursive: true, force: true });
				auditAuto({ session: sessionId, stage: "review", kind: item.kind, name: item.name, decision: "discarded" });
				ctx.ui.notify(`Discarded "${item.kind} ${item.name}"`, "info");
				return;
			}

			const items: ReviewItem[] = [];
			for (const item of staged) {
				const cachedGate = item.kind === "extension" ? (item.meta.probe as { gate?: ExtensionGateResult } | undefined)?.gate : undefined;
				const cachedProbe = item.kind === "rule" || item.kind === "context" ? (item.meta.probe as { rules?: RuleProbe } | undefined)?.rules : undefined;
				items.push({
					kind: item.kind,
					name: item.name,
					title: `${item.meta.tier === "near-miss" ? "[near-miss] " : ""}${KIND_SPECS[item.kind].label}: ${item.title}`,
					evidence: item.evidence,
					files: item.files,
					content: item.content,
					meta: item.meta,
					armHint: await describeArm(AGENT_ROOT, item),
					gate: item.kind === "extension" ? cachedGate ?? (await runExtensionGate({ name: item.name, files: item.files, expectation: item.meta.expectation })) : undefined,
					probe: cachedProbe,
				});
			}

			const outcome = await showReviewSession(items, ctx, {
				arm: async (item) => {
					const stagedItem = staged.find((s) => s.kind === item.kind && s.name === item.name);
					if (!stagedItem) {
						ctx.ui.notify(`Staged edit "${item.kind} ${item.name}" is gone`, "warning");
						return false;
					}
					let gate: ExtensionGateResult | undefined;
					if (stagedItem.kind === "extension") {
						gate = await runExtensionGate({ name: stagedItem.name, files: stagedItem.files, expectation: stagedItem.meta.expectation });
						if (!gate.ok) {
							ctx.ui.notify(`Blocked "${item.name}" — validation gate: ${gate.reasons.join("; ")}`, "warning");
							auditAuto({ session: sessionId, stage: "review", kind: item.kind, name: item.name, decision: "gate-blocked", gate: { ok: false, reasons: gate.reasons, warnings: gate.warnings } });
							return false;
						}
					}
					const result = await armProposal({ agentRoot: AGENT_ROOT, refineRoot: REFINE_DIR, item: stagedItem, gate });
					if (!result.ok) {
						ctx.ui.notify(`Skipped "${item.kind} ${item.name}" — ${result.reason}`, "warning");
						auditAuto({ session: sessionId, stage: "review", kind: item.kind, name: item.name, decision: "duplicate" });
						return false;
					}
					await rm(stagedItem.dir, { recursive: true, force: true });
					appendHistory({
						id: uuidv7(),
						timestamp: new Date().toISOString(),
						kind: item.kind,
						name: item.name,
						path: result.targets[0],
						armed: result.armed,
						evidence: item.evidence,
						source: "auto",
						digest: harnessDigest(AGENT_ROOT),
						expectation: stagedItem.meta.expectation,
						...(stagedItem.meta.recalled?.length ? { recalled: stagedItem.meta.recalled } : {}),
					});
					auditAuto({ session: sessionId, stage: "review", kind: item.kind, name: item.name, decision: "armed", score: item.meta?.score ?? null, parts: item.meta?.parts ?? null, tier: item.meta?.tier ?? null, ...(stagedItem.meta.recalled?.length ? { recalled: stagedItem.meta.recalled } : {}) });
					const hint = item.kind === "rule" || item.kind === "context" ? " — run /ttsr-reload to activate" : item.kind === "settings" ? " — applies from the next session" : "";
					ctx.ui.notify(`Armed ${KIND_SPECS[item.kind].label} "${item.name}" → ${result.targets[0]}${hint}`, "info");
					void runExperiencePass({ refineRoot: REFINE_DIR, libraryRoot: LIBRARY_ROOT, decisionsRoot: DECISIONS_ROOT, trigger: "arm" }).catch(() => {
						// expected: the lesson pass is best-effort and must never break an arm
					});
					return true;
				},
				reject: async (item) => {
					const stagedItem = staged.find((s) => s.kind === item.kind && s.name === item.name);
					if (stagedItem) {
						recordRejected(item.kind, item.name, { kind: item.kind, name: item.name, title: item.title, evidence: item.evidence, files: item.files });
						await rm(stagedItem.dir, { recursive: true, force: true });
					}
					auditAuto({ session: sessionId, stage: "review", kind: item.kind, name: item.name, decision: "discarded", score: item.meta?.score ?? null, parts: item.meta?.parts ?? null, tier: item.meta?.tier ?? null });
					ctx.ui.notify(`Rejected "${item.kind} ${item.name}"`, "info");
					return true;
				},
			});
			// Items viewed but left undecided stay staged; audit each once.
			for (const kept of outcome.keptStaged) {
				auditAuto({ session: sessionId, stage: "review", kind: kept.kind, name: kept.name, decision: "kept-staged", score: kept.meta?.score ?? null, parts: kept.meta?.parts ?? null, tier: kept.meta?.tier ?? null });
			}
		},
	});

	pi.registerTool({
		name: "refine_propose",
		label: "Refine Propose",
		description:
			"Queue a harness improvement draft (TTSR rule, note, context entry, subagent, skill, settings patch, or new pi extension) when you notice a recurring failure or a user correction. The user reviews and approves it via an overlay before anything is written.",
		promptSnippet: "Queue a multi-kind harness edit from an observed recurring failure or correction; user approves via overlay",
		promptGuidelines: [
			"Use refine_propose when the same failure occurs 2+ times in this session or the user corrects an anti-pattern likely to recur. Pick the smallest kind that carries the edit: rule (stream trigger + recurrence), note (no matchable signature), context (doc + registry fragment that fires when relevant), agent (delegation divides labor), skill (repeatable multi-step workflow), settings (narrow patch for modelRouter/courseCheck/decisionTuner/refine), extension (new tool plus the trigger that makes agents use it). Supply files as a relative path -> full content map; rule/note/agent use <name>.md, context uses <name>.md + entry.yaml, skill uses SKILL.md, settings uses patch.json, extension uses index.ts + README.md + pairing.md (+ pairing.yaml for a context pairing) and requires expectation: tool:<name> or command:<name>.",
		],
		parameters: Type.Object({
			kind: StringEnum(PROPOSABLE_KINDS),
			name: Type.String({ description: "kebab-case slug used as the filename" }),
			title: Type.String({ description: "one-line summary" }),
			evidence: Type.String({ description: "quoted trajectory line(s) justifying this edit plus why it will recur" }),
			files: Type.Record(Type.String(), Type.String()),
			expectation: Type.Optional(Type.String({ description: "extension only: machine-checkable usage signal, tool:<name> or command:<name>" })),
			dimension: Type.Optional(StringEnum(["inv", "dom"])),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const proposal = toProposal(params);
			if (!proposal) {
				throw new Error(
					`Invalid proposal: kind must be one of ${PROPOSABLE_KINDS.join(", ")}, name must be kebab-case, and the files bundle must pass that kind's validation (e.g. a rule needs frontmatter with condition/astCondition; an extension needs index.ts + README.md + a pairing trigger and an expectation).`,
				);
			}
			const coverage = await listCoverage(AGENT_ROOT, REFINE_DIR);
			if (dedupeProposals([proposal], coverage).length === 0) {
				return {
					content: [{ type: "text", text: `Skipped: "${proposal.kind} ${proposal.name}" already exists in refine coverage. Nothing queued.` }],
					details: { queued: false, reason: "duplicate" },
				};
			}
			const approved = await showProposalUi(proposal, ctx);
			if (approved !== "apply") {
				return {
					content: [{ type: "text", text: `Proposal "${proposal.name}" skipped by user.` }],
					details: { queued: false, reason: "user-declined" },
				};
			}
			await applyProposal(proposal, undefined, ctx);
			return {
				content: [{ type: "text", text: `Applied ${KIND_SPECS[proposal.kind].label} "${proposal.name}".` }],
				details: { queued: true, applied: true },
			};
		},
	});
}

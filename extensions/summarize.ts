import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { parseModelRef, resolveModelRole } from "../utils/model-role.ts";

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") {
		return [content];
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const textParts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		}
	}

	return textParts;
};

const extractToolCallLines = (content: unknown): string[] => {
	if (!Array.isArray(content)) {
		return [];
	}

	const toolCalls: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") {
			continue;
		}

		const args = block.arguments ?? {};
		toolCalls.push(`Tool ${block.name} was called with args ${JSON.stringify(args)}`);
	}

	return toolCalls;
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) {
			continue;
		}

		const role = entry.message.role;
		const isUser = role === "user";
		const isAssistant = role === "assistant";

		if (!isUser && !isAssistant) {
			continue;
		}

		const entryLines: string[] = [];
		const textParts = extractTextParts(entry.message.content);
		if (textParts.length > 0) {
			const roleLabel = isUser ? "User" : "Assistant";
			const messageText = textParts.join("\n").trim();
			if (messageText.length > 0) {
				entryLines.push(`${roleLabel}: ${messageText}`);
			}
		}

		if (isAssistant) {
			entryLines.push(...extractToolCallLines(entry.message.content));
		}

		if (entryLines.length > 0) {
			sections.push(entryLines.join("\n"));
		}
	}

	return sections.join("\n\n");
};

const DEFAULT_ROLE = "@smol";

let lastSummary: string | undefined;
let generationInProgress = false;

const buildSummaryPrompt = (conversationText: string): string =>
	[
		"Summarize this conversation so I can resume it later.",
		"Include goals, key decisions, progress, open questions, and next steps.",
		"Keep it concise and structured with headings.",
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	].join("\n");

const showSummaryUi = async (summary: string, ctx: ExtensionCommandContext) => {
	if (ctx.mode !== "tui") {
		return;
	}

	await ctx.ui.custom(
		(tui, theme, _kb, done) => {
			const md = new Markdown(summary, 1, 1, getMarkdownTheme());
			let scrollTop = 0;
			let totalLines = 0;
			let pageLines = 1;

			// Chrome: top border + blank padding rows around the markdown
			const verticalChrome = 4;
			const horizontalChrome = 4;

			const dim = (s: string) => theme.fg("dim", s);
			const accent = (s: string) => theme.fg("accent", s);
			// Strip ANSI escapes so border fills align regardless of styling
			const visibleLength = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

			const close = () => done(undefined);

			const scroll = (delta: number) => {
				scrollTop = Math.max(0, Math.min(scrollTop + delta, Math.max(0, totalLines - pageLines)));
			};

			return {
				render(width: number): string[] {
					const termHeight = tui.terminal.rows;
					pageLines = Math.max(1, termHeight - verticalChrome);
					const innerWidth = Math.max(1, width - horizontalChrome - 2);

					const lines = md.render(innerWidth);
					totalLines = lines.length;
					scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, totalLines - pageLines)));

					const body = lines.slice(scrollTop, scrollTop + pageLines);
					const scrollLabel = dim(
						totalLines > pageLines ? ` ${scrollTop + 1}-${Math.min(scrollTop + body.length, totalLines)}/${totalLines} ` : " ",
					);
					const hint = dim(" ↑/↓ scroll · Esc close · /summarize view reopen ");

					const title = accent(theme.bold(" Conversation Summary "));
					const out: string[] = [];
					out.push(
						accent("╭─") +
							title +
							accent("─".repeat(Math.max(0, width - 4 - visibleLength(title)))) +
							accent("╮"),
					);
					for (let i = 0; i < pageLines; i++) {
						const line = body[i] ?? "";
						let gutter = " ".repeat(Math.max(0, innerWidth + 2 - visibleLength(line)));
						if (totalLines > pageLines) {
							// Scrollbar: thumb sized to viewport ratio, positioned by scroll fraction
							const thumbSize = Math.max(1, Math.round((pageLines / totalLines) * pageLines));
							const thumbStart = Math.round((scrollTop / (totalLines - pageLines)) * (pageLines - thumbSize));
							gutter = gutter.slice(0, -1) + (i >= thumbStart && i < thumbStart + thumbSize ? accent("█") : dim("│"));
						}
						out.push(accent("│") + " " + line + gutter + accent("│"));
					}
					out.push(
						accent("╰─") +
							scrollLabel +
							accent("─".repeat(Math.max(0, width - 4 - visibleLength(scrollLabel) - visibleLength(hint)))) +
							hint +
							accent("╯"),
					);
					return out;
				},
				invalidate() {
					md.invalidate();
				},
				handleInput(data: string) {
					if (matchesKey(data, "escape")) {
						close();
					} else if (matchesKey(data, "up")) {
						scroll(-1);
					} else if (matchesKey(data, "down")) {
						scroll(1);
					} else if (matchesKey(data, "pageup")) {
						scroll(-pageLines);
					} else if (matchesKey(data, "pagedown")) {
						scroll(pageLines);
					} else if (matchesKey(data, "home")) {
						scrollTop = 0;
					} else if (matchesKey(data, "end")) {
						scrollTop = Number.MAX_SAFE_INTEGER;
					} else if (data === "k") {
						scroll(-1);
					} else if (data === "j" || data === " ") {
						scroll(1);
					} else if (data === "g") {
						scrollTop = 0;
					} else if (data === "G") {
						scrollTop = Number.MAX_SAFE_INTEGER;
					} else {
						return;
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

export default function (pi: ExtensionAPI) {
	pi.registerCommand("summarize", {
		description: "Summarize the current conversation in a custom UI",
		handler: async (args, ctx) => {
			const subcommand = args?.trim().toLowerCase();
			if (subcommand === "view" || subcommand === "show" || subcommand === "last") {
				if (!lastSummary) {
					if (ctx.hasUI) ctx.ui.notify("No summary yet — run /summarize first", "warning");
					return;
				}
				await showSummaryUi(lastSummary, ctx);
				return;
			}

			if (generationInProgress) {
				if (ctx.hasUI) ctx.ui.notify("Summary already in progress — /summarize view to see the last one", "warning");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			const conversationText = buildConversationText(branch);

			if (!conversationText.trim()) {
				if (ctx.hasUI) {
					ctx.ui.notify("No conversation text found", "warning");
				}
				return;
			}

			const { resolvedModel, role } = resolveModelRole(args?.trim() || DEFAULT_ROLE);
			if (!resolvedModel) {
				if (ctx.hasUI) ctx.ui.notify("Could not resolve model alias", "warning");
				return;
			}
			const ref = parseModelRef(resolvedModel);
			const model = ref.provider
				? ctx.modelRegistry.find(ref.provider, ref.modelId)
				: ctx.modelRegistry.getAvailable().find((m) => m.id === ref.modelId || m.id.includes(ref.modelId));
			if (!model) {
				if (ctx.hasUI) ctx.ui.notify(`Model ${role ?? resolvedModel} (${resolvedModel}) not found`, "warning");
				return;
			}
			if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
				if (ctx.hasUI) ctx.ui.notify(`No authentication configured for ${resolvedModel}`, "warning");
				return;
			}

			const summaryMessages = [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildSummaryPrompt(conversationText) }],
					timestamp: Date.now(),
				},
			];

			generationInProgress = true;
			if (ctx.hasUI) ctx.ui.notify("Generating summary…", "info");
			let summary: string;
			try {
				const response = await ctx.modelRegistry.complete(
					model,
					{ messages: summaryMessages },
					{
						reasoningEffort: ref.thinking ?? "high",
						effort: ref.thinking ?? "high",
						cacheRetention: "none",
						sessionId: uuidv7(),
					},
				);
				summary = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
			} catch (err) {
				if (ctx.hasUI) ctx.ui.notify(`Summary failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			} finally {
				generationInProgress = false;
			}
			if (!summary.trim()) {
				if (ctx.hasUI) ctx.ui.notify("Model returned an empty summary", "warning");
				return;
			}
			lastSummary = summary;

			if (ctx.hasUI) ctx.ui.notify("Summary ready — /summarize view to review again", "info");
			await showSummaryUi(summary, ctx);
		},
	});
}

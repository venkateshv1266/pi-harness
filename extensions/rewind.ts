/**
 * /rewind — Claude-Code-style checkpoint & rewind for pi.
 *
 * What it does:
 *  - Tracks every file the agent modifies via the `edit` and `write` tools.
 *  - Captures the on-disk state of all tracked files at each user prompt
 *    (a "checkpoint"), plus the pre-session "original" of each tracked file
 *    (the state the first time the agent touched it).
 *  - Snapshots persist to disk under ~/.pi/agent/rewind/<sessionId>/ so they
 *    survive `/resume`, `/fork`, restarts, and `/reload`.
 *  - Registers `/rewind`, an interactive command that lists each user prompt
 *    on the active branch and offers:
 *      1. Restore code and conversation
 *      2. Restore conversation (keep code)
 *      3. Restore code (keep conversation)
 *      4. Summarize from here  (compress the abandoned tail into a summary)
 *      5. Never mind
 *
 * Limitations (same as Claude Code's /rewind):
 *  - Files modified through `bash` (sed/awk/…) are NOT tracked. Use git for
 *    those.
 *  - Symlinked / hard-linked paths are restored best-effort and may be skipped.
 *  - Not a replacement for git — this is session-scoped local undo.
 *
 * Conversation restore uses pi's session tree (`navigateTree`), so rewound
 * messages are not deleted — they remain recoverable via `/tree`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FileSnap = { exists: boolean; mode?: number };

type Manifest = {
	sessionId: string;
	cwd: string;
	/** Absolute paths, indexed by fileId. Only grows. */
	trackedPaths: string[];
	/** fileId -> snapshot of the file the first time the agent touched it. */
	originals: Record<number, FileSnap>;
	/** userMessageEntryId -> fileId -> snapshot at that checkpoint. */
	checkpoints: Record<string, Record<number, FileSnap>>;
	/** userMessageEntryId -> prompt text (for the menu). */
	prompts: Record<string, string>;
};

type SessionEntry = {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: { role?: string; content?: unknown };
};

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const REWIND_ROOT = join(homedir(), ".pi", "agent", "rewind");

const baseDir = (sessionId: string): string => join(REWIND_ROOT, sessionId);
const manifestPath = (sessionId: string): string => join(baseDir(sessionId), "manifest.json");
const originalContentPath = (sessionId: string, fileId: number): string =>
	join(baseDir(sessionId), "originals", String(fileId));
const checkpointContentPath = (sessionId: string, entryId: string, fileId: number): string =>
	join(baseDir(sessionId), "checkpoints", entryId, String(fileId));

export async function loadManifest(sessionId: string): Promise<Manifest | undefined> {
	try {
		const raw = await readFile(manifestPath(sessionId), "utf8");
		return JSON.parse(raw) as Manifest;
	} catch (err) {
		// expected: ENOENT on first run / new session, or corrupt manifest —
		// treat as empty and start fresh.
		if (!isENOENT(err)) console.error("[rewind] manifest load failed:", err);
		return undefined;
	}
}

async function saveManifest(manifest: Manifest): Promise<void> {
	const dir = baseDir(manifest.sessionId);
	await mkdir(dir, { recursive: true });
	await writeFile(manifestPath(manifest.sessionId), JSON.stringify(manifest), "utf8");
}

/** Read current on-disk state of a file. */
async function snapshotFile(absPath: string): Promise<{ exists: boolean; content?: Buffer; mode?: number }> {
	try {
		const st = await stat(absPath);
		if (st.isDirectory()) {
			// Never checkpoint directories.
			return { exists: false };
		}
		const content = await readFile(absPath);
		return { exists: true, content, mode: st.mode & 0o777 };
	} catch (err) {
		// expected: ENOENT (file doesn't exist yet) — record as absent.
		if (!isENOENT(err)) console.error(`[rewind] snapshot stat failed for ${absPath}:`, err);
		return { exists: false };
	}
}

async function writeContent(path: string, content: Buffer): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

/**
 * Restore a single file to a target snapshot.
 * `contentPath` is the on-disk location of the captured content for this snap.
 * Returns true if the file was actually changed.
 */
async function restoreFile(absPath: string, snap: FileSnap, contentPath: string): Promise<boolean> {
	if (snap.exists) {
		try {
			const content = await readFile(contentPath);
			await mkdir(dirname(absPath), { recursive: true });
			await writeFile(absPath, content);
			if (snap.mode !== undefined) {
				try {
					await chmod(absPath, snap.mode);
				} catch {
					// best-effort: chmod can fail on exotic filesystems / missing privileges.
				}
			}
			return true;
		} catch (err) {
			console.error(`[rewind] failed to restore ${absPath}:`, err);
			return false;
		}
	}
	// Target state: file should not exist.
	if (existsSync(absPath)) {
		try {
			await unlink(absPath);
			return true;
		} catch (err) {
			console.error(`[rewind] failed to delete ${absPath}:`, err);
			return false;
		}
	}
	return false;
}

/** True if on-disk content differs from the captured snapshot. */
async function fileDiffersFromSnapshot(absPath: string, snap: FileSnap, contentPath: string): Promise<boolean> {
	if (snap.exists) {
		try {
			const current = await readFile(absPath);
			const captured = await readFile(contentPath);
			return !current.equals(captured);
		} catch {
			// expected: ENOENT on disk (file missing) — counts as differing.
			return true;
		}
	}
	return existsSync(absPath); // should not exist
}

function isENOENT(err: unknown): boolean {
	return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/** Resolve a tool path argument to an absolute path, matching built-in tools. */
function resolveToolPath(cwd: string, raw: string | undefined): string | undefined {
	if (typeof raw !== "string" || raw.length === 0) return undefined;
	let p = raw;
	if (p.startsWith("@")) p = p.slice(1); // some models prefix paths with @
	return resolvePath(cwd, p);
}

// ---------------------------------------------------------------------------
// Session entry helpers
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const t = (block as { text?: string }).text;
			if (typeof t === "string") parts.push(t);
		}
	}
	return parts.join("\n");
}

function previewText(text: string, max = 70): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return oneLine.slice(0, max - 1) + "…";
}

/** User message entries on the active branch, in chronological order. */
function userMessagesOnBranch(entries: SessionEntry[]): SessionEntry[] {
	return entries.filter((e) => e.type === "message" && e.message?.role === "user");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function rewindExtension(pi: ExtensionAPI): void {
	// In-memory mirror of the on-disk manifest for the current session.
	let manifest: Manifest | undefined;

	const fileIdFor = (absPath: string, m: Manifest): number => {
		let idx = m.trackedPaths.indexOf(absPath);
		if (idx === -1) {
			idx = m.trackedPaths.length;
			m.trackedPaths.push(absPath);
		}
		return idx;
	};

	// ---- session lifecycle: load / persist state ---------------------------

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		manifest = await loadManifest(sessionId);
		if (!manifest) {
			manifest = {
				sessionId,
				cwd: ctx.cwd,
				trackedPaths: [],
				originals: {},
				checkpoints: {},
				prompts: {},
			};
		}
	});

	pi.on("session_shutdown", async () => {
		if (!manifest) return;
		try {
			await saveManifest(manifest);
		} catch (err) {
			console.error("[rewind] failed to persist manifest on shutdown:", err);
		}
	});

	// ---- tracking: capture "original" before first edit/write --------------

	pi.on("tool_call", async (event) => {
		if (!manifest) return;
		let rawPath: string | undefined;
		if (isToolCallEventType("edit", event)) {
			rawPath = event.input.path;
		} else if (isToolCallEventType("write", event)) {
			rawPath = event.input.path;
		} else {
			return;
		}

		const absPath = resolveToolPath(manifest.cwd, rawPath);
		if (!absPath) return;

		const m = manifest;
		if (m.trackedPaths.includes(absPath)) return; // already tracked

		const fileId = fileIdFor(absPath, m);
		// Capture original (pre-edit) state from disk right now, before the
		// tool executes.
		const snap = await snapshotFile(absPath);
		m.originals[fileId] = { exists: snap.exists, mode: snap.mode };
		if (snap.exists && snap.content) {
			await writeContent(originalContentPath(m.sessionId, fileId), snap.content);
		}
		await saveManifest(m);
	});

	// ---- checkpointing: snapshot all tracked files at each user prompt -----

	pi.on("message_end", async (event, ctx) => {
		if (!manifest) return;
		if (event.message.role !== "user") return;

		const leaf = ctx.sessionManager.getLeafEntry() as SessionEntry | undefined;
		if (!leaf) return;
		const entryId = leaf.id;

		const m = manifest;
		// Dedupe: a checkpoint for this user message already exists (retry /
		// auto-compaction re-run). Keep the earliest snapshot.
		if (m.checkpoints[entryId]) return;

		const promptText = extractText(event.message.content);
		m.prompts[entryId] = promptText;

		const snaps: Record<number, FileSnap> = {};
		for (let fileId = 0; fileId < m.trackedPaths.length; fileId++) {
			const absPath = m.trackedPaths[fileId];
			const snap = await snapshotFile(absPath);
			snaps[fileId] = { exists: snap.exists, mode: snap.mode };
			if (snap.exists && snap.content) {
				await writeContent(checkpointContentPath(m.sessionId, entryId, fileId), snap.content);
			}
		}
		m.checkpoints[entryId] = snaps;
		await saveManifest(m);
	});

	// ---- the /rewind command ----------------------------------------------

	pi.registerCommand("rewind", {
		description: "Rewind code and/or conversation to an earlier point in the session",
		handler: async (_args, ctx) => {
			if (!manifest) {
				manifest = await loadManifest(ctx.sessionManager.getSessionId());
			}
			if (!manifest) {
				if (ctx.hasUI) ctx.ui.notify("No session state available.", "warning");
				return;
			}
			const m = manifest;

			await ctx.waitForIdle();

			const branch = ctx.sessionManager.getBranch() as SessionEntry[];
			const userMsgs = userMessagesOnBranch(branch);

			if (userMsgs.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("Nothing to rewind to yet.", "info");
				return;
			}

			if (!ctx.hasUI) {
				// Non-interactive (print/json): nothing to do.
				return;
			}

			// Build the prompt selector. Each item shows the checkpoint's file
			// count (cheap, manifest-only) and a prompt preview.
			const items: string[] = [];
			const entryIds: string[] = [];
			userMsgs.forEach((entry, i) => {
				const cp = m.checkpoints[entry.id];
				const fileCount = cp ? Object.keys(cp).length : 0;
				const text = m.prompts[entry.id] ?? extractText(entry.message?.content);
				const fileLabel = fileCount > 0 ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : "no files";
				items.push(`#${i + 1}  ${previewText(text || "(empty)")}  ·  ${fileLabel}`);
				entryIds.push(entry.id);
			});

			const choice = await ctx.ui.select("Rewind to which prompt?", items);
			if (choice === undefined) return; // cancelled
			const idx = items.indexOf(choice);
			if (idx === -1) return;
			const selectedEntryId = entryIds[idx];
			const selectedEntry = userMsgs[idx];

			// Compute how many files would change if we restored code to this
			// checkpoint (the part the user cares about).
			const filesAffected = await computeAffectedFiles(m, selectedEntryId);
			const hasCodeToRestore = filesAffected.length > 0;

			// Build the action menu.
			const actions: string[] = [];
			if (hasCodeToRestore) {
				actions.push(
					`Restore code and conversation  ·  ${filesAffected.length} file(s) will change`,
				);
				actions.push("Restore conversation only  ·  keep current code");
				actions.push(
					`Restore code only  ·  ${filesAffected.length} file(s) will change, keep conversation`,
				);
			} else {
				actions.push("Restore conversation only  ·  no file changes to undo");
			}
			actions.push("Summarize from here  ·  compress the tail into a summary");
			actions.push("Never mind");

			const action = await ctx.ui.select("Choose an action:", actions);
			if (action === undefined || action === "Never mind") return;

			const wantCode =
				action.startsWith("Restore code and conversation") || action.startsWith("Restore code only");
			const wantConversation =
				action.startsWith("Restore code and conversation") ||
				action.startsWith("Restore conversation only");
			const wantSummarize = action.startsWith("Summarize from here");

			if (wantCode) {
				const restored = await restoreCodeToCheckpoint(m, selectedEntryId);
				if (ctx.hasUI) ctx.ui.notify(`Restored ${restored} file(s) to checkpoint.`, "info");
			}

			if (wantConversation) {
				await rewindConversation(ctx, selectedEntry, m);
			}

			if (wantSummarize) {
				const result = await ctx.navigateTree(selectedEntryId, { summarize: true });
				if (result.cancelled) {
					if (ctx.hasUI) ctx.ui.notify("Summarize cancelled.", "info");
				} else if (ctx.hasUI) {
					ctx.ui.notify("Summarized from the selected prompt.", "info");
				}
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Restore logic
// ---------------------------------------------------------------------------

/** Files whose checkpoint/original target differs from current disk. */
export async function computeAffectedFiles(m: Manifest, entryId: string): Promise<number[]> {
	const affected: number[] = [];
	for (let fileId = 0; fileId < m.trackedPaths.length; fileId++) {
		const target = resolveTargetSnap(m, entryId, fileId);
		if (!target) continue;
		const absPath = m.trackedPaths[fileId];
		if (await fileDiffersFromSnapshot(absPath, target.snap, target.contentPath)) {
			affected.push(fileId);
		}
	}
	return affected;
}

/**
 * For a given checkpoint (user message) and tracked file, return the snapshot
 * to restore to: the checkpoint's snapshot if present, else the original
 * (pre-session) snapshot. Returns undefined if neither exists.
 */
export function resolveTargetSnap(
	m: Manifest,
	entryId: string,
	fileId: number,
): { snap: FileSnap; contentPath: string } | undefined {
	const cp = m.checkpoints[entryId]?.[fileId];
	if (cp) {
		return { snap: cp, contentPath: checkpointContentPath(m.sessionId, entryId, fileId) };
	}
	const orig = m.originals[fileId];
	if (orig) {
		return { snap: orig, contentPath: originalContentPath(m.sessionId, fileId) };
	}
	return undefined;
}

export async function restoreCodeToCheckpoint(m: Manifest, entryId: string): Promise<number> {
	let restored = 0;
	for (let fileId = 0; fileId < m.trackedPaths.length; fileId++) {
		const target = resolveTargetSnap(m, entryId, fileId);
		if (!target) continue;
		const absPath = m.trackedPaths[fileId];
		const ok = await restoreFile(absPath, target.snap, target.contentPath);
		if (ok) restored++;
	}
	return restored;
}

/**
 * Rewind the conversation to just before the selected user prompt.
 *
 * Navigates the session tree to the selected prompt's parent (the assistant
 * message that preceded it), which abandons the prompt and everything after it
 * on the active branch — exactly Claude Code's "restore conversation" + put the
 * prompt back in the editor so you can re-send or edit it.
 *
 * For the first prompt (no parent), navigates to the prompt itself as a
 * fallback and does not pre-fill the editor (no duplicate user message).
 */
async function rewindConversation(
	ctx: {
		sessionManager: { getEntry(id: string): SessionEntry | undefined };
		ui: {
			select: (t: string, o: string[]) => Promise<string | undefined>;
			setEditorText: (t: string) => void;
			notify: (m: string, l: "info" | "warning" | "error") => void;
		};
		navigateTree: (id: string, opts?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
	},
	selectedEntry: SessionEntry,
	m: Manifest,
): Promise<void> {
	const parentId = selectedEntry.parentId;
	const promptText = m.prompts[selectedEntry.id] ?? "";

	if (parentId) {
		const result = await ctx.navigateTree(parentId, { summarize: false });
		if (result.cancelled) {
			ctx.ui.notify("Rewind cancelled.", "info");
			return;
		}
		if (promptText) ctx.ui.setEditorText(promptText);
		ctx.ui.notify("Conversation rewound. Edit & re-send the prompt, or type a new one.", "info");
	} else {
		// First prompt: cannot go further back. Navigate to the prompt itself.
		const result = await ctx.navigateTree(selectedEntry.id, { summarize: false });
		if (result.cancelled) {
			ctx.ui.notify("Rewind cancelled.", "info");
			return;
		}
		ctx.ui.notify("Conversation rewound to the first prompt.", "info");
	}
}

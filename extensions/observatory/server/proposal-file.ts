import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type ProposalFileKind = "target" | "disabled" | "dismissed" | "record" | null;

/** `~` expansion, kept in one place so a path is resolved exactly like the file reader does. */
export function expandHome(file: string): string {
	return path.resolve(file.startsWith("~") ? path.join(homedir(), file.slice(1)) : file);
}

/**
 * Where a tuner proposal's file actually is.
 *
 * Applying a prune renames the rule out of the way (`<file>.disabled`) instead of
 * deleting it, so the path recorded on the proposal goes stale the moment it is
 * applied; some flows keep a `.dismissed` copy. The recorded path is tried first,
 * then those variants, so a stale record still opens something real instead of
 * failing as "file not found".
 *
 * A config proposal changes a setting rather than a document and records no file
 * at all, so it falls back to the log the proposal itself lives in.
 */
export function resolveProposalFile(recordedFile: string | null, kind: string | null, proposalLog: string): { file: string | null; fileKind: ProposalFileKind; fileExists: boolean } {
	const variants: Array<[Exclude<ProposalFileKind, "record" | null>, string]> = recordedFile
		? [
				["target", recordedFile],
				["disabled", `${recordedFile}.disabled`],
				["dismissed", `${recordedFile}.dismissed`],
			]
		: [];
	for (const [fileKind, candidate] of variants) {
		if (existsSync(expandHome(candidate))) return { file: candidate, fileKind, fileExists: true };
	}
	if (kind === "config") return { file: proposalLog, fileKind: "record", fileExists: existsSync(expandHome(proposalLog)) };
	// Nothing to show, but keep the recorded path so the UI can name what is missing.
	return { file: recordedFile, fileKind: recordedFile ? "target" : null, fileExists: false };
}

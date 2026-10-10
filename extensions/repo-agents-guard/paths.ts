import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const AGENTS_FILE = "AGENTS.md";

export type GovernedRepo = {
	root: string;
	agentsPath: string;
	displayPath: string;
};

export function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

// realpath fails for a path that does not exist yet (a write target), so resolve
// the deepest existing ancestor and re-attach the missing tail verbatim.
export function canonicalPath(value: string, cwd: string): string {
	const candidate = resolve(cwd, expandHome(value));
	const missing: string[] = [];
	let probe = candidate;
	for (;;) {
		try {
			const real = realpathSync.native(probe);
			return missing.length === 0 ? real : join(real, ...missing.reverse());
		} catch {
			const parent = dirname(probe);
			if (parent === probe) return candidate;
			missing.push(basename(probe));
			probe = parent;
		}
	}
}

export function findGovernedRepo(value: string, cwd: string): GovernedRepo | undefined {
	let directory = canonicalPath(value, cwd);
	for (;;) {
		const displayPath = join(directory, AGENTS_FILE);
		if (existsSync(displayPath)) {
			return {
				root: directory,
				agentsPath: canonicalPath(displayPath, directory),
				displayPath,
			};
		}
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

export function isAgentsReadPath(inputPath: unknown, repo: GovernedRepo, cwd: string): boolean {
	return typeof inputPath === "string" && canonicalPath(inputPath, cwd) === repo.agentsPath;
}

/**
 * Regression tests for repo-agents-guard path identity.
 * Run: node --experimental-strip-types paths.test.ts
 *
 * Covers two observed permanent-block bugs:
 *  A. a not-yet-existing write target under a symlinked directory resolved to a
 *     different identity than the read of its AGENTS.md;
 *  B. an AGENTS.md that is itself a symlink (e.g. to CLAUDE.md) never matched
 *     the read of AGENTS.md.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalPath, findGovernedRepo, isAgentsReadPath } from "./paths.ts";

let fail = 0;
function say(line: string): void {
	process.stdout.write(line + "\n");
}
function check(cond: boolean, msg: string): void {
	if (cond) say(`ok - ${msg}`);
	else {
		fail++;
		say(`FAIL - ${msg}`);
	}
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-agents-guard-"));

try {
	// A: symlinked repo dir + write target whose parent does not exist yet
	const realA = path.join(root, "repo-a");
	fs.mkdirSync(realA);
	fs.writeFileSync(path.join(realA, "AGENTS.md"), "# a\n");
	const linkA = path.join(root, "link-a");
	fs.symlinkSync(realA, linkA, "dir");

	const readA = findGovernedRepo(path.join(linkA, "AGENTS.md"), root);
	const writeA = findGovernedRepo(path.join(linkA, "compositions", "new.html"), root);
	check(readA !== undefined && writeA !== undefined, "A: read and write targets both find the repo");
	check(readA?.agentsPath === writeA?.agentsPath, "A: missing write target maps to the read repo identity");
	check(readA !== undefined && isAgentsReadPath(path.join(linkA, "AGENTS.md"), readA, root), "A: reading AGENTS.md through the symlink counts");

	// B: AGENTS.md is a symlink to CLAUDE.md
	const realB = path.join(root, "repo-b");
	fs.mkdirSync(realB);
	fs.writeFileSync(path.join(realB, "CLAUDE.md"), "# b\n");
	fs.symlinkSync("CLAUDE.md", path.join(realB, "AGENTS.md"));
	const linkB = path.join(root, "link-b");
	fs.symlinkSync(realB, linkB, "dir");

	const repoB = findGovernedRepo(path.join(linkB, "AGENTS.md"), root);
	check(repoB !== undefined, "B: symlinked AGENTS.md is discovered");
	check(repoB !== undefined && isAgentsReadPath(path.join(linkB, "AGENTS.md"), repoB, root), "B: reading the AGENTS.md symlink counts");
	check(repoB !== undefined && isAgentsReadPath(path.join(realB, "CLAUDE.md"), repoB, root), "B: reading the symlink target also counts");
	check(repoB !== undefined && path.basename(repoB.displayPath) === "AGENTS.md", "B: reminder keeps the AGENTS.md spelling");

	// nearest-file walk unchanged
	const nested = path.join(realA, "pkg");
	fs.mkdirSync(nested);
	check(
		findGovernedRepo(nested, root)?.agentsPath === path.join(fs.realpathSync.native(realA), "AGENTS.md"),
		"nested dir resolves to the nearest ancestor AGENTS.md",
	);
	fs.writeFileSync(path.join(nested, "AGENTS.md"), "# child\n");
	check(
		findGovernedRepo(nested, root)?.agentsPath === path.join(fs.realpathSync.native(nested), "AGENTS.md"),
		"a closer child AGENTS.md wins",
	);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

say(fail === 0 ? "REPO-AGENTS-GUARD TESTS OK" : `${fail} failures`);
process.exit(fail === 0 ? 0 : 1);

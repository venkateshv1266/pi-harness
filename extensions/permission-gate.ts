/**
 * Permission Gate Extension — Claude-Code-style permission modes.
 *
 * Modes (switch with /gate):
 *   auto (default) — fail-closed: read-only + routine dev commands run silently,
 *                    anything unrecognized prompts
 *   ask            — only the dangerous set prompts; everything else runs
 *   off            — gate disabled
 *
 * Modeled on Claude Code's documented layers: deny → protected paths →
 * critical paths → allowlist, fail-closed on anything unparseable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Mode = "off" | "ask" | "auto";

const MODES: Mode[] = ["ask", "auto", "off"];

const READ_ONLY = new Set([
	"ls", "cat", "echo", "pwd", "head", "tail", "grep", "find", "wc", "which", "diff", "stat",
	"du", "file", "tree", "env", "printenv", "date", "whoami", "hostname", "uname", "basename",
	"dirname", "realpath", "type", "rg", "cd", "export", "unset", "jq",
]);

const READ_ONLY_GIT = new Set([
	"status", "log", "diff", "show", "rev-parse", "describe", "blame", "shortlog", "ls-files",
]);

const ROUTINE_GIT = new Set([
	"add", "commit", "checkout", "switch", "pull", "fetch", "stash", "merge", "rebase", "branch",
	"tag", "restore", "worktree", "remote", "reset", "clean", "push",
]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "pnpx", "dlx"]);

const PM_EXCLUDED = new Set(["publish", "unpublish", "login", "adduser", "logout", "owner"]);

// Stripped before classification, like Claude Code's wrapper handling.
const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "command", "builtin", "stdbuf", "noglob"]);

const SUDO = /^(\S+\/)?sudo$/;

// Commands that are dangerous regardless of arguments.
const DANGEROUS = [
	/\b(chmod|chown)\b.*777/i,
	/\bdd\b.*\bof=\/dev\//,
	/\bmkfs/,
	/\b(curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/, // download-and-execute
	/\b(?:shutdown|reboot|halt|poweroff)\b/,
	/\b(?:truncate|shred)\b/,
	/\bsystemctl\s+(?:start|stop|restart|enable|disable)\b/,
];

// Deleting shared scratch dirs by wildcard, glob, or age filter is blocked
// (Claude Code v2.1.198+); a specific named path is fine.
const SHARED_SCRATCH = [/^\/tmp\//, /^\/var\/tmp\//, /^\$\{?TMPDIR\}?/, /^\/private\/var\/folders\//];

// Targets that are safe to delete without confirmation.
const SAFE_DELETE = [
	/^\/tmp\//,
	/^\/var\/tmp\//,
	/^\$\{?TMPDIR\}?\//,
	/^\/private\/var\/folders\//, // macOS per-user temp
	/^~\/(tmp|temp|\.cache)\//,
	/^(\.\/)?(node_modules|dist|build|out|coverage|tmp|temp|\.cache|\.next|\.nuxt|\.turbo|\.parcel-cache)(\/|$)/,
];

// Protected paths (Claude Code's list + sensitive home dot-dirs): writes and
// deletes are gated in every mode.
const PROTECTED_DIRS = new Set([
	".git", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn", ".claude",
]);
const PROTECTED_BASENAMES = new Set([
	".gitconfig", ".gitmodules", ".envrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnp.cjs",
	".pnp.loader.mjs", ".pnpmfile.cjs", "bunfig.toml", ".bunfig.toml", ".bazelrc", ".bazelversion",
	".bazeliskrc", ".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml", ".lefthook.yml",
	".lefthook.yaml", "gradle-wrapper.properties", "maven-wrapper.properties", ".devcontainer.json",
	".ripgreprc", "pyrightconfig.json", ".mcp.json", ".claude.json", ".netrc",
]);
const PROTECTED_PREFIXES = [
	".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile",
	".bash_login", ".bash_aliases", ".bash_logout", ".profile", ".env",
];
const PROTECTED_ETC = /^\/etc\//;
const PROTECTED_SYSTEM = /^\/(usr|boot|opt|sbin|lib|lib64)\//;
const PROTECTED_HOMEDIR = /(^|\/)\.(ssh|aws|gnupg|kube|docker)(\/|$)/;

function touchesProtected(paths: string[]): boolean {
	for (const token of paths) {
		const segs = token.split("/");
		if (segs.some((s) => PROTECTED_DIRS.has(s))) return true;
		if (/(^|\/)\.config\/git(\/|$)/.test(token)) return true;
		const base = segs[segs.length - 1] ?? token;
		if (PROTECTED_BASENAMES.has(base)) return true;
		if (PROTECTED_PREFIXES.some((p) => base.startsWith(p))) return true;
		if (PROTECTED_ETC.test(token) || PROTECTED_SYSTEM.test(token)) return true;
		if (PROTECTED_HOMEDIR.test(token)) return true;
	}
	return false;
}

// For routine file ops (mkdir/touch/cp/mv) and redirect targets: relative
// paths, home, and temp dirs — not other absolute paths, not "..".
function isHarmlessPath(t: string): boolean {
	if (t.startsWith("~/") || /^\$\{?(TMPDIR|HOME)\}?/.test(t)) return true;
	if (t === "/tmp" || t === "/dev/null" || /^\/(tmp|var\/tmp)\//.test(t)) return true;
	if (!t.startsWith("/")) return !t.includes("..");
	return false;
}

function isLocalFileOp(tokens: string[]): boolean {
	const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
	if (args.length === 0) return false;
	return args.every(isHarmlessPath);
}

function hasGlob(tokens: string[]): boolean {
	return tokens.slice(1).some((t) => !t.startsWith("-") && /[*?]/.test(t));
}

// Read-only commands that can act: find with -delete/-exec, globs that could
// expand to write-capable flags on find/sed/sort/git.
function readCaveat(tokens: string[]): boolean {
	const [cmd] = tokens;
	if (cmd === "find") {
		if (tokens.some((t) => /^-(delete|exec|execdir)$/.test(t))) return false;
		if (hasGlob(tokens)) return false;
	}
	if (["sed", "sort", "git"].includes(cmd) && hasGlob(tokens)) return false;
	return true;
}

// Git subcommands that discard work or rewrite remotes are gated, mirroring
// the classifier's default block list.
function gitRoutineArgs(sub: string, args: string[]): boolean {
	if (sub === "reset") return !args.some((a) => a === "--hard");
	if (sub === "clean") return !args.some((a) => /^-\w*f/.test(a));
	if (sub === "stash") return !args.some((a) => a === "drop" || a === "clear");
	if (sub === "commit") return !args.some((a) => a === "--amend");
	if (sub === "push")
		return !args.some((a) => /^--force/.test(a) || a === "-f" || a === "--delete");
	if (sub === "remote") return !args.some((a) => ["add", "set-url", "rename", "remove", "prune"].includes(a));
	if (sub === "checkout" || sub === "restore")
		return !args.some((a) => a === "." || a === "--" || a.startsWith(".") || a.startsWith(":"));
	return true;
}

function isRoutine(tokens: string[]): boolean {
	const [cmd, sub] = tokens;
	if (READ_ONLY.has(cmd)) return readCaveat(tokens);
	if (cmd === "git") {
		if (hasGlob(tokens)) return false;
		if (READ_ONLY_GIT.has(sub)) return true;
		return ROUTINE_GIT.has(sub) && gitRoutineArgs(sub, tokens.slice(2));
	}
	if (PACKAGE_MANAGERS.has(cmd)) return !PM_EXCLUDED.has(sub);
	if (cmd === "node") return true;
	// Read-only HTTP is allowed by default (per docs); write/upload flags are not.
	if (cmd === "curl" || cmd === "wget") {
		const a = tokens.slice(1);
		for (let i = 0; i < a.length; i++) {
			const t = a[i];
			if (
				/^(--data|-d|-D|-F|-T|--upload-file|-X|--request)$/.test(t) ||
				/^(--data|--data-raw|--data-binary|--data-urlencode|--form|--form-string|--post-data|--post-file)/.test(t) ||
				/^-X(POST|PUT|DELETE|PATCH)$/.test(t)
			)
				return false;
			if ((t === "-o" || t === "--output") && (!a[i + 1] || !isHarmlessPath(a[i + 1]))) return false;
		}
		return true;
	}
	if (["mkdir", "touch", "cp", "mv"].includes(cmd)) return isLocalFileOp(tokens);
	if (cmd === "rm") return isSafeRm(tokens);
	return false;
}

function isSafeRm(tokens: string[]): boolean {
	if (!/^(\S+\/)?rm$/.test(tokens[0])) return false;

	const targets: string[] = [];
	let onlyFiles = false;
	for (const token of tokens.slice(1)) {
		if (!onlyFiles && token === "--") {
			onlyFiles = true;
			continue;
		}
		if (!onlyFiles && token.startsWith("-")) continue;
		targets.push(token);
	}
	if (targets.length === 0) return false;

	return targets.every((t) => {
		if (t.includes("..")) return false;
		if (SHARED_SCRATCH.some((p) => p.test(t)) && /[*?]/.test(t)) return false;
		return SAFE_DELETE.some((p) => p.test(t));
	});
}

// Wrappers are transparent; sudo too when includeSudo (ask mode) — its payload
// is judged instead. Wrapper options, timeout durations, bare xargs, and
// leading env assignments are stripped.
function unwrap(tokens: string[], includeSudo: boolean): string[] {
	let rest = tokens;
	while (rest.length > 0) {
		const head = rest[0];
		if (/^[A-Za-z_]\w*=/.test(head)) {
			rest = rest.slice(1);
			continue;
		}
		if (head === "xargs" && rest[1] !== undefined && !rest[1].startsWith("-")) {
			rest = rest.slice(1);
			continue;
		}
		if (WRAPPERS.has(head) || (includeSudo && SUDO.test(head))) {
			rest = rest.slice(1);
			while (rest.length > 0 && (rest[0].startsWith("-") || /^[\d.]+[smhd]?$/.test(rest[0]))) {
				rest = rest.slice(1);
			}
			continue;
		}
		break;
	}
	return rest;
}

// Shell separators per Claude Code: && || | |& ; & and newlines. A bare &
// preceded by > or & is part of a file-descriptor redirect (2>&1), not a separator.
function segments(command: string): string[] {
	return command
		.split(/\s*(?:&&|\|\||\|&|;|\||(?<![>&])&|\n)\s*/)
		.filter((seg) => seg.trim() !== "");
}

function unparseable(command: string): boolean {
	// fd redirects (2>&1) contain separator lookalikes — mask them first
	const fdMasked = command.replace(/\d*>&\d*/g, " ");
	if (/[;|&]\s*$/.test(fdMasked.trim())) return true;
	// mask the multi-char operators, then any adjacent single separators
	const masked = fdMasked.replace(/&&|\|\||\|&/g, " § ");
	return /[;|&]\s*[;|&]/.test(masked);
}

function substitutionInnards(text: string): string[] {
	return [...text.matchAll(/\$\(([^()]*)\)|`([^`]*)`|<\(([^()]*)\)/g)]
		.map((m) => m[1] ?? m[2] ?? m[3])
		.filter((s) => s.trim() !== "");
}

function redirectTargets(tokens: string[]): string[] {
	const targets: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const m = tokens[i].match(/^(\d*&?>{1,2})(.*)$/);
		if (m) targets.push(m[2] || tokens[i + 1] || "");
	}
	return targets.filter((t) => t !== "");
}

// auto mode: fail-closed — only recognized-safe commands run silently.
function classifyAuto(command: string): boolean {
	if (DANGEROUS.some((p) => p.test(command))) return true;
	for (const seg of segments(command)) {
		if (!segmentSafeAuto(seg)) return true;
	}
	return false;
}

function segmentSafeAuto(seg: string): boolean {
	const rest = unwrap(seg.trim().split(/\s+/), false);
	if (rest.length === 0) return true;
	for (const inner of substitutionInnards(seg)) {
		for (const innerSeg of segments(inner)) {
			if (!segmentSafeAuto(innerSeg)) return false;
		}
	}
	const redirects = redirectTargets(rest);
	if (redirects.length === 0 && READ_ONLY.has(rest[0]) && readCaveat(rest)) return true;
	if (READ_ONLY.has(rest[0]) && readCaveat(rest)) {
		// A reader is judged only by its redirect targets — reading a protected
		// file is fine, writing one is not.
		if (touchesProtected(redirects)) return false;
		return redirects.every(isHarmlessPath);
	}
	if (touchesProtected(rest.slice(1))) return false;
	if (SUDO.test(rest[0])) return false;
	return isRoutine(rest);
}

// ask mode: gate only the known-dangerous set (plus protected-path writes).
function classifyAsk(command: string): boolean {
	if (DANGEROUS.some((p) => p.test(command))) return true;
	for (const seg of segments(command)) {
		if (!segmentSafeAsk(seg)) return true;
	}
	return false;
}

function segmentSafeAsk(seg: string): boolean {
	const tokens = seg.trim().split(/\s+/);
	const rest = unwrap(tokens, true);
	if (rest.length === 0) return true;
	for (const inner of substitutionInnards(seg)) {
		for (const innerSeg of segments(inner)) {
			if (!segmentSafeAsk(innerSeg)) return false;
		}
	}
	const redirects = redirectTargets(rest);
	if (redirects.length === 0 && READ_ONLY.has(rest[0]) && readCaveat(rest)) return true;
	if (READ_ONLY.has(rest[0]) && readCaveat(rest)) {
		if (touchesProtected(redirects)) return false;
		return redirects.every(isHarmlessPath);
	}
	if (touchesProtected(rest.slice(1))) return false;
	if (DANGEROUS.some((p) => p.test(rest.join(" ")))) return false;
	if (/^(\S+\/)?rm$/.test(rest[0])) return isSafeRm(rest);
	if (rest.length !== tokens.length) return false; // sudo with a non-rm payload
	return true;
}

export default function (pi: ExtensionAPI) {
	let mode: Mode = "auto";
	(globalThis as Record<string, unknown>).__permissionGateMode = mode;

	pi.registerCommand("gate", {
		description: "Cycle permission gate mode: ask → auto → off (or /gate <mode>)",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();
			if (arg && MODES.includes(arg as Mode)) {
				mode = arg as Mode;
			} else if (arg) {
				ctx.ui.notify(`Unknown mode "${arg}". Modes: ${MODES.join(", ")}`, "warning");
				return;
			} else {
				mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
			}
			ctx.ui.notify(`Permission gate: ${mode}`, "info");
			(globalThis as Record<string, unknown>).__permissionGateMode = mode;
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (mode === "off" || event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const dangerous = command.length > 10_000 || unparseable(command) ||
			(mode === "auto" ? classifyAuto(command) : classifyAsk(command));
		if (!dangerous) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
		}

		const choice = await ctx.ui.select(
			`⚠️ ${mode === "auto" ? "Not on the auto-allow list" : "Dangerous"}:\n\n  ${command}\n\nAllow?`,
			["Yes", "No"],
		);

		if (choice !== "Yes") {
			return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});
}

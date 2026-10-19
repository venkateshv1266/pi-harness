/**
 * Adoption gate for proposed extensions. Three independent checks run before
 * an extension may be armed:
 *
 *   1. compile   — typecheck the staged source against pi's real declarations;
 *   2. smoke     — load it against a fake pi API and fire boundary events;
 *   3. safety    — flag dangerous capabilities; telemetry suppression is a
 *                  hard reject (the loop may never improve its report card by
 *                  blinding the instruments).
 *
 * The gate is inert: it writes only to a temp directory and never touches the
 * live harness. Failures are reported per check so the review overlay can say
 * exactly which one blocked the arm action.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateExpectation, type ProposalFiles } from "../../utils/harness-surface.ts";

export type GateCheck = { ok: boolean; detail: string };

export type SafetyCategory = "child_process" | "network" | "fs-outside-agent" | "telemetry";

export type SafetyFlag = { category: SafetyCategory; detail: string; blocking: boolean };

export type SmokeResult = GateCheck & { tools: string[]; commands: string[]; handlers: string[] };

export type ExtensionGateResult = {
	ok: boolean;
	reasons: string[];
	warnings: string[];
	compile: GateCheck;
	smoke: SmokeResult;
	safety: GateCheck & { flags: SafetyFlag[] };
};

export type GateOptions = {
	/** Override discovery for tests. */
	tsc?: string;
	piRoot?: string;
	typeboxDts?: string;
	nodeTypes?: string;
	timeoutMs?: number;
	skipCompile?: boolean;
	skipSmoke?: boolean;
};

const fileExists = (path: string): boolean => {
	try {
		return existsSync(path);
	} catch {
		return false;
	}
};

const firstExisting = (candidates: string[]): string | null => candidates.find(fileExists) ?? null;

/**
 * Locate the installed pi package. The extension runs inside pi, but Node's
 * resolver does not necessarily expose pi's global install to a file under
 * ~/.pi/agent, so discovery walks the usual global roots and a few envs.
 */
export function discoverPiRoot(override?: string): string | null {
	if (override !== undefined) return fileExists(join(override, "dist", "index.d.ts")) ? override : null;
	const candidates = [
		process.env.PI_PACKAGE_ROOT,
		join(homedir(), ".local", "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
		join(dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
		"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	for (const root of candidates) {
		if (fileExists(join(root, "dist", "index.d.ts"))) return root;
	}
	return null;
}

export function discoverTsc(override?: string, piRoot?: string | null): string | null {
	if (override !== undefined) return fileExists(override) ? override : null;
	const candidates = [
		process.env.REFINE_TSC,
		join(homedir(), "pi-harness", "node_modules", ".bin", "tsc"),
		join(dirname(process.execPath), "..", "lib", "node_modules", "typescript", "bin", "tsc"),
		"/opt/homebrew/bin/tsc",
		"/usr/local/bin/tsc",
	];
	if (piRoot) candidates.push(join(piRoot, "node_modules", ".bin", "tsc"));
	const found = firstExisting(candidates.filter((value): value is string => typeof value === "string" && value.length > 0));
	if (found) return found;
	const which = spawnSync("which", ["tsc"], { encoding: "utf8" });
	return which.status === 0 && which.stdout.trim() ? which.stdout.trim() : null;
}

export function discoverTypeboxDts(override?: string): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	return firstExisting(
		[
			override,
			join(here, "..", "ttsr", "node_modules", "typebox", "build", "index.d.mts"),
			join(homedir(), "pi-harness", "extensions", "ttsr", "node_modules", "typebox", "build", "index.d.mts"),
			join(dirname(process.execPath), "..", "lib", "node_modules", "typebox", "build", "index.d.mts"),
		].filter((value): value is string => typeof value === "string" && value.length > 0),
	);
}

export function discoverNodeTypes(override?: string, piRoot?: string | null): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	return firstExisting(
		[
			override,
			join(here, "..", "..", "..", "node_modules", "@types"),
			join(homedir(), "pi-harness", "node_modules", "@types"),
			piRoot ? join(piRoot, "node_modules", "@types") : null,
			join(dirname(process.execPath), "..", "lib", "node_modules", "@types"),
		].filter((value): value is string => typeof value === "string" && value.length > 0),
	);
}

function writeBundle(root: string, files: ProposalFiles): string {
	const bundle = join(root, "bundle");
	mkdirSync(bundle, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const target = join(bundle, rel);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
	return bundle;
}

const tsconfigFor = (bundle: string, paths: Record<string, string[]>, nodeTypes: string | null): string =>
	JSON.stringify(
		{
			compilerOptions: {
				target: "ES2022",
				lib: ["ES2022"],
				module: "ESNext",
				moduleResolution: "bundler",
				strict: true,
				skipLibCheck: true,
				noEmit: true,
				allowImportingTsExtensions: true,
				...(nodeTypes ? { typeRoots: [nodeTypes] } : {}),
				paths,
			},
			files: [join(bundle, "index.ts")],
		},
		null,
		2,
	);

type Diagnostic = { file: string; line: number; text: string };

function parseDiagnostics(output: string): Diagnostic[] {
	const out: Diagnostic[] = [];
	for (const line of output.split("\n")) {
		const match = /^(.*?)\((\d+),\d+\):\s+error\s+(TS\d+.*)$/.exec(line.trimEnd());
		if (!match) continue;
		out.push({ file: match[1], line: Number(match[2]), text: `${match[3]}` });
	}
	return out;
}

/** Typecheck `index.ts` against pi's declarations; report first-party errors only. */
export function runCompileCheck(files: ProposalFiles, options: GateOptions = {}): GateCheck {
	const piRoot = discoverPiRoot(options.piRoot);
	if (!piRoot) return { ok: false, detail: "compile infrastructure unavailable: pi package not found (set PI_PACKAGE_ROOT)" };
	const tsc = discoverTsc(options.tsc, piRoot);
	if (!tsc) return { ok: false, detail: "compile infrastructure unavailable: tsc not found (set REFINE_TSC)" };

	const scratch = mkdtempSync(join(tmpdir(), "refine-gate-compile-"));
	try {
		const bundle = writeBundle(scratch, files);
		const paths: Record<string, string[]> = {
			"@earendil-works/pi-coding-agent": [join(piRoot, "dist", "index.d.ts")],
		};
		const nested = dirname(piRoot);
		for (const pkg of ["pi-ai", "pi-tui"]) {
			const dts = join(piRoot, "node_modules", "@earendil-works", pkg, "dist", "index.d.ts");
			const fallback = join(nested, pkg, "dist", "index.d.ts");
			const resolved = fileExists(dts) ? dts : fileExists(fallback) ? fallback : null;
			if (resolved) paths[`@earendil-works/${pkg}`] = [resolved];
		}
		const typebox = discoverTypeboxDts(options.typeboxDts);
		if (typebox) paths["typebox"] = [typebox];

		const configPath = join(scratch, "tsconfig.json");
		writeFileSync(configPath, tsconfigFor(bundle, paths, discoverNodeTypes(options.nodeTypes, piRoot)), "utf8");

		const run = spawnSync(tsc, ["-p", configPath, "--pretty", "false"], {
			encoding: "utf8",
			timeout: options.timeoutMs ?? 60_000,
			env: { ...process.env, NO_COLOR: "1" },
		});
		const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
		const diagnostics = parseDiagnostics(output);
		const firstParty = diagnostics.filter((diagnostic) => {
			const resolved = resolve(process.cwd(), diagnostic.file);
			return resolved === resolve(bundle, "index.ts") || resolved.startsWith(`${resolve(bundle)}${process.platform === "win32" ? "\\" : "/"}`);
		});
		if (run.error) return { ok: false, detail: `compile infrastructure error: ${run.error.message}` };
		if (firstParty.length > 0) {
			return { ok: false, detail: `first-party errors:\n${firstParty.slice(0, 5).map((d) => `  line ${d.line}: ${d.text}`).join("\n")}` };
		}
		if (run.status !== 0) {
			const reason = diagnostics.length > 0 ? diagnostics.slice(0, 2).map((d) => d.text).join("; ") : output.trim().slice(0, 400) || "tsc failed";
			return { ok: false, detail: `compile infrastructure failed: ${reason}` };
		}
		return { ok: true, detail: "typechecked against pi's declarations" };
	} catch (error) {
		return { ok: false, detail: `compile error: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const SMOKE_RUNNER = `
import { pathToFileURL } from "node:url";

const spec = process.argv[2];
const out = { ok: false, tools: [], commands: [], handlers: [], errors: [] };
const handlers = [];
const noop = () => undefined;
const list = (key) => (value) => {
	const name = typeof value === "string" ? value : value && typeof value.name === "string" ? value.name : "?";
	out[key].push(String(name));
};
const api = new Proxy({}, {
	get(_target, prop) {
		if (prop === "on") return (event, handler) => { handlers.push({ event: String(event), handler }); out.handlers.push(String(event)); return noop; };
		if (prop === "registerTool") return list("tools");
		if (prop === "registerCommand") return list("commands");
		if (prop === "registerMessageRenderer") return noop;
		if (prop === "registerProvider") return noop;
		if (prop === "events") return { on: noop, emit: noop };
		return noop;
	},
});

const ctx = {
	hasUI: false,
	mode: "cli",
	model: null,
	ui: { notify: noop, select: async () => null, confirm: async () => false, custom: async () => undefined },
	sessionManager: { getSessionId: () => "gate", getBranch: () => [] },
	modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false, complete: async () => ({ content: [] }) },
	isIdle: () => true,
	abort: noop,
};

try {
	const mod = await import(pathToFileURL(spec).href);
	if (typeof mod.default !== "function") throw new Error("extension has no default-exported factory");
	await mod.default(api);
	for (const { event, handler } of handlers) {
		try {
			await Promise.race([
				Promise.resolve(handler({ type: event, toolName: "gate", isError: false, result: {}, turn: 1, message: { role: "user", content: [] } }, ctx)),
				new Promise((_, reject) => setTimeout(() => reject(new Error("handler timed out")), 2000)),
			]);
		} catch (error) {
			out.errors.push(event + ": " + (error instanceof Error ? error.message : String(error)));
		}
	}
	if (out.tools.length + out.commands.length + handlers.length === 0) out.errors.push("extension registered no tools, commands or handlers");
	out.ok = out.errors.length === 0;
} catch (error) {
	out.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
}
console.log("__GATE__" + JSON.stringify(out));
process.exit(0);
`;

const smokeNodeArgs = (): string[] => {
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	const needsFlag = major < 22 || (major === 22 && minor < 18);
	return needsFlag ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"] : [];
};

/** Symlink pi + typebox into a sandbox so the staged source's bare imports resolve. */
function wireSandbox(root: string, piRoot: string, typeboxDts: string | null): void {
	const modules = join(root, "node_modules");
	mkdirSync(join(modules, "@earendil-works"), { recursive: true });
	symlinkSync(piRoot, join(modules, "@earendil-works", "pi-coding-agent"), "junction");
	for (const pkg of ["pi-ai", "pi-tui"]) {
		const nested = join(piRoot, "node_modules", "@earendil-works", pkg);
		if (fileExists(nested)) symlinkSync(nested, join(modules, "@earendil-works", pkg), "junction");
	}
	if (typeboxDts) {
		const packageRoot = dirname(dirname(typeboxDts));
		symlinkSync(packageRoot, join(modules, "typebox"), "junction");
	}
}

/** Load the staged extension against a fake pi API and fire its boundary handlers. */
export function runFakePiSmoke(files: ProposalFiles, options: GateOptions = {}): SmokeResult {
	const empty: SmokeResult = { ok: false, detail: "", tools: [], commands: [], handlers: [] };
	const piRoot = discoverPiRoot(options.piRoot);
	if (!piRoot) return { ...empty, detail: "smoke infrastructure unavailable: pi package not found" };
	const source = files["index.ts"];
	if (typeof source !== "string" || !source.trim()) return { ...empty, detail: "index.ts is missing" };

	const scratch = mkdtempSync(join(tmpdir(), "refine-gate-smoke-"));
	try {
		const bundle = writeBundle(scratch, files);
		wireSandbox(scratch, piRoot, discoverTypeboxDts(options.typeboxDts));
		const runner = join(scratch, "smoke-runner.mjs");
		writeFileSync(runner, SMOKE_RUNNER, "utf8");
		const run = spawnSync(process.execPath, [...smokeNodeArgs(), runner, join(bundle, "index.ts")], {
			encoding: "utf8",
			timeout: options.timeoutMs ?? 30_000,
			env: { ...process.env, NO_COLOR: "1" },
		});
		const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
		const line = output.split("\n").find((entry) => entry.startsWith("__GATE__"));
		if (!line) {
			return { ...empty, detail: run.error ? `smoke error: ${run.error.message}` : `smoke produced no result: ${output.trim().slice(0, 400)}` };
		}
		const parsed = JSON.parse(line.slice("__GATE__".length)) as { ok: boolean; tools: string[]; commands: string[]; handlers: string[]; errors: string[] };
		const registered = [...parsed.tools, ...parsed.commands, ...parsed.handlers];
		return {
			ok: parsed.ok === true,
			detail: parsed.ok ? `loaded; registered ${registered.length} surface(s)` : parsed.errors.join("; ").slice(0, 600),
			tools: parsed.tools,
			commands: parsed.commands,
			handlers: parsed.handlers,
		};
	} catch (error) {
		return { ...empty, detail: `smoke error: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const WRITE_API =
	/\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|cp|cpSync|copyFile|copyFileSync|truncate)\s*\(/;

function lineNumber(source: string, index: number): number {
	return source.slice(0, index).split("\n").length;
}

function matches(source: string, pattern: RegExp, category: SafetyCategory, blocking: boolean, detail: string): SafetyFlag[] {
	const flags: SafetyFlag[] = [];
	const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
	for (const match of source.matchAll(global)) {
		flags.push({ category, blocking, detail: `line ${lineNumber(source, match.index ?? 0)}: ${detail}` });
		if (flags.length >= 5) break;
	}
	return flags;
}

/** Static capability scan over the proposed source. Telemetry suppression blocks. */
export function scanSafety(files: ProposalFiles): GateCheck & { flags: SafetyFlag[] } {
	const source = files["index.ts"] ?? "";
	const flags: SafetyFlag[] = [
		...matches(source, /(?:from|require\s*\()\s*["'`](?:node:)?child_process["'`]|\bchild_process\b|\bBun\.spawn\b/, "child_process", false, "spawns a child process"),
		...matches(source, /\bfetch\s*\(|\bhttps?\.request\s*\(|(?:from|require\s*\()\s*["'`](?:node:)?https?["'`]|\bWebSocket\b|\bnet\.connect\s*\(|\bdgram\./, "network", false, "can make a network request"),
		...matches(source, /["'`]\/(?:tmp|var|etc|usr|opt|private)\/[^"'`]*["'`]/, "fs-outside-agent", false, "references a path outside ~/.pi/agent"),
	];
	if (WRITE_API.test(source) && !/(?:\.pi[\/\\]agent|agentRoot|homedir\s*\(\))/.test(source)) {
		flags.push({ category: "fs-outside-agent", blocking: false, detail: "writes files without an obvious ~/.pi/agent path" });
	}
	flags.push(...matches(source, /\bjev-decisions\b|\bobservatory\b[\s\S]{0,160}\badapter/i, "telemetry", true, "references the telemetry store or its adapters"));
	flags.push(
		...matches(source, /\b(?:logDecision|logOutcome|appendDecision)\s*=(?!=)|\bdelete\s+[\w.]*\b(?:logDecision|logOutcome|appendDecision)\b/, "telemetry", true, "reassigns or deletes the outcomes logger"),
	);
	const blocking = flags.some((flag) => flag.blocking);
	const detail = flags.length === 0 ? "no dangerous capabilities found" : `${flags.length} flag(s)`;
	return { ok: !blocking, detail, flags };
}

/**
 * Run all three checks. `ok` means the arm action may be offered; warnings are
 * surfaced in review but do not block. Compile infrastructure failures fail
 * closed — an unverified extension is not armed.
 */
export async function runExtensionGate(input: {
	name: string;
	files: ProposalFiles;
	expectation?: string;
	options?: GateOptions;
}): Promise<ExtensionGateResult> {
	const reasons: string[] = [];
	const warnings: string[] = [];
	const expectationError = validateExpectation(input.expectation);
	if (expectationError) reasons.push(expectationError);

	const safety = scanSafety(input.files);
	for (const flag of safety.flags) {
		const text = `${flag.category}: ${flag.detail}`;
		if (flag.blocking) reasons.push(text);
		else warnings.push(text);
	}

	const compile = input.options?.skipCompile ? { ok: true, detail: "compile skipped" } : runCompileCheck(input.files, input.options);
	if (!compile.ok) reasons.push(`compile: ${compile.detail}`);

	const smoke = input.options?.skipSmoke ? { ...emptySmoke(), ok: true, detail: "smoke skipped" } : runFakePiSmoke(input.files, input.options);
	if (!smoke.ok) reasons.push(`fake-pi smoke: ${smoke.detail}`);

	return { ok: reasons.length === 0, reasons, warnings, compile, smoke, safety };
}

function emptySmoke(): SmokeResult {
	return { ok: false, detail: "", tools: [], commands: [], handlers: [] };
}

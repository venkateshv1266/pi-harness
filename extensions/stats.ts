/**
 * /stats — launches the omp-stats web dashboard (React + Chart.js) against
 * this machine's pi session logs. Uses the published @oh-my-pi/omp-stats
 * package, installed at <agentDir>/utils/omp-stats (bun add @oh-my-pi/omp-stats).
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_PORT = 3847;
const STARTUP_TIMEOUT_MS = 120_000;

// Local-only dashboard; host/port overridable via env
const DEFAULT_HOST = process.env.PI_STATS_HOST ?? "127.0.0.1";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
}

function dashboardUrl(port: number): string {
	return `http://${DEFAULT_HOST}:${port}`;
}

function statsEntryPath(): string {
	return path.join(
		agentDir(),
		"utils",
		"omp-stats",
		"node_modules",
		"@oh-my-pi",
		"omp-stats",
		"src",
		"index.ts",
	);
}

function serverLogPath(): string {
	return path.join(agentDir(), "utils", "omp-stats", "server.log");
}

// pi may be launched from an env whose PATH lacks ~/.bun/bin (GUI/cmux),
// so fall back to well-known bun locations.
function resolveBun(): Promise<string> {
	const candidates = [
		process.env.BUN_BIN,
		path.join(homedir(), ".bun", "bin", "bun"),
		"/opt/homebrew/bin/bun",
		"/usr/local/bin/bun",
	].filter((c): c is string => !!c);

	return new Promise((resolve) => {
		execFile("bun", ["--version"], { timeout: 5_000 }, (err) => {
			resolve(!err ? "bun" : (candidates.find((c) => existsSync(c)) ?? "bun"));
		});
	});
}

async function isDashboardUp(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://${DEFAULT_HOST}:${port}/api/stats`, {
			signal: AbortSignal.timeout(2_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

function openBrowser(url: string): void {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	spawn(opener, args, { stdio: "ignore", detached: true }).unref();
}

async function waitUntilUp(port: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isDashboardUp(port)) return true;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("stats", {
		description: "Open the omp-stats usage dashboard (cost, tokens, cache — web UI)",
		handler: async (args, ctx) => {
			const portArg = parseInt(args.trim(), 10);
			const port = Number.isFinite(portArg) && portArg > 0 && portArg <= 65_535 ? portArg : DEFAULT_PORT;

			if (await isDashboardUp(port)) {
				openBrowser(dashboardUrl(port));
				ctx.ui.notify(`Dashboard available at: ${dashboardUrl(port)}`, "info");
				return;
			}

			ctx.ui.notify(`Starting dashboard on port ${port}… (first sync can take a minute)`, "info");
			const bun = await resolveBun();
			mkdirSync(path.dirname(serverLogPath()), { recursive: true });
			const logFd = openSync(serverLogPath(), "a");
			let child;
			try {
				child = spawn(bun, ["run", statsEntryPath(), "-p", String(port), "--host", DEFAULT_HOST], {
					env: { ...process.env, PI_CODING_AGENT_DIR: agentDir() },
					stdio: ["ignore", logFd, logFd],
					detached: true,
				});
				child.unref();
			} catch (err) {
				ctx.ui.notify(`Failed to launch omp-stats: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			child.on("error", (err) => {
				ctx.ui.notify(`omp-stats spawn failed: ${err.message} — see ${serverLogPath()}`, "error");
			});

			// Don't block the session waiting for startup. Wait in the background
			// and open the browser once it's up.
			void waitUntilUp(port, STARTUP_TIMEOUT_MS).then((up) => {
				if (!up) {
					ctx.ui.notify(
						`Dashboard did not come up on port ${port} within ${STARTUP_TIMEOUT_MS / 1000}s — see ${serverLogPath()}`,
						"error",
					);
					return;
				}
				openBrowser(dashboardUrl(port));
				ctx.ui.notify(`Dashboard available at: ${dashboardUrl(port)}`, "info");
			});
		},
	});
}

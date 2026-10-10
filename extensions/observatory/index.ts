/**
 * /observatory — starts (or stops) the local Pi Harness Observatory server and
 * opens it in the browser. The server lives in ./server and runs under bun;
 * nothing is started at extension load time.
 *
 *   /observatory            start on the configured port (default 4747) and open
 *   /observatory 4800       start on a specific port
 *   /observatory stop       stop the running server
 *   /observatory status     report whether it is running
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_PORT = 4747;
const STARTUP_TIMEOUT_MS = 60_000;

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
}

function observatoryDir(): string {
	return path.join(agentDir(), "observatory");
}

function serverEntry(): string {
	return path.join(path.dirname(new URL(import.meta.url).pathname), "server", "main.ts");
}

function logPath(): string {
	return path.join(observatoryDir(), "server.log");
}

function pidPath(): string {
	return path.join(observatoryDir(), "server.pid");
}

function configuredPort(): number {
	const file = path.join(observatoryDir(), "config.json");
	if (existsSync(file)) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { port?: number };
			if (Number.isFinite(parsed.port)) return Number(parsed.port);
		} catch (err) {
			console.error(`[observatory] malformed config.json: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return DEFAULT_PORT;
}

function configuredHost(): string {
	return process.env.OBSERVATORY_HOST ?? "127.0.0.1";
}

// pi may be launched from an env whose PATH lacks ~/.bun/bin, so fall back to
// well-known bun locations (same approach as the /stats extension).
function resolveBun(): Promise<string> {
	const candidates = [process.env.BUN_BIN, path.join(homedir(), ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].filter(
		(c): c is string => Boolean(c),
	);
	return new Promise((resolve) => {
		execFile("bun", ["--version"], { timeout: 5_000 }, (err) => {
			resolve(!err ? "bun" : (candidates.find((c) => existsSync(c)) ?? "bun"));
		});
	});
}

async function isUp(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://${configuredHost()}:${port}/api/ping`, { signal: AbortSignal.timeout(2_000) });
		return res.ok;
	} catch {
		return false;
	}
}

async function waitUntilUp(port: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isUp(port)) return true;
		await new Promise((resolve) => setTimeout(resolve, 800));
	}
	return false;
}

function openBrowser(url: string): void {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	spawn(opener, args, { stdio: "ignore", detached: true }).unref();
}

function runningPid(): number | null {
	if (!existsSync(pidPath())) return null;
	const pid = Number(readFileSync(pidPath(), "utf8").trim());
	return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("observatory", {
		description: "Open the Pi Harness Observatory (sessions, models, jev decisions, curator — local web UI)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "";

			if (sub === "stop") {
				const pid = runningPid();
				if (!pid) {
					ctx.ui.notify("Observatory is not running (no pid file).", "info");
					return;
				}
				try {
					process.kill(pid, "SIGTERM");
					unlinkSync(pidPath());
					ctx.ui.notify(`Observatory stopped (pid ${pid}).`, "info");
				} catch (err) {
					ctx.ui.notify(`Could not stop pid ${pid}: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			const portArg = Number(sub);
			const port = Number.isFinite(portArg) && portArg > 0 && portArg <= 65_535 ? portArg : configuredPort();

			if (sub === "status" || await isUp(port)) {
				ctx.ui.notify(`Observatory is running at http://${configuredHost()}:${port}`, "info");
				if (sub !== "status") openBrowser(`http://${configuredHost()}:${port}`);
				return;
			}

			mkdirSync(observatoryDir(), { recursive: true });
			const bun = await resolveBun();
			const logFd = openSync(logPath(), "a");
			ctx.ui.notify(`Starting Observatory on port ${port}… (first scan indexes all session logs)`, "info");
			let child;
			try {
				child = spawn(bun, [serverEntry()], {
					env: { ...process.env, PI_CODING_AGENT_DIR: agentDir(), OBSERVATORY_PORT: String(port) },
					stdio: ["ignore", logFd, logFd],
					detached: true,
				});
				child.unref();
				if (child.pid) writeFileSync(pidPath(), String(child.pid));
			} catch (err) {
				ctx.ui.notify(`Failed to launch Observatory: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			child.on("error", (err) => {
				ctx.ui.notify(`Observatory spawn failed: ${err.message} — see ${logPath()}`, "error");
			});

			void waitUntilUp(port, STARTUP_TIMEOUT_MS).then((up) => {
				if (!up) {
					ctx.ui.notify(`Observatory did not come up on port ${port} within ${STARTUP_TIMEOUT_MS / 1000}s — see ${logPath()}`, "error");
					return;
				}
				openBrowser(`http://${configuredHost()}:${port}`);
				ctx.ui.notify(`Observatory available at: http://${configuredHost()}:${port}`, "info");
			});
		},
	});
}

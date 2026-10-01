/**
 * MCP Cookie Gate
 *
 * Ports the pre-call auth hooks of the former mcp-bridge extension onto pi's
 * built-in MCP support: before any mcp__<grafana-*> or mcp__<redash-*> tool
 * call, runs the matching check-*-cookies.sh hook, which validates SSO cookies
 * and triggers browser re-auth when they expired. Non-zero exit blocks the call.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MCP_SERVERS_ROOT =
	process.env.MCP_SERVERS_ROOT || path.join(os.homedir(), "mcp-servers");

/** Per-server auth hooks, keyed by server-name prefix. */
const AUTH_HOOKS: Record<string, string> = {
	"grafana-": path.join(MCP_SERVERS_ROOT, "grafana-mcp", "check-grafana-cookies.sh"),
	"redash-": path.join(MCP_SERVERS_ROOT, "redash-mcp", "check-redash-cookies.sh"),
};

/** Hook must exit 0 within this budget; the SSO re-auth flow lives inside it. */
const HOOK_TIMEOUT_MS = 120_000;

/** Env-var denylist: uppercase substring match, stripped before the server's own env is merged. */
const SENSITIVE_ENV_PATTERNS = [
	"KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD",
	"CREDENTIAL", "PRIVATE_KEY", "AUTH",
	"SSH_AUTH_SOCK", "AWS_SECRET", "STRIPE",
];

interface ServerConfig {
	env?: Record<string, string>;
}
type ServerMap = Record<string, ServerConfig>;

function readServers(filePath: string): ServerMap {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return parsed?.mcpServers ?? {};
	} catch {
		return {};
	}
}

function buildChildEnv(serverEnv?: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		const upper = key.toUpperCase();
		if (!SENSITIVE_ENV_PATTERNS.some((p) => upper.includes(p))) env[key] = value;
	}
	Object.assign(env, serverEnv);
	return env;
}

interface HookResult {
	ok: boolean;
	message: string;
}

/** SIGKILL the hook's whole process group; wrapper-script grandchildren hold the stdio pipes. */
function killTree(child: ChildProcess): void {
	try {
		if (child.pid) process.kill(-child.pid, "SIGKILL");
	} catch {
		// expected: ESRCH once the process group is gone
	}
	try {
		child.kill("SIGKILL");
	} catch {
		// expected: child already exited
	}
}

export default function (pi: ExtensionAPI) {
	const active = new Set<ChildProcess>();
	let servers: ServerMap = {};

	pi.on("session_start", (_event, ctx) => {
		servers = readServers(path.join(os.homedir(), ".pi", "agent", "mcp.json"));
		const projectPath = path.join(ctx.cwd ?? process.cwd(), ".pi", "mcp.json");
		if (fs.existsSync(projectPath)) Object.assign(servers, readServers(projectPath));
	});

	function runHook(script: string, toolName: string, serverEnv?: Record<string, string>): Promise<HookResult> {
		return new Promise((resolve) => {
			if (!fs.existsSync(script)) {
				return resolve({ ok: false, message: `Auth hook not found: ${script}` });
			}

			let stdout = "";
			let stderr = "";
			let settled = false;
			let timer: NodeJS.Timeout | undefined;

			const finish = (result: HookResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				active.delete(child);
				resolve(result);
			};

			const child = spawn(script, [], {
				env: buildChildEnv(serverEnv),
				stdio: ["pipe", "pipe", "pipe"],
				// own process group so killTree reaps wrapper-script grandchildren
				detached: true,
			});
			active.add(child);

			child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
			child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
			child.stdin?.write(JSON.stringify({ tool_name: toolName }));
			child.stdin?.end();

			timer = setTimeout(() => killTree(child), HOOK_TIMEOUT_MS);

			child.on("close", (code) => {
				finish(
					code === 0
						? { ok: true, message: stdout.trim() || stderr.trim() }
						: {
								ok: false,
								message: `Auth hook exited ${code}: ${stderr.trim() || stdout.trim() || "(no output)"}`,
							}
				);
			});
			child.on("error", (err) => {
				finish({ ok: false, message: `Auth hook failed to spawn: ${err.message}` });
			});
		});
	}

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName;
		if (!toolName.startsWith("mcp__")) return;
		const parts = toolName.split("__");
		if (parts.length < 3 || !parts[1]) return;
		// pi >= 0.99.2 sanitizes MCP server "-" to "_" in tool names; map back to the mcp.json key.
		const serverName = parts[1].replace(/_/g, "-");
		const prefix = Object.keys(AUTH_HOOKS).find((p) => serverName.startsWith(p));
		if (!prefix) return;

		if (ctx.hasUI) ctx.ui.notify(`mcp-cookie-gate: auth check for ${serverName}…`, "info");
		const auth = await runHook(AUTH_HOOKS[prefix], toolName, servers[serverName]?.env);
		if (!auth.ok) {
			return {
				block: true,
				reason:
					`Authentication required for ${serverName} (${toolName}). ` +
					`Complete browser SSO if a window opened, then retry. ` +
					`Hook output: ${auth.message}`,
			};
		}
	});

	pi.on("session_shutdown", () => {
		for (const child of active) killTree(child);
		active.clear();
	});
}
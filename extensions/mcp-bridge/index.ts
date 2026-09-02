/**
 * pi MCP Bridge Extension
 *
 * Bridges Model Context Protocol (MCP) servers into pi as native tools, so
 * MCP-only tools (Grafana, Redash, Snowflake, …) work in pi exactly as they
 * do in Claude Code — reusing the SAME server config from ~/.claude.json and
 * the SAME pre-tool auth hooks (check-*-cookies.sh).
 *
 * Security measures (see security review):
 *  - Env denylist: strips *KEY/*TOKEN/*SECRET/*PASSWORD/*CREDENTIAL* etc.
 *    from the environment passed to MCP server child processes, preventing
 *    credential leakage from pi's process env.
 *  - Tool name validation: only [a-zA-Z0-9_-], preventing prompt injection
 *    via malicious tool names from a compromised MCP server.
 *  - Description sanitization: strips control chars, truncates to 1024 chars.
 *  - Tool count cap: max 100 tools per server (prevents system-prompt bloating).
 *  - Schema recursion depth limit: prevents stack overflow from nested schemas.
 *
 * Design points:
 *  - Config source: top-level `mcpServers` in ~/.claude.json, reused verbatim.
 *  - Lazy spawn: a server's child process is spawned on first tool call, not
 *    at session_start.
 *  - Tool naming: `mcp__<server>__<tool>` (Claude's convention) so the
 *    existing check-*-cookies.sh hooks parse the server name unmodified.
 *  - Per-call auth: for grafana/redash, run check-*-cookies.sh BEFORE the MCP
 *    call, feeding `{tool_name}` on stdin (exactly like Claude's PreToolUse).
 *  - session_shutdown kills spawned children.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { type ExtensionAPI, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { convertInputSchema } from "./schema-convert.ts";
import {
  type OAuthConfig,
  getOAuthStatus,
  getValidAccessToken,
} from "./oauth.ts";

/** One entry from ~/.claude.json or ~/.pi/agent/mcp-servers.json `mcpServers`. */
type McpServerConfig = {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  oauth?: OAuthConfig;
  env?: Record<string, string>;
};

/** Auth-hook config for grafana/redash servers. */
type AuthHook = {
  script: string;
};

/** Runtime state for a lazily-spawned MCP server. */
type ServerState = {
  name: string;
  config: McpServerConfig;
  client?: Client;
  transport?: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  child?: ChildProcess;
  tools?: { name: string; description?: string; inputSchema: unknown }[];
  connecting?: Promise<void>;
  authHook?: AuthHook;
  stderrBuffer?: string;
  uiNotify?: (msg: string, level: "info" | "warn" | "error") => void;
};

/** Config sources, in priority order. The pi-native file wins; the Claude
 * file is a fallback so the bridge keeps working during/after migration. */
const PI_MCP_CONFIG = path.join(os.homedir(), ".pi", "agent", "mcp-servers.json");
const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");
const MCP_SERVERS_ROOT =
  process.env.MCP_SERVERS_ROOT || path.join(os.homedir(), "mcp-servers");

/** Which config source was actually used (for /mcp status output). */
let configSource = "";

/** Per-server auth hooks, keyed by server-name prefix. */
const AUTH_HOOKS: Record<string, AuthHook> = {
  "grafana-": {
    script: path.join(MCP_SERVERS_ROOT, "grafana-mcp", "check-grafana-cookies.sh"),
  },
  "redash-": {
    script: path.join(MCP_SERVERS_ROOT, "redash-mcp", "check-redash-cookies.sh"),
  },
};

// ── Security constants ───────────────────────────────────────────────────────

/** Env-var denylist: variables matching these (case-insensitive substring)
 * are stripped from child-process environments to prevent credential leakage. */
const SENSITIVE_ENV_PATTERNS = [
  "KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD",
  "CREDENTIAL", "PRIVATE_KEY", "AUTH",
  "SSH_AUTH_SOCK", "AWS_SECRET", "STRIPE",
];

/** Max tools registered per MCP server (prevents system-prompt bloating). */
const MAX_TOOLS_PER_SERVER = 100;

/** Max schema recursion depth (prevents stack overflow from nested schemas). */
const MAX_SCHEMA_DEPTH = 32;

/** Max bytes of MCP tool text output to return inline into the conversation.
 *  Larger results are written to a temp file and replaced with a path +
 *  head/tail preview, keeping the model request under the provider's
 *  content-filter size limit. Tune via PI_MCP_MAX_INLINE_BYTES. */
const MAX_INLINE_CONTENT_BYTES =
  Number(process.env.PI_MCP_MAX_INLINE_BYTES) || 64 * 1024;

/** Dir for spillover files (created lazily, cleared on session_shutdown). */
const SPILLOVER_DIR = path.join(os.tmpdir(), "pi-mcp-spillover");
const SPILLOVER_FILES: string[] = [];

/** Lines of MCP output shown in the collapsed (default) tool row.
 *  0 = summary only. Tune via PI_MCP_PREVIEW_LINES. */
const PREVIEW_LINES = (() => {
  const raw = process.env.PI_MCP_PREVIEW_LINES;
  const n = raw === undefined ? 0 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

// ── Collapsed result rendering ───────────────────────────────────────────────

interface McpResultState {
  cachedWidth?: number;
  cachedLines?: string[];
  cachedSkipped?: number;
}

class McpResultComponent extends Container {
  state: McpResultState = {};
}

/** Text payload of a tool result, joined across text blocks. */
function resultText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/**
 * Render an MCP tool result compactly: one summary line by default, with the
 * full payload revealed only on expand (ctrl+o / app.tools.expand). MCP
 * results are typically huge JSON blobs, so dumping them into the transcript
 * makes the terminal unreadable.
 */
function buildMcpResult(
  component: McpResultComponent,
  output: string,
  summary: string,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme
): void {
  const state = component.state;
  component.clear();

  if (options.isPartial) {
    component.addChild(new Text(theme.fg("warning", "Working..."), 0, 0));
    return;
  }

  component.addChild(new Text(theme.fg("muted", summary), 0, 0));
  if (!output) return;

  const styledLines = output.split("\n").map((l) => theme.fg("toolOutput", l));

  if (options.expanded) {
    component.addChild(new Text(`\n${styledLines.join("\n")}`, 0, 0));
    return;
  }

  component.addChild({
    render: (width: number) => {
      if (state.cachedLines === undefined || state.cachedWidth !== width) {
        state.cachedLines = styledLines
          .slice(0, PREVIEW_LINES)
          .map((l) => truncateToWidth(l, width, "..."));
        state.cachedSkipped = Math.max(styledLines.length - PREVIEW_LINES, 0);
        state.cachedWidth = width;
      }
      const lines = [...(state.cachedLines ?? [])];
      if (state.cachedSkipped && state.cachedSkipped > 0) {
        const hint =
          theme.fg("muted", `${state.cachedSkipped} line${state.cachedSkipped === 1 ? "" : "s"} hidden,`) +
          ` ${keyHint("app.tools.expand", "to expand")}`;
        lines.push(truncateToWidth(hint, width, "..."));
      }
      return lines;
    },
    invalidate: () => {
      state.cachedWidth = undefined;
      state.cachedLines = undefined;
      state.cachedSkipped = undefined;
    },
  });
}

/** Compact one-line call header; full args only when expanded. */
function mcpRenderCall(label: string) {
  return function (args: any, theme: Theme, context: any) {
    const json = (() => {
      try {
        return JSON.stringify(args ?? {});
      } catch {
        return "{…}";
      }
    })();
    const header = theme.fg("toolTitle", theme.bold(label));
    if (context?.expanded) {
      let pretty = json;
      try {
        pretty = JSON.stringify(args ?? {}, null, 2);
      } catch {}
      return new Text(`${header}\n${theme.fg("muted", pretty)}`, 0, 0);
    }
    return {
      render: (width: number) => [
        truncateToWidth(`${header} ${theme.fg("muted", json)}`, width, "…"),
      ],
      invalidate: () => {},
    };
  };
}

/** Shared renderResult factory for mcp__* tools. */
function mcpRenderResult(summarize: (result: any) => string) {
  return function (result: any, options: any, theme: Theme, context: any) {
    const component =
      (context.lastComponent as McpResultComponent | undefined) ??
      new McpResultComponent();
    buildMcpResult(component, resultText(result), summarize(result), options, theme);
    component.invalidate();
    return component;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function authHookFor(serverName: string): AuthHook | undefined {
  for (const [prefix, hook] of Object.entries(AUTH_HOOKS)) {
    if (serverName.startsWith(prefix)) return hook;
  }
  return undefined;
}

/** Expand a leading ~ in a path. */
function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Load MCP server configs. Reads ~/.pi/agent/mcp-servers.json first (a flat
 * object of server configs); falls back to the `mcpServers` key in
 * ~/.claude.json if the pi file is absent. Sets `configSource` to whichever
 * path was used, so /mcp can report it.
 */
function loadMcpServers(): Record<string, McpServerConfig> {
  // 1. Pi-native config (flat object: { "server-name": {…}, … }).
  try {
    const raw = fs.readFileSync(PI_MCP_CONFIG, "utf8");
    const json = JSON.parse(raw) as Record<string, McpServerConfig>;
    if (json && typeof json === "object") {
      configSource = PI_MCP_CONFIG;
      return json;
    }
  } catch {
    // File missing or unreadable — fall through.
  }
  // 2. Fallback: ~/.claude.json top-level `mcpServers`.
  try {
    const raw = fs.readFileSync(CLAUDE_JSON, "utf8");
    const json = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
    if (json.mcpServers) {
      configSource = CLAUDE_JSON + " (fallback)";
      return json.mcpServers;
    }
  } catch {
    // Claude config missing too.
  }
  configSource = "(none found)";
  return {};
}

/** Build a child-process environment: inherit process.env but strip sensitive
 * vars, then merge the server's configured env on top. */
function buildChildEnv(serverEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (SENSITIVE_ENV_PATTERNS.some((p) => upper.includes(p))) continue;
    env[k] = v;
  }
  if (serverEnv) {
    for (const [k, v] of Object.entries(serverEnv)) env[k] = v;
  }
  return env;
}

/** Validate a tool name: only [a-zA-Z0-9_-], max 128 chars. */
function isValidToolName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length <= 128;
}

/** Sanitize a description: strip control chars, truncate to maxLen. */
function sanitizeDescription(desc: string | undefined, maxLen = 1024): string | undefined {
  if (!desc) return undefined;
  const cleaned = desc.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "…" : cleaned;
}

/** Cheap auth-status probe for grafana/redash: inspect the cookie file without
 * triggering browser SSO. Returns a short human-readable status string. */
function cookieAuthStatus(config: McpServerConfig): string {
  const cookieFile = config.env?.GRAFANA_COOKIE_FILE || config.env?.REDASH_COOKIE_FILE;
  if (!cookieFile) return "no cookie file configured";
  const p = expandTilde(cookieFile);
  try {
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw) as { cookie_header?: string };
    const hasHeader = typeof data.cookie_header === "string" && data.cookie_header.length > 0;
    if (!hasHeader) return `empty cookie file (${p}) — needs SSO`;
    const stat = fs.statSync(p);
    const ageHrs = (Date.now() - stat.mtimeMs) / 3_600_000;
    return `cookies present (file age ${ageHrs.toFixed(1)}h)`;
  } catch {
    return `no cookie file at ${p} — needs SSO`;
  }
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function mcpBridgeExtension(pi: ExtensionAPI) {
  const servers = new Map<string, ServerState>();

  /** Lazily connect to an MCP server (spawn + initialize + tools/list). */
  async function ensureConnected(st: ServerState, signal?: AbortSignal): Promise<void> {
    if (st.client && st.tools) return;
    if (st.connecting) return st.connecting;

    st.connecting = (async () => {
      const isHttp =
        st.config.type === "http" ||
        st.config.type === "sse" ||
        (!st.config.command && !!st.config.url);

      if (isHttp) {
        const serverUrl = expandTilde(st.config.url ?? "");
        if (!serverUrl) {
          throw new Error(`MCP server ${st.name} requires a "url" property for HTTP/SSE transport`);
        }

        const reqHeaders: Record<string, string> = {};
        if (st.config.headers) {
          for (const [k, v] of Object.entries(st.config.headers)) {
            reqHeaders[k] = v;
          }
        }

        if (st.config.oauth) {
          const accessToken = await getValidAccessToken(
            st.name,
            serverUrl,
            st.config.oauth,
            st.uiNotify
          );
          reqHeaders["Authorization"] = `Bearer ${accessToken}`;
        }

        let transport: StreamableHTTPClientTransport | SSEClientTransport;
        if (st.config.type === "sse") {
          transport = new SSEClientTransport(new URL(serverUrl), {
            requestInit: { headers: reqHeaders },
          });
        } else {
          transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
            requestInit: { headers: reqHeaders },
          });
        }

        transport.onerror = (err: Error) => {
          console.error(`[mcp-bridge] ${st.name} HTTP transport error:`, err);
        };

        const client = new Client(
          { name: "pi-mcp-bridge", version: "0.1.0" },
          { capabilities: {} }
        );

        await client.connect(transport);
        const caps = client.getServerCapabilities();
        if (!caps?.tools) {
          throw new Error(`MCP server ${st.name} does not expose tools`);
        }
        const list = await client.listTools();

        // Security: validate tool names, cap count, sanitize descriptions.
        const tools: { name: string; description?: string; inputSchema: unknown }[] = [];
        let skipped = 0;
        for (const t of list.tools) {
          if (!isValidToolName(t.name)) {
            console.error(`[mcp-bridge] ${st.name}: skipping invalid tool name "${t.name}"`);
            skipped++;
            continue;
          }
          if (tools.length >= MAX_TOOLS_PER_SERVER) {
            console.error(
              `[mcp-bridge] ${st.name}: tool cap (${MAX_TOOLS_PER_SERVER}) reached, ` +
                `skipping ${list.tools.length - tools.length} more`
            );
            break;
          }
          tools.push({
            name: t.name,
            description: sanitizeDescription(t.description),
            inputSchema: t.inputSchema,
          });
        }

        st.client = client;
        st.transport = transport;
        st.tools = tools;
        return;
      }

      const command = expandTilde(st.config.command ?? "");
      if (!command) {
        throw new Error(`MCP server ${st.name} requires a "command" property for stdio transport`);
      }
      const args = (st.config.args ?? []).map(expandTilde);
      const env = buildChildEnv(st.config.env);

      const transport = new StdioClientTransport({
        command,
        args,
        env,
        stderr: "pipe",
        // Spawn from a neutral cwd so npx-based servers (e.g. mcp-remote for
        // Linear) don't inherit the session project's package.json overrides,
        // which make `npx` abort with EOVERRIDE before the server starts.
        // Matches how other agents (opencode/claude) spawn MCP children.
        cwd: os.tmpdir(),
      });

      transport.onerror = (err: Error) => {
        console.error(`[mcp-bridge] ${st.name} transport error:`, err);
      };

      // Buffer server stderr so auth URLs / errors are visible to the user
      // via /mcp or session_start notify, not silently dropped.
      st.stderrBuffer = "";
      const stderrStream = (transport as unknown as { _stderrStream?: NodeJS.ReadableStream })
        ._stderrStream;
      if (stderrStream && typeof stderrStream.on === "function") {
        stderrStream.on("data", (chunk: Buffer) => {
          // Buffer server stderr for `/mcp` diagnostics, but never surface it
          // to the TUI — operational logs (grafana proxy 401s, mcp-remote
          // "Connecting to remote server" chatter, etc.) only made `/mcp
          // <server>` look stuck after a successful connect. The user just
          // sees "Connecting to X…" and "X: connected, N tools available".
          st.stderrBuffer = (st.stderrBuffer ?? "") + chunk.toString();
        });
      }

      const client = new Client(
        { name: "pi-mcp-bridge", version: "0.1.0" },
        { capabilities: {} }
      );

      await client.connect(transport);
      const caps = client.getServerCapabilities();
      if (!caps?.tools) {
        throw new Error(`MCP server ${st.name} does not expose tools`);
      }
      const list = await client.listTools();

      // Security: validate tool names, cap count, sanitize descriptions.
      const tools: { name: string; description?: string; inputSchema: unknown }[] = [];
      let skipped = 0;
      for (const t of list.tools) {
        if (!isValidToolName(t.name)) {
          console.error(`[mcp-bridge] ${st.name}: skipping invalid tool name "${t.name}"`);
          skipped++;
          continue;
        }
        if (tools.length >= MAX_TOOLS_PER_SERVER) {
          console.error(
            `[mcp-bridge] ${st.name}: tool cap (${MAX_TOOLS_PER_SERVER}) reached, ` +
              `skipping ${list.tools.length - tools.length} more`
          );
          break;
        }
        tools.push({
          name: t.name,
          description: sanitizeDescription(t.description),
          inputSchema: t.inputSchema,
        });
      }

      st.client = client;
      st.transport = transport;
      st.tools = tools;
      const child = (transport as unknown as { _process?: ChildProcess })._process;
      st.child = child;
      // Detect server-process death (e.g. chrome-devtools-mcp when its
      // dedicated Chrome window is closed by the user) and clear the live
      // connection state so the next tool call respawns the server instead
      // of returning "Not connected" forever. Keep `tools` so /mcp and
      // mcp__list still report them; the registered pi tools persist and
      // rebind to the new client on reconnect.
      if (child) {
        child.on("exit", () => {
          if (st.child !== child) return; // a respawn replaced us — leave it
          st.client = undefined;
          st.transport = undefined;
          st.child = undefined;
        });
      }
    })();

    try {
      await st.connecting;
    } finally {
      st.connecting = undefined;
    }
  }

  /** Run the pre-tool auth hook (check-*-cookies.sh) for grafana/redash. */
  function runAuthHook(
    st: ServerState,
    toolName: string,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      const hook = st.authHook;
      if (!hook) return resolve({ ok: true, message: "" });
      if (!fs.existsSync(hook.script)) {
        return resolve({ ok: false, message: `Auth hook not found: ${hook.script}` });
      }

      const env = buildChildEnv(st.config.env);

      const child = spawn(hook.script, [], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        signal: signal ?? undefined,
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

      child.stdin.write(JSON.stringify({ tool_name: toolName }));
      child.stdin.end();

      const timeout = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 120_000);

      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve({ ok: true, message: stdout.trim() || stderr.trim() });
        } else {
          resolve({
            ok: false,
            message: `Auth hook exited ${code}: ${stderr.trim() || stdout.trim() || "(no output)"}`,
          });
        }
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, message: `Auth hook failed to spawn: ${err.message}` });
      });
    });
  }

  /**
   * Call an MCP tool, reconnecting once if the server child died mid-session
   * (e.g. chrome-devtools-mcp when its Chrome window is closed) or if an HTTP
   * server rejected with 401 Unauthorized (token expired).
   */
  async function callServerTool(
    st: ServerState,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) {
    await ensureConnected(st, signal);
    try {
      return await st.client!.callTool({ name, arguments: args });
    } catch (err: any) {
      const isHttp =
        st.config.type === "http" ||
        st.config.type === "sse" ||
        (!st.config.command && !!st.config.url);

      if (isHttp && st.config.oauth) {
        const msg = String(err?.message || "").toLowerCase();
        const isAuthErr =
          msg.includes("401") ||
          msg.includes("unauthorized") ||
          msg.includes("expired") ||
          err?.code === 401;

        if (isAuthErr) {
          killServer(st);
          await getValidAccessToken(
            st.name,
            st.config.url!,
            st.config.oauth,
            st.uiNotify,
            true
          );
          await ensureConnected(st, signal);
          return await st.client!.callTool({ name, arguments: args });
        }
      }

      const alive =
        !!st.child && st.child.exitCode === null && st.child.signalCode === null;
      if (alive) throw err; // process healthy — genuine tool error
      // Child died — clear state, respawn, retry exactly once.
      st.client = undefined;
      st.transport = undefined;
      st.child = undefined;
      await ensureConnected(st, signal);
      return await st.client!.callTool({ name, arguments: args });
    }
  }

  /** Kill a server's child process / close connection (best-effort). */
  function killServer(st: ServerState) {
    try { st.client?.close?.(); } catch {}
    try { (st.transport as any)?.close?.(); } catch {}
    try { st.child?.kill("SIGTERM"); } catch {}
    st.client = undefined;
    st.transport = undefined;
    st.child = undefined;
    st.tools = undefined;
  }

  // ── session_start: load config, register mcp__list + /mcp command ──────────

  pi.on("session_start", async (_event, ctx) => {
    const configs = loadMcpServers();
    servers.clear();

    for (const [name, config] of Object.entries(configs)) {
      const type = config.type ?? (config.url ? "http" : "stdio");
      if (type !== "stdio" && type !== "http" && type !== "sse") {
        ctx.ui.notify(`mcp-bridge: skipping unsupported server ${name} (${type})`, "warn");
        continue;
      }
      const st: ServerState = {
        name,
        config: { ...config, type },
        authHook: authHookFor(name),
        uiNotify: ctx.ui.notify.bind(ctx.ui),
      };
      servers.set(name, st);
    }

    // Register the discovery tool (lazy connect on first call).
    pi.registerTool({
      name: "mcp__list",
      label: "MCP List",
      description:
        "List available MCP servers and their tools. Triggers a lazy connection to each server on demand. Returns JSON: {server: [toolName, ...]}. Use this first to discover what MCP tools are available, then call mcp__<server>__<tool> directly.",
      promptSnippet: "List available MCP servers and tools (Grafana, Redash, Snowflake)",
      promptGuidelines: [
        "Use mcp__list to discover MCP-provided tools (Grafana/Redash/Snowflake). It returns the list of servers and tool names. Call it once at the start of a task that may need these data sources.",
      ],
      parameters: Type.Object({
        server: Type.Optional(
          Type.String({
            description:
              "Optional server name to (re)connect and list tools for, e.g. 'github'. Omit to list all servers without connecting.",
          })
        ),
      }),
      renderResult: mcpRenderResult((result) => {
        const servers = (result.details as { servers?: Record<string, unknown> } | undefined)?.servers;
        const names = servers ? Object.keys(servers) : [];
        const toolCount = names.reduce((n, k) => {
          const v = (servers as Record<string, unknown>)[k];
          return n + (Array.isArray(v) ? v.length : 0);
        }, 0);
        return `${names.length} server${names.length === 1 ? "" : "s"}, ${toolCount} tool${toolCount === 1 ? "" : "s"}`;
      }),
      async execute(_id, params, signal, onUpdate, ctx) {
        const out: Record<string, string[] | { error: string }> = {};
        if (params.server) {
          const st = servers.get(params.server);
          if (!st)
            return { content: [{ type: "text", text: `Unknown server: ${params.server}` }], details: {}, isError: true };
          try {
            onUpdate?.({ content: [{ type: "text", text: `Connecting to ${params.server}…` }] });
            await ensureConnected(st, signal);
            out[params.server] = (st.tools ?? []).map((t) => t.name);
            registerServerTools(st);
          } catch (err) {
            out[params.server] = { error: (err as Error).message };
          }
        } else {
          for (const [name, st] of servers) {
            out[name] = (st.tools ?? []).map((t) => t.name);
          }
        }
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          details: { servers: out },
        };
      },
    });

    // Register the /mcp slash command.
    pi.registerCommand("mcp", {
      description:
        "List MCP servers, their connection + auth status. `/mcp <server>` lazily connects that server.",
      getArgumentCompletions(prefix: string) {
        const items = [...servers.keys()].map((v) => ({ value: v, label: v }));
        const filtered = items.filter((i) => i.value.startsWith(prefix));
        return filtered.length > 0 ? filtered : null;
      },
      handler: async (args, ctx) => {
        const target = (args ?? "").trim();
        if (target) {
          const st = servers.get(target);
          if (!st) {
            ctx.ui.notify(`Unknown MCP server: ${target}`, "error");
            return;
          }
          try {
            ctx.ui.notify(`Connecting to ${target}…`, "info");
            await ensureConnected(st, ctx.signal);
            registerServerTools(st);
            const count = st.tools?.length ?? 0;
            ctx.ui.notify(`${target}: connected, ${count} tools available`, "info");
          } catch (err) {
            ctx.ui.notify(`${target}: connect failed — ${(err as Error).message}`, "error");
          }
          return;
        }
        const rows: string[] = [];
        rows.push(`MCP servers (via ${configSource}):`);
        rows.push("");
        for (const [name, st] of servers) {
          const connected = st.client && st.tools ? "yes" : "no";
          const toolCount = st.tools?.length ?? 0;
          const isHttp =
            st.config.type === "http" ||
            st.config.type === "sse" ||
            (!st.config.command && !!st.config.url);

          let auth = "";
          if (isHttp) {
            if (st.config.oauth) {
              auth = getOAuthStatus(name, st.config.oauth).details;
            } else if (st.config.headers?.Authorization) {
              auth = "static Bearer header";
            } else {
              auth = "remote HTTP (no auth required)";
            }
          } else {
            auth = st.authHook
              ? cookieAuthStatus(st.config)
              : "SSO (server handles on first call)";
          }

          rows.push(`  ${name}`);
          rows.push(`    type:      ${st.config.type ?? "stdio"}`);
          if (st.config.url) rows.push(`    url:       ${st.config.url}`);
          rows.push(`    connected: ${connected}${connected === "yes" ? `, ${toolCount} tools` : ""}`);
          rows.push(`    auth:      ${auth}`);
          rows.push(`    hook:      ${st.authHook ? path.basename(st.authHook.script) : "(none)"}`);
        }
        rows.push("");
        rows.push("Use `/mcp <server>` to lazily connect one, or call the `mcp__list` tool.");
        ctx.ui.notify(rows.join("\n"), "info");
      },
    });

    ctx.ui.notify(`mcp-bridge: ${servers.size} servers configured from ${path.basename(configSource)} (call mcp__list to connect)`, "info");
  });

  /**
   * If the combined text content exceeds MAX_INLINE_CONTENT_BYTES, write it to
   * a temp file and return a small summary block (path + head/tail preview)
   * plus any image blocks. Otherwise return content unchanged. This keeps
   * oversized MCP results (e.g. large Grafana log queries) from blowing past
   * the model provider's content-filter request-size limit.
   */
  function maybeSpillContent(
    content: Array<{ type: string; text?: string; source?: unknown }>,
    serverName: string,
    toolName: string,
    notify?: (msg: string, level: "info" | "warn") => void
  ): Array<{ type: string; text?: string; source?: unknown }> {
    const textBlocks = content.filter(
      (b) => b.type === "text" && typeof b.text === "string"
    ) as Array<{ type: "text", text: string }>;
    const totalTextBytes = textBlocks.reduce(
      (n, b) => n + Buffer.byteLength(b.text, "utf8"),
      0
    );

    if (totalTextBytes <= MAX_INLINE_CONTENT_BYTES) return content;

    const fullText = textBlocks.map((b) => b.text).join("\n\n---\n\n");

    try {
      fs.mkdirSync(SPILLOVER_DIR, { recursive: true });
    } catch {}
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeServer = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(
      SPILLOVER_DIR,
      `${safeServer}__${safeTool}__${stamp}.txt`
    );

    try {
      fs.writeFileSync(filePath, fullText, "utf8");
      SPILLOVER_FILES.push(filePath);
    } catch (err) {
      notify?.(
        `mcp-bridge: failed to spill ${totalTextBytes}B to disk: ${(err as Error).message}; returning inline`,
        "warn"
      );
      return content;
    }

    const lines = fullText.split("\n");
    // No inline preview. A head/tail slice is useless for compact single-line
    // JSON blobs (Prometheus/Loki/Snowflake), and the previous line-based
    // preview was exactly what let a 19MB single-line payload return inline
    // and blow past the provider's content-filter size limit. Return only
    // metadata + the spill file path; the agent uses the `read` tool
    // (offset/limit) on the path to inspect the full output on demand.

    const summary =
      `MCP tool ${serverName}/${toolName} returned ${totalTextBytes.toLocaleString()} bytes ` +
      `(${lines.length} lines) \u2014 too large for inline context; preview omitted.\n` +
      `Full output saved to: ${filePath}\n` +
      `Use the \`read\` tool (with offset/limit) on the path above to inspect the full output.`;

    notify?.(
      `mcp-bridge: ${serverName}/${toolName} output spilled to ${filePath} (${(totalTextBytes / 1024).toFixed(1)} KB)`,
      "info"
    );

    const imageBlocks = content.filter((b) => b.type === "image");
    return [{ type: "text", text: summary }, ...imageBlocks];
  }

  /** Register each remote tool from a server as first-class pi tool. */
  function registerServerTools(st: ServerState) {
    if (!st.client || !st.tools) return;
    for (const t of st.tools) {
      const toolName = `mcp__${st.name}__${t.name}`;
      const existing = pi.getAllTools().find((x) => x.name === toolName);
      if (existing) continue;

      const schema = convertInputSchema(t.inputSchema, MAX_SCHEMA_DEPTH);
      const hook = st.authHook;
      const serverState = st;
      const desc = sanitizeDescription(t.description) ?? `MCP tool ${t.name} on server ${st.name}`;

      pi.registerTool({
        name: toolName,
        label: `${st.name}/${t.name}`,
        description: desc,
        promptSnippet: desc.slice(0, 80),
        promptGuidelines: hook
          ? [
              `Use ${toolName} to query ${st.name}. If it fails with an auth error, the user must complete browser SSO — tell them to do so, then retry.`,
            ]
          : [
              `Use ${toolName} to query ${st.name} (enterprise auth is handled by the MCP server on first use).`,
            ],
        parameters: schema,
        renderCall: mcpRenderCall(`${st.name}/${t.name}`),
        renderResult: mcpRenderResult((result) => {
          const text = resultText(result);
          const bytes = Buffer.byteLength(text, "utf8");
          const lines = text ? text.split("\n").length : 0;
          if ((result as { isError?: boolean }).isError) {
            return `${st.name}/${t.name} failed (${lines} line${lines === 1 ? "" : "s"})`;
          }
          const size =
            bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
          return `${size}, ${lines} line${lines === 1 ? "" : "s"}`;
        }),
        async execute(_id, params, signal, _onUpdate, ctx) {
          if (hook) {
            ctx.ui.notify(`mcp-bridge: auth check for ${st.name}…`, "info");
            const auth = await runAuthHook(serverState, toolName, signal);
            if (!auth.ok) {
              throw new Error(
                `Authentication required for ${st.name} (${toolName}). ` +
                  `Complete browser SSO if a window opened, then retry. ` +
                  `Hook output: ${auth.message}`
              );
            }
          }

          const result = await callServerTool(
            serverState,
            t.name,
            params as Record<string, unknown>,
            signal
          );

          const rawContent = (result.content as unknown[]).map((block: any) => {
            if (block?.type === "text") return { type: "text", text: String(block.text) };
            if (block?.type === "image")
              return {
                type: "image",
                source: { type: "base64", mediaType: block.mimeType, data: block.data },
              };
            return { type: "text", text: JSON.stringify(block) };
          });

          const content = maybeSpillContent(rawContent, st.name, t.name, ctx.ui.notify.bind(ctx.ui));

          return {
            content,
            details: { server: st.name, tool: t.name, isError: Boolean(result.isError) },
            isError: Boolean(result.isError),
          };
        },
      });
    }
  }

  pi.on("session_shutdown", async () => {
    for (const st of servers.values()) killServer(st);
    servers.clear();
    // Best-effort cleanup of spillover temp files from this session.
    for (const f of SPILLOVER_FILES) {
      try { fs.unlinkSync(f); } catch {}
    }
    SPILLOVER_FILES.length = 0;
  });
}

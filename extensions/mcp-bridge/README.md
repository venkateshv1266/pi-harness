# mcp-bridge

> Bridges Model Context Protocol (MCP) servers into pi as native tools — lazy-connect stdio and HTTP/SSE servers, `mcp__<server>__<tool>` tool naming, browser OAuth 2.0 PKCE, and pre-call auth hooks.

## What it does

MCP-only tools (Grafana, Redash, Snowflake, …) become first-class pi tools: a discovery tool `mcp__list` lists what is available, and each remote tool is registered as `mcp__<server>__<tool>`. Server child processes are spawned lazily on first use, not at session start, and are killed on session shutdown. A `/mcp` slash command shows per-server connection and auth status. Servers are read from `~/.pi/agent/mcp-servers.json` (or a legacy fallback config), so no tool-specific wiring is needed inside pi.

## Commands and tools

| Command / tool | What it does |
|---|---|
| `/mcp` | Lists all configured servers with type, url, connection state, auth status, and auth hook. |
| `/mcp <server>` | Lazily connects that server and registers its tools; reports the tool count. |
| `mcp__list` | Discovery tool. Returns JSON `{server: [toolName, …]}`. Without arguments it lists configured servers without connecting; with `{"server": "name"}` it connects that server and registers its tools. |
| `mcp__<server>__<tool>` | One registered pi tool per remote tool, created on first connect. |

## Configuration

Servers are declared in `~/.pi/agent/mcp-servers.json` as a flat object. If that file is absent, the bridge falls back to the top-level `mcpServers` key of `~/.claude.json` (legacy discovery; `/mcp` reports which source was used).

```jsonc
{
  // stdio server: command is spawned on first use
  "my-server": {
    "command": "npx",
    "args": ["-y", "some-mcp-server"],
    "env": { "SOME_VAR": "value" }
  },
  // remote server: HTTP (streamable) or SSE transport
  "my-remote": {
    "type": "http",            // or "sse"; optional — inferred from presence of "url"
    "url": "https://…/mcp",    // leading ~ is expanded
    "headers": { "Authorization": "Bearer …" },
    "oauth": {
      "clientId": "…",         // required to trigger the PKCE flow
      "clientSecret": "…",     // optional
      "authorizationUrl": "…", // optional; discovered via RFC 8414 if omitted
      "tokenUrl": "…",         // optional; discovered via RFC 8414 if omitted
      "callbackPort": 0,       // optional; 0 = ephemeral local port
      "callbackPath": "/",     // optional
      "scopes": ["…"]          // optional; falls back to discovery metadata
    }
  }
}
```

`type` must be `stdio`, `http`, or `sse`; anything else is skipped with a warning at session start. A server without `type` is treated as `http` if it has `url`, otherwise `stdio`. For stdio servers, `command`, `args` entries, and `url` all have a leading `~` expanded.

### Environment variables

| Env var | Default | Effect |
|---|---|---|
| `MCP_SERVERS_ROOT` | `~/mcp-servers` | Root directory for the per-server auth-hook scripts (see below). |
| `PI_MCP_MAX_INLINE_BYTES` | `65536` (64 KB) | Max combined text bytes of a tool result returned inline. Larger results spill to a temp file. Invalid or non-positive values fall back to the default. |
| `PI_MCP_PREVIEW_LINES` | `0` | Lines of output shown in a collapsed tool row in addition to the summary line (0 = summary only). Negative or non-numeric values fall back to 0. |

Additionally, the `/mcp` status probe reads `GRAFANA_COOKIE_FILE` / `REDASH_COOKIE_FILE` from a server's configured `env` to report cookie-file age without triggering SSO.

### State

| Path | Contents |
|---|---|
| `~/.pi/agent/mcp-oauth.json` | OAuth token store, one entry per server: access/refresh tokens, expiry, token URL, client id/secret, scopes. Written with mode 0600. |
| `<tmpdir>/pi-mcp-spillover/` | Spill files for oversized tool results (`<server>__<tool>__<timestamp>.txt`). Created lazily; files are deleted on session shutdown. |

## How it works

**Lazy connect.** Config is parsed at `session_start`, but nothing is spawned. A server connects on its first tool call, `/mcp <server>`, or `mcp__list` with a `server` argument: spawn (stdio) or HTTP connect, MCP initialize, `tools/list`, then register each tool. If a stdio child dies mid-session (e.g. a browser-driving server whose window was closed), the connection state is cleared and the next call respawns it; a failure during a call triggers one respawn-and-retry. For OAuth servers, a 401/unauthorized/expired error forces re-authentication (token refresh or a new browser login) and one retry.

**Transports.** stdio servers run via `StdioClientTransport` with a neutral cwd (the temp dir), so `npx`-based servers do not inherit the session project's package overrides. HTTP servers use `StreamableHTTPClientTransport` by default and `SSEClientTransport` when `type` is `"sse"`, sending configured `headers` plus an `Authorization: Bearer <token>` when an `oauth` block is present.

**Auth hooks.** Server names starting with `grafana-` or `redash-` get a pre-call hook run before every tool call: `$MCP_SERVERS_ROOT/grafana-mcp/check-grafana-cookies.sh` and `…/redash-mcp/check-redash-cookies.sh` respectively. The hook receives `{"tool_name": "mcp__<server>__<tool>"}` on stdin (mirroring a pre-tool-use hook contract), must exit 0 within 120 s, and a non-zero exit aborts the call with a message asking the user to complete browser SSO. A missing hook script also fails the call.

**OAuth 2.0 PKCE.** On first use, the bridge probes `<origin>/.well-known/oauth-authorization-server` (5 s timeout) for endpoints and scopes, falls back to config values, and opens the system browser (`open` / `xdg-open` / `cmd start`) against the authorize URL with an S256 PKCE challenge. A temporary localhost HTTP server on 127.0.0.1 receives the redirect (3-minute timeout) and shows a success/failure page. Tokens are stored in `~/.pi/agent/mcp-oauth.json`. A cached token is reused until within 60 s of expiry, then refreshed with its `refresh_token`; if refresh fails, the interactive login restarts. slack.com servers get Slack's OAuth endpoints and callback port 3118 by default.

**Result handling.** Tool output renders as a one-line summary (size and line count); the full payload is revealed on expand (`app.tools.expand`), with `PI_MCP_PREVIEW_LINES` extra lines visible while collapsed. Results whose combined text exceeds `PI_MCP_MAX_INLINE_BYTES` are written to the spill directory and replaced by a text block giving the file path, to be inspected with the `read` tool using offset/limit; image blocks are always preserved inline. If the spill write fails, the content is returned inline unchanged with a warning.

**Security model.**

- Child-process env inherits `process.env` minus any variable whose uppercase name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `PRIVATE_KEY`, `AUTH`, `SSH_AUTH_SOCK`, `AWS_SECRET`, or `STRIPE`; the server's configured `env` is then merged on top, so explicitly configured values still reach the child.
- Tool names must match `[a-zA-Z0-9_-]{1,128}`; invalid names from a compromised server are skipped.
- Tool descriptions are stripped of control characters and truncated to 1024 characters.
- At most 100 tools are registered per server.
- Input JSON Schemas are converted to typebox with a recursion depth limit of 32; `$ref`/`oneOf`/`anyOf`/`allOf` degrade to permissive unknown types, and a non-object top-level schema becomes an empty permissive object.

On `session_shutdown` all spawned children are killed and spill files are deleted.

## Caveats

- Tool registration happens on connect only; `mcp__list` without arguments does not connect anything — unconnected servers appear with empty tool lists and no `mcp__<server>__<tool>` tools exist yet. Call it with a `server` argument or use `/mcp <server>` first.
- A stdio server's stderr is buffered for `/mcp` diagnostics but never shown in the transcript, so a chatty server will not clutter the session.
- OAuth requires `clientId` in the `oauth` block; endpoints must be discoverable via RFC 8414 or given explicitly, or the login fails.
- Oversized results are not previewed inline at all (by design — single-line JSON blobs defeated head/tail previews); the agent must read the spill file.
- Spill files live in the OS temp directory and are removed on session shutdown; a killed session leaves them behind.

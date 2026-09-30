---
name: add-mcp-server
description: Add a new MCP server to pi (local stdio scripts or remote HTTP servers with OAuth/API keys like Slack, Linear, Grafana, Redash, Snowflake). Covers mcp.json, the pi mcp CLI, OAuth sign-in, exposure settings, cookie-gate auth-hook prefixes, and verification. Use when the user asks to add/configure/register a new MCP server in pi.
---

# Adding an MCP Server to pi

pi's built-in MCP support connects servers from `~/.pi/agent/mcp.json` (user-level) and `.pi/mcp.json` in a project (only in trusted projects; a project entry replaces a same-named user entry). Every tool is registered as `mcp__<server>__<tool>`.

## Quick start

1. Add an entry under `"mcpServers"` in `~/.pi/agent/mcp.json`, or run
   `pi mcp add my-new-server -- /path/to/launcher.sh` from a shell.
2. Validate: `pi mcp list` — it connects every enabled server and prints
   state, tools, and errors. Exits 1 while anything is wrong.
3. `/reload` (or start a new session) so the running session connects it.

## Config shape

```jsonc
{
  "mcpServers": {
    // stdio: command is one executable, args its arguments (not a shell string)
    "my-local-server": {
      "command": "/path/to/server-launcher.sh",
      "args": [],
      "env": { "API_URL": "https://example.internal" },
      "cwd": "optional-dir"
    },
    // remote: streamable HTTP (legacy SSE is rejected; most SSE servers also
    // serve streamable HTTP, often at /mcp instead of /sse)
    "my-remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" },
      "oauth": { "clientId": "…", "callbackPort": 8765 }
    }
  }
}
```

Per-entry extras: `type` (`stdio`, `http`, `streamable-http`; inferred from
`command`/`url`), `timeout` (seconds per request, default 60; progress
notifications reset it), `enabled: false`, `exposure`, `toolExposure`, and
`description` (shown in the `/mcp` manager). `env`/`headers` values may
reference environment variables (`${NAME}`) or run a command that prints the
whole value (`!command`, e.g. `"Authorization": "!echo Bearer $(gh auth token)"`).
Keep secrets out of the file.

## Exposure (important for skills)

The default is `codemode`: tools are callable from codemode scripts but are
**not declared to the model**, so direct `mcp__<server>__<tool>` calls fail.
Skills that call MCP tools directly need the server marked:

```json
"my-server": { "…": "…", "exposure": "direct" }
```

Other values: `deferred` (declared on demand via `tool_search`), `hidden`.
`toolExposure` overrides per tool using exact names or `*` patterns.

## OAuth sign-in

- `pi mcp login <server>` (or `/mcp login <server>` in-session) opens the
  browser and waits for approval. Tokens land in `~/.pi/agent/mcp-auth.json`
  and refresh automatically; `/mcp logout <server>` deletes them.
- Dynamic client registration is the default. For servers that need a
  pre-registered client: `oauth: { clientId, clientSecret, callbackPort,
  callbackUrl, scope, clientName }`. `callbackUrl` is sent exactly as written.

## Cookie-gate auth hooks (grafana-\*/redash-\*)

The `mcp-cookie-gate` extension runs a pre-call hook before every
`mcp__<grafana-*>` or `mcp__<redash-*>` tool call. The hook validates SSO
cookies and launches browser re-auth when they expired; a non-zero exit blocks
the call and surfaces the hook output. Hook scripts live under
`$MCP_SERVERS_ROOT` (default `~/mcp-servers`):

| Server name starts with | Hook script | Server env it reads |
|---|---|---|
| `grafana-` | `grafana-mcp/check-grafana-cookies.sh` | `GRAFANA_URL`, `GRAFANA_COOKIE_FILE` |
| `redash-` | `redash-mcp/check-redash-cookies.sh` | `REDASH_URL`, `REDASH_COOKIE_FILE` |

- Adding another Grafana/Redash instance: name it `<brand>-<env>` and put the
  URL + cookie file in the server's `env` — the hook applies automatically.
- Adding a new brand with its own `check-*-cookies.sh`: add one line to
  `AUTH_HOOKS` in `~/.pi/agent/extensions/mcp-cookie-gate.ts`, then `/reload`.

## Verification

1. `pi mcp list` exits 0.
2. In-session `/mcp` shows the server connected with its tool count.
3. For cookie-gated servers, trigger one tool call to exercise the hook.
4. Config edits need `/reload` — servers connect at session start, not lazily.
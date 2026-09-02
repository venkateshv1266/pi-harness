---
name: add-mcp-server
description: Add a new MCP server to pi (local stdio scripts or remote HTTP/SSE servers with OAuth/API keys like Slack, Linear, Grafana, Redash, Snowflake). Covers the config file, JSON shape, remote HTTP OAuth PKCE, auth-hook prefixes, cookie-file convention, lazy-connect model, and verification. Use when the user asks to add/configure/register a new MCP server in pi.
---

# Adding an MCP Server to pi

MCP servers are configured in **`~/.pi/agent/mcp-servers.json`** (a flat JSON object of server configs). The `mcp-bridge` extension at `~/.pi/agent/extensions/mcp-bridge/` reads this file at session start and lazily connects to each server on first use. No code change is needed for most servers.

## Quick start

1. Add an entry to `~/.pi/agent/mcp-servers.json`:

```json
{
  "my-new-server": {
    "type": "stdio",
    "command": "/path/to/server-launcher.sh",
    "args": [],
    "env": {
      "API_URL": "https://example.internal",
      "COOKIE_FILE": "~/.cookies/host.json"
    }
  }
}
```

2. `/reload` in pi. The startup notify should say `mcp-bridge: N servers configured from mcp-servers.json`.
3. Run `/mcp` to verify it appears, or `/mcp my-new-server` to lazily connect it and register its tools.
4. Or have the model call `mcp__list {server: "my-new-server"}` — this also triggers the lazy connect and registers tools as first-class pi tools named `mcp__my-new-server__<tool>`.

## Config shape

Each server entry supports both local `stdio` processes and remote `http` / `sse` endpoints:

### Local stdio server
```json
{
  "my-local-server": {
    "type": "stdio",
    "command": "/path/to/server-launcher.sh",
    "args": [],
    "env": {
      "API_URL": "https://example.internal"
    }
  }
}
```

### Remote HTTP / SSE server (with OAuth 2.0 PKCE, e.g. Slack)
```json
{
  "slack": {
    "type": "http",
    "url": "https://mcp.slack.com/mcp",
    "oauth": {
      "clientId": "<your-slack-app-client-id>",
      "callbackPort": 3118
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `type` | No (defaults to `stdio` if `command` provided, `http` if `url` provided) | `"stdio"`, `"http"`, or `"sse"`. |
| `command` | For `stdio` | Path to the launcher script/executable. `~` is expanded. |
| `args` | No | String array for `stdio`. `~` in each arg is expanded. |
| `url` | For `http`/`sse` | Remote MCP endpoint URL (e.g. `https://mcp.slack.com/mcp`). |
| `oauth` | No | OAuth configuration (`clientId`, `callbackPort`, `scopes`, etc.) for browser PKCE flow. |
| `headers` | No | Object of HTTP headers for `http`/`sse` servers. |
| `env` | No | Object of env vars for `stdio`. Merged on top of a **denylist-filtered** `process.env` (see Security below). |

## Auth: the name-prefix rule (important)

The extension auto-applies a pre-tool auth hook (cookie check + browser SSO refresh) **based on the server name prefix**:

| Server name starts with | Auth hook applied | Env var it reads |
|---|---|---|
| `grafana-` | `…/grafana-mcp/check-grafana-cookies.sh` | `GRAFANA_COOKIE_FILE` |
| `redash-` | `…/redash-mcp/check-redash-cookies.sh` | `REDASH_COOKIE_FILE` |
| anything else | **none** — the MCP server handles auth itself | — |

So:
- Adding another Grafana instance? Name it `grafana-<env>` and set `GRAFANA_COOKIE_FILE` in its env. The hook applies automatically — no code change.
- Adding another Redash instance? Same: `redash-<env>` + `REDASH_COOKIE_FILE`.
- Adding a **new brand** that has its own `check-*-cookies.sh`? You need one line in `~/.pi/agent/extensions/mcp-bridge/index.ts`:

```typescript
const AUTH_HOOKS: Record<string, AuthHook> = {
  "grafana-": { script: path.join(MCP_SERVERS_ROOT, "grafana-mcp", "check-grafana-cookies.sh") },
  "redash-":  { script: path.join(MCP_SERVERS_ROOT, "redash-mcp", "check-redash-cookies.sh") },
  "mybrand-": { script: path.join(MCP_SERVERS_ROOT, "mybrand-mcp", "check-mybrand-cookies.sh") }, // new
};
```

Then `/reload`. That's the only case requiring a code edit.

## Remote HTTP / SSE & OAuth servers

Remote HTTP and SSE servers connect directly over network without requiring a local subprocess or shell wrapper:

### 1. OAuth 2.0 PKCE (e.g. Slack, remote tools)
When `oauth` is specified, `mcp-bridge` uses native browser PKCE:
- It discovers authorization/token endpoints via `/.well-known/oauth-authorization-server` (or uses config).
- On first connection, opens the browser to authorize and listens on `callbackPort` (e.g. `3118`).
- Saves tokens securely to `~/.pi/agent/mcp-oauth.json` (mode `0o600`).
- Automatically handles token refresh and 401 retries in the background.

```json
"slack": {
  "type": "http",
  "url": "https://mcp.slack.com/mcp",
  "oauth": {
    "clientId": "<your-slack-app-client-id>",
    "callbackPort": 3118
  }
}
```

### 2. Static Header / Bearer Token
For services using a static API key or Bearer token:
```json
"my-remote-service": {
  "type": "http",
  "url": "https://mcp.example.com/mcp",
  "headers": {
    "Authorization": "Bearer <TOKEN>"
  }
}
```

### 3. Public / Unauthenticated
```json
"public-mcp": {
  "type": "http",
  "url": "https://mcp.public.org/mcp"
}
```

## Lazy-connect model

Servers are **not** spawned at session start. A server's child process is spawned on first use:
- First call to `mcp__list {server: "X"}` → spawn + MCP `initialize` + `tools/list` → register `mcp__X__<tool>` tools.
- First call to `/mcp X` → same.
- First call to an already-registered `mcp__X__<tool>` → spawn + auth hook (if any) + `tools/call`.

This keeps startup cheap — heavy servers (e.g. ones that spawn a container per
instance) only pay that cost when you actually use them.

## Cookie-file convention (grafana/redash)

The auth hook checks a cookie file on disk (path from `*_COOKIE_FILE` env var). `/mcp` reports its status without triggering SSO:

```
  grafana-prod
    auth: cookies present (file age 334.1h)
```

- `file age` small → recently refreshed, likely valid.
- `file age` large (days/weeks) → likely expired; first tool call will trigger the hook → browser SSO → refresh the file.
- `empty cookie file` / `no cookie file` → first call will open browser SSO.

Tokens survive pi restarts (they're files). The hook has a 300s cooldown after a failed auth attempt (baked into the scripts, not the extension).

## Security (what the extension already does)

- **Env denylist:** `*KEY/*TOKEN/*SECRET/*PASSWORD/*CREDENTIAL*/*AUTH*` are stripped from the child-process environment before the server sees it. `PATH`, `HOME`, `LANG`, `PYTHONPATH` survive. Set any auth the server needs explicitly in the server's `env` block (cookie-file paths, URLs) — don't rely on leakage from pi's process env.
- **Tool name validation:** server-provided tool names must match `^[a-zA-Z0-9_-]+$` or they're skipped (prevents prompt injection via tool names).
- **Description sanitization:** control chars stripped, truncated to 1024 chars.
- **Tool cap:** max 100 tools per server.
- **Schema depth limit:** nested JSON-Schema degrades to `Type.Any` after 32 levels.

## Verify after adding

1. `/reload`
2. `/mcp` — confirm the new server appears with the expected auth status.
3. `/mcp <new-server>` — connect it; should say `connected, N tools available`.
4. Ask the model to call one of the tools (e.g. "list data sources from <new-server>"). First call may open a browser for SSO (grafana/redash) or first-connect auth (snowflake-style).

## Common pitfalls

- **Forgot `/reload`** — the extension reads config at session start; edits to `mcp-servers.json` aren't picked up until you reload or restart.
- **Wrong name prefix for stdio hooks** — naming a grafana instance `gf-prod` instead of `grafana-prod` means no auth hook runs; the server will fail its first call with an auth error. Always use the `grafana-` / `redash-` prefix for those brands.
- **Missing `*_COOKIE_FILE` env** — the hook can't find cookies without it; `/mcp` will show `no cookie file configured`.
- **OAuth redirect URI mismatch** — ensure the server's registered callback URI matches `http://localhost:<callbackPort>/callback` (e.g. Slack uses port 3118).
- **Server needs an env var that matches the denylist** (e.g. a var literally containing "KEY") — set it explicitly in the server's `env` block; server-config env is applied after the denylist filter, so it always wins.

/**
 * pi MCP Bridge - OAuth 2.0 PKCE & Token Manager
 *
 * Provides native OAuth 2.0 PKCE browser authorization and token lifecycle
 * management (storage, expiration checking, auto-refresh) for remote MCP
 * servers (e.g. Slack, Linear) without depending on external tools or configs.
 *
 * Token storage: ~/.pi/agent/mcp-oauth.json (mode 0o600).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";

export interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackPath?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  userScope?: boolean; // If true (or Slack), use user_scope query param
}

export interface StoredOAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  serverUrl?: string;
  authorizationUrl?: string;
}

export interface OAuthStore {
  [serverName: string]: StoredOAuthToken;
}

export interface OAuthMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  scopes_supported?: string[];
  issuer?: string;
}

const PI_OAUTH_FILE = path.join(os.homedir(), ".pi", "agent", "mcp-oauth.json");

/** Load stored tokens from ~/.pi/agent/mcp-oauth.json */
export function loadOAuthStore(): OAuthStore {
  try {
    if (fs.existsSync(PI_OAUTH_FILE)) {
      const raw = fs.readFileSync(PI_OAUTH_FILE, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        return data as OAuthStore;
      }
    }
  } catch (err) {
    console.error("[mcp-bridge-oauth] Failed to read mcp-oauth.json:", err);
  }
  return {};
}

/** Save tokens to ~/.pi/agent/mcp-oauth.json with restricted permissions */
export function saveOAuthStore(store: OAuthStore): void {
  try {
    const dir = path.dirname(PI_OAUTH_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const json = JSON.stringify(store, null, 2);
    fs.writeFileSync(PI_OAUTH_FILE, json, { mode: 0o600 });
  } catch (err) {
    console.error("[mcp-bridge-oauth] Failed to write mcp-oauth.json:", err);
  }
}

/** Get human-readable OAuth status for /mcp command */
export function getOAuthStatus(
  serverName: string,
  _config: OAuthConfig
): { authenticated: boolean; details: string } {
  const store = loadOAuthStore();
  const token = store[serverName];
  if (!token || !token.accessToken) {
    return {
      authenticated: false,
      details: "needs login (browser PKCE flow on first call)",
    };
  }

  if (token.expiresAt) {
    const diffMs = token.expiresAt - Date.now();
    if (diffMs > 0) {
      const hrs = (diffMs / 3_600_000).toFixed(1);
      return {
        authenticated: true,
        details: `authenticated (token valid for ${hrs}h)`,
      };
    }
    if (token.refreshToken) {
      return {
        authenticated: true,
        details: "access token expired (will auto-refresh via refresh_token)",
      };
    }
    return {
      authenticated: false,
      details: "token expired and no refresh token available — needs login",
    };
  }

  return {
    authenticated: true,
    details: "authenticated (token present)",
  };
}

/** Discover OAuth authorization and token endpoints via RFC 8414 */
export async function discoverOAuthMetadata(serverUrl: string): Promise<OAuthMetadata | null> {
  try {
    const url = new URL(serverUrl);
    const wellKnownUrl = `${url.origin}/.well-known/oauth-authorization-server`;
    const res = await fetch(wellKnownUrl, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      return (await res.json()) as OAuthMetadata;
    }
  } catch {}
  return null;
}

/** Open URL in user's default browser */
function openInBrowser(url: string): void {
  const plat = process.platform;
  if (plat === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } else if (plat === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
  } else {
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

/** Refresh an existing OAuth token using its refresh_token */
export async function refreshOAuthToken(
  serverName: string,
  token: StoredOAuthToken
): Promise<string> {
  if (!token.refreshToken) {
    throw new Error(`Cannot refresh token for ${serverName}: no refresh_token stored`);
  }
  if (!token.tokenUrl) {
    throw new Error(`Cannot refresh token for ${serverName}: no tokenUrl stored`);
  }

  const params: Record<string, string> = {
    client_id: token.clientId,
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
  };
  if (token.clientSecret) {
    params.client_secret = token.clientSecret;
  }

  const body = new URLSearchParams(params);
  const res = await fetch(token.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Token refresh failed with HTTP ${res.status}: ${txt}`);
  }

  const data = (await res.json()) as any;
  if (data.ok === false || (data.error && !data.access_token)) {
    throw new Error(`Token refresh failed: ${data.error || JSON.stringify(data)}`);
  }

  const accessToken = data.access_token;
  if (!accessToken) {
    throw new Error(`Token refresh returned no access_token in response: ${JSON.stringify(data)}`);
  }

  const newRefreshToken = data.refresh_token || token.refreshToken;
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : undefined;

  const store = loadOAuthStore();
  store[serverName] = {
    ...token,
    accessToken,
    refreshToken: newRefreshToken,
    expiresAt,
  };
  saveOAuthStore(store);

  return accessToken;
}

/** Perform interactive browser-based OAuth 2.0 PKCE login */
export async function loginOAuthPKCE(
  serverName: string,
  serverUrl: string,
  oauthConfig: OAuthConfig,
  notify?: (msg: string, level: "info" | "warn" | "error") => void
): Promise<string> {
  // 1. Discover or determine metadata
  const meta = await discoverOAuthMetadata(serverUrl);
  const isSlack = serverUrl.includes("slack.com") || serverName.toLowerCase().includes("slack");

  const clientId = oauthConfig.clientId || "";
  if (!clientId) {
    throw new Error(
      `OAuth configuration for ${serverName} is missing "clientId". Please specify oauth.clientId in mcp-servers.json.`
    );
  }

  const authorizationUrl =
    oauthConfig.authorizationUrl ||
    meta?.authorization_endpoint ||
    (isSlack ? "https://slack.com/oauth/v2_user/authorize" : "");
  const tokenUrl =
    oauthConfig.tokenUrl ||
    meta?.token_endpoint ||
    (isSlack ? "https://slack.com/api/oauth.v2.user.access" : "");

  if (!authorizationUrl || !tokenUrl) {
    throw new Error(
      `Cannot determine OAuth endpoints for ${serverName}. Please specify authorizationUrl and tokenUrl in oauth config.`
    );
  }

  const port = oauthConfig.callbackPort || (isSlack ? 3118 : 0);
  const callbackPath = oauthConfig.callbackPath || (isSlack ? "/callback" : "/");

  // 2. Generate PKCE code verifier & challenge
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  // 3. Start local callback server
  let serverInstance: http.Server | null = null;
  let actualPort = port;

  const codePromise = new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", `http://localhost:${actualPort}`);
        const code = reqUrl.searchParams.get("code");
        const error = reqUrl.searchParams.get("error");
        const errorDesc = reqUrl.searchParams.get("error_description");

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (code) {
          res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>pi — Authorization Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px 48px; text-align: center; max-width: 440px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
    h2 { color: #58a6ff; margin-top: 0; }
    p { line-height: 1.5; color: #8b949e; }
    .status { color: #3fb950; font-size: 40px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status">✓</div>
    <h2>Connected to ${serverName}</h2>
    <p>Authorization was successful for <strong>pi</strong>.<br>You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>`);
          resolve({ code, redirectUri: `http://localhost:${actualPort}${callbackPath}` });
        } else {
          res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>pi — Authorization Failed</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px 48px; text-align: center; max-width: 440px; }
    h2 { color: #f85149; margin-top: 0; }
    p { line-height: 1.5; color: #8b949e; }
    .status { color: #f85149; font-size: 40px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status">✕</div>
    <h2>Authorization Failed</h2>
    <p>${error || "No authorization code returned"}: ${errorDesc || ""}</p>
  </div>
</body>
</html>`);
          reject(new Error(`OAuth authorization rejected: ${error} ${errorDesc || ""}`));
        }
      } catch (e) {
        reject(e);
      } finally {
        setTimeout(() => {
          try { srv.close(); } catch {}
        }, 1000);
      }
    });

    serverInstance = srv;
    srv.listen(port, "127.0.0.1", () => {
      const addr = srv.address();
      actualPort = typeof addr === "object" && addr ? addr.port : port;
    });
    srv.on("error", (err) => reject(err));
  });

  // Wait briefly for server to bind
  await new Promise((r) => setTimeout(r, 100));

  const redirectUri = `http://localhost:${actualPort}${callbackPath}`;

  // 4. Build authorize URL
  const authUrl = new URL(authorizationUrl);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const scopes = oauthConfig.scopes || meta?.scopes_supported || [];
  if (scopes.length > 0) {
    authUrl.searchParams.set("scope", scopes.join(","));
  }

  notify?.(`Opening browser for ${serverName} OAuth authorization…`, "info");
  openInBrowser(authUrl.toString());

  // Timeout after 3 minutes if user abandons
  const timer = setTimeout(() => {
    try { serverInstance?.close(); } catch {}
  }, 180_000);

  let codeResult: { code: string; redirectUri: string };
  try {
    codeResult = await codePromise;
  } finally {
    clearTimeout(timer);
    try { serverInstance?.close(); } catch {}
  }

  // 5. Exchange code for access token
  notify?.(`Exchanging authorization code with ${serverName}…`, "info");
  const exchangeParams: Record<string, string> = {
    client_id: clientId,
    grant_type: "authorization_code",
    code: codeResult.code,
    redirect_uri: codeResult.redirectUri,
    code_verifier: codeVerifier,
  };
  if (oauthConfig.clientSecret) {
    exchangeParams.client_secret = oauthConfig.clientSecret;
  }

  const exchangeBody = new URLSearchParams(exchangeParams);
  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: exchangeBody.toString(),
  });

  if (!tokenRes.ok) {
    const txt = await tokenRes.text().catch(() => "");
    throw new Error(`OAuth code exchange failed with HTTP ${tokenRes.status}: ${txt}`);
  }

  const tokenData = (await tokenRes.json()) as any;
  if (tokenData.ok === false || (tokenData.error && !tokenData.access_token)) {
    throw new Error(`OAuth token exchange failed: ${tokenData.error || JSON.stringify(tokenData)}`);
  }

  const accessToken = tokenData.access_token;
  if (!accessToken) {
    throw new Error(`OAuth response contained no access_token: ${JSON.stringify(tokenData)}`);
  }

  const refreshToken = tokenData.refresh_token;
  const expiresIn = typeof tokenData.expires_in === "number" ? tokenData.expires_in : undefined;
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : undefined;

  const store = loadOAuthStore();
  store[serverName] = {
    accessToken,
    refreshToken,
    expiresAt,
    tokenUrl,
    clientId,
    clientSecret: oauthConfig.clientSecret,
    scopes,
    serverUrl,
    authorizationUrl,
  };
  saveOAuthStore(store);

  notify?.(`Successfully connected to ${serverName}!`, "info");
  return accessToken;
}

/**
 * Get a valid access token for the server, automatically refreshing or
 * prompting for interactive PKCE login if necessary.
 */
export async function getValidAccessToken(
  serverName: string,
  serverUrl: string,
  oauthConfig: OAuthConfig,
  notify?: (msg: string, level: "info" | "warn" | "error") => void,
  forceRefresh = false
): Promise<string> {
  const store = loadOAuthStore();
  const stored = store[serverName];

  if (stored && stored.accessToken) {
    // If not forcing refresh and token is valid for > 60 seconds, use it
    const isValid = stored.expiresAt ? stored.expiresAt - Date.now() > 60_000 : true;
    if (isValid && !forceRefresh) {
      return stored.accessToken;
    }

    // Token is expired or expiring soon; attempt auto-refresh
    if (stored.refreshToken && stored.tokenUrl) {
      try {
        notify?.(`Refreshing OAuth token for ${serverName}…`, "info");
        return await refreshOAuthToken(serverName, stored);
      } catch (err) {
        console.warn(`[mcp-bridge-oauth] Token refresh failed for ${serverName}:`, err);
        notify?.(`Token refresh failed for ${serverName}; starting new login…`, "warn");
      }
    }
  }

  // No valid token or refresh failed — launch browser PKCE login
  return await loginOAuthPKCE(serverName, serverUrl, oauthConfig, notify);
}

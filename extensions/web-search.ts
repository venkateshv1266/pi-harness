/**
 * Web Search extension for pi.
 *
 * Registers two LLM-callable tools:
 *   - `web_search` : search the web and return titles + URLs + snippets
 *   - `web_fetch`  : fetch a URL and return its content as clean markdown
 *
 * Backends (auto-selected, no key required for the defaults):
 *   - Search: Tavily API if TAVILY_API_KEY is set, Brave Search API if
 *     BRAVE_SEARCH_API_KEY is set, otherwise DuckDuckGo HTML scraping (free,
 *     no key).
 *   - Fetch : Jina Reader (https://r.jina.ai/) — free, no key, returns
 *     markdown. Falls back to a raw fetch + text extraction if Jina fails.
 *
 * Place this file in ~/.pi/agent/extensions/ for auto-discovery and hot-reload
 * via /reload.
 */

import {
  type ExtensionAPI,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** Number of output lines shown in the collapsed (default) tool view. */
const PREVIEW_LINES = 5;

/**
 * Width-aware, cached collapsed preview component for text tool results.
 * Mirrors the built-in bash tool's renderResult behavior: a one-line summary
 * plus a short preview, with the full output revealed only when the user
 * expands the row (ctrl+o / app.tools.expand).
 */
interface TextResultState {
  cachedWidth: number | undefined;
  cachedLines: string[] | undefined;
  cachedSkipped: number | undefined;
}

class TextResultComponent extends Container {
  state: TextResultState = {
    cachedWidth: undefined,
    cachedLines: undefined,
    cachedSkipped: undefined,
  };
}

function buildTextResult(
  component: TextResultComponent,
  output: string,
  summary: string,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
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

  // Collapsed: show the first PREVIEW_LINES lines (top of search/fetched
  // content is the most useful), then a hint to expand for the rest.
  component.addChild({
    render: (width: number) => {
      if (state.cachedLines === undefined || state.cachedWidth !== width) {
        const total = styledLines.length;
        state.cachedLines = styledLines
          .slice(0, PREVIEW_LINES)
          .map((l) => truncateToWidth(l, width, "..."));
        state.cachedSkipped = Math.max(total - PREVIEW_LINES, 0);
        state.cachedWidth = width;
      }
      const lines = ["", ...(state.cachedLines ?? [])];
      if (state.cachedSkipped && state.cachedSkipped > 0) {
        const hint =
          theme.fg("muted", `... (${state.cachedSkipped} more lines,`) +
          ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
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

/** Extract the text payload from a tool result. */
function resultText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const content = result.content[0];
  return content?.type === "text" && content.text ? content.text : "";
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Tiny fetch wrapper with timeout + abort support. */
async function fetchText(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {},
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

/* --------------------------- Search backends --------------------------- */

/** DuckDuckGo HTML scraping — free, no API key. */
async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { status, text } = await fetchText(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
      body: `q=${encodeURIComponent(query)}`,
    },
    signal,
  );
  if (status !== 200) {
    throw new Error(`DuckDuckGo returned HTTP ${status}`);
  }

  const results: SearchResult[] = [];
  // Each result block has a result__a (title+link) and a result__snippet.
  const linkRe =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe =
    /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const links: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(text)) !== null) {
    const rawHref = m[1];
    const titleHtml = m[2];
    const uddg = decodeUddg(rawHref);
    if (!uddg) continue;
    links.push({ url: uddg, title: stripTags(titleHtml).trim() });
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(text)) !== null) {
    snippets.push(stripTags(m[1]).trim());
  }

  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    results.push({
      title: links[i].title || links[i].url,
      url: links[i].url,
      snippet: snippets[i] ?? "",
    });
  }
  return results;
}

/** Extract the real URL from a DuckDuckGo redirect link (uddg query param). */
function decodeUddg(href: string): string | undefined {
  try {
    const u = new URL(href, "https://duckduckgo.com/");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    // Some results are direct links (sponsored, etc.) — keep as-is if absolute.
    if (u.protocol.startsWith("http")) return u.href;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Tavily Search API — requires TAVILY_API_KEY. */
async function searchTavily(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY not set");
  const { status, text } = await fetchText(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: maxResults,
        include_answer: false,
      }),
    },
    signal,
  );
  if (status !== 200) {
    throw new Error(`Tavily returned HTTP ${status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (json.results ?? []).map((r) => ({
    title: r.title ?? r.url ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

/** Brave Search API — requires BRAVE_SEARCH_API_KEY. */
async function searchBrave(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) throw new Error("BRAVE_SEARCH_API_KEY not set");
  const { status, text } = await fetchText(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
      query,
    )}&count=${maxResults}`,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": key,
      },
    },
    signal,
  );
  if (status !== 200) {
    throw new Error(`Brave returned HTTP ${status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
      }>;
    };
  };
  return (json.web?.results ?? []).map((r) => ({
    title: r.title ?? r.url ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));
}

/** Pick the best available search backend. */
async function search(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<{ backend: string; results: SearchResult[] }> {
  const tavily = process.env.TAVILY_API_KEY;
  const brave = process.env.BRAVE_SEARCH_API_KEY;
  if (tavily) {
    return { backend: "tavily", results: await searchTavily(query, maxResults, signal) };
  }
  if (brave) {
    return { backend: "brave", results: await searchBrave(query, maxResults, signal) };
  }
  return {
    backend: "duckduckgo",
    results: await searchDuckDuckGo(query, maxResults, signal),
  };
}

/* ---------------------------- Fetch backend ---------------------------- */

/** Fetch a URL as clean markdown via Jina Reader (free, no key). */
async function fetchAsMarkdown(
  targetUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const jinaUrl = `https://r.jina.ai/${targetUrl}`;
  const { status, text } = await fetchText(
    jinaUrl,
    {
      headers: {
        Accept: "text/markdown",
        "User-Agent": "pi-web-search-extension/1.0",
      },
      timeoutMs: 30_000,
    },
    signal,
  );
  if (status === 200 && text.trim().length > 0) {
    return text;
  }
  // Fallback: raw fetch + naive text extraction.
  const raw = await fetchText(targetUrl, { timeoutMs: 20_000 }, signal);
  if (raw.status >= 400) {
    throw new Error(`Fetch failed: HTTP ${raw.status}`);
  }
  return stripTags(raw.text).slice(0, 20_000);
}

/* ------------------------------ Utilities ------------------------------ */

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatSearchResults(results: SearchResult[], backend: string): string {
  if (results.length === 0) {
    return `No results (backend: ${backend}).`;
  }
  const lines = results.map((r, i) =>
    [
      `${i + 1}. ${r.title}`,
      `   ${r.url}`,
      r.snippet ? `   ${r.snippet}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return `Results (backend: ${backend}):\n\n${lines.join("\n\n")}`;
}

/* ------------------------------ Extension ------------------------------ */

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const backend = process.env.TAVILY_API_KEY
      ? "tavily"
      : process.env.BRAVE_SEARCH_API_KEY
        ? "brave"
        : "duckduckgo";
    ctx.ui.notify(`Web search loaded (backend: ${backend})`, "info");
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web and return ranked results (title, URL, snippet). " +
      "Use for current information, documentation, error messages, library " +
      "usage, or anything not already in the codebase. Returns up to N results.",
    promptSnippet: "Search the web for current info or docs.",
    promptGuidelines: [
      "Use web_search when you need current information, public docs, error " +
        "messages, or library/API usage that is not in the local codebase.",
      "Prefer web_search over guessing facts, versions, or API signatures " +
        "that may have changed.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      max_results: Type.Optional(
        Type.Number({
          description: "Max results to return (default 5, max 10).",
          minimum: 1,
          maximum: 10,
        }),
      ),
    }),
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("web_search"));
      const q = String(args?.query ?? "");
      if (q) text += " " + theme.fg("accent", q);
      return new Text(text, 0, 0);
    },
    renderResult(result, options, theme, context) {
      const component =
        (context.lastComponent as TextResultComponent | undefined) ??
        new TextResultComponent();
      const details = result.details as
        | { backend?: string; count?: number; query?: string }
        | undefined;
      const count = details?.count ?? 0;
      const isError = (result as { isError?: boolean }).isError;
      const summary = isError
        ? "search failed"
        : `${count} result${count === 1 ? "" : "s"}${details?.backend ? ` (${details.backend})` : ""}`;
      buildTextResult(component, resultText(result), summary, options, theme);
      component.invalidate();
      return component;
    },
    async execute(_toolCallId, params, signal) {
      const query = params.query.trim();
      const max = Math.min(Math.max(params.max_results ?? 5, 1), 10);
      if (!query) {
        return {
          content: [{ type: "text", text: "Error: empty query." }],
          isError: true,
        };
      }
      try {
        const { backend, results } = await search(query, max, signal);
        return {
          content: [{ type: "text", text: formatSearchResults(results, backend) }],
          details: { backend, count: results.length, query },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Web search failed: ${msg}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a single URL and return its content as clean markdown. " +
      "Use after web_search to read a specific result page, or to load any " +
      "public doc/article directly.",
    promptSnippet: "Fetch a URL as readable markdown.",
    promptGuidelines: [
      "Use web_fetch to read the full content of a URL found via web_search " +
        "or supplied by the user.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The absolute URL to fetch." }),
    }),
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("web_fetch"));
      const u = String(args?.url ?? "");
      if (u) text += " " + theme.fg("accent", u);
      return new Text(text, 0, 0);
    },
    renderResult(result, options, theme, context) {
      const component =
        (context.lastComponent as TextResultComponent | undefined) ??
        new TextResultComponent();
      const details = result.details as
        | { url?: string; length?: number }
        | undefined;
      const len = details?.length ?? 0;
      const isError = (result as { isError?: boolean }).isError;
      const summary = isError
        ? "fetch failed"
        : `fetched ${len.toLocaleString()} chars`;
      buildTextResult(component, resultText(result), summary, options, theme);
      component.invalidate();
      return component;
    },
    async execute(_toolCallId, params, signal) {
      const url = params.url.trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        return {
          content: [
            { type: "text", text: "Error: provide an absolute http(s) URL." },
          ],
          isError: true,
        };
      }
      try {
        const markdown = await fetchAsMarkdown(url, signal);
        const truncated = markdown.slice(0, 20_000);
        const note =
          markdown.length > 20_000 ? "\n\n[truncated at 20k chars]" : "";
        return {
          content: [
            { type: "text", text: `Fetched ${url}:\n\n${truncated}${note}` },
          ],
          details: { url, length: markdown.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Web fetch failed: ${msg}` }],
          isError: true,
        };
      }
    },
  });
}

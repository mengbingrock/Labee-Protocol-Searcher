// A dependency-free MCP server over the stdio transport.
//
// MCP's stdio transport is newline-delimited JSON-RPC 2.0: one message per
// line on stdin, one response per line on stdout, and absolutely nothing else
// on stdout (logs go to stderr). We implement just the methods a tool-only
// server needs: initialize, tools/list, tools/call, ping. See
// https://modelcontextprotocol.io/specification for the wire format.

import { readFileSync } from "node:fs";
import { search, renderSearch } from "./search.ts";
import { VENDORS, VENDOR_IDS, type Fetchability } from "./vendors.ts";
import { providerStatus } from "./providers/registry.ts";
import { journalProviderOrder } from "./journals.ts";
import { deepSearchService } from "./agent/service.ts";
import type { DeepSearchInput } from "./agent/types.ts";
import { looksLikeEnzymeQuery } from "./rebase.ts";
import {
  browserHosts,
  fetchResourceWithBrowser,
  fetchResourcesWithBrowser,
} from "./agent/browser-fetch.ts";
import { browserAdapterForMode, defaultBrowser } from "./agent/default-browser.ts";
import {
  commitHostBrowserSearch,
  fetchHostBrowserCapture,
  prepareHostBrowserSearch,
  type HostBrowserCaptureInput,
} from "./agent/host-browser.ts";

/** Every searchable source id: the vendors/journals plus the REBASE database. */
const SOURCE_IDS = [...VENDOR_IDS, "rebase"] as const;

// Versions we speak. The spec requires echoing the client's requested version
// when we support it, else replying with our latest (the client then decides).
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"];
// Read from package.json rather than hardcoded, so the version a client sees in
// `initialize` can't drift from the published one. Both src/mcp.ts and the
// bundled dist/index.mjs sit one directory below the package root.
function packageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof version === "string" && version) return version;
  } catch {
    // Unreadable/moved package.json must not stop the server from serving tools.
  }
  return "0.0.0";
}

const SERVER_INFO = { name: "labee-protocol-searcher", version: packageVersion() };
const SERVER_INSTRUCTIONS =
  "Prefer Codex's integrated Browser for browser tasks. It keeps browsing inside Codex, uses a " +
  "separate profile, and provides a shared view; it is especially suitable for public websites, " +
  "research, and localhost testing. For NEB searches, call search with browser=host. Open the returned " +
  "hostBrowserTask.searchUrl in the integrated Browser, read its rendered results, open selected " +
  "NEB result pages in that same Browser profile, then call neb_search_commit with the captureId and " +
  "captured HTML or visible text. A later fetch of a committed id returns the cached capture without " +
  "reopening NEB. Do not substitute generic web-search results or silently switch to system Chrome, " +
  "browser=default, or CDP. Use those fallbacks only when the integrated Browser is unavailable and " +
  "the user explicitly authorizes one.";
/** Search-to-fetch browser handoff for the lifetime of one local MCP process. */
const sameProfileBrowserById = new Map<string, "cdp" | "default">();

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const TOOLS = [
  {
    name: "search",
    title: "Search protocols, reagents & enzymes",
    // Read-only, queries the open web, results vary over time → not idempotent.
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
    description:
      "Search laboratory-protocol, reagent, and restriction-enzyme sources for a technique, kit, " +
      "reagent, product, enzyme, or recognition site. Journals (STAR Protocols, Nature Protocols, " +
      "JoVE, Bio-protocol, Current Protocols, protocols.io) are searched via scholarly APIs " +
      "(Crossref/Europe PMC); vendors (Thermo Fisher, QIAGEN, NEB, Bio-Rad, Sigma-Aldrich, EMD " +
      "Millipore, Takara Bio, Promega, IDT) via web search; and restriction enzymes via REBASE (NEB's " +
      "open database — auto-included for enzyme-shaped queries like 'EcoRI' or 'GAATTC'). Returns a " +
      "ranked list of results, each with a stable `id`, a `source`, and a `fetchable` grade — " +
      "fresh exact DOI observations from the daily CI index win, current OA metadata is next, and " +
      "the source grade is the fallback prior. Call `fetch` with a result's id to read its " +
      "content; vendor pages included. Prefer Codex's integrated Browser for browser tasks because it " +
      "uses a separate profile and provides a shared view. For NEB, pass `browser: host` so both the " +
      "rendered search and selected result pages use the integrated Browser; commit " +
      "those captures with `neb_search_commit`, and a following `fetch` returns the same captured HTML. " +
      "Do not silently switch to system Chrome. Use `browser: default` or `cdp` only when the integrated " +
      "Browser is unavailable and the user explicitly authorizes that fallback.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to search for, e.g. 'RNA extraction from FFPE', 'Gibson assembly', 'BsaI', 'GAATTC'.",
        },
        sources: {
          type: "array",
          items: { type: "string", enum: SOURCE_IDS },
          description:
            "Optional subset of source ids to search. Omit to search all (REBASE is auto-included " +
            `for enzyme queries). Valid ids: ${SOURCE_IDS.join(", ")}.`,
        },
        limit: {
          type: "number",
          description: "Max results per source (1-10, default 5).",
        },
        browser: {
          type: "string",
          enum: ["off", "cdp", "default", "host"],
          description:
            "Optional NEB browser route. Prefer `host`: it delegates both NEB search and result capture " +
            "to Codex's integrated Browser via neb_search_commit. `default` uses system Chrome and must " +
            "only be selected as an explicitly authorized fallback.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "neb_search_commit",
    title: "Commit rendered NEB browser search results",
    annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: false },
    description:
      "Complete a host-browser NEB search prepared by `search(browser: host)`. Submit only results " +
      "rendered by the NEB search page, after opening each selected result in the same Codex integrated-Browser " +
      "profile. Labee caches exact HTML when supplied, otherwise rendered visible text; later `fetch` " +
      "calls return that cached capture without another NEB navigation.",
    inputSchema: {
      type: "object",
      properties: {
        captureId: { type: "string", description: "Opaque capture id returned by search(browser: host)." },
        results: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string", description: "NEB result URL from the rendered search page." },
              finalUrl: { type: "string", description: "Final NEB URL after browser redirects." },
              snippet: { type: "string" },
              html: { type: "string", description: "Exact rendered main/article HTML when available." },
              text: { type: "string", description: "Rendered visible text fallback." },
            },
            required: ["title", "url"],
          },
        },
      },
      required: ["captureId", "results"],
    },
  },
  {
    name: "fetch",
    title: "Fetch a result's content by id",
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
    description:
      "Retrieve the content of one or more `search` results by id. `rebase:<enzyme>` returns the " +
      "structured restriction-enzyme record (recognition site, cut position, isoschizomers, " +
      "methylation sensitivity, and which vendors incl. NEB supply it — from REBASE, so no neb.com " +
      "scraping). `doi:` / `pmid:` / `pmcid:` returns open-access article full text (Europe PMC, then " +
      "NCBI for PMC author manuscripts, then Unpaywall; the abstract if the article is paywalled), " +
      "rendered section-by-section — pass `section` to read just one (e.g. 'Methods'). A " +
      "`url:` page is fetched and its readable text extracted; most vendors work, but a few (notably " +
      "neb.com, sigmaaldrich.com, emdmillipore.com) refuse automated requests and return their link " +
      "instead — `search` grades each result so you know which to expect. " +
      "After a host-browser NEB search is committed, fetch returns the exact HTML or rendered text captured " +
      "by that same integrated Browser profile without reopening NEB. Default-profile searches likewise reuse " +
      "their captured HTML. Pass " +
      "`ids` to fetch a batch in one call (each returns its own row). Bare DOIs, PMIDs, PMCIDs, and " +
      "enzyme names also work. Every result ends with a `_status: …_` line (ok, entitled-full-text, " +
      "display-only-full-text, display-only-link, abstract-only, no-open-fulltext, oa-link, " +
      "not-fetchable, not-found, bad-id).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "A single result id (`rebase:…`, `doi:…`, `pmid:…`, `pmcid:…`, `url:…`) or a bare " +
            "DOI / PMID / PMCID / enzyme name.",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Several ids to fetch at once (alternative to `id`).",
        },
        section: {
          type: "string",
          description:
            "For article full text only: a case-insensitive section-title substring (e.g. " +
            "'Methods', 'Protocol') to return just that section instead of the whole article.",
        },
        browser: {
          type: "string",
          enum: ["off", "cdp", "default", "host"],
          description:
            "Optional browser recovery. `host` reads a capture committed from Codex's integrated Browser; `default` " +
            "uses normal Chrome; `cdp` connects to PROTOCOLS_BROWSER_CDP_URL; `off` uses native retrieval.",
        },
      },
    },
  },
  {
    name: "browser_launch",
    title: "Open Labee's fallback system-Chrome window",
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    description:
      "Fallback only: open or reconnect to one Labee-owned window in the user's normal Chrome profile. " +
      "Prefer Codex's integrated Browser; call this tool only when it is unavailable and the user explicitly " +
      "authorizes system Chrome. Existing windows and tabs are never inspected or closed. Chrome must allow " +
      "JavaScript from Apple Events.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_status",
    title: "Get Labee browser status",
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    description: "Report whether Labee's dedicated default-profile window is ready or needs permission/verification.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_close",
    title: "Close Labee's Chrome window",
    annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true },
    description: "Close only the dedicated Chrome window created by Labee; existing user windows remain open.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "deep_search_start",
    title: "Start a durable exhaustive research job",
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
    description:
      "Start a durable deep-search job. It searches exactly five distinct keyword variants, runs every " +
      "configured scholarly backend and every available web backend, native-fetches every returned result, " +
      "then tries deterministic OA and optional browser recovery. Use `default` for one dedicated window in " +
      "the normal Chrome profile, `cdp`/`auto` for an existing local CDP endpoint, or `off`. Returns a job id immediately.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        keywords: { type: "array", minItems: 5, maxItems: 5, items: { type: "string" } },
        sources: { type: "array", items: { type: "string", enum: SOURCE_IDS } },
        limit: { type: "number", minimum: 1, maximum: 10 },
        maxRounds: { type: "number", minimum: 1, maximum: 15 },
        maxSeconds: { type: "number", minimum: 30, maximum: 1800 },
        maxBrowserPages: { type: "number", minimum: 0, maximum: 20 },
        maxBrowserSearchPages: { type: "number", minimum: 0, maximum: 50 },
        browser: { type: "string", enum: ["auto", "off", "cdp", "default"] },
      },
      required: ["query"],
    },
  },
  {
    name: "deep_search_get",
    title: "Get deep-search status and results",
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    description: "Read a durable deep-search job. Content bodies are omitted by default to keep the response bounded.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        includeContent: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "deep_search_cancel",
    title: "Cancel a deep-search job",
    annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true },
    description: "Request cooperative cancellation of a queued or running deep-search job.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_sources",
    title: "List searchable sources",
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    description:
      "List the sources `search` can query — journals, reagent vendors, and the REBASE restriction- " +
      "enzyme database — with their ids, kind, and whether their results are fetchable.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

function toolText(text: string, isError = false): unknown {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "list_sources") {
    // Read the grade off the source rather than inferring it from `kind` — some
    // vendor pages extract fine and some journals are paywalled, so `kind` was
    // never a reliable proxy for what `fetch` will do.
    const FETCH_NOTE: Record<Fetchability, string> = {
      full: "fetchable",
      partial: "sometimes fetchable — may return a link instead",
      none: "links-only — site refuses automated requests",
    };
    const lines = VENDORS.map(
      (v) => `- ${v.id} [${v.kind}]: ${v.name} — ${v.blurb} (${FETCH_NOTE[v.fetchability]})`,
    );
    lines.unshift(
      "- rebase [database]: REBASE — restriction-enzyme facts (recognition site, cut, methylation, " +
        "suppliers incl. NEB) (fetchable)",
    );
    const providers = providerStatus()
      .map((p) => `${p.id}${p.available ? "" : " (not configured)"}`)
      .join(", ");
    return toolText(
      [
        "Sources (call `search`, then `fetch` a result's id):",
        ...lines,
        "",
        `Web-search providers (vendors): ${providers}.`,
        `Journal providers (chain): ${journalProviderOrder().join(" → ")}.`,
        "Set BRAVE_API_KEY or GOOGLE_API_KEY+GOOGLE_CSE_CX for rate-limit-free vendor search; " +
          "set PROTOCOLS_CONTACT_EMAIL to enable the Unpaywall open-access full-text fallback.",
      ].join("\n"),
    );
  }
  if (name === "search") {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query.trim()) return toolText("Error: `query` is required.", true);
    const sources = Array.isArray(args.sources)
      ? args.sources.filter((x): x is string => typeof x === "string")
      : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const browserMode = ["off", "cdp", "default", "host"].includes(String(args.browser))
      ? (args.browser as "off" | "cdp" | "default" | "host")
      : undefined;
    const wantsNeb = sources
      ? sources.some((source) => source.trim().toLowerCase() === "neb")
      : true;
    if (browserMode === "host" && wantsNeb) {
      const nonNebSources = sources
        ? sources.filter((source) => source.trim().toLowerCase() !== "neb")
        : [
            ...VENDOR_IDS.filter((source) => source !== "neb"),
            ...(looksLikeEnzymeQuery(query) ? ["rebase"] : []),
          ];
      const base = nonNebSources.length > 0
        ? await search(query, {
            sources: nonNebSources,
            ...(limit !== undefined ? { limit } : {}),
          })
        : { query: query.trim(), results: [], sources: [], unknownSources: [], partial: false };
      const task = prepareHostBrowserSearch(query, limit ?? 5, base);
      return toolText([
        ...(base.sources.length > 0 ? [renderSearch(base), ""] : []),
        "_status: host-browser-required_",
        "",
        "hostBrowserTask:",
        JSON.stringify(task, null, 2),
      ].join("\n"));
    }
    const resp = await search(query, {
      ...(sources ? { sources } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const browser = browserAdapterForMode(browserMode === "host" ? undefined : browserMode);
    const captures: string[] = [];
    if (browser) {
      for (const result of resp.results.filter((item) => item.source === "neb" && item.url)) {
        const url = new URL(result.url!);
        const hit = await browser.retrieve({
          url: url.toString(),
          sourceId: "neb",
          allowedHosts: browserHosts(url),
          maxChars: 80_000,
          timeoutMs: 12_000,
          interactionTimeoutMs: 5_000,
        });
        if (browserMode === "cdp" || browserMode === "default") {
          // Even a pending verification belongs to this profile. A following
          // fetch can retry after the user completes the visible check.
          sameProfileBrowserById.set(result.id, browserMode);
        }
        if (hit.status === "ok") {
          captures.push(`- ${result.id}: rendered HTML cached for same-profile fetch`);
        } else {
          captures.push(`- ${result.id}: browser capture ${hit.status}${hit.detail ? ` (${hit.detail})` : ""}`);
          if (hit.status === "interaction-required") break;
        }
      }
    }
    return toolText([
      renderSearch(resp),
      ...(captures.length > 0 ? ["", "Same-profile NEB browser capture:", ...captures] : []),
    ].join("\n"));
  }
  if (name === "neb_search_commit") {
    const captureId = typeof args.captureId === "string" ? args.captureId : "";
    const results = Array.isArray(args.results)
      ? args.results.filter((item): item is HostBrowserCaptureInput => Boolean(item) && typeof item === "object")
      : [];
    if (!captureId) return toolText("Error: `captureId` is required.", true);
    const committed = commitHostBrowserSearch(captureId, results);
    return toolText([
      renderSearch(committed.response),
      "",
      "Host-browser NEB captures cached:",
      ...committed.capturedIds.map((id) => `- ${id}: ${committed.formats[id]}`),
    ].join("\n"));
  }
  if (name === "fetch") {
    const section = typeof args.section === "string" ? args.section : undefined;
    const opts = section ? { section } : {};
    const requestedBrowserMode = ["off", "cdp", "default", "host"].includes(String(args.browser))
      ? (args.browser as "off" | "cdp" | "default" | "host")
      : undefined;
    const list = Array.isArray(args.ids)
      ? args.ids.filter((x): x is string => typeof x === "string" && x.trim() !== "")
      : [];
    const single = typeof args.id === "string" && args.id.trim() ? args.id : "";
    if (single) list.unshift(single);
    if (list.length === 0) return toolText("Error: `id` (or `ids`) is required.", true);
    const inheritedBrowserMode = list
      .map((id) => sameProfileBrowserById.get(id))
      .find((mode): mode is "cdp" | "default" => Boolean(mode));
    const browserMode = requestedBrowserMode === "off"
      ? "off"
      : requestedBrowserMode ?? inheritedBrowserMode;
    const browser = browserAdapterForMode(browserMode === "host" ? undefined : browserMode);
    if (list.length === 1) {
      const captured = fetchHostBrowserCapture(list[0]!);
      return toolText(captured ?? await fetchResourceWithBrowser(list[0]!, opts, browser));
    }
    const capturedRows = list.map((id) => ({ id, text: fetchHostBrowserCapture(id) }));
    const rows = capturedRows.every((row) => row.text === undefined)
      ? await fetchResourcesWithBrowser(list, opts, browser)
      : await Promise.all(capturedRows.map(async (row) => ({
          id: row.id,
          text: row.text ?? await fetchResourceWithBrowser(row.id, opts, browser),
        })));
    return toolText(rows.map((r) => `# ${r.id}\n\n${r.text}`).join("\n\n---\n\n"));
  }
  if (name === "browser_launch") {
    return toolText(JSON.stringify(await defaultBrowser().launch(), null, 2));
  }
  if (name === "browser_status") {
    return toolText(JSON.stringify(defaultBrowser().status(), null, 2));
  }
  if (name === "browser_close") {
    const browser = defaultBrowser();
    await browser.close();
    sameProfileBrowserById.clear();
    return toolText(JSON.stringify(browser.status(), null, 2));
  }
  if (name === "deep_search_start") {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query.trim()) return toolText("Error: `query` is required.", true);
    const keywords = Array.isArray(args.keywords)
      ? args.keywords.filter((x): x is string => typeof x === "string")
      : undefined;
    const sources = Array.isArray(args.sources)
      ? args.sources.filter((x): x is string => typeof x === "string")
      : undefined;
    const browser = ["auto", "off", "cdp", "default"].includes(String(args.browser))
      ? (args.browser as DeepSearchInput["browser"])
      : undefined;
    const input: DeepSearchInput = {
      query,
      ...(keywords ? { keywords } : {}),
      ...(sources ? { sources } : {}),
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      ...(typeof args.maxRounds === "number" ? { maxRounds: args.maxRounds } : {}),
      ...(typeof args.maxSeconds === "number" ? { maxSeconds: args.maxSeconds } : {}),
      ...(typeof args.maxBrowserPages === "number" ? { maxBrowserPages: args.maxBrowserPages } : {}),
      ...(typeof args.maxBrowserSearchPages === "number" ? { maxBrowserSearchPages: args.maxBrowserSearchPages } : {}),
      ...(browser ? { browser } : {}),
    };
    const progress = await deepSearchService().start(input);
    return toolText(JSON.stringify({ jobId: progress.id, status: progress.status }, null, 2));
  }
  if (name === "deep_search_get") {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) return toolText("Error: `id` is required.", true);
    const snapshot = await deepSearchService().get(id);
    if (args.includeContent !== true) {
      snapshot.findings = snapshot.findings.map(({ content: _content, ...finding }) => finding);
    }
    return toolText(JSON.stringify(snapshot, null, 2));
  }
  if (name === "deep_search_cancel") {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) return toolText("Error: `id` is required.", true);
    return toolText(JSON.stringify(await deepSearchService().cancel(id), null, 2));
  }
  return toolText(`Error: unknown tool "${name}".`, true);
}

/**
 * Pure request handler: maps a JSON-RPC request to its response, or `null` for
 * notifications (no id, or initialized) that must not be answered. Never throws
 * — tool errors are surfaced as MCP tool results with `isError: true`.
 */
export async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize": {
      const requested = (req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        },
      };
    }
    case "notifications/initialized":
      return null;
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        return { jsonrpc: "2.0", id, result: await callTool(name, args) };
      } catch (err) {
        const message = err instanceof Error ? err.message : "tool execution failed";
        return { jsonrpc: "2.0", id, result: toolText(`Error: ${message}`, true) };
      }
    }
    default:
      // Don't answer a notification we don't recognise (id is null/absent).
      if (req.id === undefined || req.id === null) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}

/** Start the stdio server. Resolves when stdin closes. */
export function runMcpServer(): Promise<void> {
  return new Promise((resolve) => {
    process.stderr.write("[labee-protocol-searcher] MCP server ready on stdio\n");
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req: JsonRpcRequest;
        try {
          req = JSON.parse(line);
        } catch {
          continue; // ignore unparseable lines
        }
        void dispatch(req).then((res) => {
          if (res) process.stdout.write(JSON.stringify(res) + "\n");
        });
      }
    });
    process.stdin.on("end", () => resolve());
    process.stdin.on("close", () => resolve());
  });
}

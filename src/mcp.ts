// A dependency-free MCP server over the stdio transport.
//
// MCP's stdio transport is newline-delimited JSON-RPC 2.0: one message per
// line on stdin, one response per line on stdout, and absolutely nothing else
// on stdout (logs go to stderr). We implement just the methods a tool-only
// server needs: initialize, tools/list, tools/call, ping. See
// https://modelcontextprotocol.io/specification for the wire format.

import { readFileSync } from "node:fs";
import { search, renderSearch } from "./search.ts";
import { fetchResource, fetchResources } from "./fetch.ts";
import { VENDORS, VENDOR_IDS, type Fetchability } from "./vendors.ts";
import { providerStatus } from "./providers/registry.ts";
import { journalProviderOrder } from "./journals.ts";

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
      "`fetchable`, `may-not-fetch`, or `links-only`. Call `fetch` with a result's id to read its " +
      "content; vendor pages included. Don't spend a `fetch` on a `links-only` result — the site " +
      "refuses automated requests and you already have its url.",
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
      },
      required: ["query"],
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
      "instead — `search` grades each result so you know which to expect. Pass " +
      "`ids` to fetch a batch in one call (each returns its own row). Bare DOIs, PMIDs, PMCIDs, and " +
      "enzyme names also work. Every result ends with a `_status: …_` line (ok, abstract-only, " +
      "no-open-fulltext, oa-link, not-fetchable, not-found, bad-id).",
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
      },
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
    const resp = await search(query, {
      ...(sources ? { sources } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return toolText(renderSearch(resp));
  }
  if (name === "fetch") {
    const section = typeof args.section === "string" ? args.section : undefined;
    const opts = section ? { section } : {};
    const list = Array.isArray(args.ids)
      ? args.ids.filter((x): x is string => typeof x === "string" && x.trim() !== "")
      : [];
    const single = typeof args.id === "string" && args.id.trim() ? args.id : "";
    if (single) list.unshift(single);
    if (list.length === 0) return toolText("Error: `id` (or `ids`) is required.", true);
    if (list.length === 1) return toolText(await fetchResource(list[0]!, opts));
    const rows = await fetchResources(list, opts);
    return toolText(rows.map((r) => `# ${r.id}\n\n${r.text}`).join("\n\n---\n\n"));
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
        result: { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
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

#!/usr/bin/env node
// Entry point, with three modes:
//
//   MCP over stdio (default — a client spawns this as a child process):
//     node dist/index.mjs
//
//   MCP over Streamable HTTP (a hosted server clients reach by URL):
//     node dist/index.mjs --http [--port 3001] [--host 127.0.0.1]
//
//   One-shot CLI, so the same logic is usable by hand and in tests:
//     node dist/index.mjs --query "RNA extraction FFPE"
//     node dist/index.mjs --query "BsaI" --sources rebase,neb --limit 3 --json
//     node dist/index.mjs --fetch "rebase:EcoRI"
//     node dist/index.mjs --fetch "doi:10.1038/nprot.2009.203"
//     node dist/index.mjs --list-sources

import "./env.ts"; // load .env (side effect) before any env-reading module.
import { runMcpServer } from "./mcp.ts";
import { runHttpServer } from "./http.ts";
import { search, renderSearch } from "./search.ts";
import { VENDORS } from "./vendors.ts";
import { describeNetworkContext, detectNetworkContext } from "./network-context.ts";
import { deepSearchService } from "./agent/service.ts";
import { fetchResourceWithBrowser } from "./agent/browser-fetch.ts";
import { browserAdapterForMode, shutdownDefaultBrowser } from "./agent/default-browser.ts";

interface CliArgs {
  query?: string;
  sources?: string[];
  limit?: number;
  fetchId?: string;
  json: boolean;
  listSources: boolean;
  http: boolean;
  port?: number;
  host?: string;
  browser?: "off" | "cdp" | "default";
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { json: false, listSources: false, http: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--query" || a === "-q") out.query = argv[++i] ?? "";
    else if (a === "--fetch" || a === "-f") out.fetchId = argv[++i] ?? "";
    else if (a === "--sources" || a === "-s")
      out.sources = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--limit" || a === "-l") out.limit = Number(argv[++i]);
    else if (a === "--json") out.json = true;
    else if (a === "--list-sources") out.listSources = true;
    else if (a === "--http") out.http = true;
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i] ?? "";
    else if (a === "--browser") {
      const mode = argv[++i] ?? "";
      if (mode !== "off" && mode !== "cdp" && mode !== "default") {
        throw new Error("--browser must be one of: off, cdp, default");
      }
      out.browser = mode;
    }
    else if (a && !a.startsWith("-") && out.query === undefined) out.query = a;
  }
  return out;
}

/**
 * Start the HTTP transport. Binds loopback by default: the deployed topology
 * puts nginx in front, so the port itself should never face the internet.
 */
async function runHttp(args: CliArgs): Promise<void> {
  const port = args.port ?? Number(process.env.PROTOCOLS_MCP_PORT ?? process.env.PORT ?? 3001);
  const host = args.host ?? process.env.PROTOCOLS_MCP_HOST ?? "127.0.0.1";
  const token = process.env.PROTOCOLS_MCP_TOKEN?.trim();
  const path = process.env.PROTOCOLS_MCP_PATH_PREFIX ?? "/mcp";

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${args.port ?? process.env.PROTOCOLS_MCP_PORT}`);
  }
  // Refuse to expose an unauthenticated endpoint on a public interface — the
  // tools spend third-party API quota, so an open one is someone else's budget.
  if (!token && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `Refusing to bind ${host} without PROTOCOLS_MCP_TOKEN set. ` +
        `Set a token, or bind 127.0.0.1 and put a proxy in front.`,
    );
  }

  await runHttpServer(port, host, { ...(token ? { token } : {}), path });
  // Resolve never: the process stays up until systemd stops it.
  await new Promise<void>(() => {});
}

async function runCli(args: CliArgs): Promise<void> {
  if (args.listSources) {
    const rows = [
      { id: "rebase", name: "REBASE (restriction enzymes)", kind: "database", fetchability: "full" },
      ...VENDORS.map((v) => ({
        id: v.id,
        name: v.name,
        kind: v.kind,
        fetchability: v.fetchability,
      })),
    ];
    if (args.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else {
      for (const r of rows) {
        process.stdout.write(`${r.id}\t[${r.kind}] ${r.name}\t${r.fetchability}\n`);
      }
    }
    return;
  }

  if (args.fetchId !== undefined) {
    const browser = browserAdapterForMode(args.browser);
    process.stdout.write((await fetchResourceWithBrowser(args.fetchId, {}, browser)) + "\n");
    return;
  }

  const resp = await search(args.query!, {
    ...(args.sources ? { sources: args.sources } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });
  process.stdout.write(
    (args.json ? JSON.stringify(resp, null, 2) : renderSearch(resp)) + "\n",
  );
}

const args = parseArgs(process.argv.slice(2));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdownDefaultBrowser().finally(() => process.exit(0));
  });
}

/**
 * First step in every mode: establish what kind of network we are on. Entitlement
 * to publisher content is decided by IP, so retrieval behaves differently from a
 * university range than from a datacenter, and a caller reading the results
 * deserves to know which one produced them. Never fatal — an unreachable
 * detector resolves to "unknown".
 */
async function detectNetwork(): Promise<void> {
  try {
    const ctx = await detectNetworkContext();
    process.stderr.write(`[labee-protocol-searcher] ${describeNetworkContext(ctx)}\n`);
  } catch (err) {
    process.stderr.write(
      `[labee-protocol-searcher] network detection skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function resumeAgentJobs(): Promise<void> {
  try {
    const ids = await deepSearchService().resumeIncompleteJobs();
    if (ids.length > 0) process.stderr.write(`[labee-protocol-searcher] resumed ${ids.length} deep-search job(s)\n`);
  } catch (err) {
    process.stderr.write(`[labee-protocol-searcher] could not resume deep-search jobs: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

if (args.query !== undefined || args.fetchId !== undefined || args.listSources) {
  detectNetwork()
    .then(() => runCli(args))
    .finally(() => shutdownDefaultBrowser())
    .catch((err) => {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
} else if (args.http) {
  detectNetwork()
    .then(() => resumeAgentJobs())
    .then(() => runHttp(args))
    .catch((err) => {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
} else {
  detectNetwork()
    .then(() => resumeAgentJobs())
    .then(() => runMcpServer())
    .finally(() => shutdownDefaultBrowser())
    .then(() => process.exit(0));
}

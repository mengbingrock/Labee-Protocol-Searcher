#!/usr/bin/env node
// Entry point. With no `--query`/`--fetch`, runs as an MCP stdio server (the
// mode the chat route spawns). Otherwise runs a one-shot CLI so the same logic
// is usable by hand and in tests:
//
//   node dist/index.mjs --query "RNA extraction FFPE"
//   node dist/index.mjs --query "BsaI" --sources rebase,neb --limit 3 --json
//   node dist/index.mjs --fetch "rebase:EcoRI"
//   node dist/index.mjs --fetch "doi:10.1038/nprot.2009.203"
//   node dist/index.mjs --list-sources

import { runMcpServer } from "./mcp.ts";
import { search, renderSearch } from "./search.ts";
import { fetchResource } from "./fetch.ts";
import { VENDORS } from "./vendors.ts";

interface CliArgs {
  query?: string;
  sources?: string[];
  limit?: number;
  fetchId?: string;
  json: boolean;
  listSources: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { json: false, listSources: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--query" || a === "-q") out.query = argv[++i] ?? "";
    else if (a === "--fetch" || a === "-f") out.fetchId = argv[++i] ?? "";
    else if (a === "--sources" || a === "-s")
      out.sources = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--limit" || a === "-l") out.limit = Number(argv[++i]);
    else if (a === "--json") out.json = true;
    else if (a === "--list-sources") out.listSources = true;
    else if (a && !a.startsWith("-") && out.query === undefined) out.query = a;
  }
  return out;
}

async function runCli(args: CliArgs): Promise<void> {
  if (args.listSources) {
    const rows = [
      { id: "rebase", name: "REBASE (restriction enzymes)", kind: "database" },
      ...VENDORS.map((v) => ({ id: v.id, name: v.name, kind: v.kind })),
    ];
    if (args.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else {
      for (const r of rows) process.stdout.write(`${r.id}\t[${r.kind}] ${r.name}\n`);
    }
    return;
  }

  if (args.fetchId !== undefined) {
    process.stdout.write((await fetchResource(args.fetchId)) + "\n");
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

if (args.query !== undefined || args.fetchId !== undefined || args.listSources) {
  runCli(args).catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
} else {
  runMcpServer().then(() => process.exit(0));
}

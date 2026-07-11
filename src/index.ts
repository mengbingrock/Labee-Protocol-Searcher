#!/usr/bin/env node
// Entry point. With no `--query`, runs as an MCP stdio server (the mode the
// chat route spawns). With `--query "..."`, runs a one-shot CLI search so the
// same logic is usable by hand and in tests:
//
//   node dist/index.mjs --query "RNA extraction FFPE"
//   node dist/index.mjs --query "Gibson assembly" --vendors neb,star-protocols --limit 3 --json

import { runMcpServer } from "./mcp.ts";
import { searchProtocols, renderMarkdown } from "./search.ts";
import { VENDORS } from "./vendors.ts";

interface CliArgs {
  query?: string;
  vendors?: string[];
  limit?: number;
  json: boolean;
  listVendors: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { json: false, listVendors: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--query" || a === "-q") out.query = argv[++i] ?? "";
    else if (a === "--vendors" || a === "-v")
      out.vendors = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--limit" || a === "-l") out.limit = Number(argv[++i]);
    else if (a === "--json") out.json = true;
    else if (a === "--list-vendors") out.listVendors = true;
    else if (a && !a.startsWith("-") && out.query === undefined) out.query = a;
  }
  return out;
}

async function runCli(args: CliArgs): Promise<void> {
  if (args.listVendors) {
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          VENDORS.map((v) => ({ id: v.id, name: v.name, blurb: v.blurb })),
          null,
          2,
        ) + "\n",
      );
    } else {
      for (const v of VENDORS) process.stdout.write(`${v.id}\t${v.name} — ${v.blurb}\n`);
    }
    return;
  }
  const resp = await searchProtocols(args.query!, {
    ...(args.vendors ? { vendors: args.vendors } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });
  process.stdout.write(
    (args.json ? JSON.stringify(resp, null, 2) : renderMarkdown(resp)) + "\n",
  );
}

const args = parseArgs(process.argv.slice(2));

if (args.query !== undefined || args.listVendors) {
  runCli(args).catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
} else {
  runMcpServer().then(() => process.exit(0));
}

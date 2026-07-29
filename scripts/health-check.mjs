#!/usr/bin/env node
// Measures what the backends actually do today, and rewrites the health block
// in README.md between the HEALTH:BEGIN / HEALTH:END markers.
//
//   node scripts/health-check.mjs                       # print the block
//   node scripts/health-check.mjs --write               # splice it into README.md
//   node scripts/health-check.mjs --json-out h.json     # also emit raw results
//
// Everything runs through the built CLI (`dist/index.mjs`), on purpose: the
// probes then exercise the shipped artifact rather than the sources, and the
// script needs no TypeScript loader, so it runs on any supported Node.
//
// The README's `fetchability` grades stay hand-curated — a single probe can't
// tell "always works" from "usually works". This script only reports what it
// measured and flags *hard contradictions* (a source graded `full` that refused
// the request, or one graded `none` that extracted fine), which are the cases
// where a human should go re-grade the source.

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "dist/index.mjs");
const README = resolve(ROOT, "README.md");
const BEGIN = "<!-- HEALTH:BEGIN -->";
const END = "<!-- HEALTH:END -->";

// One keyword for every source, so today's numbers are comparable with
// yesterday's. Overridable to re-check a specific regression.
const QUERY = process.env.HEALTH_QUERY || "PCR purification";
const ENZYME = process.env.HEALTH_ENZYME || "EcoRI";
const PER_PROBE_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS || 60_000);
// A failed probe is retried once after this pause, so a transient throttle
// doesn't get published as an outage.
const RETRY_DELAY_MS = Number(process.env.HEALTH_RETRY_DELAY_MS || 5_000);
// How many probes run at once. Each is a separate CLI process hitting a
// different host, so a handful in flight is polite and cuts the run to minutes.
const CONCURRENCY = Number(process.env.HEALTH_CONCURRENCY || 4);
const JOURNAL_PROVIDERS = ["crossref", "europepmc", "openalex", "semanticscholar", "pubmed"];
const WEB_PROVIDERS = ["brave", "google", "duckduckgo"];
// Probe targets for the two chains: one journal, one vendor.
const JOURNAL_PROBE_SOURCE = "star-protocols";
const VENDOR_PROBE_SOURCE = "thermofisher";

/** Run the CLI once. Never throws — a failed probe is a result, not a crash. */
function cli(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\nprobe exceeded ${PER_PROBE_TIMEOUT_MS}ms`;
    }, PER_PROBE_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr: stderr.trim() });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: -1, stdout: "", stderr: err.message });
    });
  });
}

async function search(args, env) {
  const { stdout, stderr, code } = await cli([...args, "--json"], env);
  try {
    return { json: JSON.parse(stdout), stderr, code };
  } catch {
    return { json: null, stderr: stderr || `unparseable output (exit ${code})`, code };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `probe`, and if `failed(result)` says it came back empty, run it once more
 * after a pause. A red cell in the README should mean "reproducibly down", not
 * "one request lost a race with a rate limiter" — otherwise the table cries wolf
 * often enough to stop being read.
 */
async function withRetry(probe, failed) {
  const first = await probe();
  if (!failed(first)) return first;
  await sleep(RETRY_DELAY_MS);
  return probe();
}

/** Map with bounded concurrency, preserving input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** The `_status: …_` footer `fetch` stamps on every result. */
function statusOf(text) {
  const all = [...text.matchAll(/_status: ([a-z-]+)_/g)];
  return all.length > 0 ? all.at(-1)[1] : "no-status";
}

/** Which retrieval tier answered, read off the `_Source:` line. */
function tierOf(text) {
  if (/Europe PMC open-access full text/.test(text)) return "Europe PMC";
  if (/Unpaywall/.test(text)) return "Unpaywall";
  const m = /\(([a-z]+) extraction\)/.exec(text);
  return m ? `${m[1]} extraction` : "";
}

const OK = "✅";
const WARN = "⚠️";
const BAD = "❌";
const NA = "—";

/** One provider, pinned via `env`, searched against `source`. */
async function probeProvider(id, chain, env, source) {
  const run = async () => {
    const { json, stderr } = await search(
      ["--query", QUERY, "--sources", source, "--limit", "3"],
      env,
    );
    const bucket = json?.sources?.[0];
    const count = bucket?.count ?? 0;
    return { id, chain, count, error: bucket?.error || (json ? "" : stderr) };
  };
  const row = await withRetry(run, (r) => r.count === 0);
  // An absent key is a configuration choice, not an outage — say so, so a fork
  // without keys doesn't read its own README as broken.
  const unconfigured = /not set/i.test(row.error);
  row.state = row.count > 0 ? "ok" : unconfigured ? "unconfigured" : "down";
  return row;
}

function probeProviders() {
  const probes = [
    ...JOURNAL_PROVIDERS.map((id) => ({
      id,
      chain: "journal",
      env: { PROTOCOLS_JOURNAL_PROVIDERS: id },
      source: JOURNAL_PROBE_SOURCE,
    })),
    ...WEB_PROVIDERS.map((id) => ({
      id,
      chain: "web",
      env: { PROTOCOLS_SEARCH_PROVIDER: id },
      source: VENDOR_PROBE_SOURCE,
    })),
  ];
  return mapLimit(probes, CONCURRENCY, (p) => probeProvider(p.id, p.chain, p.env, p.source));
}

/**
 * One search across every source, then one `fetch` of each source's top result.
 * The search half measures reach; the fetch half measures whether the declared
 * grade still matches reality.
 */
async function probeSources(declared) {
  const { json, stderr } = await search(["--query", QUERY, "--limit", "3"]);
  if (!json) return { rows: [], searchError: stderr };

  const rows = await mapLimit(json.sources ?? [], CONCURRENCY, async (bucket) => {
    const top = (json.results ?? []).find((r) => r.source === bucket.id);
    const row = {
      id: bucket.id,
      name: bucket.name,
      kind: bucket.kind,
      declared: declared.get(bucket.id) ?? "unknown",
      count: bucket.count ?? 0,
      searchError: bucket.error || "",
      fetchStatus: "",
      tier: "",
      probedId: top?.id ?? "",
    };
    if (top) {
      // Retry a hard refusal once: `not-fetchable` is what drives a drift
      // warning, so it should not rest on a single request.
      const { stdout, stderr: ferr } = await withRetry(
        () => cli(["--fetch", top.id]),
        (r) => !r.stdout || statusOf(r.stdout) === "not-fetchable",
      );
      row.fetchStatus = stdout ? statusOf(stdout) : `error: ${ferr}`;
      row.tier = tierOf(stdout);
    }
    row.drift = driftOf(row);
    return row;
  });

  // REBASE only joins a search when the query is enzyme-shaped, so it needs its
  // own probe rather than riding along on the sweep above. Both calls download
  // the 4.4 MB flat file, which is also why they get a retry.
  const { json: rjson } = await withRetry(
    () => search(["--query", ENZYME, "--sources", "rebase", "--limit", "3"]),
    (r) => !(r.json?.results?.length > 0),
  );
  const rbucket = rjson?.sources?.[0];
  const rtop = rjson?.results?.[0];
  const rrow = {
    id: "rebase",
    name: "REBASE (restriction enzymes)",
    kind: "database",
    declared: declared.get("rebase") ?? "full",
    count: rbucket?.count ?? 0,
    searchError: rbucket?.error || "",
    fetchStatus: "",
    tier: "REBASE flat file",
    probedId: rtop?.id ?? "",
  };
  if (rtop) {
    const { stdout } = await withRetry(
      () => cli(["--fetch", rtop.id]),
      (r) => !r.stdout || statusOf(r.stdout) !== "ok",
    );
    rrow.fetchStatus = stdout ? statusOf(stdout) : "error";
  }
  rrow.drift = driftOf(rrow);
  rows.push(rrow);

  return { rows, searchError: "" };
}

/**
 * Only hard contradictions count as drift. A `partial` source can legitimately
 * return either outcome, and a `full` source that came back `no-open-fulltext`
 * may just have a paywalled top hit today.
 */
function driftOf(row) {
  if (row.declared === "full" && row.fetchStatus === "not-fetchable") {
    return "graded `full` but the site refused the request";
  }
  if (row.declared === "none" && row.fetchStatus === "ok") {
    return "graded `none` but the page extracted fine";
  }
  return "";
}

function providerCell(row) {
  if (row.state === "ok") return `${OK} ${row.count} result${row.count === 1 ? "" : "s"}`;
  if (row.state === "unconfigured") return `${NA} not configured`;
  return `${BAD} ${row.error || "no results"}`;
}

function sourceCell(row) {
  if (row.count > 0) return `${OK} ${row.count}`;
  return `${BAD} ${row.searchError || "0"}`;
}

function fetchCell(row) {
  if (!row.fetchStatus) return `${NA} not probed`;
  const icon = row.fetchStatus === "ok" ? OK : row.fetchStatus === "not-fetchable" ? BAD : WARN;
  return `${icon} \`${row.fetchStatus}\`${row.tier ? ` · ${row.tier}` : ""}`;
}

const GRADE_LABEL = { full: "✅ full", partial: "⚠️ partial", none: "❌ none" };

function renderBlock(report) {
  const { generatedAt, query, enzyme, providers, sources, searchError } = report;
  const drifted = sources.filter((s) => s.drift);
  const downBackends = providers.filter((p) => p.state === "down");

  const lines = [];
  lines.push(
    `_Measured automatically by [\`scripts/health-check.mjs\`](scripts/health-check.mjs), ` +
      `re-run daily by [the health workflow](.github/workflows/health.yml). ` +
      `Last run: **${generatedAt}** · probe query \`${query}\` (\`${enzyme}\` for REBASE)._`,
  );
  lines.push("");

  if (downBackends.length === 0) {
    lines.push(`${OK} **All configured backends answered.**`);
  } else {
    lines.push(
      `${BAD} **${downBackends.length} backend${downBackends.length === 1 ? "" : "s"} not answering:** ` +
        downBackends.map((p) => `\`${p.id}\``).join(", ") +
        ". The chains fall through, so search still works as long as one provider per chain is up.",
    );
  }
  if (drifted.length > 0) {
    lines.push("");
    lines.push(
      `${WARN} **Grade drift — re-check \`fetchability\` in \`src/vendors.ts\`:** ` +
        drifted.map((s) => `\`${s.id}\` (${s.drift})`).join("; ") +
        ".",
    );
  }
  lines.push("");

  lines.push("**Backends**");
  lines.push("");
  lines.push("| Backend | Chain | Today |");
  lines.push("| --- | --- | --- |");
  for (const p of providers) {
    lines.push(`| \`${p.id}\` | ${p.chain} | ${providerCell(p)} |`);
  }
  lines.push("");

  lines.push("**Sources**");
  lines.push("");
  if (searchError) {
    lines.push(`${BAD} The full-catalog sweep failed: ${searchError}`);
  } else {
    lines.push("| Source | Declared `fetch` | Search hits | Top result `fetch` |");
    lines.push("| --- | --- | --- | --- |");
    for (const s of sources) {
      const grade = GRADE_LABEL[s.declared] ?? s.declared;
      lines.push(`| \`${s.id}\` | ${grade} | ${sourceCell(s)} | ${fetchCell(s)} |`);
    }
  }
  lines.push("");
  lines.push(
    "_A `partial` source showing `no-open-fulltext` or `may-not-fetch` is behaving as graded, not failing. " +
      "Every ❌ above is a second failed attempt — probes retry once before being recorded as down._",
  );
  return lines.join("\n");
}

async function declaredGrades() {
  const { stdout } = await cli(["--list-sources", "--json"]);
  const map = new Map();
  try {
    for (const row of JSON.parse(stdout)) map.set(row.id, row.fetchability);
  } catch {
    // Leave the map empty — the table then prints "unknown" rather than lying.
  }
  return map;
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const jsonOutIdx = argv.indexOf("--json-out");
  const jsonOut = jsonOutIdx === -1 ? "" : argv[jsonOutIdx + 1];

  const declared = await declaredGrades();
  if (declared.size === 0) {
    throw new Error(
      `could not read the source catalog from ${CLI} — run \`npm run build\` before the health check`,
    );
  }

  const providers = await probeProviders();
  const { rows: sources, searchError } = await probeSources(declared);

  const report = {
    // Minute precision. This line changes on every run by design — a "last
    // run" stamp that only moved when a result changed would read as stale
    // exactly when the check was working. So a quiet day still commits, and the
    // diff is this one line.
    generatedAt: new Date().toISOString().replace(/:\d\d\.\d+Z$/, "Z"),
    query: QUERY,
    enzyme: ENZYME,
    providers,
    sources,
    searchError,
  };
  const block = renderBlock(report);

  if (jsonOut) await writeFile(jsonOut, JSON.stringify(report, null, 2) + "\n");

  if (!write) {
    process.stdout.write(block + "\n");
    return;
  }

  await writeFile(README, spliceBlock(await readFile(README, "utf8"), block));
  process.stderr.write(`health block written to ${README}\n`);
}

/**
 * Replace the marked region of `readme` with `block`, leaving every other byte
 * alone. Throws rather than appending if the markers are gone — a health check
 * that silently stops updating anything is the one failure this whole file
 * exists to prevent.
 */
export function spliceBlock(readme, block) {
  const start = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md is missing the ${BEGIN} / ${END} markers`);
  }
  return readme.slice(0, start + BEGIN.length) + "\n" + block + "\n" + readme.slice(end);
}

export { statusOf, tierOf, driftOf, renderBlock };

// Only run when invoked as a script, so the helpers above stay importable.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`health-check failed: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}

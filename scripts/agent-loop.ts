#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpBrowserAdapter } from "../src/agent/browser.ts";
import { runDeepSearchJob } from "../src/agent/runner.ts";
import { normalizeDeepSearchInput } from "../src/agent/service.ts";
import { FileJobStore } from "../src/agent/store.ts";
import { VENDORS } from "../src/vendors.ts";

const CORE_FIVE = ["PCR purification", "Gibson assembly", "CRISPR Cas9 knockout", "RNA extraction FFPE", "EcoRI"];
const JOURNAL_BACKENDS = ["crossref", "europepmc", "openalex", "semanticscholar", "pubmed"];
const WEB_BACKENDS = ["brave", "google", "duckduckgo"];

interface Args {
  loops: number;
  limit: number;
  browser: "auto" | "off" | "cdp";
  sources?: string[];
  out: string;
}

function args(argv: string[]): Args {
  const out: Args = { loops: 1, limit: 1, browser: "auto", out: ".labee-runs" };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--loops") out.loops = Number(argv[++i]);
    else if (value === "--limit") out.limit = Number(argv[++i]);
    else if (value === "--browser") out.browser = argv[++i] as Args["browser"];
    else if (value === "--sources") {
      const raw = argv[++i] ?? "";
      if (raw !== "all") {
        out.sources = [...new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
      }
    } else if (value === "--out") out.out = argv[++i] ?? out.out;
  }
  if (!Number.isInteger(out.loops) || out.loops < 1 || out.loops > 4) throw new Error("--loops must be 1..4");
  if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > 10) throw new Error("--limit must be 1..10");
  if (!["auto", "off", "cdp"].includes(out.browser)) throw new Error("--browser must be auto, off, or cdp");
  return out;
}

function counts(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function expectedBackendIds(sources: readonly string[], browser: boolean): Set<string> {
  const byId = new Map(VENDORS.map((source) => [source.id, source]));
  const ids = new Set<string>();
  for (const id of sources) {
    const source = byId.get(id);
    if (!source) continue;
    const backends = browser
      ? source.kind === "journal" ? ["semanticscholar-browser"] : []
      : source.kind === "journal" ? JOURNAL_BACKENDS : WEB_BACKENDS;
    for (const backend of backends) ids.add(`backend:${source.id}/${backend}`);
  }
  return ids;
}

function completeCoverage(
  coverage: Readonly<Record<string, number>>,
  expected: ReadonlySet<string>,
): boolean {
  const actual = new Set(Object.keys(coverage));
  return sameSet(actual, expected) && [...expected].every((id) => coverage[id] === CORE_FIVE.length);
}

async function main(): Promise<void> {
  const options = args(process.argv.slice(2));
  const root = resolve(options.out);
  await mkdir(root, { recursive: true });
  const catalogIds = new Set(VENDORS.map((source) => source.id));
  const selectedSourceIds = options.sources
    ? options.sources.filter((source) => source !== "rebase")
    : VENDORS.map((source) => source.id);
  const unknownSources = (options.sources ?? []).filter(
    (source) => source !== "rebase" && !catalogIds.has(source),
  );
  if (unknownSources.length > 0) throw new Error(`Unknown --sources: ${unknownSources.join(", ")}`);
  if (selectedSourceIds.length === 0) {
    throw new Error("--sources must include at least one journal or vendor for backend validation");
  }
  const expectedNativeBackendIds = expectedBackendIds(selectedSourceIds, false);
  const expectedBrowserBackendIds = expectedBackendIds(selectedSourceIds, true);
  if (!options.sources && (expectedNativeBackendIds.size !== 55 || expectedBrowserBackendIds.size !== 5)) {
    throw new Error("Source catalog no longer matches the all-source 55 native + 5 browser backend invariant");
  }
  const browser = options.browser === "off" ? undefined : new CdpBrowserAdapter();
  const summaries: unknown[] = [];

  for (let loop = 1; loop <= options.loops; loop++) {
    const store = new FileJobStore(root);
    const spec = normalizeDeepSearchInput({
      query: "core-five protocol benchmark",
      keywords: CORE_FIVE,
      ...(options.sources ? { sources: options.sources } : {}),
      limit: options.limit,
      browser: options.browser,
      maxRounds: 1,
      maxBrowserPages: 20,
      maxBrowserSearchPages: 30,
      maxSeconds: 1_800,
    });
    const created = await store.create(spec);
    const progress = await runDeepSearchJob(created.id, { store, ...(browser ? { browser } : {}) });
    const attempts = await store.readAttempts(created.id);
    const findings = await store.readFindings(created.id);
    const backendAttempts = attempts.filter((attempt) => attempt.route === "search-backend");
    const browserBackendAttempts = backendAttempts.filter((attempt) => attempt.resultId.endsWith("/semanticscholar-browser"));
    const nativeBackendAttempts = backendAttempts.filter((attempt) => !attempt.resultId.endsWith("/semanticscholar-browser"));
    const nativeAttempts = attempts.filter((attempt) => attempt.route === "native-fetch");
    const nativeBackendCoverage = counts(nativeBackendAttempts.map((attempt) => attempt.resultId));
    const browserBackendCoverage = counts(browserBackendAttempts.map((attempt) => attempt.resultId));
    const nativeBackendComplete = completeCoverage(nativeBackendCoverage, expectedNativeBackendIds);
    const browserBackendComplete = options.browser === "off"
      ? browserBackendAttempts.length === 0
      : completeCoverage(browserBackendCoverage, expectedBrowserBackendIds);
    const findingIdCounts = counts(findings.map((finding) => finding.result.id));
    const nativeIdCounts = counts(nativeAttempts.map((attempt) => attempt.resultId));
    const findingIds = new Set(Object.keys(findingIdCounts));
    const nativeIds = new Set(Object.keys(nativeIdCounts));
    const duplicateFindingIds = Object.entries(findingIdCounts).filter(([, count]) => count !== 1).map(([id]) => id);
    const duplicateNativeIds = Object.entries(nativeIdCounts).filter(([, count]) => count !== 1).map(([id]) => id);
    const missingNativeIds = [...findingIds].filter((id) => !nativeIds.has(id));
    const unexpectedNativeIds = [...nativeIds].filter((id) => !findingIds.has(id));
    const nativeFetchComplete = sameSet(nativeIds, findingIds)
      && duplicateFindingIds.length === 0
      && duplicateNativeIds.length === 0
      && findingIds.size === progress.uniqueResults
      && nativeAttempts.length === progress.nativeFetchAttempts;
    const summary = {
      loop,
      jobId: created.id,
      searchQueries: progress.searchedKeywords.length,
      resultOccurrences: progress.resultOccurrences,
      nativeFetchAttempts: nativeAttempts.length,
      nativeFetchComplete,
      missingNativeIds,
      unexpectedNativeIds,
      duplicateFindingIds,
      duplicateNativeIds,
      uniqueResults: progress.uniqueResults,
      verifiedResults: progress.verifiedResults,
      backendAttempts: backendAttempts.length,
      nativeBackendAttempts: nativeBackendAttempts.length,
      expectedNativeBackendPairs: expectedNativeBackendIds.size,
      nativeBackendComplete,
      browserBackendAttempts: browserBackendAttempts.length,
      expectedBrowserBackendPairs: options.browser === "off" ? 0 : expectedBrowserBackendIds.size,
      browserBackendComplete,
      backendStatus: counts(backendAttempts.map((attempt) => `${attempt.resultId}:${attempt.status}`)),
      finalStatus: counts(findings.map((finding) => finding.finalStatus)),
      recoveryRoutes: counts(findings.map((finding) => finding.route)),
      browserPages: progress.browserPages,
      browserSearchPages: progress.browserSearchPages,
    };
    if (summary.searchQueries !== CORE_FIVE.length || !nativeFetchComplete || !nativeBackendComplete || !browserBackendComplete) {
      throw new Error(`Loop ${loop} violated search, backend, or native-fetch completeness invariants`);
    }
    summaries.push(summary);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  }
  await browser?.close();
  process.stdout.write(`${JSON.stringify({ completed: true, loops: summaries }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`Agent loop failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

// Orchestrates a protocol search across sources.
//
//   - Journal sources (STAR Protocols, Nature Protocols) go to scholarly APIs
//     (Crossref → Europe PMC): reliable, keyless, no rate limits.
//   - Vendor sources go to the active web-search provider chain (Brave/Google
//     when a key is set, else DuckDuckGo), batched into combined
//     `(site:a OR site:b ...)` queries with results bucketed back per vendor.
//
// Every source is also paired with its deterministic on-site search URL, so the
// tool stays useful even when a backend is unavailable.

import type { ProviderOptions, RawResult } from "./providers/types.ts";
import { webSearch } from "./providers/registry.ts";
import { searchJournal } from "./journals.ts";
import { resolveVendors, getVendor, type Fetchability, type Vendor } from "./vendors.ts";
import { looksLikeEnzymeQuery, searchRebase } from "./rebase.ts";
import {
  assessDoiAvailability,
  loadFetchabilityIndex,
  type DoiAvailabilityEvidence,
  type FetchabilityIndex,
} from "./fetchability-index.ts";

export interface VendorResults {
  id: string;
  name: string;
  /** Deterministic deep link into the source's own search page. */
  searchUrl: string;
  results: RawResult[];
  /** Which backend produced the results (e.g. "crossref", "brave", "duckduckgo"). */
  source?: string;
  /** Exhaustive scholarly-backend coverage for journal sources. */
  providers?: SearchBackendOutcome[];
  /** Present when live result extraction returned nothing for this source. */
  error?: string;
}

export interface SearchBackendOutcome {
  id: string;
  status: "ok" | "empty" | "error" | "unavailable";
  count: number;
  elapsedMs: number;
  error?: string;
}

export interface SearchResponse {
  query: string;
  vendors: VendorResults[];
  unknownVendors: string[];
  /** True when at least one source came back empty/rate-limited. */
  partial: boolean;
}

export interface SearchOptions {
  vendors?: readonly string[];
  /** Max results per source (default 5, clamped to 1..10). */
  limit?: number;
  /** Vendors per combined web query (default 6). */
  batchSize?: number;
  /** Max concurrent journal lookups (default 4). */
  concurrency?: number;
  /** Forwarded to providers / journal APIs (timeout, fetch injection). */
  providerOpts?: ProviderOptions;
}

/** Normalize a URL to `host/path` without the `www.` prefix, lowercased. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "").toLowerCase() + u.pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Find the vendor a result URL belongs to. Matches by `ddgSite` prefix on a
 * host boundary (so "neb.com" never matches "neb.com.evil.com") and prefers
 * the most specific match.
 */
function matchVendor(url: string, vendors: readonly Vendor[]): Vendor | undefined {
  const norm = normalizeUrl(url);
  const host = norm.split("/")[0]!;
  let best: Vendor | undefined;
  for (const v of vendors) {
    const site = v.ddgSite.replace(/^www\./, "").toLowerCase();
    const siteHost = site.split("/")[0]!;
    if (host !== siteHost) continue;
    if (norm === site || norm.startsWith(site)) {
      if (!best || v.ddgSite.length > best.ddgSite.length) best = v;
    }
  }
  return best;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function searchProtocols(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  const trimmed = query.trim();
  const { vendors, unknown } = resolveVendors(opts.vendors);
  if (!trimmed) {
    return { query: "", vendors: [], unknownVendors: unknown, partial: false };
  }
  const limit = Math.max(1, Math.min(10, Math.floor(opts.limit ?? 5)));
  // One query per vendor. Batching several into `(site:a OR site:b) q` shares a
  // single result budget, so a large domain crowds the others out and they come
  // back empty even when they do have matching pages. Costs one search-provider
  // call per vendor — raise `batchSize` to trade recall back for quota.
  const batchSize = Math.max(1, opts.batchSize ?? 1);
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const providerOpts = opts.providerOpts ?? {};

  const buckets = new Map<string, VendorResults>(
    vendors.map((v) => [
      v.id,
      { id: v.id, name: v.name, searchUrl: v.searchUrl(trimmed), results: [] },
    ]),
  );
  let partial = false;

  // --- Journals: scholarly APIs, run concurrently (they don't rate-limit). ---
  const journals = vendors.filter((v) => v.kind === "journal");
  await mapPool(journals, concurrency, async (v) => {
    const bucket = buckets.get(v.id)!;
    const outcome = await searchJournal(v.journal!, trimmed, limit, providerOpts);
    bucket.providers = outcome.providers;
    if (outcome.results.length > 0) {
      bucket.results = outcome.results;
      bucket.source = outcome.source;
      if (outcome.error) {
        partial = true;
        bucket.error = outcome.error;
      }
    } else {
      partial = true;
      bucket.error = outcome.error ?? "no results";
    }
  });

  // --- Vendors: combined web-search queries, bucketed by hostname. ---
  const webVendors = vendors.filter((v) => v.kind === "vendor");
  await mapPool(chunk(webVendors, batchSize), concurrency, async (group) => {
    const sites = group.map((v) => `site:${v.ddgSite}`).join(" OR ");
    const combined = group.length === 1 ? `${sites} ${trimmed}` : `(${sites}) ${trimmed}`;
    const outcome = await webSearch(combined, limit * group.length, providerOpts);
    for (const v of group) buckets.get(v.id)!.providers = outcome.providers;
    if (outcome.results.length === 0) {
      partial = true;
      const reason = outcome.error ?? "no results";
      for (const v of group) {
        const bucket = buckets.get(v.id)!;
        if (bucket.results.length === 0) {
          bucket.error = `${reason} (via ${outcome.provider})`;
        }
      }
      return;
    }
    for (const r of outcome.results) {
      const vendor = matchVendor(r.url, group);
      if (!vendor) continue;
      const bucket = buckets.get(vendor.id)!;
      if (bucket.results.length < limit) {
        bucket.results.push(r);
        bucket.source = outcome.provider;
      }
    }
    // Vendors in this group with no hits still count as partial.
    for (const v of group) {
      if (buckets.get(v.id)!.results.length === 0) {
        partial = true;
        buckets.get(v.id)!.error ??= `no results (via ${outcome.provider})`;
      }
    }
  });

  return {
    query: trimmed,
    vendors: Array.from(buckets.values()),
    unknownVendors: unknown,
    partial,
  };
}

/** Render a SearchResponse as compact, model-friendly markdown. */
export function renderMarkdown(resp: SearchResponse): string {
  if (!resp.query) return "No query provided.";
  const lines: string[] = [`# Protocol search: "${resp.query}"`, ""];
  if (resp.unknownVendors.length > 0) {
    lines.push(`> Unknown vendor ids ignored: ${resp.unknownVendors.join(", ")}`, "");
  }
  let totalHits = 0;
  for (const v of resp.vendors) {
    lines.push(`## ${v.name}${v.source ? ` _(via ${v.source})_` : ""}`);
    lines.push(`Search page: ${v.searchUrl}`);
    if (v.results.length === 0) {
      lines.push(`_No extractable results${v.error ? ` (${v.error})` : ""}._`, "");
      continue;
    }
    for (const r of v.results) {
      totalHits++;
      lines.push(`- [${r.title}](${r.url})`);
      if (r.snippet) lines.push(`  ${r.snippet}`);
    }
    lines.push("");
  }
  const note = resp.partial
    ? " Some sources returned nothing (rate-limited or unconfigured) — use their search pages directly, or set BRAVE_API_KEY / GOOGLE_API_KEY for reliable vendor search."
    : "";
  lines.push(
    `_${totalHits} result${totalHits === 1 ? "" : "s"} across ${resp.vendors.length} source${
      resp.vendors.length === 1 ? "" : "s"
    }. Search pages always work even when extraction is blocked.${note}_`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Unified search: one flat, id-addressable result list across journals,
// vendors, AND the REBASE enzyme database. Every result carries a stable `id`
// (that `fetch` resolves) and a `fetchable` grade encoding how likely `fetch`
// is to return real content: "full", "partial" (worth trying, may come back as
// a link), or "none" (the site refuses automated requests). The grade comes
// from the source's measured `fetchability` — see vendors.ts — so it can't
// drift from what `fetch` actually does. This is the `search`/`fetch` shape.
// ---------------------------------------------------------------------------

export type ResultKind = "enzyme" | "article" | "vendor-page";

export interface UnifiedResult {
  /** e.g. "rebase:EcoRI", "doi:10.…", "pmid:123", "pmcid:PMC…", "url:https://…". */
  id: string;
  source: string;
  kind: ResultKind;
  title: string;
  url?: string;
  snippet?: string;
  /** How likely `fetch(id)` is to return real content. */
  fetchable: Fetchability;
  /** Search backends that independently discovered this merged paper. */
  discoveredBy?: string[];
  /** Evidence hierarchy behind the legacy `fetchable` grade. */
  availability?: DoiAvailabilityEvidence;
}

export interface SourceStatus {
  id: string;
  name: string;
  /** "journal" | "vendor" | "database". */
  kind: string;
  /** On-site search page (journals/vendors). */
  searchUrl?: string;
  /** Human-readable form of the query actually scoped to this source. */
  query?: string;
  count: number;
  /** Per-backend status when this is a journal source. */
  providers?: SearchBackendOutcome[];
  error?: string;
}

export interface UnifiedResponse {
  query: string;
  results: UnifiedResult[];
  sources: SourceStatus[];
  unknownSources: string[];
  partial: boolean;
}

export interface UnifiedOptions extends Omit<SearchOptions, "vendors"> {
  /** Subset of source ids (vendor/journal ids and/or "rebase"). Omit for all. */
  sources?: readonly string[];
  /** Force REBASE lookup mode when the query is enzyme-shaped. */
  by?: "name" | "site";
  /** Inject a validated CI index (primarily for hermetic tests). */
  fetchabilityIndex?: FetchabilityIndex;
}

function gradeForEvidence(evidence: DoiAvailabilityEvidence): Fetchability {
  if (evidence.availability === "verified-full-text" || evidence.availability === "likely-fetchable") {
    return "full";
  }
  if (evidence.availability === "verified-unavailable" || evidence.availability === "unlikely-fetchable") {
    return "none";
  }
  return "partial";
}

/**
 * Derive a fetchable id from a journal result URL (DOI / PMCID / PMID).
 * `resolvable` says only whether we found an identifier `fetch` knows how to
 * look up — whether that lookup finds open text is the journal's
 * `fetchability`, which the caller applies.
 */
function idForArticleUrl(url: string): { id: string; resolvable: boolean } {
  const doi = /doi\.org\/(10\.\S+)/i.exec(url);
  // JoVE mints a `-v` sibling DOI for the video edition of an article
  // (10.3791/59550-v alongside 10.3791/59550). Europe PMC indexes only the
  // article, so the video DOI resolves to nothing — normalise to the article.
  if (doi) return { id: `doi:${doi[1]!.replace(/-v\d*$/i, "")}`, resolvable: true };
  const pmc = /(PMC\d+)/i.exec(url);
  if (pmc) return { id: `pmcid:${pmc[1]!.toUpperCase()}`, resolvable: true };
  const med = /europepmc\.org\/article\/MED\/(\d+)/i.exec(url);
  if (med) return { id: `pmid:${med[1]}`, resolvable: true };
  return { id: `url:${url}`, resolvable: false };
}

export async function search(query: string, opts: UnifiedOptions = {}): Promise<UnifiedResponse> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { query: "", results: [], sources: [], unknownSources: [], partial: false };
  }

  const requested = opts.sources;
  const wantRebase = requested
    ? requested.some((s) => s.trim().toLowerCase() === "rebase")
    : looksLikeEnzymeQuery(trimmed);
  const vendorIds = requested
    ? requested.filter((s) => s.trim().toLowerCase() !== "rebase")
    : undefined;

  // Run the journal+vendor engine unless the caller asked for REBASE only.
  const onlyRebase = Boolean(requested) && (vendorIds?.length ?? 0) === 0;
  const base: SearchResponse = onlyRebase
    ? { query: trimmed, vendors: [], unknownVendors: [], partial: false }
    : await searchProtocols(trimmed, {
        ...(vendorIds ? { vendors: vendorIds } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        ...(opts.providerOpts ? { providerOpts: opts.providerOpts } : {}),
      });

  const results: UnifiedResult[] = [];
  const sources: SourceStatus[] = [];
  let partial = base.partial;
  const hasJournalResults = base.vendors.some(
    (bucket) => getVendor(bucket.id)?.kind === "journal" && bucket.results.length > 0,
  );
  const fetchabilityIndex = hasJournalResults
    ? opts.fetchabilityIndex ??
      (await loadFetchabilityIndex({ allowRemote: opts.providerOpts?.fetchImpl === undefined }))
    : undefined;

  for (const b of base.vendors) {
    const vendor = getVendor(b.id);
    const kind = vendor?.kind ?? "vendor";
    // Echo the effective scoping so the agent can judge why a source was empty.
    // Must mirror what searchProtocols actually sends (see the vendor loop) —
    // an echo that adds quotes the real query never had reads as an exact-phrase
    // search and invites "loosen the quoting" fixes for a non-existent problem.
    const effectiveQuery = vendor
      ? kind === "journal"
        ? `${trimmed} in ${b.name}`
        : `site:${vendor.ddgSite} ${trimmed}`
      : undefined;
    // Collect first, then drop same-id repeats within the source: normalising
    // DOI variants (see idForArticleUrl) can collapse two hits onto one id, and
    // a duplicate row just spends the caller's `fetch` budget twice.
    const rows: UnifiedResult[] = [];
    const seen = new Set<string>();
    // An unknown source can't be graded; "partial" tells the agent to try and
    // be ready for a link, which is the safe reading of "we don't know".
    const grade: Fetchability = vendor?.fetchability ?? "partial";
    for (const r of b.results) {
      let id: string;
      let fetchable: Fetchability;
      if (kind === "journal") {
        const article = idForArticleUrl(r.url);
        id = article.id;
        // A journal hit with no DOI/PMID/PMCID is a bare publisher URL, and
        // those are exactly the paywalled pages the scholarly APIs exist to
        // route around — never claim it's retrievable.
        fetchable = article.resolvable ? grade : "none";
      } else {
        id = `url:${r.url}`;
        fetchable = grade;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const availability =
        kind === "journal" && id.startsWith("doi:") && fetchabilityIndex
          ? assessDoiAvailability(id, grade, fetchabilityIndex, r.oaEvidence ?? [])
          : undefined;
      if (availability) fetchable = gradeForEvidence(availability);
      rows.push({
        id,
        source: b.id,
        kind: kind === "journal" ? "article" : "vendor-page",
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        fetchable,
        ...(r.discoveredBy?.length ? { discoveredBy: r.discoveredBy } : {}),
        ...(availability ? { availability } : {}),
      });
    }

    sources.push({
      id: b.id,
      name: b.name,
      kind,
      searchUrl: b.searchUrl,
      ...(effectiveQuery ? { query: effectiveQuery } : {}),
      count: rows.length,
      ...(b.providers ? { providers: b.providers } : {}),
      ...(b.error ? { error: b.error } : {}),
    });
    results.push(...rows);
  }

  if (wantRebase) {
    try {
      const hits = await searchRebase(trimmed, {
        ...(opts.providerOpts ?? {}),
        ...(opts.by ? { by: opts.by } : {}),
      });
      sources.push({
        id: "rebase",
        name: "REBASE (restriction enzymes)",
        kind: "database",
        query: `${trimmed} (by ${opts.by ?? (looksLikeEnzymeQuery(trimmed) ? "auto" : "name")})`,
        count: hits.length,
      });
      for (const h of hits) {
        results.push({
          id: `rebase:${h.name}`,
          source: "rebase",
          kind: "enzyme",
          title: h.title,
          snippet: h.snippet,
          // The whole REBASE release is already parsed in memory by this point.
          fetchable: "full",
        });
      }
      if (hits.length === 0) partial = true;
    } catch (err) {
      partial = true;
      sources.push({
        id: "rebase",
        name: "REBASE (restriction enzymes)",
        kind: "database",
        count: 0,
        error: err instanceof Error ? err.message : "lookup failed",
      });
    }
  }

  return { query: trimmed, results, sources, unknownSources: base.unknownVendors, partial };
}

/** How each fetchability grade reads in a result listing. */
const FETCHABLE_LABEL: Record<Fetchability, string> = {
  full: "fetchable",
  partial: "may-not-fetch",
  none: "links-only",
};

function resultFetchabilityLabel(result: UnifiedResult): string {
  const evidence = result.availability;
  if (!evidence) return FETCHABLE_LABEL[result.fetchable];
  if (evidence.confidence === "verified") {
    const day = evidence.checkedAt?.slice(0, 10) ?? "unknown date";
    const tier = evidence.retrievalTier ? ` · ${evidence.retrievalTier}` : "";
    return `${evidence.availability} (CI ${day}${tier})`;
  }
  if (evidence.confidence === "metadata") {
    const providers = [...new Set((evidence.signals ?? []).map((signal) => signal.split(":")[0]))];
    return `likely-fetchable (current ${providers.join("+") || "OA"} metadata)`;
  }
  return `${FETCHABLE_LABEL[result.fetchable]} (journal prior; DOI untested)`;
}

/** Render a UnifiedResponse as compact, model-friendly markdown with ids. */
export function renderSearch(resp: UnifiedResponse): string {
  if (!resp.query) return "No query provided.";
  const lines: string[] = [`# Search: "${resp.query}"`, ""];
  if (resp.unknownSources.length > 0) {
    lines.push(`> Unknown source ids ignored: ${resp.unknownSources.join(", ")}`, "");
  }

  const bySource = new Map<string, UnifiedResult[]>();
  for (const r of resp.results) {
    const arr = bySource.get(r.source);
    if (arr) arr.push(r);
    else bySource.set(r.source, [r]);
  }

  for (const s of resp.sources) {
    const rs = bySource.get(s.id) ?? [];
    lines.push(`## ${s.name} _(${s.kind})_`);
    if (s.query) lines.push(`Query: \`${s.query}\``);
    if (s.searchUrl) lines.push(`Search page: ${s.searchUrl}`);
    if (s.providers) {
      lines.push(
        `Backends: ${s.providers.map((p) => `${p.id}=${p.status}(${p.count})`).join(" · ")}`,
      );
    }
    if (rs.length === 0) {
      lines.push(`_No extractable results${s.error ? ` (${s.error})` : ""}._`, "");
      continue;
    }
    for (const r of rs) {
      lines.push(`- ${r.url ? `[${r.title}](${r.url})` : r.title}`);
      lines.push(
        `  \`${r.id}\` · ${resultFetchabilityLabel(r)}` +
          `${r.snippet ? ` — ${r.snippet}` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push(
    `_${resp.results.length} result${resp.results.length === 1 ? "" : "s"} across ` +
      `${resp.sources.length} source${resp.sources.length === 1 ? "" : "s"}. ` +
      "Call `fetch` with a result's id to read it. CI-verified labels are exact while fresh; " +
      "metadata labels are predictions; journal-prior labels mean that DOI has not been tested. " +
      "`links-only` results should be opened directly._",
  );
  return lines.join("\n");
}

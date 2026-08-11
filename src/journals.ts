// Scholarly-API search for the protocol journals (STAR Protocols, Nature
// Protocols). These journals are indexed by several free, machine-friendly
// scholarly APIs, so we get real protocol titles, DOIs, and links without
// scraping the paywalled/bot-blocked publisher sites.
//
// Five providers, all queried on every search. Because they're run by different
// organizations and index different records, exhaustive coverage both survives
// outages and recovers results one index may omit. Order is configurable via PROTOCOLS_JOURNAL_PROVIDERS
// (comma-separated ids); default: crossref,europepmc,openalex,semanticscholar,pubmed.
//
//   - crossref         — DOI registry metadata for ~all publishers
//   - europepmc        — EMBL-EBI life-sciences index (+ open-access full text)
//   - openalex         — open index of 250M+ works (filtered by ISSN)
//   - semanticscholar  — AI/citation-graph index (optional SEMANTIC_SCHOLAR_API_KEY)
//   - pubmed           — NCBI E-utilities, esearch→esummary (optional NCBI_API_KEY)

import {
  type ProviderOptions,
  type RawResult,
  fetchWithRetry,
  stripTags,
} from "./providers/types.ts";
import type { JournalInfo } from "./vendors.ts";

const DEFAULT_TIMEOUT_MS = 9000;
// Identifies us to the "polite pools" (Crossref, OpenAlex, NCBI) for reliability.
const CONTACT = process.env.PROTOCOLS_CONTACT_EMAIL || "labee-protocol-searcher@example.com";

export interface JournalSearchOutcome {
  results: RawResult[];
  source: string;
  providers: JournalProviderOutcome[];
  error?: string;
}

export interface JournalProviderOutcome {
  id: string;
  status: "ok" | "empty" | "error";
  count: number;
  elapsedMs: number;
  error?: string;
}

type JournalSearchFn = (
  journal: JournalInfo,
  query: string,
  limit: number,
  opts: ProviderOptions,
) => Promise<RawResult[]>;

/**
 * Titles and abstracts arrive as publisher markup, and some sources escape it:
 * Crossref returns `&lt;i&gt;Synechocystis&lt;/i&gt;`, not `<i>…</i>`.
 *
 * `stripTags` strips tags and *then* decodes entities, so one pass over an
 * escaped title only turns it into a tag-bearing one. A second pass removes
 * those. Two is enough — nothing here is escaped three deep — and the pass is
 * safe for a bare `&lt;` (the tag regex needs a closing `>` to match).
 */
function text(raw?: string): string {
  return raw ? stripTags(stripTags(raw)) : "";
}

/** `text`, capped for use as a result snippet. */
function clean(raw?: string): string {
  const t = text(raw);
  // Cut on a word boundary and mark the elision, so snippets don't end mid-word.
  if (t.length <= 300) return t;
  const cut = t.slice(0, 300);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 200 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function doiUrl(doi?: string): string {
  if (!doi) return "";
  // OpenAlex/S2 sometimes return a full URL; Crossref/PubMed return a bare DOI.
  if (doi.startsWith("http")) return doi;
  return `https://doi.org/${doi.replace(/^doi:/i, "")}`;
}

/** Reconstruct plain text from OpenAlex's abstract_inverted_index. */
function fromInvertedIndex(inv?: Record<string, number[]>): string {
  if (!inv) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions) words[p] = word;
  }
  return clean(words.join(" "));
}

// ---- Crossref -------------------------------------------------------------
interface CrossrefResponse {
  message?: { items?: { title?: string[]; URL?: string; DOI?: string; abstract?: string }[] };
}
const crossref: JournalSearchFn = async (journal, query, limit, opts) => {
  const doFetch = opts.fetchImpl ?? fetch;
  const url =
    `https://api.crossref.org/works?query=${encodeURIComponent(query)}` +
    `&filter=container-title:${encodeURIComponent(journal.crossrefContainer)}` +
    `&rows=${limit}&select=title,DOI,URL,abstract&sort=relevance&mailto=${encodeURIComponent(CONTACT)}`;
  const res = await fetchWithRetry(
    doFetch,
    url,
    { headers: { Accept: "application/json", "User-Agent": `labee-protocol-searcher (mailto:${CONTACT})` } },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (res.status !== 200) throw new Error(`Crossref HTTP ${res.status}`);
  const json = (await res.json()) as CrossrefResponse;
  return (json.message?.items ?? [])
    .map((it) => ({
      title: text(it.title?.[0]),
      url: it.URL ?? doiUrl(it.DOI),
      snippet: clean(it.abstract),
    }))
    .filter((r) => r.title && r.url)
    .slice(0, limit);
};

// ---- Europe PMC -----------------------------------------------------------
interface EuropePmcResponse {
  resultList?: {
    result?: {
      title?: string;
      doi?: string;
      abstractText?: string;
      id?: string;
      pmcid?: string;
      isOpenAccess?: string;
      inEPMC?: string;
    }[];
  };
}
const europepmc: JournalSearchFn = async (journal, query, limit, opts) => {
  const doFetch = opts.fetchImpl ?? fetch;
  const q = `${query} AND JOURNAL:"${journal.europepmcJournal}"`;
  const url =
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}` +
    `&format=json&pageSize=${limit}&resultType=lite`;
  const res = await fetchWithRetry(
    doFetch,
    url,
    { headers: { Accept: "application/json" } },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (res.status !== 200) throw new Error(`Europe PMC HTTP ${res.status}`);
  const json = (await res.json()) as EuropePmcResponse;
  return (json.resultList?.result ?? [])
    .map((r) => {
      const evidence: string[] = [];
      if (r.pmcid) evidence.push(`europepmc:pmcid:${r.pmcid.toUpperCase()}`);
      if (/^(?:y|yes|true|1)$/i.test(r.isOpenAccess ?? "")) evidence.push("europepmc:open-access");
      if (/^(?:y|yes|true|1)$/i.test(r.inEPMC ?? "")) evidence.push("europepmc:fulltext-indexed");
      return {
        title: text(r.title),
        url: r.doi ? doiUrl(r.doi) : r.id ? `https://europepmc.org/article/MED/${r.id}` : "",
        snippet: clean(r.abstractText),
        ...(evidence.length > 0 ? { oaEvidence: evidence } : {}),
      };
    })
    .filter((r) => r.title && r.url)
    .slice(0, limit);
};

// ---- OpenAlex -------------------------------------------------------------
interface OpenAlexResponse {
  results?: {
    display_name?: string;
    doi?: string;
    id?: string;
    abstract_inverted_index?: Record<string, number[]>;
    open_access?: { is_oa?: boolean };
    best_oa_location?: { is_oa?: boolean; landing_page_url?: string; pdf_url?: string } | null;
  }[];
}
const openalex: JournalSearchFn = async (journal, query, limit, opts) => {
  const doFetch = opts.fetchImpl ?? fetch;
  const issnFilter = journal.issn.join("|"); // OpenAlex treats `|` as OR
  const url =
    `https://api.openalex.org/works?search=${encodeURIComponent(query)}` +
    `&filter=primary_location.source.issn:${encodeURIComponent(issnFilter)}` +
    `&per_page=${limit}&mailto=${encodeURIComponent(CONTACT)}`;
  const res = await fetchWithRetry(
    doFetch,
    url,
    { headers: { Accept: "application/json", "User-Agent": `labee-protocol-searcher (mailto:${CONTACT})` } },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (res.status !== 200) throw new Error(`OpenAlex HTTP ${res.status}`);
  const json = (await res.json()) as OpenAlexResponse;
  return (json.results ?? [])
    .map((w) => {
      const evidence: string[] = [];
      if (w.open_access?.is_oa || w.best_oa_location?.is_oa) evidence.push("openalex:open-access");
      const oaUrl = w.best_oa_location?.pdf_url ?? w.best_oa_location?.landing_page_url;
      if (oaUrl) evidence.push(`openalex:oa-url:${oaUrl}`);
      return {
        title: text(w.display_name),
        url: doiUrl(w.doi) || w.id || "",
        snippet: fromInvertedIndex(w.abstract_inverted_index),
        ...(evidence.length > 0 ? { oaEvidence: evidence } : {}),
      };
    })
    .filter((r) => r.title && r.url)
    .slice(0, limit);
};

// ---- Semantic Scholar -----------------------------------------------------
interface SemanticScholarResponse {
  data?: {
    title?: string;
    externalIds?: { DOI?: string };
    url?: string;
    abstract?: string;
    openAccessPdf?: { url?: string; status?: string } | null;
  }[];
}
const semanticscholar: JournalSearchFn = async (journal, query, limit, opts) => {
  const doFetch = opts.fetchImpl ?? fetch;
  const url =
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}` +
    `&venue=${encodeURIComponent(journal.crossrefContainer)}` +
    `&fields=title,externalIds,url,abstract,openAccessPdf&limit=${limit}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY;
  if (key) headers["x-api-key"] = key;
  // A keyless 429 is the shared public quota, not a transient request failure;
  // test the backend once, record it, and move on to the other exhaustive APIs.
  const res = await fetchWithRetry(
    doFetch,
    url,
    { headers },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    { retries: key ? 2 : 0 },
  );
  if (res.status !== 200) throw new Error(`Semantic Scholar HTTP ${res.status}`);
  const json = (await res.json()) as SemanticScholarResponse;
  return (json.data ?? [])
    .map((w) => {
      const evidence = w.openAccessPdf?.url
        ? [`semanticscholar:open-access-pdf:${w.openAccessPdf.url}`]
        : [];
      return {
        title: text(w.title),
        url: doiUrl(w.externalIds?.DOI) || w.url || "",
        snippet: clean(w.abstract),
        ...(evidence.length > 0 ? { oaEvidence: evidence } : {}),
      };
    })
    .filter((r) => r.title && r.url)
    .slice(0, limit);
};

// ---- PubMed (NCBI E-utilities) --------------------------------------------
interface ESearchResponse {
  esearchresult?: { idlist?: string[] };
}
interface ESummaryResponse {
  result?: Record<string, { title?: string; articleids?: { idtype?: string; value?: string }[] }>;
}
const pubmed: JournalSearchFn = async (journal, query, limit, opts) => {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const keyParam = process.env.NCBI_API_KEY ? `&api_key=${process.env.NCBI_API_KEY}` : "";
  const common = `&tool=labee-protocol-searcher&email=${encodeURIComponent(CONTACT)}${keyParam}`;
  const term = `${query} AND "${journal.europepmcJournal}"[Journal]`;
  const esearchUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json` +
    `&retmax=${limit}&term=${encodeURIComponent(term)}${common}`;
  const sres = await fetchWithRetry(doFetch, esearchUrl, { headers: { Accept: "application/json" } }, timeoutMs);
  if (sres.status !== 200) throw new Error(`PubMed esearch HTTP ${sres.status}`);
  const ids = ((await sres.json()) as ESearchResponse).esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];
  const esummaryUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json` +
    `&id=${ids.join(",")}${common}`;
  const ures = await fetchWithRetry(doFetch, esummaryUrl, { headers: { Accept: "application/json" } }, timeoutMs);
  if (ures.status !== 200) throw new Error(`PubMed esummary HTTP ${ures.status}`);
  const result = ((await ures.json()) as ESummaryResponse).result ?? {};
  return ids
    .map((id) => {
      const it = result[id];
      if (!it) return null;
      const doi = (it.articleids ?? []).find((a) => a.idtype === "doi")?.value;
      const pmcid = (it.articleids ?? []).find((a) => a.idtype === "pmc")?.value;
      return {
        title: text(it.title).replace(/\.$/, ""),
        url: doi ? doiUrl(doi) : `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        snippet: "",
        ...(pmcid ? { oaEvidence: [`pubmed:pmcid:${pmcid.toUpperCase()}`] } : {}),
      };
    })
    .filter((r): r is RawResult => Boolean(r && r.title && r.url))
    .slice(0, limit);
};

const PROVIDERS: Record<string, JournalSearchFn> = {
  crossref,
  europepmc,
  openalex,
  semanticscholar,
  pubmed,
};

const DEFAULT_ORDER = ["crossref", "europepmc", "openalex", "semanticscholar", "pubmed"];

/** Active journal-provider ids, in priority order (PROTOCOLS_JOURNAL_PROVIDERS). */
export function journalProviderOrder(): string[] {
  const raw = process.env.PROTOCOLS_JOURNAL_PROVIDERS?.trim();
  if (!raw) return DEFAULT_ORDER;
  const ids = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => PROVIDERS[s]);
  return ids.length > 0 ? ids : DEFAULT_ORDER;
}

function resultKey(result: RawResult): string {
  try {
    const url = new URL(result.url);
    if (url.hostname.toLowerCase() === "doi.org") {
      return `doi:${decodeURIComponent(url.pathname).replace(/^\//, "").toLowerCase()}`;
    }
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return `${result.title.toLowerCase()}|${result.url.toLowerCase()}`;
  }
}

/** Search every active scholarly API, merge unique results, and report coverage. */
export async function searchJournal(
  journal: JournalInfo,
  query: string,
  limit: number,
  opts: ProviderOptions = {},
): Promise<JournalSearchOutcome> {
  const errors: string[] = [];
  const providers: JournalProviderOutcome[] = [];
  const merged = new Map<string, RawResult>();
  const order = journalProviderOrder();
  for (const id of order) {
    const fn = PROVIDERS[id]!;
    const started = Date.now();
    try {
      const results = await fn(journal, query, limit, opts);
      providers.push({ id, status: results.length > 0 ? "ok" : "empty", count: results.length, elapsedMs: Date.now() - started });
      if (results.length === 0) errors.push(`${id}: no results`);
      for (const result of results) {
        const key = resultKey(result);
        const current = merged.get(key);
        const discoveredBy = [...new Set([...(current?.discoveredBy ?? []), id])];
        const oaEvidence = [...new Set([...(current?.oaEvidence ?? []), ...(result.oaEvidence ?? [])])];
        if (!current) {
          merged.set(key, {
            ...result,
            discoveredBy,
            ...(oaEvidence.length > 0 ? { oaEvidence } : {}),
          });
        } else {
          merged.set(key, {
            ...current,
            ...(!current.snippet && result.snippet ? { snippet: result.snippet } : {}),
            discoveredBy,
            ...(oaEvidence.length > 0 ? { oaEvidence } : {}),
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed";
      errors.push(`${id}: ${message}`);
      providers.push({ id, status: "error", count: 0, elapsedMs: Date.now() - started, error: message });
    }
  }
  const successful = providers.filter((provider) => provider.status === "ok").map((provider) => provider.id);
  return {
    results: [...merged.values()],
    source: successful.join("+") || order.at(-1) || "none",
    providers,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

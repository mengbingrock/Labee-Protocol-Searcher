import { decodeEntities, stripTags, fetchWithTimeout, type ProviderOptions, type RawResult } from "./providers/types.ts";

const INDEX = "https://www.morimotolab.org/protocols";
const CATEGORY_PATHS = new Set([
  "/prokaryotic-cells", "/transcriptional-analysis", "/eukaryotic-cells",
  "/nucleic-acid-hybridization", "/protein-biochemistry", "/dna-techniques",
  "/yeast-methods", "/c-elegans-methods", "/rna-techniques", "/general",
]);
const PDF = /^\/_files\/ugd\/[^/?#]+\.pdf$/i;
const TTL_MS = 60 * 60 * 1_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
type CatalogEntry = RawResult & { category: string };
let cached: { until: number; loading: Promise<CatalogEntry[]> } | undefined;

export interface MorimotoSearchOutcome {
  status: "ok" | "error";
  results: RawResult[];
  elapsedMs: number;
  error?: string;
}

function links(html: string, base: string): Array<{ url: URL; title: string }> {
  const found: Array<{ url: URL; title: string }> = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decodeEntities(match[2]!), base);
      // The protocol PDFs are mirrored on this same publisher host. Do not
      // crawl unrelated navigation, user-supplied hosts, or third-party links.
      if (url.origin !== "https://www.morimotolab.org") continue;
      const title = stripTags(match[3]!).replace(/\s+/g, " ").trim();
      if (title) found.push({ url, title });
    } catch { /* Ignore malformed anchors. */ }
  }
  return found;
}

async function loadCatalog(opts: ProviderOptions): Promise<CatalogEntry[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const read = async (url: string): Promise<string> => {
    await opts.validateUrl?.(url);
    const response = await fetchWithTimeout(doFetch, url, {
      headers: { Accept: "text/html" }, redirect: "error",
    }, opts.timeoutMs ?? 12_000);
    if (!response.ok) throw new Error("publisher catalog request failed");
    const length = Number(response.headers.get("content-length"));
    if (length > MAX_HTML_BYTES) throw new Error("publisher catalog too large");
    const html = await response.text();
    if (html.length > MAX_HTML_BYTES) throw new Error("publisher catalog too large");
    return html;
  };
  const categories = [...new Map(links(await read(INDEX), INDEX)
    .filter(link => CATEGORY_PATHS.has(link.url.pathname))
    .map(link => [link.url.pathname, link])).values()];
  if (!categories.length) throw new Error("publisher categories unavailable");
  const results = new Map<string, CatalogEntry>();
  // All advertised categories must load before the catalog is cached, so a
  // failed category cannot silently remove matching protocols from a search.
  for (let start = 0; start < categories.length; start += 3) {
    const group = await Promise.all(categories.slice(start, start + 3).map(async category => ({
      category, html: await read(category.url.href),
    })));
    for (const { category, html } of group) for (const link of links(html, category.url.href)) {
      if (!PDF.test(link.url.pathname)) continue;
      link.url.search = "";
      link.url.hash = "";
      results.set(link.url.href, {
        title: link.title, url: link.url.href, category: category.title,
        snippet: `Morimoto Lab protocol PDF · ${category.title}. Matched against the publisher's document catalog, not PDF full text.`,
        discoveredBy: ["morimoto-lab-catalog"],
      });
    }
  }
  if (!results.size) throw new Error("publisher protocol documents unavailable");
  return [...results.values()];
}

function terms(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase()
    .replace(/polymerase chain reaction/g, "pcr")
    .replace(/caenorhabditis elegans/g, "c elegans");
  return normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
}

const STOP = new Set(["a", "an", "and", "for", "from", "in", "of", "on", "or", "protocol", "protocols", "the", "to", "with"]);

/** Search the publisher's current categorized PDF catalog without a browser. */
export async function searchMorimotoLab(query: string, limit: number, opts: ProviderOptions = {}): Promise<MorimotoSearchOutcome> {
  const started = Date.now();
  try {
    // Injected fetch/policy requests bypass the shared cache for isolation.
    const cacheable = !opts.fetchImpl && !opts.validateUrl;
    if (cacheable && (!cached || cached.until <= Date.now())) {
      const loading = loadCatalog(opts);
      const entry = { until: Date.now() + TTL_MS, loading };
      cached = entry;
      void loading.catch(() => { if (cached === entry) cached = undefined; });
    }
    const catalog = await (cacheable ? cached!.loading : loadCatalog(opts));
    const queryTerms = [...new Set(terms(query).filter(term => !STOP.has(term)))];
    const ranked = catalog.map(entry => {
      const titleTerms = terms(entry.title);
      const title = new Set(titleTerms);
      const combined = new Set([...titleTerms, ...terms(entry.category)]);
      const matched = queryTerms.filter(term => combined.has(term)).length;
      const titleMatched = queryTerms.filter(term => title.has(term)).length;
      return { entry, matched, score: matched * 100 + titleMatched * 20 };
    }).filter(row => !queryTerms.length || row.matched === queryTerms.length)
      .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
    return {
      status: "ok", elapsedMs: Date.now() - started,
      results: ranked.slice(0, limit).map(({ entry: { category: _category, ...result } }) => result),
    };
  } catch {
    return { status: "error", results: [], elapsedMs: Date.now() - started,
      error: "Morimoto Lab protocol catalog could not be loaded completely" };
  }
}

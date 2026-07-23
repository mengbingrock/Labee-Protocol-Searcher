// Unified content retrieval: resolve an id from `search` (or a bare
// DOI / PMID / PMCID / enzyme) to its content, dispatching on the id's scheme.
//
//   rebase:<enzyme|site>   → REBASE structured record   (rebase.ts)
//   doi: / pmid: / pmcid:  → open full text              (fulltext.ts)
//   url:<href>             → extract the page's readable text; sites that refuse
//                            the request (403) degrade to returning the link
//
// Bare ids with no scheme are inferred from their shape, so the model can pass a
// raw DOI, accession, or enzyme name directly. `fetchResources` resolves a
// batch concurrently, returning a per-id row so one bad id never sinks the rest.
// Every result carries a machine-readable `_status: …_` footer.

import type { ProviderOptions } from "./providers/types.ts";
import { findRestrictionEnzyme } from "./rebase.ts";
import { getProtocolFulltext, type FulltextOptions } from "./fulltext.ts";
import { extractOaContent } from "./extract.ts";

const PMCID = /^PMC\d+$/i;
const PMID = /^\d+$/;
const DOI = /^10\.\S+\/\S+/;
const ENZYME_NAME = /^[A-Za-z]{2,}[IVX]+$/;
const IUPAC_SITE = /^[ACGTRYSWKMBDHVN]+$/i;
// A leading URI scheme, e.g. "doi:", "rebase:", "https:".
const SCHEME = /^([a-z][a-z0-9+.-]*):([\s\S]*)$/i;

/** Fetch options: provider knobs plus the JATS `section` filter for full text. */
export type FetchOptions = FulltextOptions;

function withStatus(text: string, status: string): string {
  return `${text}\n\n_status: ${status}_`;
}

function notFetchable(url: string): string {
  return withStatus(
    "This page can't be retrieved automatically — the site refused the request.\n\n" +
      `Open it directly: ${url}`,
    "not-fetchable",
  );
}

/** Max characters of extracted vendor-page text to return. */
const WEB_PAGE_MAX_CHARS = 40_000;

/**
 * Retrieve a vendor/web page's readable text. Some vendors (neb.com) answer a
 * plain request with 403; `extractOaContent` returns null for any non-200 rather
 * than throwing, so those degrade to the bare link instead of failing the call.
 * We make one ordinary request and take no for an answer.
 */
async function fetchWebPage(url: string, opts: FetchOptions): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return notFetchable(url);
  const extracted = await extractOaContent(url, opts, WEB_PAGE_MAX_CHARS);
  if (!extracted?.text?.trim()) return notFetchable(url);
  return withStatus(`_Source: ${url} (${extracted.format} extraction)._\n\n${extracted.text}`, "ok");
}

/** Fetch the content behind a search-result id (or a bare identifier). */
export async function fetchResource(id: string, opts: FetchOptions = {}): Promise<string> {
  const raw = id.trim();
  if (!raw) return "Error: `id` is required.";

  const m = SCHEME.exec(raw);
  const scheme = m ? m[1]!.toLowerCase() : "";
  const rest = (m ? m[2]! : raw).trim();

  switch (scheme) {
    case "rebase":
      return withStatus(await findRestrictionEnzyme(rest, opts), "ok");
    case "doi":
    case "pmid":
    case "pmcid":
      // getProtocolFulltext appends its own (more specific) status footer.
      return getProtocolFulltext(rest, opts);
    case "url":
      return fetchWebPage(rest, opts);
    case "http":
    case "https":
      return fetchWebPage(raw, opts);
  }

  // No recognised scheme — infer from the bare value's shape.
  if (PMCID.test(raw) || PMID.test(raw) || DOI.test(raw)) return getProtocolFulltext(raw, opts);
  if (ENZYME_NAME.test(raw) || IUPAC_SITE.test(raw)) {
    return withStatus(await findRestrictionEnzyme(raw, opts), "ok");
  }
  return withStatus(
    `Unrecognised id "${raw}". Pass an id from \`search\` ` +
      "(`rebase:…`, `doi:…`, `pmid:…`, `pmcid:…`, `url:…`) " +
      "or a bare DOI / PMID / PMCID / enzyme name.",
    "bad-id",
  );
}

export interface FetchRow {
  id: string;
  text: string;
}

/**
 * Resolve a batch of ids concurrently (bounded), returning one row per id in
 * request order. A row that throws is captured as an error message rather than
 * failing the whole batch — mirroring how `search` reports partial results.
 */
export async function fetchResources(ids: readonly string[], opts: FetchOptions = {}): Promise<FetchRow[]> {
  const out: FetchRow[] = Array.from({ length: ids.length });
  let next = 0;
  const concurrency = Math.min(3, ids.length); // gentle on NCBI/EPMC rate limits
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const i = next++;
      if (i >= ids.length) return;
      const id = ids[i]!;
      try {
        out[i] = { id, text: await fetchResource(id, opts) };
      } catch (err) {
        const message = err instanceof Error ? err.message : "fetch failed";
        out[i] = { id, text: withStatus(`Error fetching \`${id}\`: ${message}`, "error") };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

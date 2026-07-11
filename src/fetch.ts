// Unified content retrieval: resolve an id from `search` (or a bare
// DOI / PMID / PMCID / enzyme) to its content, dispatching on the id's scheme.
//
//   rebase:<enzyme|site>   → REBASE structured record   (rebase.ts)
//   doi: / pmid: / pmcid:  → Europe PMC open full text   (fulltext.ts)
//   url:<href>             → not fetchable (the vendor bot-blocks) — return the link
//
// Bare ids with no scheme are inferred from their shape, so the model can pass a
// raw DOI, accession, or enzyme name directly.

import type { ProviderOptions } from "./providers/types.ts";
import { findRestrictionEnzyme } from "./rebase.ts";
import { getProtocolFulltext } from "./fulltext.ts";

const PMCID = /^PMC\d+$/i;
const PMID = /^\d+$/;
const DOI = /^10\.\S+\/\S+/;
const ENZYME_NAME = /^[A-Za-z]{2,}[IVX]+$/;
const IUPAC_SITE = /^[ACGTRYSWKMBDHVN]+$/i;
// A leading URI scheme, e.g. "doi:", "rebase:", "https:".
const SCHEME = /^([a-z][a-z0-9+.-]*):([\s\S]*)$/i;

function notFetchable(url: string): string {
  return (
    "This page can't be retrieved automatically — the site bot-blocks direct requests.\n\n" +
    `Open it directly: ${url}`
  );
}

/** Fetch the content behind a search-result id (or a bare identifier). */
export async function fetchResource(id: string, opts: ProviderOptions = {}): Promise<string> {
  const raw = id.trim();
  if (!raw) return "Error: `id` is required.";

  const m = SCHEME.exec(raw);
  const scheme = m ? m[1]!.toLowerCase() : "";
  const rest = (m ? m[2]! : raw).trim();

  switch (scheme) {
    case "rebase":
      return findRestrictionEnzyme(rest, opts);
    case "doi":
    case "pmid":
    case "pmcid":
      return getProtocolFulltext(rest, opts);
    case "url":
      return notFetchable(rest);
    case "http":
    case "https":
      return notFetchable(raw);
  }

  // No recognised scheme — infer from the bare value's shape.
  if (PMCID.test(raw) || PMID.test(raw) || DOI.test(raw)) return getProtocolFulltext(raw, opts);
  if (ENZYME_NAME.test(raw) || IUPAC_SITE.test(raw)) return findRestrictionEnzyme(raw, opts);
  return (
    `Unrecognised id "${raw}". Pass an id from \`search\` ` +
    "(`rebase:…`, `doi:…`, `pmid:…`, `pmcid:…`, `url:…`) " +
    "or a bare DOI / PMID / PMCID / enzyme name."
  );
}

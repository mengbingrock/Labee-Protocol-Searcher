// Open-access full-text retrieval via Europe PMC. Publisher/vendor sites
// bot-block automated fetches, so instead of scraping a protocol/methods page
// we pull the real article text from Europe PMC's structured REST API — the
// same service journals.ts already searches.
//
// Two steps, tiered like established biomedical MCP tools (fall through to a
// citation when open text isn't available):
//   1. Resolve the caller's id (DOI / PMID / PMCID) to a PMCID via the search
//      API (SRC/EXT_ID/DOI/pmcid fields).
//   2. GET {source}/{pmcid}/fullTextXML and strip the JATS XML to plain text.
// If there is no open-access full text, return the article link so the model
// still has a citation.

import { type ProviderOptions, fetchWithRetry, stripTags } from "./providers/types.ts";

const SEARCH_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const FULLTEXT_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_CHARS = 20000; // keep the tool result model-friendly

interface EpmcResult {
  id?: string;
  source?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
}
interface EpmcSearchResponse {
  resultList?: { result?: EpmcResult[] };
}

/** Build the Europe PMC search query that best resolves a raw identifier. */
function resolveQuery(id: string): string {
  const s = id.trim();
  if (/^PMC\d+$/i.test(s)) return `PMCID:${s.toUpperCase()}`;
  if (/^\d+$/.test(s)) return `EXT_ID:${s} AND SRC:MED`; // bare PMID
  if (/^10\.\S+\/\S+/.test(s) || s.toLowerCase().startsWith("doi:")) {
    return `DOI:"${s.replace(/^doi:/i, "")}"`;
  }
  return s; // best-effort free-text
}

/** Human-facing citation link for an article we couldn't get full text for. */
function articleUrl(r: EpmcResult, fallbackId: string): string {
  if (r.doi) return `https://doi.org/${r.doi}`;
  if (r.pmcid) return `https://europepmc.org/article/PMC/${r.pmcid}`;
  if (r.source && r.id) return `https://europepmc.org/article/${r.source}/${r.id}`;
  return `https://europepmc.org/search?query=${encodeURIComponent(fallbackId)}`;
}

/** Extract the JATS <body> if present, else the whole document, as plain text. */
function xmlToText(xml: string): string {
  const body = /<body[\s>]([\s\S]*?)<\/body>/i.exec(xml);
  const text = stripTags(body ? body[1]! : xml);
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n\n…[truncated; full text at the article link]`
    : text;
}

/**
 * Fetch open-access full text for a DOI / PMID / PMCID from Europe PMC and
 * return it as markdown. Falls back to a citation link when no open text is
 * available. Never throws for the "unavailable" case — only for hard fetch
 * failures the caller reports as a tool error.
 */
export async function getProtocolFulltext(
  id: string,
  opts: ProviderOptions = {},
): Promise<string> {
  const trimmed = id.trim();
  if (!trimmed) return "Error: `id` is required (a DOI, PMID, or PMCID).";
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // --- Step 1: resolve to a PMCID. ---
  const url =
    `${SEARCH_BASE}?query=${encodeURIComponent(resolveQuery(trimmed))}` +
    `&format=json&pageSize=1&resultType=lite`;
  const sres = await fetchWithRetry(doFetch, url, { headers: { Accept: "application/json" } }, timeoutMs);
  if (sres.status !== 200) throw new Error(`Europe PMC HTTP ${sres.status}`);
  const result = ((await sres.json()) as EpmcSearchResponse).resultList?.result?.[0];
  if (!result) {
    return `No Europe PMC record found for "${trimmed}". It may not be indexed; try a DOI, PMID, or PMCID.`;
  }

  const title = (result.title ?? "").replace(/<[^>]+>/g, "").trim();
  const heading = `# ${title || trimmed}`;
  const pmcid = result.pmcid;
  if (!pmcid) {
    return (
      `${heading}\n\nNo open-access full text is available for this article via Europe PMC.\n\n` +
      `Read it at: ${articleUrl(result, trimmed)}`
    );
  }

  // --- Step 2: fetch and strip the JATS full text. ---
  // The full-text endpoint is a single PMC-prefixed segment, e.g.
  // /webservices/rest/PMC11000335/fullTextXML (not /PMC/{id}/…).
  const ftUrl = `${FULLTEXT_BASE}/${pmcid}/fullTextXML`;
  const fres = await fetchWithRetry(doFetch, ftUrl, { headers: { Accept: "application/xml" } }, timeoutMs);
  if (fres.status !== 200) {
    return (
      `${heading}\n\nOpen-access full text could not be retrieved (Europe PMC HTTP ${fres.status}).\n\n` +
      `Read it at: ${articleUrl(result, trimmed)}`
    );
  }
  const xml = await fres.text();
  const text = xmlToText(xml);
  if (!text) {
    return `${heading}\n\nFull text was empty. Read it at: ${articleUrl(result, trimmed)}`;
  }
  return `${heading}\n\n_Source: Europe PMC open-access full text (${pmcid})._\n\n${text}`;
}

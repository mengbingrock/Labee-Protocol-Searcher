// Open-access full-text retrieval. Publisher/vendor sites bot-block automated
// fetches, so instead of scraping a protocol/methods page we pull the real
// article text from open, structured APIs — the same services journals.ts
// already searches.
//
// A tiered chain, like established biomedical MCP tools (fall through until we
// get open text, then to a citation link):
//   1. Resolve the caller's id (DOI / PMID / PMCID) to a PMCID via Europe PMC.
//   2. GET {source}/{pmcid}/fullTextXML and render the JATS to section-aware
//      markdown (procedure sections first; optional single-section filter).
//   3. No PMCID (or the XML failed)? Ask Unpaywall for an open-access copy — it
//      often points back at a PMC record we can still render, or at least a
//      direct OA link that beats a paywalled DOI.
// Every path ends with a machine-readable `_status: …_` footer so the agent can
// branch on the outcome without parsing prose.

import { type ProviderOptions, fetchWithRetry, stripTags } from "./providers/types.ts";
import { extractOaContent } from "./extract.ts";

const SEARCH_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const FULLTEXT_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const UNPAYWALL_BASE = "https://api.unpaywall.org/v2";
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_CHARS = 20000; // keep the tool result model-friendly

// Unpaywall requires a contact email; the same one journals.ts uses for polite
// pools. Read lazily (not at module load) so a `.env` loaded at startup applies.
// With the default placeholder Unpaywall 422s and we simply skip the tier.
function contactEmail(): string {
  return process.env.PROTOCOLS_CONTACT_EMAIL || "labee-protocol-searcher@example.com";
}

/** Extending ProviderOptions: `section` filters JATS full text to one section. */
export interface FulltextOptions extends ProviderOptions {
  /** Case-insensitive substring; return only sections whose title matches. */
  section?: string;
}

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

/** Machine-readable status footer the agent can branch on. */
function withStatus(text: string, status: string): string {
  return `${text}\n\n_status: ${status}_`;
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

// --- JATS section parsing --------------------------------------------------
// PubMed's JATS <body> nests <sec> elements, each with an optional <title>.
// Regex can't match balanced nested tags, so we scan for <sec>/</sec> tokens
// and track depth to carve out top-level sections, then recurse.

const SEC_TOKEN = /<sec\b[^>]*>|<\/sec>/gi;

interface SecRange {
  /** Index of the opening `<sec>` tag. */
  blockStart: number;
  /** Index just past the opening tag (start of inner content). */
  innerStart: number;
  /** Index of the closing `</sec>` tag (end of inner content). */
  innerEnd: number;
  /** Index just past the closing tag. */
  blockEnd: number;
}

/** Ranges of the top-level (depth-0) <sec>…</sec> blocks in `xml`. */
function topSecRanges(xml: string): SecRange[] {
  const ranges: SecRange[] = [];
  let depth = 0;
  let blockStart = -1;
  let innerStart = -1;
  SEC_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEC_TOKEN.exec(xml))) {
    const isClose = m[0][1] === "/";
    if (!isClose) {
      if (depth === 0) {
        blockStart = m.index;
        innerStart = m.index + m[0].length;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && blockStart !== -1) {
        ranges.push({ blockStart, innerStart, innerEnd: m.index, blockEnd: m.index + m[0].length });
        blockStart = -1;
      }
    }
  }
  return ranges;
}

/** Inner contents of each top-level <sec>. */
function topSecs(xml: string): string[] {
  return topSecRanges(xml).map((r) => xml.slice(r.innerStart, r.innerEnd));
}

/** Remove the top-level <sec>…</sec> blocks, leaving only this level's markup. */
function stripTopSecs(xml: string): string {
  const ranges = topSecRanges(xml);
  if (ranges.length === 0) return xml;
  let out = "";
  let last = 0;
  for (const r of ranges) {
    out += xml.slice(last, r.blockStart);
    last = r.blockEnd;
  }
  out += xml.slice(last);
  return out;
}

interface FlatSection {
  title: string;
  text: string;
  depth: number;
}

/** Flatten a <sec> block (and its children) into ordered, depth-tagged rows. */
function flattenSec(inner: string, depth: number, out: FlatSection[]): void {
  const titleM = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(inner);
  const title = titleM ? stripTags(titleM[1]!) : "";
  const children = topSecs(inner);
  // This level's own text: drop nested sections and the leading title.
  let self = stripTopSecs(inner);
  if (titleM) self = self.replace(titleM[0], "");
  const text = stripTags(self);
  out.push({ title, text, depth });
  for (const c of children) flattenSec(c, depth + 1, out);
}

// Sections a protocol reader almost always wants first when space is tight.
const PROCEDURE_RE = /method|protocol|procedure|step|materials|reagent|prepar|assay|workflow/i;

/**
 * Render JATS full text to markdown. With `section`, returns only matching
 * sections (and lists the titles when nothing matches). Otherwise renders all
 * sections in document order, but when the budget is exceeded keeps procedure
 * sections and drops the rest, naming what was omitted so the agent can
 * re-fetch a specific section.
 */
function jatsToMarkdown(xml: string, section: string | undefined, maxChars: number): string {
  const bodyM = /<body[\s>]([\s\S]*?)<\/body>/i.exec(xml);
  const body = bodyM ? bodyM[1]! : xml;

  const flat: FlatSection[] = [];
  for (const s of topSecs(body)) flattenSec(s, 2, flat);

  // No structured sections — fall back to a flat strip of the whole body.
  if (flat.length === 0) {
    const text = stripTags(body);
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n\n…[truncated; full text at the article link]`
      : text;
  }

  if (section) {
    const q = section.toLowerCase();
    const hits = flat.filter((s) => s.title.toLowerCase().includes(q));
    if (hits.length === 0) {
      const titles = flat.filter((s) => s.title).map((s) => s.title).join(" · ") || "(untitled)";
      return `No section matching "${section}". Available sections: ${titles}.`;
    }
    return renderSections(hits, maxChars).markdown;
  }

  // Full render; if over budget, prefer procedure sections and report the rest.
  const { markdown, omitted } = renderSections(flat, maxChars);
  const toc =
    flat.length > 1
      ? `_Sections: ${flat.filter((s) => s.title).map((s) => s.title).join(" · ")}._\n\n`
      : "";
  const tail =
    omitted.length > 0
      ? `\n\n…[${omitted.length} section(s) omitted for length: ${omitted.join(" · ")}. ` +
        "Re-fetch with `section` to read one in full.]"
      : "";
  return `${toc}${markdown}${tail}`;
}

/** Concatenate sections within a char budget, keeping procedure ones first. */
function renderSections(
  sections: FlatSection[],
  maxChars: number,
): { markdown: string; omitted: string[] } {
  const ordered = [...sections].sort((a, b) => {
    const ap = PROCEDURE_RE.test(a.title) ? 0 : 1;
    const bp = PROCEDURE_RE.test(b.title) ? 0 : 1;
    return ap - bp; // stable within each group → document order preserved
  });
  const rendered = new Array<string | null>(sections.length).fill(null);
  const omitted: string[] = [];
  let used = 0;
  for (const s of ordered) {
    const idx = sections.indexOf(s);
    const head = s.title ? `${"#".repeat(Math.min(s.depth, 6))} ${s.title}` : "";
    const block = [head, s.text].filter(Boolean).join("\n\n");
    if (!block) continue;
    if (used > 0 && used + block.length > maxChars) {
      omitted.push(s.title || "(untitled)");
      continue;
    }
    rendered[idx] = block;
    used += block.length + 2;
  }
  // Re-emit in original document order.
  const markdown = rendered.filter((b): b is string => b !== null).join("\n\n");
  return { markdown, omitted };
}

// --- Unpaywall fallback tier -----------------------------------------------
interface OaLocation {
  url?: string;
  url_for_pdf?: string;
  license?: string;
  version?: string;
}
interface UnpaywallResponse {
  is_oa?: boolean;
  best_oa_location?: OaLocation | null;
  oa_locations?: OaLocation[];
}
interface UnpaywallHit {
  pmcid?: string | undefined;
  oaUrl?: string | undefined;
  license?: string | undefined;
  version?: string | undefined;
}

/**
 * Ask Unpaywall for an open-access copy of a DOI. Prefers a location we can
 * still render (one bearing a PMCID → re-resolvable to fullTextXML); otherwise
 * returns the best direct OA link. Never throws — a miss just returns null.
 */
async function tryUnpaywall(
  doi: string | undefined,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<UnpaywallHit | null> {
  if (!doi) return null;
  try {
    const url = `${UNPAYWALL_BASE}/${encodeURIComponent(doi)}?email=${encodeURIComponent(contactEmail())}`;
    const res = await fetchWithRetry(doFetch, url, { headers: { Accept: "application/json" } }, timeoutMs, {
      retries: 1,
    });
    if (res.status !== 200) return null;
    const json = (await res.json()) as UnpaywallResponse;
    if (!json.is_oa) return null;
    const locs = [json.best_oa_location, ...(json.oa_locations ?? [])].filter(
      (l): l is OaLocation => Boolean(l),
    );
    for (const loc of locs) {
      const pmc = /(PMC\d+)/i.exec(`${loc.url ?? ""} ${loc.url_for_pdf ?? ""}`);
      if (pmc) return { pmcid: pmc[1]!.toUpperCase(), license: loc.license, version: loc.version };
    }
    const best = json.best_oa_location ?? locs[0];
    const link = best?.url_for_pdf ?? best?.url;
    if (link) return { oaUrl: link, license: best?.license, version: best?.version };
    return null;
  } catch {
    return null;
  }
}

/** GET a PMCID's JATS full text and render it, or return null if unavailable. */
async function fetchPmcFulltext(
  pmcid: string,
  doFetch: typeof fetch,
  timeoutMs: number,
  section: string | undefined,
): Promise<string | null> {
  // The full-text endpoint is a single PMC-prefixed segment, e.g.
  // /webservices/rest/PMC11000335/fullTextXML (not /PMC/{id}/…).
  const ftUrl = `${FULLTEXT_BASE}/${pmcid}/fullTextXML`;
  const res = await fetchWithRetry(doFetch, ftUrl, { headers: { Accept: "application/xml" } }, timeoutMs);
  if (res.status !== 200) return null;
  const text = jatsToMarkdown(await res.text(), section, MAX_CHARS);
  return text || null;
}

/** DOI for an id: from the resolved record, or the id itself if DOI-shaped. */
function doiFor(result: EpmcResult, id: string): string | undefined {
  if (result.doi) return result.doi;
  const m = /(10\.\S+\/\S+)/.exec(id.replace(/^doi:/i, ""));
  return m ? m[1] : undefined;
}

/**
 * Fetch open-access full text for a DOI / PMID / PMCID and return it as
 * markdown, falling back through Unpaywall to a citation link. Never throws for
 * the "unavailable" case — only for hard fetch failures the caller reports as a
 * tool error.
 */
export async function getProtocolFulltext(
  id: string,
  opts: FulltextOptions = {},
): Promise<string> {
  const trimmed = id.trim();
  if (!trimmed) return "Error: `id` is required (a DOI, PMID, or PMCID).";
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const section = opts.section;

  // --- Step 1: resolve to a Europe PMC record (→ PMCID / DOI). ---
  const url =
    `${SEARCH_BASE}?query=${encodeURIComponent(resolveQuery(trimmed))}` +
    `&format=json&pageSize=1&resultType=lite`;
  const sres = await fetchWithRetry(doFetch, url, { headers: { Accept: "application/json" } }, timeoutMs);
  if (sres.status !== 200) throw new Error(`Europe PMC HTTP ${sres.status}`);
  const result = ((await sres.json()) as EpmcSearchResponse).resultList?.result?.[0];
  if (!result) {
    return withStatus(
      `No Europe PMC record found for "${trimmed}". It may not be indexed; try a DOI, PMID, or PMCID.`,
      "not-found",
    );
  }

  const title = (result.title ?? "").replace(/<[^>]+>/g, "").trim();
  const heading = `# ${title || trimmed}`;
  const doi = doiFor(result, trimmed);

  // --- Step 2: Europe PMC open-access full text, if a PMCID is present. ---
  if (result.pmcid) {
    const text = await fetchPmcFulltext(result.pmcid, doFetch, timeoutMs, section);
    if (text) {
      return withStatus(
        `${heading}\n\n_Source: Europe PMC open-access full text (${result.pmcid})._\n\n${text}`,
        "ok",
      );
    }
    // XML endpoint failed — fall through to Unpaywall before giving up.
  }

  // --- Step 3: Unpaywall — recover a PMC copy, else a direct OA link. ---
  const oa = await tryUnpaywall(doi, doFetch, timeoutMs);
  if (oa?.pmcid) {
    const text = await fetchPmcFulltext(oa.pmcid, doFetch, timeoutMs, section);
    if (text) {
      const lic = oa.license ? ` · ${oa.license}` : "";
      return withStatus(
        `${heading}\n\n_Source: Unpaywall → Europe PMC open-access full text (${oa.pmcid}${lic})._\n\n${text}`,
        "ok",
      );
    }
  }
  if (oa?.oaUrl) {
    const meta = [oa.version, oa.license].filter(Boolean).join(", ");
    // Try to extract the OA copy's actual text (HTML/XML always; PDF if `unpdf`
    // is installed). On any failure, fall back to just handing back the link.
    const extracted = await extractOaContent(oa.oaUrl, { fetchImpl: doFetch, timeoutMs }, MAX_CHARS);
    if (extracted) {
      return withStatus(
        `${heading}\n\n_Source: Unpaywall open-access ${extracted.format}, best-effort extraction ` +
          `from ${oa.oaUrl}${meta ? ` (${meta})` : ""}._\n\n${extracted.text}`,
        "ok",
      );
    }
    return withStatus(
      `${heading}\n\nNo machine-readable full text, but Unpaywall found an open-access copy` +
        `${meta ? ` (${meta})` : ""}:\n\n${oa.oaUrl}\n\n` +
        `Citation: ${articleUrl(result, trimmed)}`,
      "oa-link",
    );
  }

  // --- No open text anywhere: return a citation link. ---
  return withStatus(
    `${heading}\n\nNo open-access full text is available for this article via Europe PMC or Unpaywall.\n\n` +
      `Read it at: ${articleUrl(result, trimmed)}`,
    "no-open-fulltext",
  );
}

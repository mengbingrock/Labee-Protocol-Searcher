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
//   3. Europe PMC 404s? Ask NCBI E-utilities for the same PMCID. Europe PMC
//      serves only its open-access subset, while NCBI also serves author
//      manuscripts — for Nature Protocols that's the difference between 35
//      articles and ~1,050, and measured over 25 PMC-deposited protocols the
//      Europe PMC endpoint returned a body for 0 and NCBI for 20.
//   4. Still nothing? Ask Unpaywall for an open-access copy — it often points
//      back at a PMC record we can still render, or at least a direct OA link
//      that beats a paywalled DOI.
//   5. No open text at all? Return the abstract, which Europe PMC hands us in
//      step 1 for essentially every indexed article. A paywalled protocol still
//      yields its aim, principle and timing — far more use than a bare link.
// Every path ends with a machine-readable `_status: …_` footer so the agent can
// branch on the outcome without parsing prose.
//
// Nothing here works around an access control: NCBI itself withholds the body
// for articles whose publisher opted out of XML download, and we report that
// case as an abstract rather than reaching for the publisher's HTML.

import { type ProviderOptions, fetchWithRetry, stripTags } from "./providers/types.ts";
import { extractOaContent } from "./extract.ts";

const SEARCH_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const FULLTEXT_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const UNPAYWALL_BASE = "https://api.unpaywall.org/v2";
// NCBI asks every client to identify itself; `tool` must be stable and
// space-free. Their guidelines allow 3 requests/second, or 10 with an API key —
// `fetch` makes one call per user request, so neither is close to binding.
const NCBI_TOOL = "labee-protocol-searcher";
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
  /** Present on `resultType=core` for essentially every indexed article. */
  abstractText?: string;
  meshHeadingList?: { meshHeading?: { descriptorName?: string }[] };
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
 * The PMCID in an Unpaywall location URL. Unpaywall writes PMC links both ways —
 * `/pmc/articles/PMC3868217` and, for older records, `/pmc/articles/3004291` —
 * and missing the bare form sends us scraping the PMC website (which answers
 * with a bot challenge) instead of asking an API for the same article.
 */
export function pmcidFromUrl(url: string): string | undefined {
  const prefixed = /(PMC\d+)/i.exec(url);
  if (prefixed) return prefixed[1]!.toUpperCase();
  const bare = /\/pmc\/articles\/(\d+)/i.exec(url);
  return bare ? `PMC${bare[1]}` : undefined;
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
      const pmcid = pmcidFromUrl(`${loc.url ?? ""} ${loc.url_for_pdf ?? ""}`);
      if (pmcid) return { pmcid, license: loc.license, version: loc.version };
    }
    const best = json.best_oa_location ?? locs[0];
    const link = best?.url_for_pdf ?? best?.url;
    if (link) return { oaUrl: link, license: best?.license, version: best?.version };
    return null;
  } catch {
    return null;
  }
}

/** A rendered full text plus the service that served it, for the source line. */
interface PmcText {
  markdown: string;
  via: "Europe PMC" | "NCBI E-utilities";
}

/** GET a PMCID's JATS from Europe PMC and render it, or null if unavailable. */
async function fetchEpmcFulltext(
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

/**
 * The same PMCID from NCBI, which serves author manuscripts Europe PMC's
 * open-access endpoint 404s on. When the publisher has opted out of XML
 * download NCBI returns the record without a `<body>` (and says so in a
 * comment) — that's a miss, not text, so require a body before rendering.
 */
async function fetchNcbiFulltext(
  pmcid: string,
  doFetch: typeof fetch,
  timeoutMs: number,
  section: string | undefined,
): Promise<string | null> {
  const key = process.env.NCBI_API_KEY ? `&api_key=${process.env.NCBI_API_KEY}` : "";
  const url =
    `${EUTILS_BASE}/efetch.fcgi?db=pmc&retmode=xml&id=${encodeURIComponent(pmcid.replace(/^PMC/i, ""))}` +
    `&tool=${NCBI_TOOL}&email=${encodeURIComponent(contactEmail())}${key}`;
  const res = await fetchWithRetry(doFetch, url, { headers: { Accept: "application/xml" } }, timeoutMs);
  if (res.status !== 200) return null;
  const xml = await res.text();
  if (!/<body[\s>]/i.test(xml)) return null;
  const text = jatsToMarkdown(xml, section, MAX_CHARS);
  return text || null;
}

/** Europe PMC first (it's the OA-licensed copy), then NCBI for manuscripts. */
async function fetchPmcFulltext(
  pmcid: string,
  doFetch: typeof fetch,
  timeoutMs: number,
  section: string | undefined,
): Promise<PmcText | null> {
  const epmc = await fetchEpmcFulltext(pmcid, doFetch, timeoutMs, section);
  if (epmc) return { markdown: epmc, via: "Europe PMC" };
  const ncbi = await fetchNcbiFulltext(pmcid, doFetch, timeoutMs, section);
  if (ncbi) return { markdown: ncbi, via: "NCBI E-utilities" };
  return null;
}

/**
 * The abstract Europe PMC already returned in step 1, as a last resort before a
 * bare link. Costs no extra request — `resultType=core` carries it — and for a
 * paywalled protocol it still states the aim, principle and typical timing.
 */
function abstractBlock(result: EpmcResult): string | null {
  const abstract = stripTags(result.abstractText ?? "").trim();
  if (abstract.length < 100) return null; // a stub abstract isn't worth a tier
  const mesh = (result.meshHeadingList?.meshHeading ?? [])
    .map((m) => m.descriptorName)
    .filter((d): d is string => Boolean(d));
  const meshLine = mesh.length > 0 ? `\n\n_MeSH: ${mesh.slice(0, 12).join(" · ")}._` : "";
  const body = abstract.length > MAX_CHARS ? `${abstract.slice(0, MAX_CHARS)}…` : abstract;
  return `## Abstract\n\n${body}${meshLine}`;
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

  // --- Step 1: resolve to a Europe PMC record (→ PMCID / DOI / abstract). ---
  // `core` rather than `lite`: same single request, but it carries the abstract
  // and MeSH terms that the last tier falls back on.
  const url =
    `${SEARCH_BASE}?query=${encodeURIComponent(resolveQuery(trimmed))}` +
    `&format=json&pageSize=1&resultType=core`;
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

  // --- Step 2: PMC full text — Europe PMC's OA subset, then NCBI. ---
  if (result.pmcid) {
    const hit = await fetchPmcFulltext(result.pmcid, doFetch, timeoutMs, section);
    if (hit) {
      return withStatus(
        `${heading}\n\n_Source: ${hit.via} full text (${result.pmcid})._\n\n${hit.markdown}`,
        "ok",
      );
    }
    // Both PMC endpoints declined — fall through before giving up.
  }

  // --- Step 3: Unpaywall — recover a PMC copy, else a direct OA link. ---
  const oa = await tryUnpaywall(doi, doFetch, timeoutMs);
  if (oa?.pmcid) {
    const hit = await fetchPmcFulltext(oa.pmcid, doFetch, timeoutMs, section);
    if (hit) {
      const lic = oa.license ? ` · ${oa.license}` : "";
      return withStatus(
        `${heading}\n\n_Source: Unpaywall → ${hit.via} full text (${oa.pmcid}${lic})._\n\n${hit.markdown}`,
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

  // --- Step 4: the abstract, which beats a bare link for a paywalled article. ---
  const pmcNote = result.pmcid
    ? `\n\nA PMC copy exists and is free to read in a browser, though its full text isn't served ` +
      `for download: https://www.ncbi.nlm.nih.gov/pmc/articles/${result.pmcid}/`
    : "";
  const abstract = abstractBlock(result);
  if (abstract) {
    return withStatus(
      `${heading}\n\n_Source: Europe PMC abstract — no open-access full text for this article._\n\n` +
        `${abstract}${pmcNote}\n\nRead the full protocol at: ${articleUrl(result, trimmed)}`,
      "abstract-only",
    );
  }

  // --- No open text and no abstract: return a citation link. ---
  return withStatus(
    `${heading}\n\nNo open-access full text is available for this article via Europe PMC, NCBI or Unpaywall.` +
      `${pmcNote}\n\nRead it at: ${articleUrl(result, trimmed)}`,
    "no-open-fulltext",
  );
}

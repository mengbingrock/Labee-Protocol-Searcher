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
import { extractEntitledArticle, extractOaContent, looksLikeBotWall } from "./extract.ts";
import { institutionName, networkContext, onAcademicNetwork } from "./network-context.ts";
import { cachedEntitlement, entitlementKey, rememberEntitlement } from "./entitlement.ts";

const SEARCH_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const FULLTEXT_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const UNPAYWALL_BASE = "https://api.unpaywall.org/v2";
const OPENALEX_BASE = "https://api.openalex.org/works";
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
  /** Europe PMC's own list of where the full text can be read. */
  fullTextUrlList?: {
    fullTextUrl?: { availability?: string; documentStyle?: string; url?: string }[];
  };
  /** "Y" only for the PMC Open Access Subset — see displayOnlyPdfUrl(). */
  isOpenAccess?: string;
  inEPMC?: string;
  /** Entitlement is per journal, not per publisher, so the title is the cache key. */
  journalInfo?: { journal?: { title?: string } };
}
interface EpmcSearchResponse {
  resultList?: { result?: EpmcResult[] };
}

/** Machine-readable status footer the agent can branch on. */
function withStatus(text: string, status: string): string {
  return `${text}\n\n_status: ${status}_`;
}

/**
 * Europe PMC's rendered PDF for an article that is free to read but sits outside
 * the Open Access Subset.
 *
 * These are records with `inEPMC: Y` and `isOpenAccess: N`: the publisher granted
 * PMC the right to *display* the full text, but not the redistribution licence
 * that puts an article in the OA subset. Consequently the `fullTextXML` endpoint
 * and NCBI's OA service both decline it (`idIsNotOpenAccess`) — which is why the
 * tiers above come up empty — while Europe PMC still lists a "Free pdf" URL that
 * any browser can open.
 *
 * Retrieving it circumvents no authentication, paywall or challenge; the flag it
 * disregards is about redistribution rights, not access. That is a licence
 * judgement rather than a technical one, so it is opt-out-able:
 * PROTOCOLS_DISPLAY_ONLY_FETCH=off. The result is labelled `display-only-full-text`
 * so it is never mistaken for open-access content that may be redistributed.
 */
export function displayOnlyPdfUrl(result: {
  pmcid?: string;
  isOpenAccess?: string;
  inEPMC?: string;
  fullTextUrlList?: {
    fullTextUrl?: { availability?: string; documentStyle?: string; url?: string }[];
  };
}): string | null {
  if (!result.pmcid) return null;
  if (result.isOpenAccess === "Y") return null; // the OA tiers above own this case
  if (result.inEPMC !== "Y") return null;
  const advertisesFreePdf = (result.fullTextUrlList?.fullTextUrl ?? []).some(
    (u) => u.availability?.startsWith("Free") && u.documentStyle === "pdf",
  );
  if (!advertisesFreePdf) return null;
  return `https://europepmc.org/articles/${result.pmcid}?pdf=render`;
}

/**
 * Publishers that serve the article PDF from a stable, public URL derivable from
 * the DOI.
 *
 * Bio-protocol is the motivating case: its HTML article page sits behind a
 * SafeLine WAF challenge that no automated client can pass, while the PDF itself
 * is served straight from `en.bio-protocol.org/pdf/` with no gate at all. The
 * articles are CC BY-NC, so this is the publisher's own open copy — a different
 * endpoint, not a way around the challenge.
 *
 * Add a publisher here only when the mapping is deterministic and the content is
 * openly licensed.
 */
const DIRECT_PDF: { re: RegExp; build: (m: RegExpMatchArray) => string }[] = [
  {
    // 10.21769/BioProtoc.5775 → https://en.bio-protocol.org/pdf/Bio-protocol5775.pdf
    re: /^10\.21769\/bioprotoc\.(\d+)$/i,
    build: (m) => `https://en.bio-protocol.org/pdf/Bio-protocol${m[1]}.pdf`,
  },
];

export function directPdfUrl(doi: string | undefined): string | null {
  if (!doi) return null;
  const clean = doi.trim().replace(/^doi:/i, "");
  for (const { re, build } of DIRECT_PDF) {
    const m = clean.match(re);
    if (m) return build(m);
  }
  return null;
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

interface OpenAlexLocation {
  landing_page_url?: string | null;
  pdf_url?: string | null;
  license?: string | null;
  version?: string | null;
}

interface OpenAlexWork {
  open_access?: {
    is_oa?: boolean;
    oa_status?: string | null;
    oa_url?: string | null;
  };
  best_oa_location?: OpenAlexLocation | null;
  locations?: OpenAlexLocation[];
}

interface OpenAlexHit {
  pmcid?: string;
  oaUrl: string;
  license?: string;
  version?: string;
  oaStatus?: string;
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
      if (pmcid) {
        return {
          pmcid,
          ...(loc.url_for_pdf ?? loc.url ? { oaUrl: loc.url_for_pdf ?? loc.url } : {}),
          license: loc.license,
          version: loc.version,
        };
      }
    }
    const best = json.best_oa_location ?? locs[0];
    const link = best?.url_for_pdf ?? best?.url;
    if (link) return { oaUrl: link, license: best?.license, version: best?.version };
    return null;
  } catch {
    return null;
  }
}

/**
 * OpenAlex is deliberately a late metadata fallback. Newly deposited PMC copies
 * can appear there before Europe PMC adds a PMCID to its search record (Current
 * Protocols e70422 is a measured example). OpenAlex does not serve the article;
 * it only lets us retain the public repository URL instead of incorrectly
 * concluding that no copy exists.
 */
async function tryOpenAlex(
  doi: string | undefined,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<OpenAlexHit | null> {
  if (!doi) return null;
  try {
    const id = `https://doi.org/${doi}`;
    const url = `${OPENALEX_BASE}/${encodeURIComponent(id)}?mailto=${encodeURIComponent(contactEmail())}`;
    const res = await fetchWithRetry(
      doFetch,
      url,
      { headers: { Accept: "application/json" } },
      timeoutMs,
      { retries: 1 },
    );
    if (res.status !== 200) return null;
    const json = (await res.json()) as OpenAlexWork;
    if (!json.open_access?.is_oa) return null;

    const locations = [json.best_oa_location, ...(json.locations ?? [])].filter(
      (location): location is OpenAlexLocation => Boolean(location),
    );
    const urlCandidates = [
      json.open_access.oa_url,
      ...locations.flatMap((location) => [location.pdf_url, location.landing_page_url]),
    ].filter((candidate): candidate is string => Boolean(candidate));
    const oaUrl = urlCandidates.find((candidate) => Boolean(pmcidFromUrl(candidate))) ?? urlCandidates[0];
    if (!oaUrl) return null;

    const selected = locations.find(
      (location) => location.pdf_url === oaUrl || location.landing_page_url === oaUrl,
    );
    const license = selected?.license?.trim() || undefined;
    const version = selected?.version?.trim() || undefined;
    const pmcid = pmcidFromUrl(oaUrl);
    return {
      oaUrl,
      ...(pmcid ? { pmcid } : {}),
      ...(license ? { license } : {}),
      ...(version ? { version } : {}),
      ...(json.open_access.oa_status ? { oaStatus: json.open_access.oa_status } : {}),
    };
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

function displayOnlyEnabled(): boolean {
  return process.env.PROTOCOLS_DISPLAY_ONLY_FETCH?.trim().toLowerCase() !== "off";
}

function displayOnlyLink(
  heading: string,
  pmcid: string,
  url: string,
  citation: string,
): string {
  return withStatus(
    `${heading}\n\nA full-text PMC copy is free to read in a browser, but it is outside the ` +
      `Open Access Subset and carries no explicit redistribution licence. Labee therefore ` +
      `keeps it as display-only instead of calling it openly licensed:\n\n${url}\n\n` +
      `PMCID: ${pmcid}\n\nCitation: ${citation}`,
    "display-only-link",
  );
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

  // --- Step 2.4: the publisher's own public PDF, when the DOI maps to one. ---
  // Placed ahead of the PMC and Unpaywall tiers because it is the publisher's
  // native open copy: better licensed than the display-only PMC route below, and
  // it sidesteps an HTML page that may be gated without touching that gate.
  const direct = directPdfUrl(doi);
  if (direct) {
    const extracted = await extractOaContent(direct, { fetchImpl: doFetch, timeoutMs }, MAX_CHARS);
    // The endpoint answers a bad id with HTTP 200 and an HTML landing page rather
    // than a 404, so status is not a usable signal — require an actual parsed PDF.
    if (extracted?.format === "pdf" && extracted.text.trim()) {
      return withStatus(
        `${heading}\n\n_Source: publisher open-access PDF (${direct})._\n\n${extracted.text}`,
        "ok",
      );
    }
  }

  // --- Step 2.5: free-to-read PMC copy outside the OA subset. ---
  // The tiers above only serve the OA subset, so an article the publisher let PMC
  // display without an open licence lands here rather than in step 2.
  const displayOnly =
    displayOnlyEnabled() ? displayOnlyPdfUrl(result) : null;
  if (displayOnly) {
    const extracted = await extractOaContent(displayOnly, { fetchImpl: doFetch, timeoutMs }, MAX_CHARS);
    if (extracted?.text?.trim() && !looksLikeBotWall(extracted.text)) {
      return withStatus(
        `${heading}\n\n_Source: Europe PMC free-to-read PDF (${result.pmcid}) — free to read but ` +
          `outside the Open Access Subset, so it carries no redistribution licence._\n\n${extracted.text}`,
        "display-only-full-text",
      );
    }
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
    if (displayOnlyEnabled() && oa.oaUrl && !oa.license) {
      return displayOnlyLink(heading, oa.pmcid, oa.oaUrl, articleUrl(result, trimmed));
    }
  }

  // --- Step 3.2: OpenAlex — catch repository deposits ahead of EPMC indexing. ---
  // OpenAlex can know about a PMC landing page before Europe PMC exposes the
  // PMCID in its own search record. We still ask the proper PMC APIs first. If
  // they decline and OpenAlex supplies no licence, retain the browser-readable
  // copy as display-only rather than incorrectly reporting that no copy exists.
  const openAlex = await tryOpenAlex(doi, doFetch, timeoutMs);
  if (openAlex?.pmcid) {
    const hit = await fetchPmcFulltext(openAlex.pmcid, doFetch, timeoutMs, section);
    if (hit) {
      const lic = openAlex.license ? ` · ${openAlex.license}` : "";
      return withStatus(
        `${heading}\n\n_Source: OpenAlex → ${hit.via} full text (${openAlex.pmcid}${lic})._\n\n` +
          hit.markdown,
        "ok",
      );
    }
    if (displayOnlyEnabled() && !openAlex.license) {
      return displayOnlyLink(
        heading,
        openAlex.pmcid,
        openAlex.oaUrl,
        articleUrl(result, trimmed),
      );
    }
  }
  if (openAlex?.oaUrl) {
    const meta = [openAlex.version, openAlex.license, openAlex.oaStatus].filter(Boolean).join(", ");
    const extracted = await extractOaContent(
      openAlex.oaUrl,
      { fetchImpl: doFetch, timeoutMs },
      MAX_CHARS,
    );
    if (extracted) {
      const status = openAlex.license ? "ok" : "display-only-full-text";
      const rights = openAlex.license
        ? "open-access"
        : "free-to-read, with no explicit redistribution licence";
      return withStatus(
        `${heading}\n\n_Source: OpenAlex ${rights} ${extracted.format}, best-effort extraction ` +
          `from ${openAlex.oaUrl}${meta ? ` (${meta})` : ""}._\n\n${extracted.text}`,
        status,
      );
    }
    return withStatus(
      `${heading}\n\nOpenAlex reports a public copy, but Labee could not extract it automatically` +
        `${meta ? ` (${meta})` : ""}:\n\n${openAlex.oaUrl}\n\n` +
        `Citation: ${articleUrl(result, trimmed)}`,
      openAlex.license ? "oa-link" : "display-only-link",
    );
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

  // --- Step 3.5: entitled retrieval. ---
  // Two gates, not one. The network gate asks "could this address hold any
  // subscription?"; the entitlement gate asks "does it hold *this journal*?" —
  // a distinction publishers make and we used to ignore, spending a full PDF
  // round trip on titles the institution never bought.
  //
  // The verdict is cached per journal, so the first article from an unavailable
  // title pays one landing-page fetch and every later one costs nothing.
  //
  // Nothing here is open access: it is content this IP is entitled to, labelled
  // as such and never described as open. PROTOCOLS_ENTITLED_FETCH=off skips it.
  const entitledEnabled = process.env.PROTOCOLS_ENTITLED_FETCH?.trim().toLowerCase() !== "off";
  let entitlementNote = "";
  if (doi && entitledEnabled && onAcademicNetwork()) {
    const via = institutionName() ?? networkContext()?.org ?? "this network";
    const journal = result.journalInfo?.journal?.title;
    const key = entitlementKey(`https://doi.org/${doi}`, journal);
    const known = cachedEntitlement(key);

    if (known?.status === "not-entitled") {
      // Already established for this journal — skip the round trip entirely.
      entitlementNote =
        `\n\n_${via} does not appear to subscribe to ${journal ?? "this journal"} ` +
        `(${known.evidence}), so the publisher's copy was not attempted._`;
    } else {
      const outcome = await extractEntitledArticle(
        `https://doi.org/${doi}`,
        { fetchImpl: doFetch, timeoutMs },
        MAX_CHARS,
        institutionName(),
      );
      rememberEntitlement(key, { status: outcome.entitlement, evidence: outcome.evidence });

      const body = outcome.extracted;
      // A bot wall or a paywall stub extracts as "text" too; both are worse than
      // the abstract we already hold, so only a substantive body is accepted.
      if (body && body.text.trim().length > 2000 && !looksLikeBotWall(body.text)) {
        return withStatus(
          `${heading}\n\n_Source: publisher ${body.format} via institutional access ` +
            `(${via}${journal ? ` · ${journal}` : ""}) — NOT open access; redistribution is ` +
            `governed by that subscription._\n\n${body.text}`,
          "entitled-full-text",
        );
      }
      if (outcome.entitlement === "not-entitled") {
        entitlementNote =
          `\n\n_${via} does not provide access to ${journal ?? "this journal"} ` +
          `(publisher said: ${outcome.evidence})._`;
      }
    }
  }

  // --- Step 4: the abstract, which beats a bare link for a paywalled article. ---
  const pmcNote = result.pmcid
    ? `\n\nA PMC copy exists and is free to read in a browser, though its full text isn't served ` +
      `for download: https://www.ncbi.nlm.nih.gov/pmc/articles/${result.pmcid}/`
    : "";
  const abstract = abstractBlock(result);
  if (abstract) {
    return withStatus(
      `${heading}\n\n_Source: Europe PMC abstract — no public open-access full text was found ` +
        `at retrieval time._\n\n` +
        `${abstract}${pmcNote}${entitlementNote}\n\nRead the full protocol at: ${articleUrl(result, trimmed)}`,
      "abstract-only",
    );
  }

  // --- No open text and no abstract: return a citation link. ---
  return withStatus(
    `${heading}\n\nNo public open-access full text was found at retrieval time via Europe PMC, ` +
      `NCBI, Unpaywall or OpenAlex.` +
      `${pmcNote}\n\nRead it at: ${articleUrl(result, trimmed)}`,
    "no-open-fulltext",
  );
}

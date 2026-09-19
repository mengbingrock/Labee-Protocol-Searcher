// The catalog of laboratory-protocol / reagent sources this server can search.
//
// Every publisher is searched on its own site first through the configured AWS
// Browserless deployment. Scholarly indexes (journals) and site-scoped web
// search (vendors) are fallbacks only. `publisherResult` identifies genuine
// result links in the rendered publisher page; navigation/header links are not
// accepted merely because they share the same hostname.
//
// Every source also exposes searchUrl(query): a deterministic, always-valid
// deep link into its own search page. It never fails and never gets bot-
// blocked (it's a URL, not a fetch), so it's the guaranteed-useful part of
// every result even when live extraction is unavailable.

export interface JournalInfo {
  /** Exact Crossref `container-title` for this journal (also Semantic Scholar venue). */
  crossrefContainer: string;
  /** Exact Europe PMC `JOURNAL:"..."` name (also the PubMed `[Journal]` term). */
  europepmcJournal: string;
  /** ISSN(s) identifying the journal in OpenAlex (print + electronic). */
  issn: string[];
}

/**
 * How reliably `fetch` can return real content for this source's results.
 *
 *   "full"    — retrieval essentially always works.
 *   "partial" — works for some results and not others, and which is which isn't
 *               knowable at search time (a paywalled article, a JoVE DOI Europe
 *               PMC never indexed, a vendor page behind an inconsistent bot
 *               check). Worth attempting; be ready for a link back.
 *   "none"    — the site refuses automated requests; `fetch` can only hand back
 *               the link, so spending a call on it buys nothing.
 *
 * These are measured, not assumed — see the per-source notes below. Re-check
 * them if a source starts behaving differently.
 */
export type Fetchability = "full" | "partial" | "none";

export type PublisherFetch = "full" | "abstract-only" | "blocked";

export interface InteractivePublisherSearch {
  /** Page containing the publisher's visible search input. */
  startUrl: string;
  /** Optional exact selectors; Browserless otherwise finds the visible search field. */
  inputSelector?: string;
  submitSelector?: string;
}

export interface Vendor {
  /** Stable id used in tool arguments and CLI flags. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** What this source is good for (shown to the model so it can pick well). */
  blurb: string;
  /** Source category; it determines which fallback runs after publisher search. */
  kind: "journal" | "vendor";
  /** Expected outcome of `fetch` on this source's results. */
  fetchability: Fetchability;
  /** Measured result of fetching the publisher page itself through Browserless. */
  publisherFetch: PublisherFetch;
  /**
   * URL shapes this source serves to a plain request even though its pages in
   * general do not. A matching result is graded `full` regardless of
   * `fetchability`, and listed ahead of the source's other hits so the agent
   * spends its first `fetch` on the one that will work.
   *
   * A grade is per site; a bot wall is per URL type. This is where the two are
   * reconciled instead of pretending the site is uniform.
   */
  ungated?: RegExp;
  /** Domain (optionally `domain/path`) scoping the web `site:` query (vendors). */
  searchSite: string;
  /** Scholarly-API metadata (journals only). */
  journal?: JournalInfo;
  /** Build the source's own on-site search URL for `query`. */
  searchUrl: (query: string) => string;
  /** URL shape of a genuine result on the publisher's rendered search page. */
  publisherResult: RegExp;
  /** Optional result-link class needed to exclude same-host navigation links. */
  publisherResultClass?: RegExp;
  /** CSS selector extracted through Browserless `/scrape` with challenge solving. */
  publisherScrapeSelector?: string;
  /** Prefer an available local residential exit for this publisher's search. */
  publisherResidentialFirst?: boolean;
  /** Publishers whose current search UI must be submitted interactively. */
  interactiveSearch?: InteractivePublisherSearch;
  /** Result links are rendered inside open shadow roots (currently IDT). */
  shadowSearch?: boolean;
}

const enc = encodeURIComponent;

export const VENDORS: Vendor[] = [
  {
    id: "star-protocols",
    name: "STAR Protocols (Cell Press)",
    blurb: "Peer-reviewed step-by-step life-science protocols.",
    kind: "journal",
    // open-access full text via Europe PMC.
    fetchability: "full",
    publisherFetch: "full",
    searchSite: "cell.com/star-protocols",
    journal: {
      crossrefContainer: "STAR Protocols",
      europepmcJournal: "STAR Protocols",
      issn: ["2666-1667"],
    },
    searchUrl: (q) =>
      `https://www.cell.com/action/doSearch?type=quicksearch&text1=${enc(q)}&field1=AllField&journalCode=xpro&SeriesKey=xpro`,
    publisherResult: /^https?:\/\/(?:www\.)?cell\.com\/star-protocols\/fulltext\//i,
  },
  {
    id: "nature-protocols",
    name: "Nature Protocols",
    blurb: "Peer-reviewed protocols across the life sciences.",
    kind: "journal",
    // Mostly paywalled, but ~26% of the journal is deposited in PMC as author
    // manuscripts that NCBI serves in full; the rest returns the abstract.
    fetchability: "partial",
    publisherFetch: "abstract-only",
    searchSite: "nature.com/nprot",
    journal: {
      crossrefContainer: "Nature Protocols",
      europepmcJournal: "Nature Protocols",
      issn: ["1750-2799", "1754-2189"],
    },
    searchUrl: (q) => `https://www.nature.com/search?journal=nprot&q=${enc(q)}`,
    publisherResult: /^https?:\/\/(?:www\.)?nature\.com\/articles\//i,
  },
  {
    id: "jove",
    name: "JoVE (Journal of Visualized Experiments)",
    blurb: "Peer-reviewed video protocols across the life sciences.",
    kind: "journal",
    // many JoVE DOIs are not indexed by Europe PMC and resolve to nothing.
    fetchability: "partial",
    publisherFetch: "blocked",
    searchSite: "jove.com",
    journal: {
      crossrefContainer: "Journal of Visualized Experiments",
      europepmcJournal: "Journal of Visualized Experiments",
      issn: ["1940-087X"],
    },
    searchUrl: (q) => `https://www.jove.com/search?query=${enc(q)}`,
    publisherResult: /^https?:\/\/(?:www\.)?jove\.com\/(?:t|v)\//i,
  },
  {
    id: "bio-protocol",
    name: "Bio-protocol",
    blurb: "Peer-reviewed, community-contributed step-by-step life-science protocols.",
    kind: "journal",
    // Search is public, while article pages currently trip SafeLine; scholarly
    // metadata and the deterministic publisher PDF remain useful fallbacks.
    fetchability: "partial",
    publisherFetch: "blocked",
    searchSite: "bio-protocol.org",
    journal: {
      crossrefContainer: "Bio-protocol",
      europepmcJournal: "Bio-protocol",
      issn: ["2331-8325"],
    },
    searchUrl: (q) => `https://bio-protocol.org/en/searchlist?content=${enc(q)}`,
    publisherResult: /^https?:\/\/(?:www\.)?bio-protocol\.org\/en\/bpdetail\?/i,
    interactiveSearch: { startUrl: "https://bio-protocol.org/en" },
  },
  {
    id: "current-protocols",
    name: "Current Protocols (Wiley)",
    blurb: "Comprehensive, regularly-updated protocols across life-science methods.",
    kind: "journal",
    fetchability: "partial",
    publisherFetch: "abstract-only",
    searchSite: "currentprotocols.onlinelibrary.wiley.com",
    journal: {
      crossrefContainer: "Current Protocols",
      europepmcJournal: "Current Protocols",
      issn: ["2691-1299"],
    },
    searchUrl: (q) =>
      `https://currentprotocols.onlinelibrary.wiley.com/action/doSearch?AllField=${enc(q)}`,
    publisherResult: /^https?:\/\/currentprotocols\.onlinelibrary\.wiley\.com\/doi\//i,
  },
  {
    id: "protocols-io",
    name: "protocols.io",
    blurb: "Open-access repository of step-by-step protocols (community + published, with DOIs).",
    kind: "vendor",
    // public /view/ protocols extract via their .json; others do not.
    fetchability: "full",
    publisherFetch: "full",
    searchSite: "protocols.io",
    searchUrl: (q) => `https://www.protocols.io/search?q=${enc(q)}`,
    publisherResult: /^https?:\/\/(?:www\.)?protocols\.io\/view\//i,
  },
  {
    id: "thermofisher",
    name: "Thermo Fisher Scientific",
    blurb: "Reagents, kits, instruments; extensive product protocols and manuals.",
    kind: "vendor",
    // product pages extract cleanly.
    fetchability: "full",
    publisherFetch: "full",
    searchSite: "thermofisher.com",
    searchUrl: (q) =>
      `https://www.thermofisher.com/search/results?query=${enc(q)}&focusarea=Search%20All`,
    publisherResult: /^https?:\/\/(?:www\.)?thermofisher\.com\/order\/catalog\/product\//i,
  },
  {
    id: "qiagen",
    name: "QIAGEN",
    blurb: "Nucleic-acid extraction/purification kits and their handbooks.",
    kind: "vendor",
    // product pages extract cleanly.
    fetchability: "full",
    publisherFetch: "full",
    searchSite: "qiagen.com",
    searchUrl: (q) => `https://www.qiagen.com/us/search?q=${enc(q)}`,
    publisherResult: /^https?:\/\/(?:www\.)?qiagen\.com\/(?:[a-z]{2}\/)?products\//i,
  },
  {
    id: "neb",
    name: "New England Biolabs (NEB)",
    blurb:
      "Enzymes, cloning/library-prep reagents; detailed molecular-biology protocols. " +
      "For restriction-enzyme recognition/cut/methylation facts use REBASE rather than this " +
      "vendor's pages: `search` with `sources: [\"rebase\"]`, then `fetch` the `rebase:<enzyme>` id.",
    kind: "vendor",
    // neb.com HTML answers automated requests with a Cloudflare challenge. Its
    // PDF manuals under /-/media/ are not behind it: measured 2026-09-17,
    // manuale0554.pdf returned HTTP 200 (860 KB) to a plain request and
    // extracted to 24k chars in one second, while the same kit's HTML protocol
    // page needed a remote browser for 10k chars. So the PDF is both the
    // reachable copy and the better one.
    fetchability: "full",
    publisherFetch: "full",
    ungated: /^https?:\/\/(?:www\.)?neb\.com\/.+\.pdf(?:$|\?)/i,
    searchSite: "neb.com",
    searchUrl: (q) => `https://www.neb.com/en-us/search#q=${enc(q)}`,
    publisherResult: /^https?:\/\/(?:www\.)?neb\.com\/en-us\/(?:products|protocols)\//i,
    publisherResultClass: /\bCoveoResultLink\b/i,
    // Coveo's live result anchors are visible in Chromium but are not included
    // in `/content`'s serialized HTML. `/scrape` reads the live DOM and, unlike
    // `/function`, supports the server's public-page challenge solver.
    publisherScrapeSelector: ".CoveoResultLink",
    publisherResidentialFirst: true,
  },
  {
    id: "bio-rad",
    name: "Bio-Rad",
    blurb: "Electrophoresis, blotting, qPCR, chromatography reagents and protocols.",
    kind: "vendor",
    // most product pages extract; some category URLs 403.
    fetchability: "full",
    publisherFetch: "full",
    searchSite: "bio-rad.com",
    searchUrl: (q) =>
      `https://www.bio-rad.com/en-us/SearchResults?search_api_fulltext=${enc(q)}`,
    publisherResult: /^https?:\/\/(?:www\.)?bio-rad\.com\/en-us\/product\//i,
  },
  {
    id: "sigma-aldrich",
    name: "Sigma-Aldrich (Merck)",
    blurb: "Broad chemicals/biochemicals catalog; SDS and product protocols.",
    kind: "vendor",
    // sigmaaldrich.com answers automated requests with 403.
    fetchability: "none",
    publisherFetch: "blocked",
    searchSite: "sigmaaldrich.com",
    searchUrl: (q) =>
      `https://www.sigmaaldrich.com/US/en/search/${enc(q)}?focus=products&type=product`,
    publisherResult: /^https?:\/\/(?:www\.)?sigmaaldrich\.com\/US\/en\/product\//i,
  },
  {
    id: "emd-millipore",
    name: "EMD Millipore (MilliporeSigma)",
    blurb: "Life-science reagents, filtration, antibodies; product protocols.",
    kind: "vendor",
    // emdmillipore.com answers automated requests with 403.
    fetchability: "none",
    publisherFetch: "blocked",
    searchSite: "emdmillipore.com",
    searchUrl: (q) =>
      `https://www.emdmillipore.com/US/en/search/-/Search?SearchTerm=${enc(q)}`,
    publisherResult: /^https?:\/\/(?:www\.)?emdmillipore\.com\/US\/en\/product\//i,
  },
  {
    id: "takarabio",
    name: "Takara Bio",
    blurb: "cDNA synthesis, PCR, NGS library-prep kits and user manuals.",
    kind: "vendor",
    // product pages extract cleanly.
    fetchability: "full",
    publisherFetch: "full",
    searchSite: "takarabio.com",
    searchUrl: (q) =>
      `https://www.takarabio.com/search-results?term=${enc(q)}&tab=product`,
    publisherResult: /^https?:\/\/(?:www\.)?takarabio\.com\/products\//i,
  },
  {
    id: "promega",
    name: "Promega",
    blurb: "Reporter assays, purification, cell-viability reagents and protocols.",
    kind: "vendor",
    // product pages extract cleanly.
    fetchability: "full",
    publisherFetch: "full",
    searchSite: "promega.com",
    searchUrl: (q) => `https://www.promega.com/results#q=${enc(q)}`,
    publisherResult: /^https?:\/\/(?:www\.)?promega\.com\/products\//i,
    interactiveSearch: { startUrl: "https://www.promega.com/" },
  },
  {
    id: "idt",
    name: "Integrated DNA Technologies (IDT)",
    blurb: "Custom oligos/primers/gBlocks; primer-design and oligo-handling protocols.",
    kind: "vendor",
    // extracts once the country-cookie redirect gate is followed.
    fetchability: "full",
    publisherFetch: "full",
    searchSite: "idtdna.com",
    searchUrl: (q) => `https://www.idtdna.com/page/search#q=${enc(q)}`,
    publisherResult:
      /^https?:\/\/(?:www\.)?idtdna\.com\/page\/support-and-education\//i,
    shadowSearch: true,
  },
];

const BY_ID = new Map(VENDORS.map((v) => [v.id, v]));

export function getVendor(id: string): Vendor | undefined {
  return BY_ID.get(id);
}

/** Resolve a catalog publisher from an absolute result/page URL. */
export function getVendorForUrl(raw: string): Vendor | undefined {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
  return VENDORS.find((vendor) => {
    const expected = vendor.searchSite.split("/")[0]!.toLowerCase().replace(/^www\./, "");
    return host === expected;
  });
}

/**
 * Resolve a list of requested vendor ids to Vendor objects. Unknown ids are
 * collected separately so the caller can report them instead of silently
 * dropping them. With no ids (undefined/empty), every vendor is returned.
 */
export function resolveVendors(ids?: readonly string[]): {
  vendors: Vendor[];
  unknown: string[];
} {
  if (!ids || ids.length === 0) return { vendors: VENDORS, unknown: [] };
  const vendors: Vendor[] = [];
  const unknown: string[] = [];
  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    const v = BY_ID.get(id);
    if (v) vendors.push(v);
    else unknown.push(raw);
  }
  return { vendors, unknown };
}

export const VENDOR_IDS = VENDORS.map((v) => v.id);

// The catalog of laboratory-protocol / reagent sources this server can search.
//
// Sources come in two kinds:
//   - "journal": peer-reviewed protocol journals (STAR Protocols, Nature
//     Protocols). These are indexed by scholarly APIs (Crossref, Europe PMC)
//     that are free, keyless, and reliable — far better than scraping the
//     publisher sites, which paywall/bot-block. See journals.ts.
//   - "vendor": reagent/instrument vendors. Their own sites bot-block
//     automated fetches and render results with JavaScript, so we reach them
//     through a web-search provider (Brave/Google when an API key is set,
//     otherwise DuckDuckGo) scoped with a `site:` filter. See providers/.
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

export interface Vendor {
  /** Stable id used in tool arguments and CLI flags. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** What this source is good for (shown to the model so it can pick well). */
  blurb: string;
  /** "journal" → scholarly APIs; "vendor" → web-search provider. */
  kind: "journal" | "vendor";
  /** Domain (optionally `domain/path`) scoping the web `site:` query (vendors). */
  ddgSite: string;
  /** Scholarly-API metadata (journals only). */
  journal?: JournalInfo;
  /** Build the source's own on-site search URL for `query`. */
  searchUrl: (query: string) => string;
}

const enc = encodeURIComponent;

export const VENDORS: Vendor[] = [
  {
    id: "star-protocols",
    name: "STAR Protocols (Cell Press)",
    blurb: "Peer-reviewed step-by-step life-science protocols.",
    kind: "journal",
    ddgSite: "cell.com/star-protocols",
    journal: {
      crossrefContainer: "STAR Protocols",
      europepmcJournal: "STAR Protocols",
      issn: ["2666-1667"],
    },
    searchUrl: (q) =>
      `https://www.cell.com/action/doSearch?journalCode=star-protocols&field1=AllField&text1=${enc(q)}`,
  },
  {
    id: "nature-protocols",
    name: "Nature Protocols",
    blurb: "Peer-reviewed protocols across the life sciences.",
    kind: "journal",
    ddgSite: "nature.com/nprot",
    journal: {
      crossrefContainer: "Nature Protocols",
      europepmcJournal: "Nature Protocols",
      issn: ["1750-2799", "1754-2189"],
    },
    searchUrl: (q) => `https://www.nature.com/search?journal=nprot&q=${enc(q)}`,
  },
  {
    id: "jove",
    name: "JoVE (Journal of Visualized Experiments)",
    blurb: "Peer-reviewed video protocols across the life sciences.",
    kind: "journal",
    ddgSite: "jove.com",
    journal: {
      crossrefContainer: "Journal of Visualized Experiments",
      europepmcJournal: "Journal of Visualized Experiments",
      issn: ["1940-087X"],
    },
    searchUrl: (q) => `https://www.jove.com/search?query=${enc(q)}`,
  },
  {
    id: "bio-protocol",
    name: "Bio-protocol",
    blurb: "Peer-reviewed, community-contributed step-by-step life-science protocols.",
    kind: "journal",
    ddgSite: "bio-protocol.org",
    journal: {
      crossrefContainer: "Bio-protocol",
      europepmcJournal: "Bio-protocol",
      issn: ["2331-8325"],
    },
    searchUrl: (q) => `https://bio-protocol.org/en/search?keyword=${enc(q)}`,
  },
  {
    id: "current-protocols",
    name: "Current Protocols (Wiley)",
    blurb: "Comprehensive, regularly-updated protocols across life-science methods.",
    kind: "journal",
    ddgSite: "currentprotocols.onlinelibrary.wiley.com",
    journal: {
      crossrefContainer: "Current Protocols",
      europepmcJournal: "Current Protocols",
      issn: ["2691-1299"],
    },
    searchUrl: (q) =>
      `https://currentprotocols.onlinelibrary.wiley.com/action/doSearch?AllField=${enc(q)}`,
  },
  {
    id: "protocols-io",
    name: "protocols.io",
    blurb: "Open-access repository of step-by-step protocols (community + published, with DOIs).",
    kind: "vendor",
    ddgSite: "protocols.io",
    searchUrl: (q) => `https://www.protocols.io/search?q=${enc(q)}`,
  },
  {
    id: "thermofisher",
    name: "Thermo Fisher Scientific",
    blurb: "Reagents, kits, instruments; extensive product protocols and manuals.",
    kind: "vendor",
    ddgSite: "thermofisher.com",
    searchUrl: (q) =>
      `https://www.thermofisher.com/search/results?query=${enc(q)}&focusarea=Search%20All`,
  },
  {
    id: "qiagen",
    name: "QIAGEN",
    blurb: "Nucleic-acid extraction/purification kits and their handbooks.",
    kind: "vendor",
    ddgSite: "qiagen.com",
    searchUrl: (q) => `https://www.qiagen.com/us/search?q=${enc(q)}`,
  },
  {
    id: "neb",
    name: "New England Biolabs (NEB)",
    blurb:
      "Enzymes, cloning/library-prep reagents; detailed molecular-biology protocols. " +
      "neb.com is links-only (bot-blocked) — for restriction-enzyme recognition/cut/methylation " +
      "facts use the `find_restriction_enzyme` tool (REBASE), not this vendor's pages.",
    kind: "vendor",
    ddgSite: "neb.com",
    searchUrl: (q) => `https://www.neb.com/en-us/search?searchValue=${enc(q)}`,
  },
  {
    id: "bio-rad",
    name: "Bio-Rad",
    blurb: "Electrophoresis, blotting, qPCR, chromatography reagents and protocols.",
    kind: "vendor",
    ddgSite: "bio-rad.com",
    searchUrl: (q) => `https://www.bio-rad.com/en-us/search?text=${enc(q)}`,
  },
  {
    id: "sigma-aldrich",
    name: "Sigma-Aldrich (Merck)",
    blurb: "Broad chemicals/biochemicals catalog; SDS and product protocols.",
    kind: "vendor",
    ddgSite: "sigmaaldrich.com",
    searchUrl: (q) =>
      `https://www.sigmaaldrich.com/US/en/search/${enc(q)}?focus=products&type=product`,
  },
  {
    id: "emd-millipore",
    name: "EMD Millipore (MilliporeSigma)",
    blurb: "Life-science reagents, filtration, antibodies; product protocols.",
    kind: "vendor",
    ddgSite: "emdmillipore.com",
    searchUrl: (q) =>
      `https://www.emdmillipore.com/US/en/search/-/Search?SearchTerm=${enc(q)}`,
  },
  {
    id: "takarabio",
    name: "Takara Bio",
    blurb: "cDNA synthesis, PCR, NGS library-prep kits and user manuals.",
    kind: "vendor",
    ddgSite: "takarabio.com",
    searchUrl: (q) => `https://www.takarabio.com/search?q=${enc(q)}`,
  },
  {
    id: "promega",
    name: "Promega",
    blurb: "Reporter assays, purification, cell-viability reagents and protocols.",
    kind: "vendor",
    ddgSite: "promega.com",
    searchUrl: (q) => `https://www.promega.com/search/?q=${enc(q)}`,
  },
  {
    id: "idt",
    name: "Integrated DNA Technologies (IDT)",
    blurb: "Custom oligos/primers/gBlocks; primer-design and oligo-handling protocols.",
    kind: "vendor",
    ddgSite: "idtdna.com",
    searchUrl: (q) => `https://www.idtdna.com/site/search?searchterm=${enc(q)}`,
  },
];

const BY_ID = new Map(VENDORS.map((v) => [v.id, v]));

export function getVendor(id: string): Vendor | undefined {
  return BY_ID.get(id);
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

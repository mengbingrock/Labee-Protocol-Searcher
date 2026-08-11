import { describe, it, expect, afterEach } from "vitest";
import { searchJournal, journalProviderOrder } from "../src/journals.ts";
import type { JournalInfo } from "../src/vendors.ts";

const STAR: JournalInfo = {
  crossrefContainer: "STAR Protocols",
  europepmcJournal: "STAR Protocols",
  issn: ["2666-1667"],
};

const bodies = {
  crossref: JSON.stringify({
    message: {
      items: [
        {
          title: ["CRISPR knockout protocol"],
          DOI: "10.1016/j.xpro.2023.102406",
          URL: "https://doi.org/10.1016/j.xpro.2023.102406",
          abstract: "<jats:p>A <b>CRISPR</b> protocol.</jats:p>",
        },
      ],
    },
  }),
  europepmc: JSON.stringify({
    resultList: {
      result: [
        {
          title: "EPMC protocol",
          doi: "10.1/epmc",
          abstractText: "x",
          pmcid: "PMC123",
          isOpenAccess: "Y",
        },
      ],
    },
  }),
  openalex: JSON.stringify({
    results: [
      {
        display_name: "OpenAlex protocol",
        doi: "https://doi.org/10.1/oa",
        abstract_inverted_index: { A: [0], reconstructed: [1], abstract: [2] },
        open_access: { is_oa: true },
        best_oa_location: { is_oa: true, pdf_url: "https://oa.example/paper.pdf" },
      },
    ],
  }),
  semanticscholar: JSON.stringify({
    data: [
      {
        title: "S2 protocol",
        externalIds: { DOI: "10.1/s2" },
        url: "https://s2.org/x",
        abstract: "ab",
        openAccessPdf: { url: "https://oa.example/s2.pdf", status: "GREEN" },
      },
    ],
  }),
  esearch: JSON.stringify({ esearchresult: { idlist: ["35733605"] } }),
  esummary: JSON.stringify({
    result: { "35733605": { title: "PubMed protocol.", articleids: [{ idtype: "doi", value: "10.1/pm" }] } },
  }),
};

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe("journalProviderOrder", () => {
  it("defaults to all five and honors the env override", () => {
    delete process.env.PROTOCOLS_JOURNAL_PROVIDERS;
    expect(journalProviderOrder()).toEqual(["crossref", "europepmc", "openalex", "semanticscholar", "pubmed"]);
    process.env.PROTOCOLS_JOURNAL_PROVIDERS = "pubmed, openalex , bogus";
    expect(journalProviderOrder()).toEqual(["pubmed", "openalex"]);
  });
});

function only(id: string): void {
  process.env.PROTOCOLS_JOURNAL_PROVIDERS = id;
}

describe("searchJournal provider parsing", () => {
  it("crossref: strips abstract tags, maps DOI url", async () => {
    only("crossref");
    const f = (async () => new Response(bodies.crossref, { status: 200 })) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "CRISPR", 3, { fetchImpl: f });
    expect(out.source).toBe("crossref");
    expect(out.results[0]).toMatchObject({ title: "CRISPR knockout protocol", url: "https://doi.org/10.1016/j.xpro.2023.102406" });
    expect(out.results[0]!.snippet).toContain("CRISPR protocol");
  });

  it("openalex: reconstructs abstract from inverted index, filters by issn", async () => {
    only("openalex");
    let seen = "";
    const f = (async (url: string) => {
      seen = url;
      return new Response(bodies.openalex, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "CRISPR", 3, { fetchImpl: f });
    expect(seen).toContain("primary_location.source.issn:2666-1667");
    expect(out.source).toBe("openalex");
    expect(out.results[0]).toMatchObject({ title: "OpenAlex protocol", url: "https://doi.org/10.1/oa" });
    expect(out.results[0]!.snippet).toBe("A reconstructed abstract");
    expect(out.results[0]!.oaEvidence).toContain("openalex:open-access");
  });

  it("semanticscholar: maps DOI then url, scoped by venue", async () => {
    only("semanticscholar");
    let seen = "";
    const f = (async (url: string) => {
      seen = url;
      return new Response(bodies.semanticscholar, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "x", 3, { fetchImpl: f });
    expect(seen).toContain("venue=STAR%20Protocols");
    expect(seen).toContain("openAccessPdf");
    expect(out.results[0]!.url).toBe("https://doi.org/10.1/s2");
    expect(out.results[0]!.oaEvidence?.[0]).toContain("semanticscholar:open-access-pdf:");
  });

  it("pubmed: esearch then esummary, builds DOI url", async () => {
    only("pubmed");
    const f = (async (url: string) =>
      new Response(url.includes("esearch") ? bodies.esearch : bodies.esummary, { status: 200 })) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "Gibson", 3, { fetchImpl: f });
    expect(out.source).toBe("pubmed");
    expect(out.results[0]).toMatchObject({ title: "PubMed protocol", url: "https://doi.org/10.1/pm" });
  });
});

describe("searchJournal chain", () => {
  it("runs every provider even after an earlier provider succeeds", async () => {
    delete process.env.PROTOCOLS_JOURNAL_PROVIDERS; // all five, in order
    const seen: string[] = [];
    const f = (async (url: string) => {
      if (url.includes("crossref")) { seen.push("crossref"); return new Response(bodies.crossref, { status: 200 }); }
      if (url.includes("europepmc")) { seen.push("europepmc"); return new Response(bodies.europepmc, { status: 200 }); }
      if (url.includes("openalex")) { seen.push("openalex"); return new Response(bodies.openalex, { status: 200 }); }
      if (url.includes("semanticscholar")) { seen.push("semanticscholar"); return new Response(bodies.semanticscholar, { status: 200 }); }
      if (url.includes("esearch")) { seen.push("pubmed-esearch"); return new Response(bodies.esearch, { status: 200 }); }
      seen.push("pubmed-esummary");
      return new Response(bodies.esummary, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "CRISPR", 3, { fetchImpl: f });
    expect(seen).toEqual(["crossref", "europepmc", "openalex", "semanticscholar", "pubmed-esearch", "pubmed-esummary"]);
    expect(out.providers.map((provider) => provider.id)).toEqual(journalProviderOrder());
    expect(out.providers.every((provider) => provider.status === "ok")).toBe(true);
    expect(out.results).toHaveLength(5);
    expect(out.source).toBe("crossref+europepmc+openalex+semanticscholar+pubmed");
  });

  it("deduplicates the same DOI across backends while retaining coverage", async () => {
    process.env.PROTOCOLS_JOURNAL_PROVIDERS = "crossref,europepmc";
    const sameEpmc = JSON.stringify({ resultList: { result: [{ title: "Same", doi: "10.1016/j.xpro.2023.102406", abstractText: "better snippet" }] } });
    const f = (async (url: string) => new Response(url.includes("crossref") ? bodies.crossref : sameEpmc, { status: 200 })) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "CRISPR", 3, { fetchImpl: f });
    expect(out.results).toHaveLength(1);
    expect(out.providers).toHaveLength(2);
    expect(out.results[0]!.discoveredBy).toEqual(["crossref", "europepmc"]);
  });

  it("reports aggregated errors when every provider is empty/down", async () => {
    process.env.PROTOCOLS_JOURNAL_PROVIDERS = "crossref,europepmc";
    const f = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "zzz", 3, { fetchImpl: f });
    expect(out.results).toEqual([]);
    expect(out.providers.map((provider) => provider.status)).toEqual(["error", "error"]);
    expect(out.error).toMatch(/crossref.*europepmc/s);
  });
});

describe("title / abstract text normalisation", () => {
  it("unescapes double-escaped publisher markup instead of leaking entities", async () => {
    // Crossref returns markup escaped as entities, so a tags-only strip leaves
    // `&lt;i&gt;` in the title and a single strip+decode leaves a literal `<i>`.
    process.env.PROTOCOLS_JOURNAL_PROVIDERS = "crossref";
    const body = JSON.stringify({
      message: {
        items: [
          {
            title: ["RNA Extraction from &lt;i&gt;Synechocystis&lt;/i&gt; sp. PCC 6803"],
            URL: "https://doi.org/10.1/x",
            abstract: "<jats:p>Grow at 30 &deg;C in 5 &micro;L.</jats:p>",
          },
        ],
      },
    });
    const f = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "RNA", 3, { fetchImpl: f });
    expect(out.results[0]!.title).toBe("RNA Extraction from Synechocystis sp. PCC 6803");
    expect(out.results[0]!.snippet).toBe("Grow at 30 °C in 5 µL.");
  });

  it("caps a long abstract on a word boundary rather than mid-word", async () => {
    process.env.PROTOCOLS_JOURNAL_PROVIDERS = "crossref";
    const abstract = "supercalifragilistic ".repeat(40).trim(); // > 300 chars
    const body = JSON.stringify({
      message: { items: [{ title: ["T"], URL: "https://doi.org/10.1/x", abstract }] },
    });
    const f = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "x", 3, { fetchImpl: f });
    const snippet = out.results[0]!.snippet;
    expect(snippet.length).toBeLessThanOrEqual(301);
    expect(snippet.endsWith("…")).toBe(true);
    // The kept text must be a whole-word prefix: the source continues with a
    // space at exactly the cut point, so no word was sliced in half.
    const kept = snippet.slice(0, -1);
    expect(abstract.startsWith(kept)).toBe(true);
    expect(abstract[kept.length]).toBe(" ");
  });
});

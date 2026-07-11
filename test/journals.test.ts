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
    resultList: { result: [{ title: "EPMC protocol", doi: "10.1/epmc", abstractText: "x" }] },
  }),
  openalex: JSON.stringify({
    results: [
      {
        display_name: "OpenAlex protocol",
        doi: "https://doi.org/10.1/oa",
        abstract_inverted_index: { A: [0], reconstructed: [1], abstract: [2] },
      },
    ],
  }),
  semanticscholar: JSON.stringify({
    data: [{ title: "S2 protocol", externalIds: { DOI: "10.1/s2" }, url: "https://s2.org/x", abstract: "ab" }],
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
    expect(out.results[0]!.url).toBe("https://doi.org/10.1/s2");
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
  it("falls through 429/empty providers to the first that answers", async () => {
    delete process.env.PROTOCOLS_JOURNAL_PROVIDERS; // all five, in order
    const f = (async (url: string) => {
      if (url.includes("crossref")) return new Response("rate", { status: 429 });
      if (url.includes("europepmc")) return new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200 });
      if (url.includes("openalex")) return new Response(bodies.openalex, { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "CRISPR", 3, { fetchImpl: f });
    expect(out.source).toBe("openalex"); // crossref 429, europepmc empty → openalex
    expect(out.results).toHaveLength(1);
  });

  it("reports aggregated errors when every provider is empty/down", async () => {
    process.env.PROTOCOLS_JOURNAL_PROVIDERS = "crossref,europepmc";
    const f = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const out = await searchJournal(STAR, "zzz", 3, { fetchImpl: f });
    expect(out.results).toEqual([]);
    expect(out.error).toMatch(/crossref.*europepmc/s);
  });
});

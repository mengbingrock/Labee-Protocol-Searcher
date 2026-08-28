import { describe, it, expect, afterEach } from "vitest";
import { searchProtocols, renderMarkdown, search, renderSearch } from "../src/search.ts";

// Brave's response to a combined `(site:neb.com OR site:takarabio.com) ...`
// query — three hits spanning both vendors, to be bucketed back per vendor.
const MIXED_BRAVE = JSON.stringify({
  web: {
    results: [
      { title: "Q5 Polymerase", url: "https://www.neb.com/en-us/products/m0491", description: "High-fidelity PCR." },
      { title: "SMARTer cDNA Kit", url: "https://www.takarabio.com/products/cdna", description: "cDNA synthesis." },
      { title: "PCR Protocol", url: "https://www.neb.com/protocols/pcr", description: "Cycling conditions." },
    ],
  },
});

const CROSSREF = JSON.stringify({
  message: { items: [{ title: ["CRISPR protocol"], URL: "https://doi.org/10.1/x" }] },
});

describe("searchProtocols", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("buckets combined web results back to the right vendor by URL", async () => {
    process.env.PROTOCOLS_SEARCH_PROVIDER = "brave";
    process.env.BRAVE_API_KEY = "k";
    const fakeFetch = (async () =>
      new Response(MIXED_BRAVE, { status: 200 })) as unknown as typeof fetch;
    const resp = await searchProtocols("pcr", {
      vendors: ["neb", "takarabio"],
      providerOpts: { fetchImpl: fakeFetch },
    });
    const neb = resp.vendors.find((v) => v.id === "neb")!;
    const takara = resp.vendors.find((v) => v.id === "takarabio")!;
    expect(neb.results.map((r) => r.title)).toEqual(["Q5 Polymerase", "PCR Protocol"]);
    expect(takara.results.map((r) => r.title)).toEqual(["SMARTer cDNA Kit"]);
    expect(neb.source).toBe("brave");
    expect(resp.partial).toBe(false);
  });

  // The removal of the keyless provider must be visible to a caller, not
  // silently indistinguishable from a vendor that had no matching pages.
  it("reports the missing key when no web provider is configured", async () => {
    delete process.env.PROTOCOLS_SEARCH_PROVIDER;
    delete process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_CSE_KEY;
    delete process.env.GOOGLE_CSE_CX;
    const resp = await searchProtocols("pcr", { vendors: ["neb"] });
    expect(resp.partial).toBe(true);
    expect(resp.vendors[0]!.results).toEqual([]);
    expect(resp.vendors[0]!.error).toMatch(/BRAVE_API_KEY/);
    // The deterministic on-site search URL is still the useful fallback.
    expect(resp.vendors[0]!.searchUrl).toContain("neb.com");
  });

  it("routes journal sources to the scholarly API, not web search", async () => {
    process.env.PROTOCOLS_JOURNAL_PROVIDERS = "crossref";
    const fakeFetch = (async (url: string) => {
      // A journal query must hit Crossref, never the web-search chain.
      expect(url).toContain("crossref");
      return new Response(CROSSREF, { status: 200 });
    }) as unknown as typeof fetch;
    const resp = await searchProtocols("CRISPR", {
      vendors: ["star-protocols"],
      providerOpts: { fetchImpl: fakeFetch },
    });
    expect(resp.vendors[0]!.source).toBe("crossref");
    expect(resp.vendors[0]!.results[0]!.url).toBe("https://doi.org/10.1/x");
  });

  it("always attaches a deterministic search URL even when blocked", async () => {
    const blocked = (async () =>
      new Response("<html>challenge</html>", { status: 202 })) as unknown as typeof fetch;
    const resp = await searchProtocols("gibson", {
      vendors: ["neb"],
      providerOpts: { fetchImpl: blocked, timeoutMs: 400 },
    });
    expect(resp.partial).toBe(true);
    expect(resp.vendors[0]!.results).toEqual([]);
    expect(resp.vendors[0]!.searchUrl).toBe(
      "https://www.neb.com/en-us/search?searchValue=gibson",
    );
    expect(renderMarkdown(resp)).toMatch(/BRAVE_API_KEY|search pages/);
  });

  it("prefers Brave over Google when both are configured", async () => {
    process.env.BRAVE_API_KEY = "k";
    const braveBody = JSON.stringify({
      web: { results: [{ title: "Gibson kit", url: "https://www.neb.com/g", description: "d" }] },
    });
    const fakeFetch = (async (url: string) => {
      expect(url).toContain("api.search.brave.com"); // never reaches Google
      return new Response(braveBody, { status: 200 });
    }) as unknown as typeof fetch;
    const resp = await searchProtocols("gibson", {
      vendors: ["neb"],
      providerOpts: { fetchImpl: fakeFetch },
    });
    expect(resp.vendors[0]!.source).toBe("brave");
    expect(resp.vendors[0]!.results[0]!.url).toBe("https://www.neb.com/g");
  });

  it("reports unknown vendor ids and an empty query", async () => {
    process.env.PROTOCOLS_SEARCH_PROVIDER = "brave";
    process.env.BRAVE_API_KEY = "k";
    expect((await searchProtocols("   ")).query).toBe("");
    const resp = await searchProtocols("pcr", {
      vendors: ["neb", "nope"],
      providerOpts: { fetchImpl: (async () => new Response(MIXED_BRAVE, { status: 200 })) as unknown as typeof fetch },
    });
    expect(resp.unknownVendors).toEqual(["nope"]);
  });

  it("does not cross-attribute lookalike hostnames", async () => {
    // A key must be set, or no provider runs and the assertion below passes
    // without the hostname check ever being exercised.
    process.env.PROTOCOLS_SEARCH_PROVIDER = "brave";
    process.env.BRAVE_API_KEY = "k";
    const evil = (async () =>
      new Response(
        JSON.stringify({
          web: { results: [{ title: "Phish", url: "https://neb.com.evil.com/x", description: "d" }] },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const resp = await searchProtocols("pcr", {
      vendors: ["neb"],
      providerOpts: { fetchImpl: evil, timeoutMs: 400 },
    });
    expect(resp.vendors[0]!.results).toEqual([]);
  });
});

describe("result fetchability", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("carries the source's grade onto its results instead of a blanket true", async () => {
    process.env.PROTOCOLS_SEARCH_PROVIDER = "brave";
    process.env.BRAVE_API_KEY = "k";
    const f = (async (url: string) => {
      // Both vendors answer from one combined web-search query.
      if (url.includes("api.search.brave.com")) return new Response(MIXED_BRAVE, { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const out = await search("pcr", { sources: ["neb", "takarabio"], providerOpts: { fetchImpl: f } });
    const neb = out.results.find((r) => r.source === "neb")!;
    const takara = out.results.find((r) => r.source === "takarabio")!;
    expect(neb.fetchable).toBe("none"); // neb.com 403s
    expect(takara.fetchable).toBe("full"); // takarabio.com extracts fine
  });

  it("marks a journal hit with no resolvable identifier as links-only", async () => {
    process.env.PROTOCOLS_JOURNAL_PROVIDERS = "crossref";
    // A bare publisher URL — no DOI, PMID or PMCID for `fetch` to resolve.
    const body = JSON.stringify({
      message: { items: [{ title: ["Paywalled"], URL: "https://www.nature.com/articles/x" }] },
    });
    const f = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const out = await search("x", { sources: ["star-protocols"], providerOpts: { fetchImpl: f } });
    expect(out.results[0]!.id).toMatch(/^url:/);
    expect(out.results[0]!.fetchable).toBe("none");
  });

  it("promotes a DOI to fetchable on live open-access signals from the backends", async () => {
    process.env.PROTOCOLS_JOURNAL_PROVIDERS = "crossref";
    const body = JSON.stringify({
      message: {
        items: [
          {
            title: ["Open Nature protocol"],
            URL: "https://doi.org/10.1038/nprot.2011.388",
          },
        ],
      },
    });
    const f = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const out = await search("x", {
      sources: ["nature-protocols"],
      providerOpts: { fetchImpl: f },
    });
    // Crossref alone carries no OA signal, so the partial journal prior stands —
    // there is no longer any shared index that could claim otherwise.
    expect(out.results[0]).toMatchObject({
      fetchable: "partial",
      availability: { confidence: "journal-prior", journalPrior: "partial" },
    });
    expect(renderSearch(out)).toContain("may-not-fetch (journal prior; DOI untested)");
  });

  it("labels an untested DOI explicitly as a journal prior", async () => {
    process.env.PROTOCOLS_JOURNAL_PROVIDERS = "crossref";
    const body = JSON.stringify({
      message: {
        items: [{ title: ["Untested"], URL: "https://doi.org/10.1038/nprot.2099.1" }],
      },
    });
    const f = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const out = await search("x", {
      sources: ["nature-protocols"],
      providerOpts: { fetchImpl: f },
    });
    expect(renderSearch(out)).toContain("may-not-fetch (journal prior; DOI untested)");
  });

  it("renders the three grades distinguishably", () => {
    const md = renderSearch({
      query: "q",
      unknownSources: [],
      partial: false,
      sources: [{ id: "neb", name: "NEB", kind: "vendor", count: 3 }],
      results: [
        { id: "a", source: "neb", kind: "vendor-page", title: "A", fetchable: "full" },
        { id: "b", source: "neb", kind: "vendor-page", title: "B", fetchable: "partial" },
        { id: "c", source: "neb", kind: "vendor-page", title: "C", fetchable: "none" },
      ],
    });
    expect(md).toContain("`a` · fetchable");
    expect(md).toContain("`b` · may-not-fetch");
    expect(md).toContain("`c` · links-only");
  });
});

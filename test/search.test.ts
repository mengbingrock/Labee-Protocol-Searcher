import { describe, it, expect, afterEach } from "vitest";
import { searchProtocols, renderMarkdown } from "../src/search.ts";

// Lite-format markup mixing results from two vendors, returned for a combined
// `(site:neb.com OR site:takarabio.com) ...` DuckDuckGo query.
const MIXED_LITE = `
<table>
  <tr><td><a href="https://www.neb.com/en-us/products/m0491" class="result-link">Q5 Polymerase</a></td></tr>
  <tr><td class="result-snippet">High-fidelity PCR.</td></tr>
  <tr><td><a href="https://www.takarabio.com/products/cdna" class="result-link">SMARTer cDNA Kit</a></td></tr>
  <tr><td class="result-snippet">cDNA synthesis.</td></tr>
  <tr><td><a href="https://www.neb.com/protocols/pcr" class="result-link">PCR Protocol</a></td></tr>
  <tr><td class="result-snippet">Cycling conditions.</td></tr>
</table>
`;

const CROSSREF = JSON.stringify({
  message: { items: [{ title: ["CRISPR protocol"], URL: "https://doi.org/10.1/x" }] },
});

describe("searchProtocols", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("buckets combined web results back to the right vendor by URL", async () => {
    // Force the keyless default chain → DuckDuckGo.
    delete process.env.PROTOCOLS_SEARCH_PROVIDER;
    delete process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_CSE_KEY;
    const fakeFetch = (async () =>
      new Response(MIXED_LITE, { status: 200 })) as unknown as typeof fetch;
    const resp = await searchProtocols("pcr", {
      vendors: ["neb", "takarabio"],
      providerOpts: { fetchImpl: fakeFetch },
    });
    const neb = resp.vendors.find((v) => v.id === "neb")!;
    const takara = resp.vendors.find((v) => v.id === "takarabio")!;
    expect(neb.results.map((r) => r.title)).toEqual(["Q5 Polymerase", "PCR Protocol"]);
    expect(takara.results.map((r) => r.title)).toEqual(["SMARTer cDNA Kit"]);
    expect(neb.source).toBe("duckduckgo");
    expect(resp.partial).toBe(false);
  });

  it("routes journal sources to the scholarly API, not web search", async () => {
    const fakeFetch = (async (url: string) => {
      // A journal query must hit Crossref, never DuckDuckGo.
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

  it("prefers a keyed provider over DuckDuckGo when configured", async () => {
    process.env.BRAVE_API_KEY = "k";
    const braveBody = JSON.stringify({
      web: { results: [{ title: "Gibson kit", url: "https://www.neb.com/g", description: "d" }] },
    });
    const fakeFetch = (async (url: string) => {
      expect(url).toContain("api.search.brave.com"); // never reaches DuckDuckGo
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
    expect((await searchProtocols("   ")).query).toBe("");
    const resp = await searchProtocols("pcr", {
      vendors: ["neb", "nope"],
      providerOpts: { fetchImpl: (async () => new Response(MIXED_LITE, { status: 200 })) as unknown as typeof fetch },
    });
    expect(resp.unknownVendors).toEqual(["nope"]);
  });

  it("does not cross-attribute lookalike hostnames", async () => {
    const evil = (async () =>
      new Response(
        `<table><tr><td><a href="https://neb.com.evil.com/x" class="result-link">Phish</a></td></tr></table>`,
        { status: 200 },
      )) as unknown as typeof fetch;
    const resp = await searchProtocols("pcr", {
      vendors: ["neb"],
      providerOpts: { fetchImpl: evil, timeoutMs: 400 },
    });
    expect(resp.vendors[0]!.results).toEqual([]);
  });
});

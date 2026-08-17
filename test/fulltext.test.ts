import { describe, it, expect } from "vitest";
import { directPdfUrl, displayOnlyPdfUrl, getProtocolFulltext, pmcidFromUrl } from "../src/fulltext.ts";

const searchHit = (extra: Record<string, unknown>) =>
  JSON.stringify({ resultList: { result: [{ id: "123", source: "MED", title: "My Protocol", ...extra }] } });

const FULLTEXT_XML =
  "<article><front><article-meta>METADATA-NOISE</article-meta></front>" +
  "<body><sec><title>Steps</title><p>Step 1: mix the reagents.</p></sec></body></article>";

/** Route by URL: /search → search JSON, /fullTextXML → the JATS XML. */
function router(search: string, xml = FULLTEXT_XML): typeof fetch {
  return (async (url: string) =>
    new Response(url.includes("/search") ? search : xml, { status: 200 })) as unknown as typeof fetch;
}

describe("getProtocolFulltext", () => {
  it("resolves an id to a PMCID and returns the stripped body text", async () => {
    const f = router(searchHit({ pmcid: "PMC999", doi: "10.1/x" }));
    const out = await getProtocolFulltext("10.1/x", { fetchImpl: f });
    expect(out).toContain("# My Protocol");
    expect(out).toContain("PMC999");
    expect(out).toContain("Step 1: mix the reagents.");
    expect(out).not.toContain("METADATA-NOISE"); // <front> is excluded, only <body>
  });

  it("builds the fullTextXML URL from the resolved PMCID", async () => {
    let ftUrl = "";
    const f = (async (url: string) => {
      if (url.includes("/search")) return new Response(searchHit({ pmcid: "PMC42" }), { status: 200 });
      ftUrl = url;
      return new Response(FULLTEXT_XML, { status: 200 });
    }) as unknown as typeof fetch;
    await getProtocolFulltext("PMC42", { fetchImpl: f });
    expect(ftUrl).toContain("/rest/PMC42/fullTextXML");
  });

  it("falls back to a citation link when there is no open-access PMCID", async () => {
    const f = router(searchHit({ doi: "10.1/paywalled" }));
    const out = await getProtocolFulltext("10.1/paywalled", { fetchImpl: f });
    expect(out).toContain("No open-access full text");
    expect(out).toContain("https://doi.org/10.1/paywalled");
  });

  it("reports when nothing is indexed", async () => {
    const f = router(JSON.stringify({ resultList: { result: [] } }));
    const out = await getProtocolFulltext("nonsense", { fetchImpl: f });
    expect(out).toContain("No Europe PMC record found");
  });

  it("throws on a non-200 search response", async () => {
    const bad = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(getProtocolFulltext("10.1/x", { fetchImpl: bad })).rejects.toThrow(/Europe PMC HTTP 403/);
  });

  it("tags every outcome with a machine-readable status footer", async () => {
    const ok = router(searchHit({ pmcid: "PMC1" }));
    expect(await getProtocolFulltext("PMC1", { fetchImpl: ok })).toContain("_status: ok_");
    const none = router(searchHit({ doi: "10.1/paywalled" }));
    expect(await getProtocolFulltext("10.1/paywalled", { fetchImpl: none })).toContain(
      "_status: no-open-fulltext_",
    );
  });
});

// A body with two sections; the parser should split them by <title>.
const MULTISEC_XML =
  "<article><body>" +
  "<sec><title>Introduction</title><p>Background prose.</p></sec>" +
  "<sec><title>Methods</title><p>Add 5 uL enzyme; incubate 37C.</p></sec>" +
  "</body></article>";

describe("getProtocolFulltext — section-aware rendering", () => {
  it("returns only the requested section", async () => {
    const f = router(searchHit({ pmcid: "PMC7" }), MULTISEC_XML);
    const out = await getProtocolFulltext("PMC7", { fetchImpl: f, section: "methods" });
    expect(out).toContain("## Methods");
    expect(out).toContain("incubate 37C");
    expect(out).not.toContain("Background prose");
  });

  it("lists available sections when the filter matches none", async () => {
    const f = router(searchHit({ pmcid: "PMC7" }), MULTISEC_XML);
    const out = await getProtocolFulltext("PMC7", { fetchImpl: f, section: "nope" });
    expect(out).toContain("No section matching");
    expect(out).toContain("Introduction");
    expect(out).toContain("Methods");
  });

  it("renders a section TOC when there are multiple sections", async () => {
    const f = router(searchHit({ pmcid: "PMC7" }), MULTISEC_XML);
    const out = await getProtocolFulltext("PMC7", { fetchImpl: f });
    expect(out).toContain("Sections:");
    expect(out).toContain("## Introduction");
    expect(out).toContain("## Methods");
  });
});

// Europe PMC serves only its open-access subset and 404s on author manuscripts;
// NCBI serves those. Without this tier a PMC-deposited protocol in a paywalled
// journal reads as "no full text" even though the deposited text is right there.
describe("getProtocolFulltext — NCBI fallback for PMC author manuscripts", () => {
  /** Europe PMC 404s the PMCID; NCBI's efetch answers with the JATS. */
  function ncbiRouter(ncbiXml: string, search = searchHit({ pmcid: "PMC3868217", doi: "10.1/nprot" })) {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(url);
      if (url.includes("/search")) return new Response(search, { status: 200 });
      if (url.includes("fullTextXML")) return new Response("not found", { status: 404 });
      if (url.includes("efetch.fcgi")) return new Response(ncbiXml, { status: 200 });
      return new Response(JSON.stringify({ is_oa: false }), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("renders the manuscript NCBI serves when Europe PMC has no open copy", async () => {
    const { impl } = ncbiRouter(FULLTEXT_XML);
    const out = await getProtocolFulltext("10.1/nprot", { fetchImpl: impl });
    expect(out).toContain("Step 1: mix the reagents.");
    expect(out).toContain("NCBI E-utilities");
    expect(out).toContain("PMC3868217");
    expect(out).toContain("_status: ok_");
  });

  it("identifies the client to NCBI and strips the PMC prefix from the id", async () => {
    const { impl, calls } = ncbiRouter(FULLTEXT_XML);
    await getProtocolFulltext("10.1/nprot", { fetchImpl: impl });
    const efetch = calls.find((u) => u.includes("efetch.fcgi"))!;
    expect(efetch).toContain("db=pmc");
    expect(efetch).toContain("id=3868217"); // NCBI wants the bare number
    expect(efetch).toContain("tool=labee-protocol-searcher");
    expect(efetch).toMatch(/email=/);
  });

  it("tries Europe PMC first, so an OA article never costs an NCBI request", async () => {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(url);
      if (url.includes("/search")) return new Response(searchHit({ pmcid: "PMC1" }), { status: 200 });
      return new Response(FULLTEXT_XML, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await getProtocolFulltext("PMC1", { fetchImpl: impl });
    expect(out).toContain("Europe PMC");
    expect(calls.some((u) => u.includes("efetch.fcgi"))).toBe(false);
  });

  it("treats a publisher opt-out (no <body>) as a miss, not as text", async () => {
    // What NCBI actually returns for those: metadata plus a comment saying the
    // publisher doesn't allow XML download. Rendering it would emit noise.
    const optOut =
      "<article><front><article-meta><article-id>3004291</article-id></article-meta></front>" +
      "<!--The publisher of this article does not allow downloading of the full text in XML form.--></article>";
    const { impl } = ncbiRouter(optOut, searchHit({ pmcid: "PMC3004291", doi: "10.1/closed", abstractText: "A".repeat(150) }));
    const out = await getProtocolFulltext("10.1/closed", { fetchImpl: impl });
    expect(out).not.toContain("3004291</article-id>");
    expect(out).toContain("_status: abstract-only_");
    // The deposit is still readable in a browser — say where.
    expect(out).toContain("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3004291/");
  });
});

// Every Europe PMC record carries an abstract, and step 1 already paid for it.
describe("getProtocolFulltext — abstract fallback", () => {
  const paywalled = (extra: Record<string, unknown> = {}) =>
    searchHit({
      doi: "10.1038/nprot.2008.133",
      abstractText:
        "Touchdown PCR offers a simple and rapid means to optimize PCRs, increasing specificity, " +
        "sensitivity and yield, without the need for lengthy optimizations.",
      meshHeadingList: { meshHeading: [{ descriptorName: "DNA Primers" }, { descriptorName: "Temperature" }] },
      ...extra,
    });

  it("returns the abstract and MeSH terms instead of a bare link", async () => {
    const f = router(paywalled());
    const out = await getProtocolFulltext("10.1038/nprot.2008.133", { fetchImpl: f });
    expect(out).toContain("## Abstract");
    expect(out).toContain("Touchdown PCR offers a simple and rapid means");
    expect(out).toContain("MeSH: DNA Primers · Temperature");
    expect(out).toContain("https://doi.org/10.1038/nprot.2008.133");
    expect(out).toContain("_status: abstract-only_");
  });

  it("stays `no-open-fulltext` when there is no abstract either", async () => {
    const f = router(searchHit({ doi: "10.1/bare" }));
    const out = await getProtocolFulltext("10.1/bare", { fetchImpl: f });
    expect(out).toContain("_status: no-open-fulltext_");
    expect(out).not.toContain("## Abstract");
  });

  it("ignores a stub abstract rather than passing off a fragment as content", async () => {
    const f = router(searchHit({ doi: "10.1/stub", abstractText: "No abstract available." }));
    expect(await getProtocolFulltext("10.1/stub", { fetchImpl: f })).toContain("_status: no-open-fulltext_");
  });

  it("never displaces real full text", async () => {
    const f = router(paywalled({ pmcid: "PMC1" }));
    const out = await getProtocolFulltext("10.1038/nprot.2008.133", { fetchImpl: f });
    expect(out).toContain("_status: ok_");
    expect(out).toContain("Step 1: mix the reagents.");
    expect(out).not.toContain("## Abstract");
  });

  it("strips markup out of the abstract", async () => {
    const f = router(searchHit({ doi: "10.1/tags", abstractText: `<p>Structured <b>abstract</b> text. ${"x".repeat(120)}</p>` }));
    const out = await getProtocolFulltext("10.1/tags", { fetchImpl: f });
    expect(out).toContain("Structured abstract text.");
    expect(out).not.toContain("<b>");
  });
});

describe("getProtocolFulltext — Unpaywall fallback", () => {
  it("recovers a PMC copy via Unpaywall when Europe PMC has no PMCID", async () => {
    const f = (async (url: string) => {
      if (url.includes("/search")) return new Response(searchHit({ doi: "10.5/oa" }), { status: 200 });
      if (url.includes("api.unpaywall.org")) {
        return new Response(
          JSON.stringify({
            is_oa: true,
            best_oa_location: { url: "https://europepmc.org/articles/PMC555", license: "cc-by" },
          }),
          { status: 200 },
        );
      }
      return new Response(FULLTEXT_XML, { status: 200 }); // the recovered fullTextXML
    }) as unknown as typeof fetch;
    const out = await getProtocolFulltext("10.5/oa", { fetchImpl: f });
    expect(out).toContain("Unpaywall");
    expect(out).toContain("PMC555");
    expect(out).toContain("Step 1: mix the reagents.");
    expect(out).toContain("_status: ok_");
  });

  it("extracts an OA HTML landing page when Unpaywall has no PMC copy", async () => {
    const f = (async (url: string) => {
      if (url.includes("/search")) return new Response(searchHit({ doi: "10.5/html" }), { status: 200 });
      if (url.includes("api.unpaywall.org")) {
        return new Response(
          JSON.stringify({ is_oa: true, best_oa_location: { url: "https://oa.example/paper", license: "cc-by" } }),
          { status: 200 },
        );
      }
      return new Response("<html><body><article><p>Extracted OA body text.</p></article></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const out = await getProtocolFulltext("10.5/html", { fetchImpl: f });
    expect(out).toContain("best-effort extraction");
    expect(out).toContain("Extracted OA body text.");
    expect(out).toContain("_status: ok_");
  });

  it("returns a direct OA link when the copy can't be extracted (e.g. PDF, no unpdf)", async () => {
    const f = (async (url: string) => {
      if (url.includes("/search")) return new Response(searchHit({ doi: "10.5/pdf" }), { status: 200 });
      if (url.includes("api.unpaywall.org")) {
        return new Response(
          JSON.stringify({ is_oa: true, best_oa_location: { url_for_pdf: "https://oa.example/x.pdf" } }),
          { status: 200 },
        );
      }
      return new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } });
    }) as unknown as typeof fetch;
    const out = await getProtocolFulltext("10.5/pdf", { fetchImpl: f });
    expect(out).toContain("https://oa.example/x.pdf");
    expect(out).toContain("_status: oa-link_");
  });
});

// Unpaywall writes PMC links both ways. Missing the bare form sent `fetch` to
// scrape the PMC website, which answers with a bot challenge — measured on
// 10.1038/nprot.2006.98, which was published as `ok` with the wall as its text.
describe("pmcidFromUrl", () => {
  it("reads the prefixed form", () => {
    expect(pmcidFromUrl("https://europepmc.org/articles/PMC555")).toBe("PMC555");
    expect(pmcidFromUrl("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6058056/pdf/")).toBe("PMC6058056");
  });

  it("reads the bare form older records use", () => {
    expect(pmcidFromUrl("https://www.ncbi.nlm.nih.gov/pmc/articles/3004291")).toBe("PMC3004291");
  });

  it("is undefined for a non-PMC location", () => {
    expect(pmcidFromUrl("https://research.wur.nl/en/publications/chip-of-plant-tfs")).toBeUndefined();
  });
});

describe("getProtocolFulltext — a bare-numbered PMC location", () => {
  it("routes to the PMC API instead of scraping the PMC website", async () => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      if (url.includes("/search")) return new Response(searchHit({ doi: "10.1/bare-pmc" }), { status: 200 });
      if (url.includes("api.unpaywall.org")) {
        return new Response(
          JSON.stringify({ is_oa: true, best_oa_location: { url: "https://www.ncbi.nlm.nih.gov/pmc/articles/3004291" } }),
          { status: 200 },
        );
      }
      if (url.includes("fullTextXML")) return new Response("nope", { status: 404 });
      if (url.includes("efetch.fcgi")) return new Response(FULLTEXT_XML, { status: 200 });
      return new Response("<html><body>Checking your browser before accessing</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const out = await getProtocolFulltext("10.1/bare-pmc", { fetchImpl: f });
    expect(out).toContain("Step 1: mix the reagents.");
    expect(out).toContain("PMC3004291");
    expect(calls.some((u) => u.includes("efetch.fcgi"))).toBe(true);
    expect(out).not.toContain("Checking your browser");
  });
});

describe("displayOnlyPdfUrl", () => {
  const freePdf = {
    fullTextUrl: [
      { availability: "Free", documentStyle: "pdf", url: "https://europepmc.org/articles/PMC1?pdf=render" },
    ],
  };

  it("offers the rendered PDF for a free-to-read record outside the OA subset", () => {
    expect(
      displayOnlyPdfUrl({ pmcid: "PMC6017984", inEPMC: "Y", isOpenAccess: "N", fullTextUrlList: freePdf }),
    ).toBe("https://europepmc.org/articles/PMC6017984?pdf=render");
  });

  it("declines an OA-subset record, which the proper OA tiers already serve", () => {
    expect(
      displayOnlyPdfUrl({ pmcid: "PMC1", inEPMC: "Y", isOpenAccess: "Y", fullTextUrlList: freePdf }),
    ).toBeNull();
  });

  it("declines when the full text is not in Europe PMC at all", () => {
    expect(
      displayOnlyPdfUrl({ pmcid: "PMC1", inEPMC: "N", isOpenAccess: "N", fullTextUrlList: freePdf }),
    ).toBeNull();
  });

  it("declines when no free PDF is advertised", () => {
    expect(
      displayOnlyPdfUrl({
        pmcid: "PMC1",
        inEPMC: "Y",
        isOpenAccess: "N",
        fullTextUrlList: {
          fullTextUrl: [{ availability: "Subscription required", documentStyle: "pdf", url: "https://x" }],
        },
      }),
    ).toBeNull();
  });

  it("declines without a PMCID", () => {
    expect(displayOnlyPdfUrl({ inEPMC: "Y", isOpenAccess: "N", fullTextUrlList: freePdf })).toBeNull();
  });
});

describe("directPdfUrl", () => {
  it("maps a Bio-protocol DOI to the publisher's public PDF", () => {
    expect(directPdfUrl("10.21769/BioProtoc.5775")).toBe(
      "https://en.bio-protocol.org/pdf/Bio-protocol5775.pdf",
    );
  });

  it("is case-insensitive and tolerates a doi: prefix", () => {
    expect(directPdfUrl("doi:10.21769/bioprotoc.2829")).toBe(
      "https://en.bio-protocol.org/pdf/Bio-protocol2829.pdf",
    );
  });

  it("declines a DOI from any other publisher", () => {
    expect(directPdfUrl("10.1038/nprot.2017.006")).toBeNull();
    expect(directPdfUrl("10.1002/cpz1.289")).toBeNull();
  });

  it("declines a malformed Bio-protocol DOI rather than guessing an id", () => {
    expect(directPdfUrl("10.21769/BioProtoc.abc")).toBeNull();
    expect(directPdfUrl("10.21769/SomethingElse.5775")).toBeNull();
  });

  it("declines undefined", () => {
    expect(directPdfUrl(undefined)).toBeNull();
  });
});

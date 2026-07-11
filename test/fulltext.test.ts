import { describe, it, expect } from "vitest";
import { getProtocolFulltext } from "../src/fulltext.ts";

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

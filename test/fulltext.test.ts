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
});

import { describe, it, expect, afterEach } from "vitest";
import { parseHtmlResults, parseLiteResults, duckduckgoProvider } from "../src/providers/duckduckgo.ts";
import { braveProvider } from "../src/providers/brave.ts";
import { googleProvider } from "../src/providers/google.ts";

const HTML_SAMPLE = `
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.takarabio.com%2Fproducts%2Fcdna&amp;rut=abc">
      SMARTer cDNA Synthesis Kit &amp; Guide
    </a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">A <b>cDNA</b> synthesis protocol.</a>
</div>
`;
const LITE_SAMPLE = `
<table>
  <tr><td><a rel="nofollow" href="https://www.neb.com/en-us/products/m0491" class="result-link">Q5 Polymerase</a></td></tr>
  <tr><td class="result-snippet">High-fidelity PCR.</td></tr>
</table>
`;

describe("duckduckgo parsers", () => {
  it("parses html markup, unwrapping uddg + entities", () => {
    const out = parseHtmlResults(HTML_SAMPLE, 5);
    expect(out[0]).toMatchObject({
      title: "SMARTer cDNA Synthesis Kit & Guide",
      url: "https://www.takarabio.com/products/cdna",
    });
  });
  it("parses lite table markup with following snippets", () => {
    const out = parseLiteResults(LITE_SAMPLE, 5);
    expect(out[0]).toMatchObject({
      title: "Q5 Polymerase",
      url: "https://www.neb.com/en-us/products/m0491",
      snippet: "High-fidelity PCR.",
    });
  });
});

describe("duckduckgoProvider", () => {
  it("returns lite results then reports rate-limit after retries", async () => {
    const ok = (async () => new Response(LITE_SAMPLE, { status: 200 })) as unknown as typeof fetch;
    expect((await duckduckgoProvider.run("site:neb.com pcr", 5, { fetchImpl: ok })).results).toHaveLength(1);

    let calls = 0;
    const blocked = (async () => {
      calls++;
      return new Response("<html>challenge</html>", { status: 202 });
    }) as unknown as typeof fetch;
    const res = await duckduckgoProvider.run("x", 5, { fetchImpl: blocked, timeoutMs: 800 });
    expect(calls).toBe(4); // 2 endpoints x 2 attempts
    expect(res.error).toMatch(/202/);
  });
});

describe("keyed providers", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("brave is unavailable without a key and parses JSON with one", async () => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    expect(braveProvider.available()).toBe(false);

    process.env.BRAVE_API_KEY = "test-key";
    expect(braveProvider.available()).toBe(true);
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["X-Subscription-Token"]).toBe("test-key");
      return new Response(
        JSON.stringify({
          web: { results: [{ title: "Gibson Assembly Protocol", url: "https://www.neb.com/x", description: "steps" }] },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const res = await braveProvider.run("site:neb.com gibson", 5, { fetchImpl: fakeFetch });
    expect(res.results).toEqual([
      { title: "Gibson Assembly Protocol", url: "https://www.neb.com/x", snippet: "steps" },
    ]);
  });

  it("honors BRAVE_API_ENDPOINT override (self-host / proxy)", async () => {
    process.env.BRAVE_API_KEY = "k";
    process.env.BRAVE_API_ENDPOINT = "http://localhost:9999/search";
    let seen = "";
    const fakeFetch = (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    await braveProvider.run("site:neb.com x", 5, { fetchImpl: fakeFetch });
    expect(seen.startsWith("http://localhost:9999/search?")).toBe(true);
  });

  it("google needs both key and cx, then parses items", async () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_CSE_KEY;
    process.env.GOOGLE_CSE_CX = "cx123";
    expect(googleProvider.available()).toBe(false);
    process.env.GOOGLE_API_KEY = "k";
    expect(googleProvider.available()).toBe(true);
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ items: [{ title: "RNeasy Handbook", link: "https://www.qiagen.com/h", snippet: "rna" }] }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const res = await googleProvider.run("site:qiagen.com rneasy", 5, { fetchImpl: fakeFetch });
    expect(res.results[0]).toMatchObject({ url: "https://www.qiagen.com/h", title: "RNeasy Handbook" });
  });
});

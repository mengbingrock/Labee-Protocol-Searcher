import { describe, it, expect, afterEach } from "vitest";
import { braveProvider } from "../src/providers/brave.ts";
import { googleProvider } from "../src/providers/google.ts";
import { NO_PROVIDER_CONFIGURED, activeProviders, webSearch } from "../src/providers/registry.ts";

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

  it("runs every available web backend and records exhaustive coverage", async () => {
    process.env.BRAVE_API_KEY = "k";
    process.env.GOOGLE_API_KEY = "k";
    process.env.GOOGLE_CSE_CX = "cx";
    delete process.env.PROTOCOLS_SEARCH_PROVIDER;
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      if (url.includes("api.search.brave.com")) {
        seen.push("brave");
        return new Response(JSON.stringify({ web: { results: [{ title: "Q5", url: "https://www.neb.com/en-us/products/m0491", description: "brave" }] } }), { status: 200 });
      }
      if (url.includes("googleapis.com")) {
        seen.push("google");
        return new Response(JSON.stringify({ items: [{ title: "Q5", link: "https://www.neb.com/en-us/products/m0491", snippet: "google" }] }), { status: 200 });
      }
      throw new Error(`unexpected provider call: ${url}`);
    }) as unknown as typeof fetch;
    const out = await webSearch("site:neb.com Q5", 3, { fetchImpl: fakeFetch });
    expect(seen).toEqual(["brave", "google"]);
    expect(out.providers.map((provider) => [provider.id, provider.status])).toEqual([
      ["brave", "ok"], ["google", "ok"],
    ]);
    expect(out.results).toHaveLength(1);
  });

  // With DuckDuckGo gone there is no keyless provider, so an unkeyed install
  // has nothing to try. It must say that rather than report "no results",
  // which reads as "the vendor had nothing" and hides the missing key.
  it("reports the missing key instead of an empty result set", async () => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_CSE_KEY;
    delete process.env.GOOGLE_CSE_CX;
    delete process.env.PROTOCOLS_SEARCH_PROVIDER;
    expect(activeProviders()).toEqual([]);

    const neverCalled = (async () => {
      throw new Error("no provider should have been contacted");
    }) as unknown as typeof fetch;
    const out = await webSearch("site:neb.com Q5", 3, { fetchImpl: neverCalled });
    expect(out.results).toEqual([]);
    expect(out.provider).toBe("none");
    expect(out.error).toBe(NO_PROVIDER_CONFIGURED);
    expect(out.providers.map((p) => [p.id, p.status])).toEqual([
      ["brave", "unavailable"], ["google", "unavailable"],
    ]);
  });
});

describe("snippet markup", () => {
  it("strips Brave's <strong> match markers and entities", async () => {
    process.env.BRAVE_API_KEY = "k";
    const body = JSON.stringify({
      web: {
        results: [
          {
            title: "RNA <strong>Extraction</strong> Kits &amp; Reagents",
            url: "https://www.qiagen.com/x",
            description: "Explore our <strong>RNA extraction kit</strong>s at 4 &deg;C.",
          },
        ],
      },
    });
    const f = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const out = await braveProvider.run("rna", 3, { fetchImpl: f });
    expect(out.results[0]!.title).toBe("RNA Extraction Kits & Reagents");
    expect(out.results[0]!.snippet).toBe("Explore our RNA extraction kits at 4 °C.");
  });
});

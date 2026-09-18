import { describe, it, expect, afterEach } from "vitest";
import {
  assertBrowserlessEndpoint,
  browserlessConfig,
  looksLikeSoftNotFound,
  renderWithBrowserless,
} from "../src/browserless.ts";
import { extractOaContent, extractEntitledArticle } from "../src/extract.ts";
import { fetchResource } from "../src/fetch.ts";

const PAGE = `<html><body><article><p>${"Add 5 µl of buffer and incubate at 37 °C. ".repeat(20)}</p></article></body></html>`;

/** Refuses the site outright, answers as Browserless for the unblock call. */
function blockedSiteWithBrowserless(html: string, seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    seen.push(url);
    // Self-hosted /content answers raw HTML; hosted /unblock wraps it in JSON.
    if (url.includes("/content")) {
      return new Response(html, { status: 200 });
    }
    if (url.includes("/unblock")) {
      return new Response(JSON.stringify({ content: html }), { status: 200 });
    }
    return new Response("Access Denied", { status: 403 });
  }) as unknown as typeof fetch;
}

describe("browserlessConfig", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("is unconfigured without a token, so an install without one is unchanged", () => {
    delete process.env.BROWSERLESS_TOKEN;
    expect(browserlessConfig()).toBeNull();
  });

  it("can be switched off even when a token is present", () => {
    process.env.BROWSERLESS_TOKEN = "t";
    process.env.PROTOCOLS_BROWSERLESS = "off";
    expect(browserlessConfig()).toBeNull();
  });

  it("defaults the endpoint and clamps an absurd timeout", () => {
    process.env.BROWSERLESS_TOKEN = "t";
    delete process.env.PROTOCOLS_BROWSERLESS;
    delete process.env.BROWSERLESS_URL;
    process.env.BROWSERLESS_TIMEOUT_MS = "999999";
    const cfg = browserlessConfig()!;
    // Our own deployment, not a hosted browserless.io region: that is a
    // different codebase without the residential exit.
    expect(cfg.endpoint).toBe("https://browserless.truegrit.dev");
    expect(cfg.timeoutMs).toBe(120_000);
  });
});

describe("assertBrowserlessEndpoint", () => {
  it("accepts HTTPS and loopback HTTP (the self-hosted container)", () => {
    expect(assertBrowserlessEndpoint("https://production-sfo.browserless.io").protocol).toBe("https:");
    expect(assertBrowserlessEndpoint("http://127.0.0.1:3000").port).toBe("3000");
  });

  it("refuses plaintext to a public host and credentials in the URL", () => {
    expect(() => assertBrowserlessEndpoint("http://browserless.example.com")).toThrow(/HTTPS/);
    expect(() => assertBrowserlessEndpoint("https://user:pw@browserless.io")).toThrow(/credentials/);
  });
});

describe("looksLikeSoftNotFound", () => {
  it("catches the rendered 404 that carries no HTTP status", () => {
    // Verbatim shape of the neb.com 404 that previously extracted as content.
    expect(looksLikeSoftNotFound("We're very sorry, but we cannot find the URL that you have requested.")).toBe(true);
    expect(looksLikeSoftNotFound("Page Not Found")).toBe(true);
  });

  it("does not discard a protocol that merely discusses status codes", () => {
    const body = `Troubleshooting. If the server returns 404 not found, check the accession. ${"x".repeat(2000)}`;
    expect(looksLikeSoftNotFound(body.slice(1_300))).toBe(false);
  });
});

describe("renderWithBrowserless", () => {
  const cfg = { endpoint: "https://production-sfo.browserless.io", token: "t", timeoutMs: 5_000 };

  it("posts the target to /unblock and returns the rendered HTML", async () => {
    let body = "";
    const f = (async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ content: "<html>ok</html>" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await renderWithBrowserless("https://www.neb.com/x", f, cfg)).toBe("<html>ok</html>");
    expect(JSON.parse(body)).toMatchObject({ url: "https://www.neb.com/x", content: true });
  });

  it("returns null rather than throwing on any failure", async () => {
    const fail = (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
    expect(await renderWithBrowserless("https://x.test/a", fail, cfg)).toBeNull();

    const garbage = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    expect(await renderWithBrowserless("https://x.test/a", garbage, cfg)).toBeNull();

    const threw = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    expect(await renderWithBrowserless("https://x.test/a", threw, cfg)).toBeNull();
  });
});

describe("extractOaContent — remote-browser fallback", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("is never the first attempt: a page that fetches directly never reaches it", async () => {
    process.env.BROWSERLESS_TOKEN = "t";
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      return new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;

    const out = await extractOaContent("https://www.takarabio.com/p", { fetchImpl: f }, 5_000);
    expect(out?.via).toBeUndefined();
    expect(seen.some((u) => /\/(content|unblock)/.test(u))).toBe(false);
  });

  it("recovers a page the site refuses, and marks how it was obtained", async () => {
    process.env.BROWSERLESS_TOKEN = "t";
    const seen: string[] = [];
    const out = await extractOaContent(
      "https://www.neb.com/protocols/x",
      { fetchImpl: blockedSiteWithBrowserless(PAGE, seen) },
      5_000,
    );
    expect(out?.via).toBe("browserless");
    expect(out?.text).toContain("incubate at 37 °C");
    expect(seen.some((u) => u.includes("/content"))).toBe(true);
  });

  it("stays null without a token, so behaviour is unchanged when unconfigured", async () => {
    delete process.env.BROWSERLESS_TOKEN;
    const seen: string[] = [];
    const out = await extractOaContent(
      "https://www.neb.com/protocols/x",
      { fetchImpl: blockedSiteWithBrowserless(PAGE, seen) },
      5_000,
    );
    expect(out).toBeNull();
    expect(seen.some((u) => /\/(content|unblock)/.test(u))).toBe(false);
  });

  it("rejects a rendered soft 404 instead of reporting it as content", async () => {
    process.env.BROWSERLESS_TOKEN = "t";
    const notFound = "<html><body><main>We're very sorry, but we cannot find the URL that you have requested.</main></body></html>";
    const out = await extractOaContent(
      "https://www.neb.com/protocols/dead",
      { fetchImpl: blockedSiteWithBrowserless(notFound) },
      5_000,
    );
    expect(out).toBeNull();
  });

  it("does not spend a render on a PDF, which a browser opens in its viewer", async () => {
    process.env.BROWSERLESS_TOKEN = "t";
    const seen: string[] = [];
    await extractOaContent(
      "https://example.test/article.pdf",
      { fetchImpl: blockedSiteWithBrowserless(PAGE, seen) },
      5_000,
    );
    expect(seen.some((u) => /\/(content|unblock)/.test(u))).toBe(false);
  });
});

describe("entitled retrieval never uses the remote browser", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  // Entitlement is decided by IP. Content fetched from a datacenter would be
  // labelled `entitled-full-text` while having been obtained under no
  // entitlement, and since entitled retrieval is now the first tier that wrong
  // answer would pre-empt every open-access tier below it.
  it("does not call Browserless when the publisher refuses", async () => {
    process.env.BROWSERLESS_TOKEN = "t";
    const seen: string[] = [];
    const out = await extractEntitledArticle(
      "https://doi.org/10.1/paywalled",
      { fetchImpl: blockedSiteWithBrowserless(PAGE, seen) },
      5_000,
      "Some University",
    );
    expect(out.extracted).toBeNull();
    expect(seen.some((u) => /\/(content|unblock)/.test(u))).toBe(false);
  });
});

describe("fetchWebPage labelling", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("reports browser-derived text as display-only, not ok", async () => {
    process.env.BROWSERLESS_TOKEN = "t";
    const out = await fetchResource("url:https://www.neb.com/protocols/x", {
      fetchImpl: blockedSiteWithBrowserless(PAGE),
    });
    expect(out).toContain("_status: display-only-full-text_");
    expect(out).toContain("read in a remote browser");
  });

  it("still reports an ordinary retrieval as ok", async () => {
    process.env.BROWSERLESS_TOKEN = "t";
    const f = (async () =>
      new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const out = await fetchResource("url:https://www.takarabio.com/p", { fetchImpl: f });
    expect(out).toContain("_status: ok_");
  });
});

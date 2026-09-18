import { describe, expect, it } from "vitest";
import { browserHosts, chromeFallbackUrl, fetchResourceWithBrowser } from "../src/agent/browser-fetch.ts";
import type { BrowserAdapter, BrowserEvidence, BrowserRequest } from "../src/agent/types.ts";

class NebBrowser implements BrowserAdapter {
  readonly id = "fixture-browser";
  async available() { return { available: true }; }
  async retrieve(request: BrowserRequest): Promise<BrowserEvidence> {
    return {
      status: "ok" as const,
      text: "NEB protocol: combine the reaction, incubate, and wash the product.",
      finalUrl: request.url,
      links: ["https://www.protocols.io/view/official-neb-protocol-abc123"],
      provenance: { adapter: this.id, route: "publisher-dom" },
    };
  }
  async close() {}
}

describe("fetchResourceWithBrowser", () => {
  it("uses the canonical DOI instead of an unrelated URL found in abstract text", () => {
    expect(chromeFallbackUrl(
      "doi:10.1038/nprot.2016.055",
      "Abstract metadata: https://europepmc.org/article/MED/27120195",
    )).toBe("https://doi.org/10.1038/nprot.2016.055");
  });

  it("prefers an official NEB protocols.io mirror discovered in the visible page", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("protocols.io")) {
        return new Response(JSON.stringify({
          title: "Official NEB protocol",
          authors: [{ name: "New England Biolabs" }],
          steps: [{ step: JSON.stringify({ blocks: [{ type: "unstyled", text: "Incubate at 37 °C for 30 minutes." }] }) }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 403 });
    }) as typeof fetch;
    const output = await fetchResourceWithBrowser(
      "url:https://www.neb.com/en-us/protocols/example",
      { fetchImpl, validateUrl: async () => undefined },
      new NebBrowser(),
    );
    expect(output).toContain("# Official NEB protocol");
    expect(output).toContain("Incubate at 37 °C for 30 minutes");
    expect(output).toContain("_status: ok_");
    expect(output).not.toContain("display-only-full-text");
  });

  it("labels publisher DOM as display-only when no licensed mirror is present", async () => {
    const browser = new NebBrowser();
    browser.retrieve = async (request) => ({
      status: "ok",
      text: "Step 1: Add buffer. Step 2: Incubate for 30 minutes. Step 3: Wash twice.",
      finalUrl: request.url,
      links: [],
      provenance: { adapter: browser.id, route: "publisher-dom" },
    });
    const output = await fetchResourceWithBrowser(
      "url:https://www.neb.com/en-us/protocols/example",
      { fetchImpl: (async () => new Response("", { status: 403 })) as typeof fetch },
      browser,
    );
    expect(output).toContain("no redistribution licence was detected");
    expect(output).toContain("_status: display-only-full-text_");
  });

  it("returns NEB HTML captured during search from the same default-profile cache", async () => {
    const browser = new NebBrowser();
    browser.retrieve = async (request) => ({
      status: "ok",
      text: "Step 1: Assemble the PCR reaction and begin thermocycling.",
      html: "<article><h1>NEB PCR</h1><ol><li>Assemble the reaction.</li></ol></article>",
      finalUrl: request.url,
      provenance: { adapter: browser.id, route: "publisher-dom-cache" },
    });
    const output = await fetchResourceWithBrowser(
      "url:https://www.neb.com/en-us/protocols/example",
      { fetchImpl: (async () => new Response("", { status: 403 })) as typeof fetch },
      browser,
    );
    expect(output).toContain("<article><h1>NEB PCR</h1>");
    expect(output).toContain("rendered HTML captured during NEB search");
    expect(output).toContain("_status: display-only-full-text_");
  });

  it("returns an actionable status when visible verification remains unresolved", async () => {
    const browser = new NebBrowser();
    browser.retrieve = async (request) => ({
      status: "interaction-required",
      finalUrl: request.url,
      detail: "complete the visible browser verification, then retry",
      provenance: { adapter: browser.id, route: "publisher-dom" },
    });
    const output = await fetchResourceWithBrowser(
      "url:https://www.neb.com/en-us/protocols/example",
      { fetchImpl: (async () => new Response("", { status: 403 })) as typeof fetch },
      browser,
    );
    expect(output).toContain("Complete the visible check, then retry");
    expect(output).toContain("_status: interaction-required_");
  });
});

// A Merck brand consolidation redirects emdmillipore.com product URLs onto
// www.sigmaaldrich.com. With only the requested hostname allowlisted, the
// destination failed the URL policy and the adapter returned `unsafe-url`,
// which reaches the caller as `not-fetchable` — indistinguishable from the site
// refusing the request. The page was never blocked; real Chrome loads it.
describe("browserHosts sibling domains", () => {
  it("allows the Merck brands to redirect into one another", () => {
    const hosts = browserHosts(new URL("https://www.emdmillipore.com/US/en/product/x"));
    expect(hosts).toContain("www.sigmaaldrich.com");
    expect(hosts).toContain("www.merckmillipore.com");
    // Symmetric: a sigmaaldrich.com URL may land back on emdmillipore.com.
    expect(browserHosts(new URL("https://www.sigmaaldrich.com/US/en/p"))).toContain(
      "www.emdmillipore.com",
    );
  });

  it("keeps NEB's Cloudflare challenge assets", () => {
    const hosts = browserHosts(new URL("https://www.neb.com/protocols/x"));
    expect(hosts).toContain("challenges.cloudflare.com");
    expect(hosts).toContain("neb.com");
  });

  it("does not widen an unrelated host, so the policy stays an allowlist", () => {
    expect(browserHosts(new URL("https://www.qiagen.com/x"))).toEqual(["www.qiagen.com"]);
    // A lookalike must not inherit the group.
    expect(browserHosts(new URL("https://sigmaaldrich.com.evil.test/x"))).toEqual([
      "sigmaaldrich.com.evil.test",
    ]);
  });
});

/** A smallest-valid PDF carrying one line of text, with a correct xref table. */
function minimalPdf(text: string): ArrayBuffer {
  const enc = (s: string) => new TextEncoder().encode(s);
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${enc(content).length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(enc(body).length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = enc(body).length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) body += `${String(o).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // An ArrayBuffer, not a Uint8Array: Response's BodyInit typing rejects
  // Uint8Array<ArrayBufferLike> under current lib definitions.
  const bytes = enc(body);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// NEB's HTML sits behind a Cloudflare challenge; its PDF manuals do not. When
// the rendered page links to one, the native PDF is the better answer on every
// axis — `ok` rather than display-only, no browser round trip, and the kit
// manual holds more of the protocol than the HTML summary — so it is tried
// before the protocols.io mirror and before falling back to the browser DOM.
describe("ungated NEB documents discovered in the visible page", () => {
  const MANUAL = "https://www.neb.com/en-us/-/media/nebus/files/manuals/manuale0554.pdf?rev=1";

  function nebPageLinkingTo(links: string[]): NebBrowser {
    const browser = new NebBrowser();
    browser.retrieve = async (request) => ({
      status: "ok",
      text: "Q5 Site-Directed Mutagenesis Kit protocol summary. Incubate and wash.",
      finalUrl: request.url,
      links,
      provenance: { adapter: browser.id, route: "publisher-dom" },
    });
    return browser;
  }

  it("fetches the manual natively and returns it as ok, ahead of the mirror and the DOM", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith(MANUAL)) {
        return new Response(minimalPdf("Step 1: mix 25 uL of Q5 Hot Start Master Mix."), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      if (url.includes("protocols.io")) {
        return new Response(JSON.stringify({ title: "Mirror", steps: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 403 }); // the gated HTML
    }) as typeof fetch;

    const output = await fetchResourceWithBrowser(
      "url:https://www.neb.com/en-us/protocols/q5-sdm",
      { fetchImpl, validateUrl: async () => undefined },
      nebPageLinkingTo([MANUAL, "https://www.protocols.io/view/official-neb-protocol-abc123"]),
    );

    expect(output).toContain("_status: ok_");
    expect(output).toContain("(pdf extraction)");
    expect(output).toContain("Q5 Hot Start Master Mix");
    expect(output).not.toContain("display-only-full-text");
    // The manual won outright, so the mirror was never spent.
    expect(requested.some((u) => u.startsWith(MANUAL))).toBe(true);
    expect(requested.some((u) => u.includes("protocols.io"))).toBe(false);
  });

  it("falls through to the existing behaviour when the manual is not retrievable", async () => {
    const fetchImpl = (async () => new Response("", { status: 403 })) as typeof fetch;
    const output = await fetchResourceWithBrowser(
      "url:https://www.neb.com/en-us/protocols/q5-sdm",
      { fetchImpl, validateUrl: async () => undefined },
      nebPageLinkingTo([MANUAL]),
    );
    // Manual 403'd, no mirror: the browser DOM is still returned, still labelled.
    expect(output).toContain("_status: display-only-full-text_");
    expect(output).toContain("Incubate and wash");
  });

  it("ignores a PDF on a lookalike host", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response("", { status: 403 });
    }) as typeof fetch;
    await fetchResourceWithBrowser(
      "url:https://www.neb.com/en-us/protocols/q5-sdm",
      { fetchImpl, validateUrl: async () => undefined },
      nebPageLinkingTo(["https://neb.com.evil.test/manual.pdf"]),
    );
    expect(requested.some((u) => u.includes("evil.test"))).toBe(false);
  });
});

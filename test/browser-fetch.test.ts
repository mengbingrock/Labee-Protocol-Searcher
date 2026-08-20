import { describe, expect, it } from "vitest";
import { fetchResourceWithBrowser } from "../src/agent/browser-fetch.ts";
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

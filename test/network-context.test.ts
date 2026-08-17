import { describe, it, expect, afterEach } from "vitest";
import {
  classify,
  detectNetworkContext,
  onAcademicNetwork,
  resetNetworkContext,
} from "../src/network-context.ts";
import { findCitationPdfUrl } from "../src/extract.ts";

const ENV_KEYS = [
  "PROTOCOLS_NETWORK_KIND",
  "PROTOCOLS_NETWORK_DETECT",
  "PROTOCOLS_NETWORK_LOOKUP_URL",
] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetNetworkContext();
});

describe("classify", () => {
  it("recognises a university by operator name", () => {
    expect(classify({ org: "AS26488 Santa Clara University" }).kind).toBe("academic");
    expect(classify({ org: "AS3999 Pennsylvania State University" }).kind).toBe("academic");
  });

  it("recognises non-English university spellings", () => {
    // A trailing \b after the "universit" stem matches none of these, which is
    // exactly the bug this asserts against.
    expect(classify({ org: "AS1234 Universität Heidelberg" }).kind).toBe("academic");
    expect(classify({ org: "AS5678 Université de Paris" }).kind).toBe("academic");
    expect(classify({ org: "AS9012 Universidad de Chile" }).kind).toBe("academic");
  });

  it("recognises national research and education networks", () => {
    for (const org of ["AS786 Jisc Services Limited", "AS680 DFN-Verein", "AS11537 Internet2"]) {
      expect(classify({ org }).kind, org).toBe("academic");
    }
  });

  it("recognises academic reverse-DNS suffixes", () => {
    expect(classify({ rdns: "node.mit.edu" }).kind).toBe("academic");
    expect(classify({ rdns: "host-12.cs.ox.ac.uk" }).kind).toBe("academic");
    expect(classify({ rdns: "lab.eng.edu.au" }).kind).toBe("academic");
  });

  it("calls a cloud or consumer network commercial", () => {
    expect(classify({ org: "AS15169 Google LLC" }).kind).toBe("commercial");
    expect(classify({ org: "AS14618 Amazon.com, Inc." }).kind).toBe("commercial");
    expect(classify({ rdns: "pool-1-2-3.example.net" }).kind).toBe("commercial");
  });

  it("reports unknown rather than guessing when it has no signal", () => {
    const out = classify({});
    expect(out.kind).toBe("unknown");
    expect(out.reason).toMatch(/no network signals/);
  });

  it("explains which signal decided the verdict", () => {
    expect(classify({ org: "AS1 Example University" }).reason).toContain("Example University");
  });
});

describe("detectNetworkContext", () => {
  it("honours an explicit override without any lookup", async () => {
    process.env.PROTOCOLS_NETWORK_KIND = "academic";
    const ctx = await detectNetworkContext();
    expect(ctx.kind).toBe("academic");
    expect(ctx.reason).toMatch(/override/);
    expect(onAcademicNetwork()).toBe(true);
  });

  it("resolves to unknown when detection is switched off", async () => {
    process.env.PROTOCOLS_NETWORK_DETECT = "off";
    const ctx = await detectNetworkContext();
    expect(ctx.kind).toBe("unknown");
    expect(onAcademicNetwork()).toBe(false);
  });

  it("resolves to unknown when the lookup is unreachable, never throwing", async () => {
    // Reserved TEST-NET-1 address, so nothing can answer.
    process.env.PROTOCOLS_NETWORK_LOOKUP_URL = "http://192.0.2.1/json";
    process.env.PROTOCOLS_NETWORK_TIMEOUT_MS = "300";
    const ctx = await detectNetworkContext();
    expect(ctx.kind).toBe("unknown");
    delete process.env.PROTOCOLS_NETWORK_TIMEOUT_MS;
  });

  it("caches, so a second call does not re-detect", async () => {
    process.env.PROTOCOLS_NETWORK_KIND = "academic";
    const a = await detectNetworkContext();
    delete process.env.PROTOCOLS_NETWORK_KIND;
    const b = await detectNetworkContext();
    expect(b).toBe(a);
  });
});

describe("findCitationPdfUrl", () => {
  it("finds the publisher PDF with name before content", () => {
    const html = `<meta name="citation_pdf_url" content="https://p.test/a.pdf">`;
    expect(findCitationPdfUrl(html, "https://p.test/a")).toBe("https://p.test/a.pdf");
  });

  it("finds it with content before name", () => {
    const html = `<meta content="/rel/a.pdf" name="citation_pdf_url" />`;
    expect(findCitationPdfUrl(html, "https://p.test/articles/a")).toBe("https://p.test/rel/a.pdf");
  });

  it("returns null when the page advertises no PDF", () => {
    expect(findCitationPdfUrl("<html><head></head></html>", "https://p.test/a")).toBeNull();
  });
});

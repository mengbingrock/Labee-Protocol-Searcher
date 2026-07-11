import { describe, it, expect } from "vitest";
import { extractOaContent } from "../src/extract.ts";

function resp(body: string, contentType: string, status = 200): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "content-type": contentType } })) as unknown as typeof fetch;
}

describe("extractOaContent", () => {
  it("pulls the main <article> text out of an HTML page, dropping chrome", async () => {
    const html =
      "<html><head><style>.x{}</style></head><body><nav>menu</nav>" +
      "<article><h2>Protocol</h2><p>Mix 5 uL enzyme.</p><script>evil()</script>" +
      "<p>Incubate at 37&deg;C.</p></article><footer>copyright</footer></body></html>";
    const out = await extractOaContent("https://oa.example/paper", { fetchImpl: resp(html, "text/html") }, 20000);
    expect(out?.format).toBe("html");
    expect(out?.text).toContain("Mix 5 uL enzyme.");
    expect(out?.text).toContain("Incubate at 37°C."); // entity decoded
    expect(out?.text).not.toContain("menu");
    expect(out?.text).not.toContain("evil");
    expect(out?.text).not.toContain("copyright");
  });

  it("strips XML to its <body> text", async () => {
    const xml = "<article><front>META</front><body><p>Step one.</p></body></article>";
    const out = await extractOaContent("https://oa.example/x.xml", { fetchImpl: resp(xml, "application/xml") }, 20000);
    expect(out?.format).toBe("xml");
    expect(out?.text).toContain("Step one.");
    expect(out?.text).not.toContain("META");
  });

  it("returns null for a malformed/undecodable PDF (caller falls back to the link)", async () => {
    const out = await extractOaContent(
      "https://oa.example/x.pdf",
      { fetchImpl: resp("%PDF-1.7 not-a-real-pdf", "application/pdf") },
      20000,
    );
    expect(out).toBeNull(); // unpdf can't parse it → fall back to the plain OA link
  });

  it("returns null on a non-200 response", async () => {
    const out = await extractOaContent("https://oa.example/gone", { fetchImpl: resp("no", "text/html", 404) }, 20000);
    expect(out).toBeNull();
  });

  it("truncates overly long output with a marker", async () => {
    const html = `<body><p>${"a".repeat(50000)}</p></body>`;
    const out = await extractOaContent("https://oa.example/big", { fetchImpl: resp(html, "text/html") }, 1000);
    expect(out!.text.length).toBeLessThan(1200);
    expect(out!.text).toContain("truncated");
  });
});

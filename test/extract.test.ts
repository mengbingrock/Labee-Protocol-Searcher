import { describe, it, expect } from "vitest";
import { extractOaContent, looksLikeBotWall } from "../src/extract.ts";

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

describe("extractOaContent — protocols.io", () => {
  const PAYLOAD = {
    title: "eDNA COI PCR",
    authors: [{ name: "A. Researcher" }],
    description: "<p>Amplify COI.</p>",
    steps: [
      { step: JSON.stringify({ blocks: [{ text: "Wipe pipette with 70% ethanol" }] }) },
      { step: JSON.stringify({ blocks: [{ text: "Denature at 95C" }, { text: "Anneal at 55C" }] }) },
    ],
  };

  it("reads the .json sibling instead of the empty client-rendered shell", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url.endsWith(".json")) {
        return new Response(JSON.stringify(PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // What the real site serves a bot: a shell with no readable text.
      return new Response("<html><body><main></main></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const out = await extractOaContent("https://www.protocols.io/view/edna-coi-pcr-abc123", { fetchImpl }, 20000);
    expect(seen[0]).toBe("https://www.protocols.io/view/edna-coi-pcr-abc123.json");
    expect(out?.format).toBe("json");
    expect(out?.text).toContain("# eDNA COI PCR");
    expect(out?.text).toContain("Wipe pipette with 70% ethanol");
    expect(out?.text).toContain("Anneal at 55C"); // every draft-js block, not just the first
  });

  it("falls back to `document` for narrative protocols with no steps", async () => {
    // Some protocols.io entries ship steps: [] and put everything in `document`.
    // Without the fallback these extract to a title line and still report ok.
    const narrative = {
      title: "Introduction to PCR",
      authors: [{ name: "I. Anigbogu" }],
      steps: [],
      document: JSON.stringify({
        blocks: [{ text: "Goals" }, { text: "Learn the principles of amplification." }],
      }),
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(narrative), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const out = await extractOaContent("https://www.protocols.io/view/intro-abc/v1", { fetchImpl }, 20000);
    expect(out?.text).toContain("Learn the principles of amplification.");
    expect(out!.text.length).toBeGreaterThan(60);
  });

  it("renders reaction tables and notes from the draft-js entityMap", async () => {
    // The bench-critical content (volumes, concentrations) lives in `atomic`
    // blocks pointing into entityMap, not in blocks[].text.
    const step = JSON.stringify({
      blocks: [
        { type: "unstyled", text: "Set up the following reaction:", entityRanges: [] },
        { type: "atomic", text: " ", entityRanges: [{ key: 0 }] },
        { type: "atomic", text: " ", entityRanges: [{ key: 1 }] },
      ],
      entityMap: {
        "0": { type: "notes", data: { blocks: [{ type: "unstyled", text: "Keep on ice.", entityRanges: [] }] } },
        "1": {
          type: "tables",
          data: {
            data: [
              ["Component", "25 µl Reaction", "Final Concentration"],
              ["5X Q5 Buffer", "5 µl", "1X"],
              ["Template DNA", "variable", "&lt; 1,000 ng"],
            ],
          },
        },
      },
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ title: "Q5 PCR", steps: [{ step }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const out = await extractOaContent("https://www.protocols.io/view/q5-abc", { fetchImpl }, 20000);
    expect(out?.text).toContain("| Component | 25 µl Reaction | Final Concentration |");
    expect(out?.text).toContain("| 5X Q5 Buffer | 5 µl | 1X |");
    expect(out?.text).toContain("< 1,000 ng"); // entity decoded, not &lt;
    expect(out?.text).toContain("> Keep on ice."); // note rendered as a quote
  });

  it("parses a draft-js `description` instead of dumping raw JSON", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          title: "T",
          description: JSON.stringify({ blocks: [{ type: "unstyled", text: "High-fidelity polymerase.", entityRanges: [] }] }),
          steps: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const out = await extractOaContent("https://www.protocols.io/view/t-abc", { fetchImpl }, 20000);
    expect(out?.text).toContain("High-fidelity polymerase.");
    expect(out?.text).not.toContain('{"blocks"');
  });

  it("leaves non-protocols.io hosts on the normal HTML path", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response("<html><body><article><p>Plain page.</p></article></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const out = await extractOaContent("https://example.com/view/thing", { fetchImpl }, 20000);
    expect(seen).toEqual(["https://example.com/view/thing"]);
    expect(out?.format).toBe("html");
  });
});

describe("extractOaContent — cookie-gated redirect loop", () => {
  it("replays with the cookies a same-url redirect tried to set", async () => {
    let calls = 0;
    // Mimics idtdna.com: bounce a cookie-less client, serve a client that has one.
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls++;
      const cookie = (init?.headers as Record<string, string>)?.["Cookie"];
      if (cookie?.includes("SessionId=abc")) {
        return new Response("<html><body><article><p>Digital PCR overview.</p></article></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (init?.redirect === "manual") {
        return new Response("", {
          status: 302,
          headers: { "set-cookie": "SessionId=abc; path=/; HttpOnly", location: "/same" },
        });
      }
      const err = new Error("fetch failed");
      (err as Error & { cause?: unknown }).cause = { message: "redirect count exceeded" };
      throw err;
    }) as unknown as typeof fetch;

    const out = await extractOaContent("https://www.idtdna.com/pages/x", { fetchImpl }, 20000);
    expect(out?.text).toContain("Digital PCR overview.");
    // Redirects are manual from the first request so every destination can be
    // validated: one hop harvests the cookie and the second succeeds with it.
    expect(calls).toBe(2);
  });

  it("gives up when the redirect sets no cookie", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (init?.redirect === "manual") {
        return new Response("", { status: 302, headers: { location: "/same" } });
      }
      const err = new Error("fetch failed");
      (err as Error & { cause?: unknown }).cause = { message: "redirect count exceeded" };
      throw err;
    }) as unknown as typeof fetch;
    expect(await extractOaContent("https://loop.example/x", { fetchImpl }, 20000)).toBeNull();
  });
});

describe("extractOaContent — multi-hop cookie chain", () => {
  it("carries cookies across a redirect chain that visits another path first", async () => {
    // idtdna.com's real shape: the article bounces to a country-selection page,
    // and only that page sets the cookie the article requires.
    const visited: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const cookie = (init?.headers as Record<string, string>)?.["Cookie"] ?? "";
      if (init?.redirect !== "manual") {
        const err = new Error("fetch failed");
        (err as Error & { cause?: unknown }).cause = { message: "redirect count exceeded" };
        throw err;
      }
      visited.push(new URL(url).pathname);
      if (url.includes("/country")) {
        return new Response("", {
          status: 302,
          headers: { "set-cookie": "Country=US; path=/", location: "/article" },
        });
      }
      if (!cookie.includes("Country=US")) {
        return new Response("", { status: 302, headers: { location: "/country?back=/article" } });
      }
      return new Response("<html><body><article><p>qPCR guidance.</p></article></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const out = await extractOaContent("https://www.idtdna.com/article", { fetchImpl }, 20000);
    expect(out?.text).toContain("qPCR guidance.");
    expect(visited).toEqual(["/article", "/country", "/article"]);
  });

  it("stops after the hop cap instead of looping forever", async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (init?.redirect !== "manual") {
        const err = new Error("fetch failed");
        (err as Error & { cause?: unknown }).cause = { message: "redirect count exceeded" };
        throw err;
      }
      const n = Number(new URL(url).searchParams.get("n") ?? "0");
      return new Response("", { status: 302, headers: { location: `/x?n=${n + 1}` } });
    }) as unknown as typeof fetch;
    expect(await extractOaContent("https://endless.example/x?n=0", { fetchImpl }, 20000)).toBeNull();
  });

  it("validates every redirect hop before issuing the next request", async () => {
    const visited: string[] = [];
    const fetchImpl = (async (url: string) => {
      visited.push(url);
      return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    }) as unknown as typeof fetch;
    const validateUrl = async (url: string) => {
      const host = new URL(url).hostname;
      if (host === "169.254.169.254") throw new Error("unsafe-url: non-public address");
    };

    expect(await extractOaContent(
      "https://93.184.216.34/article",
      { fetchImpl, validateUrl },
      20000,
    )).toBeNull();
    expect(visited).toEqual(["https://93.184.216.34/article"]);
  });

  it("does not forward cookies to a redirect on another host", async () => {
    const cookies: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      cookies.push((init.headers as Record<string, string>).Cookie ?? "");
      if (new URL(url).hostname === "public.example") {
        return new Response("", {
          status: 302,
          headers: { location: "https://other.example/article", "set-cookie": "Session=secret; Path=/" },
        });
      }
      return new Response("<article>Public protocol article text.</article>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const out = await extractOaContent(
      "https://public.example/article",
      { fetchImpl, validateUrl: async () => undefined },
      20000,
    );
    expect(out?.text).toContain("Public protocol article text");
    expect(cookies).toEqual(["", ""]);
  });
});

// A challenge page extracts as clean, plausible text, so without this guard the
// caller stamps `ok` on "Checking your browser…" and the health table counts it
// as a working source. Measured live: PMC's article pages answer this way.
describe("looksLikeBotWall", () => {
  it("recognises the common challenge interstitials", () => {
    expect(looksLikeBotWall("Checking your browser before accessing pmc.ncbi.nlm.nih.gov")).toBe(true);
    expect(looksLikeBotWall("Just a moment...")).toBe(true);
    expect(looksLikeBotWall("Click here if you are not automatically redirected after 5 seconds.")).toBe(true);
    expect(looksLikeBotWall("Verifying you are human. This may take a few seconds.")).toBe(true);
  });

  it("leaves real article text alone", () => {
    expect(looksLikeBotWall("Add 5 uL of enzyme and incubate at 37 C for 30 min.")).toBe(false);
  });

  it("does not fire on a long article that merely quotes the phrase", () => {
    // Length is the tiebreak: an article discussing bot walls must survive.
    const article = `Automated clients often see "just a moment..." pages. ${"Protocol text. ".repeat(120)}`;
    expect(article.length).toBeGreaterThan(1500);
    expect(looksLikeBotWall(article)).toBe(false);
  });

  it("recognizes NEB-style short security verification interstitials", () => {
    expect(looksLikeBotWall("Performing security verification. Verify that you are human."))
      .toBe(true);
  });

  it("returns null from extraction rather than handing the wall back as content", async () => {
    const wall = resp(
      "<html><body><h1>Checking your browser before accessing pmc.ncbi.nlm.nih.gov</h1>" +
        "<p>Click here if you are not automatically redirected after 5 seconds.</p></body></html>",
      "text/html",
    );
    expect(await extractOaContent("https://www.ncbi.nlm.nih.gov/pmc/articles/3004291", { fetchImpl: wall }, 20000)).toBeNull();
  });
});

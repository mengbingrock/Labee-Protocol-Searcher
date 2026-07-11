import { describe, it, expect, beforeEach } from "vitest";
import { fetchResource, fetchResources } from "../src/fetch.ts";
import { _resetRebaseCache } from "../src/rebase.ts";

// Reuse a tiny REBASE slice so `rebase:` / bare-enzyme routing stays offline.
const REBASE = `REBASE codes for commercial sources of enzymes

                N        New England Biolabs (8/24)

<1>EcoRI
<2>
<3>G^AATTC
<4>
<5>Escherichia coli RY13
<6>R.N. Yoshimori
<7>N
<8>Ref.
`;
const f = (async () => new Response(REBASE, { status: 200 })) as unknown as typeof fetch;

beforeEach(() => _resetRebaseCache());

describe("fetchResource — scheme dispatch", () => {
  it("returns the link (not a scrape) for a bot-blocked url id", async () => {
    const out = await fetchResource("url:https://www.neb.com/x");
    expect(out).toContain("https://www.neb.com/x");
    expect(out.toLowerCase()).toContain("bot-block");
  });

  it("treats a bare https url as non-fetchable", async () => {
    const out = await fetchResource("https://qiagen.com/y");
    expect(out).toContain("https://qiagen.com/y");
  });

  it("routes rebase: ids to the REBASE record", async () => {
    const out = await fetchResource("rebase:EcoRI", { fetchImpl: f });
    expect(out).toContain("# EcoRI");
    expect(out).toContain("G^AATTC");
  });

  it("errors clearly on an unrecognised id", async () => {
    const out = await fetchResource("this is not an id");
    expect(out).toContain("Unrecognised id");
  });
});

describe("fetchResource — bare-id inference", () => {
  it("infers an enzyme name and routes to REBASE", async () => {
    const out = await fetchResource("EcoRI", { fetchImpl: f });
    expect(out).toContain("# EcoRI");
  });

  it("infers an IUPAC site and routes to REBASE", async () => {
    const out = await fetchResource("GAATTC", { fetchImpl: f });
    expect(out).toContain("Enzymes recognising");
  });
});

describe("fetchResource — status footers", () => {
  it("tags a bot-blocked url as not-fetchable", async () => {
    expect(await fetchResource("url:https://neb.com/x")).toContain("_status: not-fetchable_");
  });

  it("tags an unrecognised id as bad-id", async () => {
    expect(await fetchResource("this is not an id")).toContain("_status: bad-id_");
  });
});

describe("fetchResources — batch", () => {
  it("resolves each id into its own row, in request order", async () => {
    const rows = await fetchResources(["EcoRI", "url:https://neb.com/x"], { fetchImpl: f });
    expect(rows.map((r) => r.id)).toEqual(["EcoRI", "url:https://neb.com/x"]);
    expect(rows[0]!.text).toContain("# EcoRI");
    expect(rows[1]!.text.toLowerCase()).toContain("bot-block");
  });

  it("isolates a failing id instead of sinking the batch", async () => {
    const boom = (async (url: string) => {
      if (url.includes("neb.com")) return new Response("", { status: 200 }); // unused; url ids don't fetch
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const rows = await fetchResources(["10.1/x", "url:https://neb.com/x"], { fetchImpl: boom });
    expect(rows[0]!.text).toContain("_status: error_"); // DOI fetch threw
    expect(rows[1]!.text.toLowerCase()).toContain("bot-block"); // url id still fine
  });
});

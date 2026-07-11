import { describe, it, expect, beforeEach } from "vitest";
import { fetchResource } from "../src/fetch.ts";
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

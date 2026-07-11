import { describe, it, expect, beforeEach } from "vitest";
import {
  findRestrictionEnzyme,
  normalizeSite,
  parseRebase,
  _resetRebaseCache,
} from "../src/rebase.ts";

// A minimal REBASE withrefm slice: supplier legend + a few records.
const REBASE = `REBASE codes for commercial sources of enzymes

                K        Takara Bio Inc. (3/22)
                N        New England Biolabs (8/24)

<1>EcoRI
<2>
<3>G^AATTC
<4>
<5>Escherichia coli RY13
<6>R.N. Yoshimori
<7>N
<8>Roberts, R.J., Nucleic Acids Res.,
1980.

<1>BsaI
<2>Eco31I
<3>GGTCTC(1/5)
<4>
<5>Bacillus stearothermophilus
<6>NEB
<7>N
<8>Some Ref.

<1>FunII
<2>
<3>GAATTC
<4>
<5>Fusarium
<6>
<7>K
<8>Other Ref.
`;

const f = (async () => new Response(REBASE, { status: 200 })) as unknown as typeof fetch;

beforeEach(() => _resetRebaseCache());

describe("normalizeSite", () => {
  it("strips cut markers, offsets and whitespace", () => {
    expect(normalizeSite("G^AATTC")).toBe("GAATTC");
    expect(normalizeSite("GGTCTC(1/5)")).toBe("GGTCTC");
    expect(normalizeSite(" c^ggccg ")).toBe("CGGCCG");
  });
});

describe("parseRebase", () => {
  it("indexes by name and site and reads the supplier legend", () => {
    const idx = parseRebase(REBASE);
    expect(idx.suppliers.get("N")).toBe("New England Biolabs");
    expect(idx.byName.get("ECORI")?.site).toBe("G^AATTC");
    expect(idx.byName.get("BSAI")?.suppliers).toBe("N");
    expect(idx.bySite.get("GAATTC")).toEqual(["EcoRI", "FunII"]);
  });
});

describe("findRestrictionEnzyme", () => {
  it("looks up by name and reports the site, cut and NEB availability", async () => {
    const out = await findRestrictionEnzyme("EcoRI", { fetchImpl: f });
    expect(out).toContain("G^AATTC");
    expect(out).toContain("Supplied by NEB");
    expect(out).toContain("New England Biolabs");
  });

  it("is case-insensitive on the name", async () => {
    const out = await findRestrictionEnzyme("bsai", { fetchImpl: f });
    expect(out).toContain("# BsaI");
    expect(out).toContain("GGTCTC(1/5)");
  });

  it("auto-detects a recognition-site query and lists matches, NEB first", async () => {
    const out = await findRestrictionEnzyme("GAATTC", { fetchImpl: f });
    expect(out).toContain("Enzymes recognising");
    expect(out).toContain("EcoRI, FunII");
    // NEB-supplied EcoRI is detailed before Takara-only FunII.
    expect(out.indexOf("# EcoRI")).toBeLessThan(out.indexOf("# FunII"));
  });

  it("honours an explicit `by` mode", async () => {
    const out = await findRestrictionEnzyme("GGTCTC", { fetchImpl: f, by: "site" });
    expect(out).toContain("BsaI");
  });

  it("returns guidance, not an error, when the name is unknown", async () => {
    const out = await findRestrictionEnzyme("Eco", { fetchImpl: f });
    expect(out).toContain('No REBASE enzyme named "Eco"');
    expect(out).toContain("EcoRI"); // suggestion
  });

  it("throws on a non-200 REBASE response", async () => {
    _resetRebaseCache();
    // 403 is non-retryable, so this returns immediately (no backoff sleeps).
    const bad = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await expect(findRestrictionEnzyme("EcoRI", { fetchImpl: bad })).rejects.toThrow(/REBASE HTTP 403/);
  });
});

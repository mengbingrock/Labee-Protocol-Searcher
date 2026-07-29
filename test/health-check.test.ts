// The health check's pure logic: status/tier parsing, the drift rule, and the
// README splice. The live probes aren't tested here (they'd be network calls),
// but everything that decides *what the README claims* is.

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations by design.
import { driftOf, renderBlock, spliceBlock, statusOf, tierOf } from "../scripts/health-check.mjs";

describe("statusOf", () => {
  it("reads the status footer", () => {
    expect(statusOf("body\n\n_status: ok_")).toBe("ok");
    expect(statusOf("nope\n\n_status: not-fetchable_")).toBe("not-fetchable");
  });

  it("takes the last status in a batch response", () => {
    const batch = "# a\n\n_status: ok_\n\n# b\n\n_status: bad-id_";
    expect(statusOf(batch)).toBe("bad-id");
  });

  it("reports a missing footer rather than guessing", () => {
    expect(statusOf("Error: `id` is required.")).toBe("no-status");
  });
});

describe("tierOf", () => {
  it("names the retrieval tier that answered", () => {
    expect(tierOf("_Source: Europe PMC open-access full text (PMC1)._")).toBe("Europe PMC");
    expect(tierOf("_Source: via Unpaywall._")).toBe("Unpaywall");
    expect(tierOf("_Source: https://x.test/p (html extraction)._")).toBe("html extraction");
    expect(tierOf("_Source: https://x.test/p (json extraction)._")).toBe("json extraction");
  });

  it("is empty when no tier is identifiable", () => {
    expect(tierOf("something else entirely")).toBe("");
  });
});

describe("driftOf", () => {
  it("flags a source graded full that refused the request", () => {
    expect(driftOf({ declared: "full", fetchStatus: "not-fetchable" })).toMatch(/refused/);
  });

  it("flags a source graded none that extracted fine", () => {
    expect(driftOf({ declared: "none", fetchStatus: "ok" })).toMatch(/extracted/);
  });

  it("stays quiet for a partial source, whichever way it went", () => {
    expect(driftOf({ declared: "partial", fetchStatus: "ok" })).toBe("");
    expect(driftOf({ declared: "partial", fetchStatus: "not-fetchable" })).toBe("");
    expect(driftOf({ declared: "partial", fetchStatus: "no-open-fulltext" })).toBe("");
  });

  it("stays quiet when a full source's top hit is merely paywalled today", () => {
    // Per-article availability, not a wrong grade — flagging it would train the
    // reader to ignore the warning.
    expect(driftOf({ declared: "full", fetchStatus: "no-open-fulltext" })).toBe("");
  });
});

const report = {
  generatedAt: "2026-01-01T00:00Z",
  query: "PCR purification",
  enzyme: "EcoRI",
  providers: [
    { id: "crossref", chain: "journal", count: 3, error: "", state: "ok" },
    { id: "duckduckgo", chain: "web", count: 0, error: "HTTP 202", state: "down" },
    { id: "google", chain: "web", count: 0, error: "GOOGLE_API_KEY not set", state: "unconfigured" },
  ],
  sources: [
    {
      id: "neb",
      declared: "none",
      count: 3,
      searchError: "",
      fetchStatus: "not-fetchable",
      tier: "",
      drift: "",
    },
  ],
  searchError: "",
};

describe("renderBlock", () => {
  it("separates an outage from a missing key", () => {
    const md = renderBlock(report);
    expect(md).toContain("1 backend not answering");
    expect(md).toContain("`duckduckgo`");
    expect(md).not.toContain("`google`, ");
    expect(md).toMatch(/`google`.*not configured/);
  });

  it("stamps the run time and the probe query", () => {
    const md = renderBlock(report);
    expect(md).toContain("2026-01-01T00:00Z");
    expect(md).toContain("PCR purification");
  });

  it("names drifted sources so the grade gets re-checked", () => {
    const drifted = {
      ...report,
      sources: [{ ...report.sources[0]!, declared: "full", drift: "graded `full` but refused" }],
    };
    expect(renderBlock(drifted)).toContain("Grade drift");
    expect(renderBlock(report)).not.toContain("Grade drift");
  });

  it("says so when the whole sweep failed, instead of printing an empty table", () => {
    const md = renderBlock({ ...report, searchError: "unparseable output (exit 1)" });
    expect(md).toContain("full-catalog sweep failed");
    expect(md).not.toContain("| Source | Declared");
  });
});

describe("spliceBlock", () => {
  const readme = "# Title\n\nbefore\n\n<!-- HEALTH:BEGIN -->\nold\n<!-- HEALTH:END -->\n\nafter\n";

  it("replaces only the marked region", () => {
    const out = spliceBlock(readme, "new");
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).toContain("new");
    expect(out).not.toContain("old");
  });

  it("is idempotent — markers survive repeated writes", () => {
    const once = spliceBlock(readme, "new");
    const twice = spliceBlock(once, "new");
    expect(twice).toBe(once);
    expect(twice.match(/HEALTH:BEGIN/g)).toHaveLength(1);
    expect(twice.match(/HEALTH:END/g)).toHaveLength(1);
  });

  it("throws when the markers are missing rather than appending silently", () => {
    expect(() => spliceBlock("# Title\n\nno markers here\n", "new")).toThrow(/missing the/);
  });
});

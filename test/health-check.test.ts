// The health check's pure logic: status/tier parsing, the drift rule, and the
// README splice. The live probes aren't tested here (they'd be network calls),
// but everything that decides *what the README claims* is.

import { describe, expect, it } from "vitest";
import {
  appendHistory,
  driftOf,
  historyRows,
  parseHistory,
  renderBlock,
  renderHistory,
  spliceBlock,
  statusOf,
  summarize,
  tierOf,
  // @ts-expect-error — plain .mjs script, no type declarations by design.
} from "../scripts/health-check.mjs";

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

  it("keeps earlier days below today's snapshot", () => {
    const md = renderBlock(report, [
      { date: "2025-12-31", at: "2025-12-31T00:00Z", backendsUp: 2, backendsConfigured: 2 },
    ]);
    expect(md).toContain("Daily history");
    expect(md).toContain("| 2025-12-31 |");
    // Today's table still comes first — history is context, not the headline.
    expect(md.indexOf("**Backends**")).toBeLessThan(md.indexOf("Daily history"));
  });
});

describe("summarize", () => {
  it("counts configured backends separately from unconfigured ones", () => {
    const row = summarize(report);
    // 3 providers, one of them keyless: 1 up out of 2 configured.
    expect(row).toMatchObject({ backendsUp: 1, backendsConfigured: 2, backendsUnconfigured: 1 });
    expect(row.down).toEqual(["duckduckgo"]);
  });

  it("dates the record so the table can group by day", () => {
    expect(summarize(report)).toMatchObject({ date: "2026-01-01", at: "2026-01-01T00:00Z" });
  });

  it("carries the source and drift tallies", () => {
    const row = summarize({
      ...report,
      sources: [
        { id: "a", count: 3, fetchStatus: "ok", drift: "" },
        { id: "b", count: 0, fetchStatus: "not-fetchable", drift: "graded `full` but refused" },
      ],
    });
    expect(row).toMatchObject({
      sourcesProbed: 2,
      sourcesWithHits: 1,
      fetchOk: 1,
      drift: ["b"],
      sweepFailed: false,
    });
  });

  it("records a failed sweep as such rather than as zero sources", () => {
    expect(summarize({ ...report, searchError: "exit 1" }).sweepFailed).toBe(true);
  });
});

describe("parseHistory", () => {
  it("reads one record per line", () => {
    const text = '{"at":"2026-01-01T00:00Z"}\n{"at":"2026-01-02T00:00Z"}\n';
    expect(parseHistory(text)).toHaveLength(2);
  });

  it("drops corrupt lines instead of losing the whole log", () => {
    const text = '{"at":"2026-01-01T00:00Z"}\nnot json\n\n{"no":"stamp"}\n{"at":"2026-01-02T00:00Z"}';
    expect(parseHistory(text).map((r: { at: string }) => r.at)).toEqual([
      "2026-01-01T00:00Z",
      "2026-01-02T00:00Z",
    ]);
  });

  it("treats a missing file's empty contents as an empty log", () => {
    expect(parseHistory("")).toEqual([]);
  });
});

describe("appendHistory", () => {
  const rec = (at: string, extra = {}) => ({ at, date: at.slice(0, 10), ...extra });

  it("keeps every earlier run", () => {
    const out = appendHistory([rec("2026-01-01T00:00Z")], rec("2026-01-02T00:00Z"));
    expect(out.map((r: { at: string }) => r.at)).toEqual(["2026-01-01T00:00Z", "2026-01-02T00:00Z"]);
  });

  it("replaces a run with the same stamp, so a retried job doesn't double-count", () => {
    const out = appendHistory(
      [rec("2026-01-01T00:00Z", { backendsUp: 1 })],
      rec("2026-01-01T00:00Z", { backendsUp: 5 }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].backendsUp).toBe(5);
  });

  it("stays in run order even when a record arrives late", () => {
    const out = appendHistory(
      [rec("2026-01-02T00:00Z"), rec("2026-01-03T00:00Z")],
      rec("2026-01-01T00:00Z"),
    );
    expect(out.map((r: { at: string }) => r.at)).toEqual([
      "2026-01-01T00:00Z",
      "2026-01-02T00:00Z",
      "2026-01-03T00:00Z",
    ]);
  });
});

describe("historyRows", () => {
  const rec = (at: string, backendsUp: number) => ({ at, date: at.slice(0, 10), backendsUp });

  it("shows one row per day, newest first", () => {
    const rows = historyRows([rec("2026-01-01T05:00Z", 5), rec("2026-01-02T05:00Z", 6)]);
    expect(rows.map((r: { date: string }) => r.date)).toEqual(["2026-01-02", "2026-01-01"]);
  });

  it("collapses a day's extra runs to the latest one, but counts them", () => {
    const rows = historyRows([rec("2026-01-01T05:00Z", 5), rec("2026-01-01T18:00Z", 7)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ backendsUp: 7, runs: 2 });
  });

  it("counts a day's runs even when the log is out of order", () => {
    const rows = historyRows([rec("2026-01-01T18:00Z", 7), rec("2026-01-01T05:00Z", 5)]);
    expect(rows[0]).toMatchObject({ backendsUp: 7, runs: 2 });
  });

  it("caps the table without touching the underlying log", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      rec(`2026-03-${String(i + 1).padStart(2, "0")}T00:00Z`, 5),
    );
    const rows = historyRows(many, 30);
    expect(rows).toHaveLength(30);
    // The cap drops the *oldest* days — the newest reading must always survive.
    expect(rows[0].date).toBe("2026-03-40");
    expect(many).toHaveLength(40);
  });
});

describe("renderHistory", () => {
  const day = {
    date: "2026-01-02",
    at: "2026-01-02T05:00Z",
    backendsUp: 5,
    backendsConfigured: 7,
    down: ["duckduckgo"],
    sourcesWithHits: 16,
    sourcesProbed: 16,
    fetchOk: 12,
    drift: [],
    sweepFailed: false,
  };

  it("prints a row per recorded day", () => {
    const md = renderHistory([day, { ...day, date: "2026-01-01", at: "2026-01-01T05:00Z" }]).join(
      "\n",
    );
    expect(md).toContain("| 2026-01-02 |");
    expect(md).toContain("| 2026-01-01 |");
    expect(md).toContain("5/7");
    expect(md).toContain("`duckduckgo`");
  });

  it("says the log is empty rather than printing a headless table", () => {
    const md = renderHistory([]).join("\n");
    expect(md).toContain("No runs recorded yet");
    expect(md).not.toContain("| Date |");
  });

  it("marks a failed sweep instead of reporting 0/0 sources", () => {
    const md = renderHistory([{ ...day, sweepFailed: true, sourcesProbed: 0 }]).join("\n");
    expect(md).toContain("sweep failed");
    expect(md).not.toContain("0/0");
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

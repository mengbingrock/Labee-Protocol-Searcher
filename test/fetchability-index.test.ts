import { describe, expect, it } from "vitest";
import {
  assessDoiAvailability,
  freshDoiObservation,
  normalizeDoi,
  parseFetchabilityIndex,
  type FetchabilityIndex,
} from "../src/fetchability-index.ts";

const now = Date.parse("2026-08-12T05:17:00Z");

function index(
  status: "ok" | "abstract-only" | "not-found",
  checkedAt = "2026-08-11T05:17:00Z",
): FetchabilityIndex {
  return {
    schemaVersion: 1,
    generatedAt: checkedAt,
    dois: {
      "10.1038/nprot.2011.388": {
        status,
        checkedAt,
        retrievalTier: "NCBI author manuscript",
      },
    },
  };
}

describe("fetchability index validation", () => {
  it("normalizes DOI forms to one stable key", () => {
    expect(normalizeDoi(" DOI:10.1038/NPROT.2011.388 ")).toBe("10.1038/nprot.2011.388");
    expect(normalizeDoi("https://doi.org/10.1038/nprot.2011.388")).toBe(
      "10.1038/nprot.2011.388",
    );
    expect(normalizeDoi("not a doi")).toBeUndefined();
  });

  it("drops invalid rows instead of trusting unbounded CI JSON", () => {
    const parsed = parseFetchabilityIndex({
      schemaVersion: 1,
      generatedAt: "2026-08-11T05:17:00Z",
      dois: {
        "10.1038/NPROT.2011.388": {
          status: "ok",
          checkedAt: "2026-08-11T05:17:00Z",
          discoveredBy: ["crossref", "crossref", 3],
        },
        garbage: { status: "ok", checkedAt: "today" },
      },
    });
    expect(parsed?.dois["10.1038/nprot.2011.388"]?.discoveredBy).toEqual(["crossref"]);
    expect(Object.keys(parsed?.dois ?? {})).toEqual(["10.1038/nprot.2011.388"]);
  });
});

describe("DOI evidence precedence and freshness", () => {
  it("lets a fresh exact DOI success override a partial journal prior", () => {
    expect(
      assessDoiAvailability("doi:10.1038/nprot.2011.388", "partial", index("ok"), [], now),
    ).toMatchObject({
      availability: "verified-full-text",
      confidence: "verified",
      journalPrior: "partial",
      status: "ok",
    });
  });

  it("uses current OA metadata when the DOI has no fresh observation", () => {
    const empty: FetchabilityIndex = {
      schemaVersion: 1,
      generatedAt: "2026-08-11T05:17:00Z",
      dois: {},
    };
    expect(
      assessDoiAvailability(
        "10.1038/nprot.2011.388",
        "partial",
        empty,
        ["openalex:open-access"],
        now,
      ),
    ).toMatchObject({ availability: "likely-fetchable", confidence: "metadata" });
  });

  it("falls back to the journal prior after short-lived negative evidence expires", () => {
    const old = index("not-found", "2026-08-01T05:17:00Z");
    expect(freshDoiObservation(old, "10.1038/nprot.2011.388", now)).toBeUndefined();
    expect(
      assessDoiAvailability("10.1038/nprot.2011.388", "partial", old, [], now),
    ).toMatchObject({ availability: "unknown", confidence: "journal-prior" });
  });
});

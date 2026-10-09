import { describe, it, expect } from "vitest";
import { VENDORS, VENDOR_IDS, getVendor, resolveVendors } from "../src/vendors.ts";
import {
  parseProtocolsIoSearchOptions,
  protocolsIoSearchUrl,
} from "../src/protocols-io.ts";

describe("vendor registry", () => {
  it("lists the ten requested vendors plus protocol journals", () => {
    // All ten reagent/oligo vendors from the brief, plus the two protocol journals.
    for (const id of [
      "thermofisher",
      "qiagen",
      "neb",
      "bio-rad",
      "sigma-aldrich",
      "emd-millipore",
      "takarabio",
      "promega",
      "idt",
      "star-protocols",
      "nature-protocols",
    ]) {
      expect(VENDOR_IDS, id).toContain(id);
    }
  });

  it("builds an encoded, vendor-specific search URL for every vendor", () => {
    for (const v of VENDORS) {
      const url = v.searchUrl("RNA extraction & cleanup");
      expect(url).toMatch(/^https:\/\//);
      // The space and ampersand must be percent-encoded, not raw.
      expect(url).not.toContain(" ");
      expect(url).toContain("RNA%20extraction%20%26%20cleanup");
    }
  });

  it("uses the publisher routes verified by the Browserless sweep", () => {
    expect(getVendor("star-protocols")!.searchUrl("PCR purification")).toContain("journalCode=xpro");
    expect(getVendor("bio-protocol")!.searchUrl("PCR purification")).toContain("/en/searchlist?content=");
    expect(getVendor("bio-rad")!.searchUrl("PCR purification")).toContain("/SearchResults?search_api_fulltext=");
    expect(getVendor("takarabio")!.searchUrl("PCR purification")).toContain("/search-results?term=");
    expect(getVendor("promega")!.searchUrl("PCR purification")).toContain("/results#q=");
    expect(getVendor("idt")!.searchUrl("PCR purification")).toContain("/page/search#q=");
    expect(getVendor("neb")!.searchUrl("PCR purification")).toContain("/search#q=");
    expect(getVendor("neb")!.publisherScrapeSelector).toBe(".CoveoResultLink");
    expect(getVendor("neb")!.publisherResidentialFirst).toBe(true);
  });

  it("marks the two protocol journals as journal-kind with Crossref metadata", () => {
    for (const id of ["star-protocols", "nature-protocols"]) {
      const v = getVendor(id)!;
      expect(v.kind).toBe("journal");
      expect(v.journal?.crossrefContainer).toBeTruthy();
      expect(v.journal?.europepmcJournal).toBeTruthy();
    }
    expect(getVendor("neb")!.kind).toBe("vendor");
    expect(getVendor("neb")!.journal).toBeUndefined();
  });

  it("resolves known ids, defaults to all, and reports unknowns", () => {
    expect(getVendor("neb")?.name).toContain("New England Biolabs");
    expect(resolveVendors().vendors).toHaveLength(VENDORS.length);
    const { vendors, unknown } = resolveVendors(["neb", "NEB", "bogus"]);
    expect(vendors.map((v) => v.id)).toEqual(["neb", "neb"]); // case-insensitive
    expect(unknown).toEqual(["bogus"]);
  });
});

describe("fetchability grading", () => {
  it("grades every source, and never claims a known-blocked site is fetchable", () => {
    for (const v of VENDORS) {
      expect(["full", "partial", "none"], v.id).toContain(v.fetchability);
    }
    // Still blocked after AWS Browserless + residential retry.
    for (const id of ["sigma-aldrich", "emd-millipore"]) {
      expect(getVendor(id)!.fetchability, id).toBe("none");
    }
    expect(getVendor("neb")!.fetchability).toBe("full");
    expect(getVendor("bio-protocol")!.fetchability).toBe("full");
    expect(getVendor("nature-protocols")!.publisherFetch).toBe("abstract-only");
    expect(getVendor("current-protocols")!.publisherFetch).toBe("abstract-only");
    expect(getVendor("protocols-io")!.publisherFetch).toBe("full");
  });

  it("does not infer fetchability from kind", () => {
    // The bug this replaces assumed journal ⇒ fetchable, vendor ⇒ links-only.
    // Both halves are false, and these two sources are why.
    expect(getVendor("nature-protocols")!.kind).toBe("journal");
    expect(getVendor("nature-protocols")!.fetchability).not.toBe("full");
    expect(getVendor("promega")!.kind).toBe("vendor");
    expect(getVendor("promega")!.fetchability).toBe("full");
  });
});

describe("protocols.io search options", () => {
  it("builds the native sort, order, page, access, and facet parameters", () => {
    const url = new URL(protocolsIoSearchUrl("pcr", {
      sortBy: "mentions",
      order: "desc",
      page: 2,
      access: ["open_access", "springer_protocols"],
      techniques: ["PCR", "Real-time PCR"],
      antibodies: ["Anti-Taq"],
      organisms: ["Homo sapiens"],
      cellLines: ["HEK293"],
    }));
    expect(url.searchParams.get("q")).toBe("pcr");
    expect(url.searchParams.get("sort_by")).toBe("mentions");
    expect(url.searchParams.get("sort_dir")).toBe("desc");
    expect(url.searchParams.get("page_id")).toBe("2");
    expect(url.searchParams.get("access")).toBe("open_access,springer_protocols");
    expect(url.searchParams.get("techniques")).toBe("PCR|Real-time PCR");
    expect(url.searchParams.get("antibodies")).toBe("Anti-Taq");
    expect(url.searchParams.get("organisms")).toBe("Homo sapiens");
    expect(url.searchParams.get("cell_lines")).toBe("HEK293");
  });

  it("encodes tags and every advanced-search family in protocols.io's q object", () => {
    const url = new URL(protocolsIoSearchUrl("pcr", {
      sortBy: "title",
      mode: "advanced",
      openAccess: true,
      tags: ["diagnostics"],
      fields: [
        { field: "all_entities.techniques", value: "PCR" },
        { field: "authors_string", value: "Jane Doe" },
        { field: "reagent_catalog_number", value: "M0491" },
      ],
      journalTitle: "Nature Protocols",
      articleDoi: "10.1000/example",
      publishedFrom: "2025-01-01",
      publishedTo: "2026-01-01",
    }));
    const q = JSON.parse(url.searchParams.get("q")!) as Record<string, unknown>;
    expect(url.searchParams.get("is_advanced")).toBe("1");
    expect(url.searchParams.get("sort_by")).toBe("title");
    expect(url.searchParams.get("sort_dir")).toBe("asc");
    expect(q).toMatchObject({
      fields: [
        { key: "all", value: "pcr" },
        { key: "keywords", value: "diagnostics" },
        { key: "all_entities.techniques", value: "PCR" },
        { key: "authors_string", value: "Jane Doe" },
        { key: "reagent_catalog_number", value: "M0491" },
      ],
      open_access: true,
      springer_protocol: false,
      journal_title: "Nature Protocols",
      article_doi: "10.1000/example",
      published_from: "2025-01-01",
      published_to: "2026-01-01",
    });
  });

  it("normalizes valid input without silently dropping invalid constraints", () => {
    expect(parseProtocolsIoSearchOptions({
      mode: "advanced",
      sortBy: "mentions",
      page: 2,
      tags: ["PCR", " PCR "],
      fields: [{ field: "orcid", value: "0000-0001" }],
    })).toEqual({
      mode: "advanced",
      sortBy: "mentions",
      page: 2,
      tags: ["PCR"],
      fields: [{ field: "orcid", value: "0000-0001" }],
    });
    expect(() => parseProtocolsIoSearchOptions({ order: "sideways" })).toThrow();
  });
});

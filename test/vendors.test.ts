import { describe, it, expect } from "vitest";
import { VENDORS, VENDOR_IDS, getVendor, resolveVendors } from "../src/vendors.ts";

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

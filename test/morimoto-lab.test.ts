import { describe, expect, it } from "vitest";
import { searchMorimotoLab } from "../src/morimoto-lab.ts";
import { search } from "../src/search.ts";

const ROOT = "https://www.morimotolab.org";
const PCR = `${ROOT}/_files/ugd/pcr.pdf`;
const mockFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url === `${ROOT}/protocols`) return new Response(
    `<a href="/dna-techniques">DNA Techniques</a><a href="/protein-biochemistry">Protein Biochemistry</a>` +
    `<a href="/publications">Publications</a><a href="https://evil.test/dna-techniques">Other</a>`);
  if (url === `${ROOT}/dna-techniques`) return new Response(
    `<a href="${PCR}">Polymerase chain reaction</a>` +
    `<a href="/_files/ugd/rt.pdf">Quantitative RT-PCR</a>` +
    `<a href="/_files/ugd/lysis.pdf">Alkaline lysis method</a>` +
    `<a href="/contact">Contact us</a><a href="https://evil.test/file.pdf">PCR foreign PDF</a>`);
  if (url === `${ROOT}/protein-biochemistry`) return new Response(
    `<a href="/_files/ugd/blot.pdf">Western blotting</a>`);
  throw new Error("Unexpected catalog request");
}) as typeof fetch;

describe("Morimoto Lab catalog search", () => {
  it("finds PDFs across categories, recognizes PCR, and excludes navigation/foreign URLs", async () => {
    const result = await searchMorimotoLab("PCR protocol", 10, { fetchImpl: mockFetch });
    expect(result.status).toBe("ok");
    expect(result.results.map(row => row.url)).toEqual([PCR, `${ROOT}/_files/ugd/rt.pdf`]);
    expect(result.results[0]?.snippet).toContain("DNA Techniques");
    expect(result.results[0]?.discoveredBy).toEqual(["morimoto-lab-catalog"]);
    const protein = await searchMorimotoLab("western blotting", 1, { fetchImpl: mockFetch });
    expect(protein.results[0]?.url).toBe(`${ROOT}/_files/ugd/blot.pdf`);
  });

  it("confirms zero title/category matches and honors limits", async () => {
    expect((await searchMorimotoLab("nonexistent technique 918273", 2, { fetchImpl: mockFetch })).results).toEqual([]);
    expect((await searchMorimotoLab("DNA", 2, { fetchImpl: mockFetch })).results).toHaveLength(2);
  });

  it("checks URL policy for every catalog request", async () => {
    const checked: string[] = [];
    const result = await searchMorimotoLab("PCR", 1, {
      fetchImpl: mockFetch, validateUrl: async url => { checked.push(url); },
    });
    expect(result.status).toBe("ok");
    expect(checked).toEqual([`${ROOT}/protocols`, `${ROOT}/dna-techniques`, `${ROOT}/protein-biochemistry`]);
  });

  it("reports category failures without returning an incomplete catalog", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/protein-biochemistry")) return new Response("Unavailable", { status: 503 });
      return mockFetch(input, init);
    }) as typeof fetch;
    const result = await searchMorimotoLab("PCR", 2, { fetchImpl });
    expect(result).toMatchObject({ status: "error", results: [], error: expect.stringContaining("completely") });
  });

  it("reports missing categories as failure rather than zero matches", async () => {
    const result = await searchMorimotoLab("PCR", 2, { fetchImpl: (async () => new Response("<html>Maintenance</html>")) as typeof fetch });
    expect(result.status).toBe("error");
  });

  it("returns fetchable PDF ids and keeps zero matches on the direct route", async () => {
    const result = await search("PCR", { sources: ["morimoto-lab"], limit: 1, providerOpts: { fetchImpl: mockFetch } });
    expect(result.sources[0]?.route).toBe("morimoto-lab-catalog");
    expect(result.results).toMatchObject([{ id: `url:${PCR}`, fetchable: "full", source: "morimoto-lab" }]);
    const empty = await search("nonexistent 918273", { sources: ["morimoto-lab"], providerOpts: { fetchImpl: mockFetch } });
    expect(empty).toMatchObject({ partial: false, results: [], sources: [{ route: "morimoto-lab-catalog" }] });
  });
});

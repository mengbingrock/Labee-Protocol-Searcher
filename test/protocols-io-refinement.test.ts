import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtocolsIoSearchStore, protocolsIoFacetsFromHtml } from "../src/protocols-io-refinement.ts";
import { parseProtocolsIoSearchOptions, protocolsIoSearchUrl } from "../src/protocols-io.ts";
import { searchProtocols } from "../src/search.ts";
import * as searches from "../src/search.ts";
import { dispatch } from "../src/mcp.ts";
import { messageMayNeedResidential } from "../src/stdio-proxy.ts";

const url = "https://www.protocols.io/search?q=pcr&sort_by=mentions";
// Reduced markup observed in the publisher's rendered search sidebar, 2026-09-25.
const html = `<div role="status">Filter 'Real-time PCR' applied, 4,972 results</div>
<div class="_drgghv">1,966&nbsp;results for</div><div>pcr</div>
<input data-testid="checkbox-filter-option-access-Open Access" data-option-label="Open Access" type="checkbox" aria-label="Open Access, 456">
<input data-testid="checkbox-filter-option-access-Springer Protocols" data-option-label="Springer Protocols" type="checkbox" aria-label="Springer Protocols, 1,966">
<input data-testid="checkbox-filter-option-techniques-PCR" data-option-label="PCR" type="checkbox" aria-label="PCR, 1,966" checked="">
<button>Show all 100</button><button>Organism</button>`;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("protocols.io publisher facets", () => {
  it("reads publisher counts and marks rendered subsets incomplete", () => {
    expect(protocolsIoFacetsFromHtml(html, url)).toEqual({
      totalMatches: 1966, facetsAvailable: true,
      availableFacets: {
        access: { complete: false, options: [
          { value: "open_access", label: "Open Access", count: 456 },
          { value: "springer_protocols", label: "Springer Protocols", count: 1966 },
        ] },
        techniques: { complete: false, options: [{ value: "PCR", label: "PCR", count: 1966 }] },
      },
    });
  });
  it("distinguishes unknown counts, explicit zero, and advanced-mode absence", () => {
    expect(protocolsIoFacetsFromHtml("<script>0 results for</script><p>Loading</p>", url).totalMatches).toBeNull();
    expect(protocolsIoFacetsFromHtml("<p>0 results for pcr</p>", url).totalMatches).toBe(0);
    expect(protocolsIoFacetsFromHtml(html, `${url}&is_advanced=1`)).toEqual({ totalMatches: 1966, facetsAvailable: false, availableFacets: {} });
  });
  it("carries facets through Browserless and does not turn zero matches into fallback results", async () => {
    vi.stubEnv("BROWSERLESS_TOKEN", "test");
    vi.stubEnv("BROWSERLESS_URL", "https://browserless.example");
    vi.stubEnv("PROTOCOLS_BROWSERLESS", "on");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(html.replace("1,966&nbsp;results for", "0&nbsp;results for")));
    const response = await searchProtocols("pcr", { vendors: ["protocols-io"], providerOpts: { fetchImpl } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.partial).toBe(false);
    expect(response.vendors[0]).toMatchObject({ results: [], protocolsIo: { totalMatches: 0 }, source: "publisher-browserless" });
  });
  it("does not report a challenge as a confirmed zero-result search", async () => {
    vi.stubEnv("BROWSERLESS_TOKEN", "test");
    vi.stubEnv("BROWSERLESS_URL", "https://browserless.example");
    vi.stubEnv("PROTOCOLS_BROWSERLESS", "on");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("<title>Just a moment</title><div>0 results for pcr</div>"));
    const response = await searchProtocols("pcr", { vendors: ["protocols-io"], protocolsIo: { mode: "simple" }, providerOpts: { fetchImpl } });
    expect(response.partial).toBe(true);
    expect(response.vendors[0]?.protocolsIo).toBeUndefined();
  });
});

describe("explicit protocols.io modes", () => {
  it.each([
    { tags: ["PCR"] }, { fields: [{ field: "title", value: "PCR" }] },
    { mode: "advanced", techniques: ["PCR"] }, { mode: "advanced", access: ["open_access"] },
    { mode: "advanced", fields: [{ field: "fake", value: "PCR" }] },
    { mode: "advanced", publishedFrom: "2026-02-30", publishedTo: "2026-03-01" },
    { mode: "advanced", publishedFrom: "2026-03-01", publishedTo: "2026-02-01" },
    { mode: "advanced", publishedFrom: "2026-03-01" },
    { techniques: ["PCR|RNA"] }, { page: 1.5 }, { unknown: "value" },
  ])("rejects invalid or silently converted constraints: %j", options => {
    expect(() => parseProtocolsIoSearchOptions(options)).toThrow();
  });
  it("keeps sidebar access as a union and advanced access as explicit booleans", () => {
    expect(new URL(protocolsIoSearchUrl("pcr", { access: ["open_access", "springer_protocols"] })).searchParams.get("access")).toBe("open_access,springer_protocols");
    const advanced = new URL(protocolsIoSearchUrl("pcr", { mode: "advanced", openAccess: true, springerProtocol: true }));
    expect(JSON.parse(advanced.searchParams.get("q")!)).toMatchObject({ open_access: true, springer_protocol: true });
    expect(advanced.searchParams.has("access")).toBe(false);
  });
});

describe("refinement state", () => {
  it("preserves query, sort, and limit while replacing or clearing only named filters", () => {
    const store = new ProtocolsIoSearchStore();
    const saved = store.save({ query: "pcr", limit: 3, options: { sortBy: "mentions", order: "desc", page: 4, techniques: ["PCR"], organisms: ["Homo sapiens"] } });
    const cleared = store.refine(saved.searchId, { techniques: [] });
    expect(cleared).toEqual({ query: "pcr", limit: 3, options: { sortBy: "mentions", order: "desc", page: 1, organisms: ["Homo sapiens"] } });
    expect(store.refine(saved.searchId, { page: 5 }).options).toMatchObject({ techniques: ["PCR"], page: 5 });
    expect(store.refine(saved.searchId, { techniques: ["RNA"], page: 2 }).options.page).toBe(2);
    expect(() => store.refine(saved.searchId, { mode: "advanced" })).toThrow("new search");
  });
  it("clears advanced fields without changing modes or unrelated constraints", () => {
    const store = new ProtocolsIoSearchStore();
    const saved = store.save({ query: "pcr", limit: 5, options: { mode: "advanced", tags: ["PCR"], fields: [{ field: "title", value: "test" }], openAccess: true } });
    expect(store.refine(saved.searchId, { fields: [], tags: [] }).options).toEqual({ mode: "advanced", openAccess: true, page: 1 });
  });
  it("expires and bounds immutable snapshots", () => {
    let now = 1000;
    const store = new ProtocolsIoSearchStore(() => now, 100, 2);
    const state = { query: "pcr", limit: 5, options: {} };
    const a = store.save(state), b = store.save(state);
    store.save(state);
    expect(() => store.refine(a.searchId, {})).toThrow("expired");
    expect(store.refine(b.searchId, {}).query).toBe("pcr");
    now += 100;
    expect(() => store.refine(b.searchId, {})).toThrow("expired");
  });
});

describe("MCP refinement", () => {
  async function call(name: string, args: object) {
    const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return response?.result as { isError: boolean; content: Array<{ text: string }>; structuredContent: { artifact: { protocolsIo: { searchId: string; page: number; totalMatches: number; selectedFilters: object }; request: object } } };
  }
  it("searches then refines the complete publisher query and returns fresh state", async () => {
    const spy = vi.spyOn(searches, "search").mockResolvedValue({ query: "pcr", results: [], sources: [{ id: "protocols-io", name: "protocols.io", kind: "journal", count: 0, protocolsIo: protocolsIoFacetsFromHtml(html, url) }], unknownSources: [], partial: false });
    const first = await call("search", { query: "pcr", sources: ["protocols-io"], limit: 3, protocolsIo: { sortBy: "mentions", page: 4, techniques: ["PCR"] } });
    const id = first.structuredContent.artifact.protocolsIo.searchId;
    const next = await call("refine_search", { searchId: id, changes: { techniques: [], access: ["open_access"] } });
    expect(next.isError).toBe(false);
    expect(spy).toHaveBeenLastCalledWith("pcr", { sources: ["protocols-io"], limit: 3, protocolsIo: { mode: "simple", sortBy: "mentions", page: 1, access: ["open_access"] } });
    expect(next.structuredContent.artifact.protocolsIo).toMatchObject({ page: 1, totalMatches: 1966, selectedFilters: { techniques: [], access: ["open_access"] } });
    expect(next.structuredContent.artifact.protocolsIo.searchId).not.toBe(id);
    expect(next.content[0]!.text).toContain("availableFacets");
    expect((await call("refine_search", { searchId: "unknown", changes: {} })).isError).toBe(true);
  });
  it("offers the local residential route for refinement calls", () => {
    expect(messageMayNeedResidential(JSON.stringify({ method: "tools/call", params: { name: "refine_search" } }))).toBe(true);
  });
});

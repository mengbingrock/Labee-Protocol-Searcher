import { afterEach, describe, expect, it, vi } from "vitest";
import { protocolsIoApiSearchUrl, searchProtocolsIoApi } from "../src/protocols-io-api.ts";
import { protocolsIoAdvancedQuery, protocolsIoSearchUrl, parseProtocolsIoSearchOptions } from "../src/protocols-io.ts";
import { searchProtocols } from "../src/search.ts";
import { dispatch } from "../src/mcp.ts";

const token = "test-protocols-token";
const item = { title: "PCR <i>protocol</i>", public: 1, uri: "pcr-legacy", version_uri: "pcr-current/v3", description: "<b>PCR</b> conditions." };
const payload = (items: unknown[] = [item], total = 2028, page = 1) => ({
  status_code: 0, items, pagination: { current_page: page, total_results: total },
  access_facets: { open_access: { count: total }, springer_protocols: { count: 5304 } },
  entity_facets: { techniques: [{ label: "PCR", count: 238 }], antibodies: [], organisms: [], cell_lines: [] },
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("protocols.io native API", () => {
  it("maps the public website's controls to a credential-free native URL", () => {
    const url = new URL(protocolsIoApiSearchUrl("pcr", { sortBy: "mentions", order: "asc", page: 2,
      access: ["open_access", "springer_protocols"], antibodies: ["Anti-rabbit"], techniques: ["PCR", "Real-time PCR"] }));
    expect(url.origin + url.pathname).toBe("https://www.protocols.io/api/v1/search");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: "pcr", types: "1", sort_by: "mentions", sort_dir: "asc",
      page_id: "2", page_size: "30", is_advanced: "false", entity_facets: "true", antibodies: "Anti-rabbit",
      techniques: "PCR|Real-time PCR", access: "open_access,springer_protocols" });
    expect(url.toString()).not.toContain(token);
  });

  it("defaults to Open Access and preserves an explicit cleared access filter", () => {
    expect(new URL(protocolsIoApiSearchUrl("pcr")).searchParams.get("access")).toBe("open_access");
    const cleared = parseProtocolsIoSearchOptions({ access: [] });
    expect(cleared).toEqual({ access: [] });
    expect(new URL(protocolsIoApiSearchUrl("pcr", cleared)).searchParams.has("access")).toBe(false);
    expect(new URL(protocolsIoSearchUrl("pcr", cleared)).searchParams.get("access")).toBe("");
    expect(new URL(protocolsIoApiSearchUrl("pcr", { sortBy: "title" })).searchParams.get("sort_dir")).toBe("asc");
  });

  it("serializes advanced search as the website's field query, rather than JSON", () => {
    const options = { mode: "advanced" as const, tags: ["PCR"],
      fields: [{ field: "all_entities.techniques" as const, value: "Real-time PCR" }, { field: "title" as const, value: "Q5 (PCR)" }],
      journalTitle: "Nature Protocols", articleDoi: "10.1038/example", springerProtocol: true, openAccess: true,
      publishedFrom: "2026-01-01", publishedTo: "2026-10-08" };
    expect(protocolsIoAdvancedQuery("pcr", options)).toBe('pcr AND keywords:(PCR) AND all_entities.techniques:("Real-time PCR") AND title:(Q5 \\(PCR\\)) AND journal_title:(Nature Protocols) AND origin:(springer_link) AND is_open_access:(true) AND article_doi:(10.1038\\/example) AND published:[2026-01-01 TO 2026-10-08]');
    const url = new URL(protocolsIoApiSearchUrl("pcr", options));
    expect(url.searchParams.get("q")).toBe(protocolsIoAdvancedQuery("pcr", options));
    expect(url.searchParams.get("is_advanced")).toBe("true");
    expect(url.searchParams.has("entity_facets")).toBe(false);
    expect(url.searchParams.has("access")).toBe(false);
  });

  it("uses the token only in a header, preserves versioned links/order, and reads publisher counts", async () => {
    vi.stubEnv("PROTOCOLS_IO_ACCESS_TOKEN", token);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload())));
    const validateUrl = vi.fn().mockResolvedValue(undefined);
    const result = await searchProtocolsIoApi("pcr", 2, {}, { fetchImpl, validateUrl });
    expect(result).toMatchObject({ status: "ok", results: [{ title: "PCR protocol", url: "https://www.protocols.io/view/pcr-current/v3", snippet: "PCR conditions." }],
      protocolsIo: { totalMatches: 2028, facetsAvailable: true, availableFacets: { techniques: {
        complete: false, options: [{ value: "PCR", label: "PCR", count: 238 }],
      } } } });
    expect(validateUrl).toHaveBeenCalledWith(fetchImpl.mock.calls[0]![0]);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("does not contact the API when unconfigured", async () => {
    vi.stubEnv("PROTOCOLS_IO_ACCESS_TOKEN", "");
    const fetchImpl = vi.fn<typeof fetch>();
    expect((await searchProtocolsIoApi("pcr", 2, {}, { fetchImpl })).status).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { ...payload(), status_code: 1, error_message: token },
    { ...payload(), pagination: { current_page: 2, total_results: 2028 } },
    { ...payload(), pagination: {} },
    payload([{ ...item, public: 0 }]),
    payload([{ ...item, version_uri: "https://attacker.invalid/" }]),
    payload([item], 0),
    payload([], 2),
  ])("rejects invalid, private, or inconsistent API data without exposing it", async body => {
    vi.stubEnv("PROTOCOLS_IO_ACCESS_TOKEN", token);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    const result = await searchProtocolsIoApi("pcr", 2, {}, { fetchImpl });
    expect(result.status).toBe("error");
    expect(result.results).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("redacts reflected upstream errors", async () => {
    vi.stubEnv("PROTOCOLS_IO_ACCESS_TOKEN", token);
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(`Credential: ${token}`));
    expect((await searchProtocolsIoApi("pcr", 2, {}, { fetchImpl })).error).toBe("protocols.io search API request failed");
  });

  it("accepts an empty later page without replacing it with unfiltered results", async () => {
    vi.stubEnv("PROTOCOLS_IO_ACCESS_TOKEN", token);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload([], 1, 2))));
    expect((await searchProtocolsIoApi("pcr", 2, { page: 2 }, { fetchImpl })).status).toBe("ok");
  });
});

describe("API search orchestration", () => {
  it("uses native JSON for filtered search without Browserless or web search", async () => {
    vi.stubEnv("PROTOCOLS_IO_ACCESS_TOKEN", token);
    vi.stubEnv("BROWSERLESS_TOKEN", "test-browserless");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload())));
    const response = await searchProtocols("pcr", { vendors: ["protocols-io"], protocolsIo: { antibodies: ["Anti-rabbit"] }, providerOpts: { fetchImpl } });
    expect(response.vendors[0]).toMatchObject({ source: "protocols-io-api", protocolsIo: { totalMatches: 2028 }, results: [{ title: "PCR protocol" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.partial).toBe(false);
  });

  it("keeps confirmed zero matches and access facet counts without a fallback", async () => {
    vi.stubEnv("PROTOCOLS_IO_ACCESS_TOKEN", token);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload([], 0))));
    const response = await searchProtocols("pcr", { vendors: ["protocols-io"], providerOpts: { fetchImpl } });
    expect(response.vendors[0]).toMatchObject({ source: "protocols-io-api", results: [], protocolsIo: { totalMatches: 0 } });
    expect(response.partial).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the exact rendered query after an API auth error without leaking the API token", async () => {
    vi.stubEnv("PROTOCOLS_IO_ACCESS_TOKEN", token);
    vi.stubEnv("BROWSERLESS_TOKEN", "test-browserless");
    vi.stubEnv("BROWSERLESS_URL", "https://browserless.example");
    vi.stubEnv("PROTOCOLS_BROWSERLESS", "on");
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(token, { status: 401 }))
      .mockResolvedValueOnce(new Response('<p>1 result for pcr</p><a href="https://www.protocols.io/view/pcr-second/v1">PCR second</a>'));
    const response = await searchProtocols("pcr", { vendors: ["protocols-io"], protocolsIo: { techniques: ["PCR"], sortBy: "mentions" }, providerOpts: { fetchImpl } });
    expect(response.vendors[0]).toMatchObject({ source: "publisher-browserless", results: [{ title: "PCR second" }],
      providers: [{ id: "protocols-io-api", status: "error" }, { id: "publisher-browserless", status: "ok" }] });
    const init = fetchImpl.mock.calls[1]![1]!;
    expect(JSON.stringify(init)).not.toContain(token);
    const rendered = new URL(JSON.parse(String(init.body)).url);
    expect(rendered.searchParams.get("techniques")).toBe("PCR");
    expect(rendered.searchParams.get("sort_by")).toBe("mentions");
  });

  it("does not return popular recommendations from an empty Browserless search", async () => {
    vi.stubEnv("PROTOCOLS_IO_ACCESS_TOKEN", "");
    vi.stubEnv("BROWSERLESS_TOKEN", "test-browserless");
    vi.stubEnv("BROWSERLESS_URL", "https://browserless.example");
    vi.stubEnv("PROTOCOLS_BROWSERLESS", "on");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('<p>No results for pcr</p><h2>Popular protocols</h2><a href="https://www.protocols.io/view/irrelevant/v1">Popular unrelated protocol</a>'));
    const response = await searchProtocols("pcr", { vendors: ["protocols-io"], providerOpts: { fetchImpl } });
    expect(response.vendors[0]).toMatchObject({ results: [], protocolsIo: { totalMatches: 0 } });
    expect(response.partial).toBe(false);
  });

  it("exposes API facets, defaults, and route through MCP and re-runs refinement", async () => {
    vi.stubEnv("PROTOCOLS_IO_ACCESS_TOKEN", token);
    const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(payload())));
    async function call(name: string, args: object) {
      const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return (response!.result as { structuredContent: { artifact: { protocolsIo: { searchId: string; route: string; facetStatus: string; selectedFilters: object; options: object } } } }).structuredContent.artifact;
    }
    const first = await call("search", { query: "pcr", sources: ["protocols-io"], limit: 2 });
    expect(first.protocolsIo).toMatchObject({ route: "protocols-io-api", facetStatus: "publisher-api-subset", selectedFilters: { access: ["open_access"] } });
    const refined = await call("refine_search", { searchId: first.protocolsIo.searchId, changes: { access: [], techniques: ["PCR"] } });
    expect(refined.protocolsIo).toMatchObject({ selectedFilters: { access: [], techniques: ["PCR"] } });
    const refinedUrl = new URL(String(fetchImpl.mock.calls[1]![0]));
    expect(refinedUrl.searchParams.has("access")).toBe(false);
    expect(refinedUrl.searchParams.get("techniques")).toBe("PCR");
  });
});

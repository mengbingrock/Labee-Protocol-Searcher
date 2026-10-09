import { expect, it } from "vitest";
import { dispatch } from "../src/mcp.ts";

// Explicit opt-in only. Credential values are never printed.
it.skipIf(process.env.LABEE_LIVE_PROTOCOLS_IO_API !== "1")("searches, sorts, pages, and refines protocols.io over native HTTP", async () => {
  await import("../src/env.ts");
  if (!process.env.PROTOCOLS_IO_ACCESS_TOKEN) throw new Error("Live API smoke test requires PROTOCOLS_IO_ACCESS_TOKEN");
  async function call(name: string, args: object) {
    const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const result = response?.result as { isError: boolean; structuredContent: { artifact: {
      protocolsIo: { searchId: string; totalMatches: number; facetsAvailable: boolean; facetStatus: string; page: number; sortBy: string; selectedFilters: object };
      sources: Array<{ route: string }>;
      results: Array<{ id: string }>;
    } } };
    expect(result.isError).toBe(false);
    const artifact = result.structuredContent.artifact;
    expect(artifact.sources[0]?.route).toBe("protocols-io-api");
    console.log(JSON.stringify({ tool: name, args, route: artifact.sources[0]?.route, total: artifact.protocolsIo.totalMatches, count: artifact.results.length }));
    return artifact;
  }
  for (const sortBy of ["relevance", "date", "title", "mentions", "wfm"]) {
    const result = await call("search", { query: "pcr", sources: ["protocols-io"], limit: 2, protocolsIo: { sortBy } });
    expect(result.results).toHaveLength(2);
    expect(result.protocolsIo).toMatchObject({ sortBy, facetsAvailable: true, facetStatus: "publisher-api-subset" });
  }
  const first = await call("search", { query: "pcr", sources: ["protocols-io"], limit: 2, protocolsIo: { sortBy: "date" } });
  const page2 = await call("refine_search", { searchId: first.protocolsIo.searchId, changes: { page: 2 } });
  expect(page2.protocolsIo.page).toBe(2);
  expect(page2.results).toHaveLength(2);
  expect(page2.results.some(x => first.results.some(y => x.id === y.id))).toBe(false);
  const refined = await call("refine_search", { searchId: first.protocolsIo.searchId, changes: { techniques: ["PCR"], organisms: ["Homo sapiens"] } });
  expect(refined.protocolsIo.totalMatches).toBeGreaterThan(0);
  expect(refined.protocolsIo.totalMatches).toBeLessThan(first.protocolsIo.totalMatches);
  const cleared = await call("refine_search", { searchId: refined.protocolsIo.searchId, changes: { access: [], techniques: [], organisms: [], antibodies: ["Anti-rabbit"] } });
  expect(cleared.protocolsIo.selectedFilters).toMatchObject({ access: [], antibodies: ["Anti-rabbit"] });
  expect(cleared.protocolsIo.totalMatches).toBeGreaterThan(0);
  const advanced = await call("search", { query: "pcr", sources: ["protocols-io"], limit: 2, protocolsIo: { mode: "advanced", fields: [{ field: "title", value: "PCR" }], openAccess: true } });
  expect(advanced.protocolsIo.totalMatches).toBeGreaterThan(0);
  expect(advanced.protocolsIo.facetsAvailable).toBe(false);
  const empty = await call("search", { query: "pcr", sources: ["protocols-io"], protocolsIo: { techniques: ["Labee nonexistent technique 918273"] } });
  expect(empty.protocolsIo.totalMatches).toBe(0);
  expect(empty.results).toEqual([]);
}, 90_000);

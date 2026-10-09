import { expect, it } from "vitest";
import { dispatch } from "../src/mcp.ts";

// Opt-in network smoke test. Uses existing .env credentials without printing them.
it.skipIf(process.env.LABEE_LIVE_SEARCH !== "1")("searches and refines protocols.io through Browserless", async () => {
  await import("../src/env.ts");
  if (!process.env.BROWSERLESS_TOKEN) throw new Error("Live smoke test requires BROWSERLESS_TOKEN in the environment or .env");
  async function call(name: string, args: object) {
    const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const result = response?.result as { isError: boolean; structuredContent: { artifact: {
      protocolsIo: { searchId: string; facetsAvailable: boolean; totalMatches: number | null; selectedFilters: object; sortBy: string; page: number; mode: string };
      sources: Array<{ route?: string; error?: string }>;
      results: unknown[];
    } } };
    expect(result.isError).toBe(false);
    const artifact = result.structuredContent.artifact;
    console.log(JSON.stringify({ tool: name, args, state: artifact.protocolsIo, sources: artifact.sources, returnedCount: artifact.results.length }));
    expect(artifact.sources[0]?.route).toMatch(/^publisher-browserless/);
    expect(artifact.results.length).toBeGreaterThan(0);
    return artifact;
  }
  const first = await call("search", { query: "pcr", sources: ["protocols-io"], limit: 2, protocolsIo: { mode: "simple", sortBy: "mentions" } });
  expect(first.protocolsIo.facetsAvailable).toBe(true);
  expect(first.protocolsIo.totalMatches).toBeGreaterThan(0);
  const next = await call("refine_search", { searchId: first.protocolsIo.searchId, changes: { access: ["open_access"], techniques: ["PCR"] } });
  expect(next.protocolsIo).toMatchObject({ sortBy: "mentions", page: 1, selectedFilters: { access: ["open_access"], techniques: ["PCR"] } });
  expect(next.protocolsIo.totalMatches).toBeGreaterThan(0);
  expect(next.protocolsIo.totalMatches).toBeLessThanOrEqual(first.protocolsIo.totalMatches!);
  const advanced = await call("search", { query: "pcr", sources: ["protocols-io"], limit: 2, protocolsIo: { mode: "advanced", fields: [{ field: "title", value: "PCR" }], openAccess: true } });
  expect(advanced.protocolsIo).toMatchObject({ mode: "advanced", facetsAvailable: false });
}, 240_000);

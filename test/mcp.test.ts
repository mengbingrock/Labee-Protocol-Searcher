import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatch, TOOLS } from "../src/mcp.ts";
import * as search from "../src/search.ts";

describe("MCP dispatch", () => {
  it("answers initialize with protocol version and tool capability", async () => {
    const res = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res?.result).toMatchObject({
      protocolVersion: expect.any(String),
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-protocols" },
    });
  });

  it("echoes the client's protocol version when supported, else its latest", async () => {
    const echoed = await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect((echoed!.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");

    const fallback = await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect((fallback!.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  });

  it("does not reply to the initialized notification", async () => {
    const res = await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res).toBeNull();
  });

  it("lists all tools with input schemas", async () => {
    const res = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (res!.result as { tools: typeof TOOLS }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "search_protocols",
      "find_restriction_enzyme",
      "get_protocol_fulltext",
      "list_protocol_vendors",
    ]);
    expect(tools[0]!.inputSchema.required).toContain("query");
  });

  it("returns an isError tool result when query is missing", async () => {
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_protocols", arguments: {} },
    });
    expect(res?.result).toMatchObject({ isError: true });
  });

  it("errors on an unknown method (with id)", async () => {
    const res = await dispatch({ jsonrpc: "2.0", id: 4, method: "no/such" });
    expect(res?.error?.code).toBe(-32601);
  });

  describe("search_protocols tool", () => {
    beforeEach(() => {
      vi.spyOn(search, "searchProtocols").mockResolvedValue({
        query: "gibson assembly",
        unknownVendors: [],
        partial: false,
        vendors: [
          {
            id: "neb",
            name: "New England Biolabs (NEB)",
            searchUrl: "https://www.neb.com/en-us/search?searchValue=gibson%20assembly",
            results: [
              { title: "Gibson Assembly Protocol", url: "https://www.neb.com/x", snippet: "steps" },
            ],
          },
        ],
      });
    });
    afterEach(() => vi.restoreAllMocks());

    it("renders the search response as markdown text content", async () => {
      const res = await dispatch({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "search_protocols", arguments: { query: "gibson assembly" } },
      });
      const content = (res!.result as { content: { type: string; text: string }[] }).content;
      expect(content[0]!.type).toBe("text");
      expect(content[0]!.text).toContain("Gibson Assembly Protocol");
      expect(content[0]!.text).toContain("https://www.neb.com/x");
    });
  });
});

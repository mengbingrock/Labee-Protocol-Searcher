import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatch, TOOLS } from "../src/mcp.ts";
import * as search from "../src/search.ts";

describe("MCP dispatch", () => {
  it("answers initialize with protocol version and tool capability", async () => {
    const res = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res?.result).toMatchObject({
      protocolVersion: expect.any(String),
      capabilities: { tools: {} },
      serverInfo: { name: "labee-protocol-searcher" },
    });
  });

  it("reports the package.json version, not a hardcoded one", async () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const res = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect((res!.result as { serverInfo: { version: string } }).serverInfo.version).toBe(
      pkg.version,
    );
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
    expect(tools.map((t) => t.name)).toEqual(["search", "fetch", "list_sources"]);
    expect(tools[0]!.inputSchema.required).toContain("query");
  });

  it("returns an isError tool result when query is missing", async () => {
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });
    expect(res?.result).toMatchObject({ isError: true });
  });

  it("errors on an unknown method (with id)", async () => {
    const res = await dispatch({ jsonrpc: "2.0", id: 4, method: "no/such" });
    expect(res?.error?.code).toBe(-32601);
  });

  describe("search tool", () => {
    beforeEach(() => {
      vi.spyOn(search, "search").mockResolvedValue({
        query: "gibson assembly",
        unknownSources: [],
        partial: false,
        sources: [
          {
            id: "neb",
            name: "New England Biolabs (NEB)",
            kind: "vendor",
            searchUrl: "https://www.neb.com/en-us/search?searchValue=gibson%20assembly",
            count: 1,
          },
        ],
        results: [
          {
            id: "url:https://www.neb.com/x",
            source: "neb",
            kind: "vendor-page",
            title: "Gibson Assembly Protocol",
            url: "https://www.neb.com/x",
            snippet: "steps",
            fetchable: "none",
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
        params: { name: "search", arguments: { query: "gibson assembly" } },
      });
      const content = (res!.result as { content: { type: string; text: string }[] }).content;
      expect(content[0]!.type).toBe("text");
      expect(content[0]!.text).toContain("Gibson Assembly Protocol");
      expect(content[0]!.text).toContain("url:https://www.neb.com/x");
    });
  });

  describe("fetch tool", () => {
    // A non-http url can't be retrieved and needs no network to prove it, which
    // keeps this hermetic; the 403-degrades and 200-extracts paths are covered
    // with mocked fetches in test/fetch.test.ts.
    it("returns the link for a url id that can't be retrieved", async () => {
      const res = await dispatch({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "fetch", arguments: { id: "url:mailto:orders@neb.com" } },
      });
      const text = (res!.result as { content: { text: string }[] }).content[0]!.text;
      expect(text).toContain("mailto:orders@neb.com");
      expect(text).toContain("_status: not-fetchable_");
    });

    it("errors when id is missing", async () => {
      const res = await dispatch({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "fetch", arguments: {} },
      });
      expect(res?.result).toMatchObject({ isError: true });
    });

    it("fetches a batch of ids into one response, each under its own header", async () => {
      const res = await dispatch({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "fetch",
          arguments: { ids: ["url:https://www.neb.com/x", "url:https://qiagen.com/y"] },
        },
      });
      const text = (res!.result as { content: { text: string }[] }).content[0]!.text;
      expect(text).toContain("# url:https://www.neb.com/x");
      expect(text).toContain("# url:https://qiagen.com/y");
      expect(text).toContain("---");
    });
  });
});

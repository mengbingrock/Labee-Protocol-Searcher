import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatch, TOOLS } from "../src/mcp.ts";
import * as search from "../src/search.ts";
import {
  prepareChromeSessionFetch,
  resetHostBrowserStateForTests,
} from "../src/agent/host-browser.ts";

describe("MCP dispatch", () => {
  it("answers initialize with protocol version and tool capability", async () => {
    const res = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res?.result).toMatchObject({
      protocolVersion: expect.any(String),
      capabilities: { tools: {} },
      serverInfo: { name: "labee-protocol-searcher" },
      instructions: expect.stringContaining("browser=host"),
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
    expect(tools.map((t) => t.name)).toEqual([
      "search",
      "neb_search_commit",
      "fetch",
      "chrome_fetch_commit",
      "browser_launch",
      "browser_status",
      "browser_close",
      "deep_search_start",
      "deep_search_get",
      "deep_search_cancel",
      "list_sources",
    ]);
    expect(tools[0]!.inputSchema.required).toContain("query");
    expect(TOOLS.find((tool) => tool.name === "fetch")?.inputSchema.properties.browser.enum)
      .toContain("default");
    expect(TOOLS.find((tool) => tool.name === "fetch")?.inputSchema.properties.browser.enum)
      .toContain("chrome");
    expect(TOOLS.find((tool) => tool.name === "search")?.inputSchema.properties.browser.enum)
      .toContain("default");
    expect(TOOLS.find((tool) => tool.name === "search")?.inputSchema.properties.browser.enum)
      .toContain("host");
    expect(TOOLS.find((tool) => tool.name === "search")?.description)
      .toContain("Prefer Codex's integrated Browser");
    expect(TOOLS.find((tool) => tool.name === "search")?.description)
      .toContain("Do not silently switch to system Chrome");
  });

  it("reports default-browser status without launching it", async () => {
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "browser_status", arguments: {} },
    });
    const text = (res!.result as { content: { text: string }[] }).content[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ state: "stopped", profile: "default" });
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
    afterEach(() => {
      resetHostBrowserStateForTests();
      vi.restoreAllMocks();
    });

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

    it("delegates NEB search to the host browser and serves committed HTML from cache", async () => {
      const prepared = await dispatch({
        jsonrpc: "2.0",
        id: 51,
        method: "tools/call",
        params: {
          name: "search",
          arguments: { query: "gibson assembly", sources: ["neb"], limit: 1, browser: "host" },
        },
      });
      const preparedText = (prepared!.result as { content: { text: string }[] }).content[0]!.text;
      expect(preparedText).toContain("_status: host-browser-required_");
      expect(search.search).not.toHaveBeenCalled();
      const task = JSON.parse(preparedText.slice(preparedText.indexOf("{")).trim()) as {
        captureId: string;
        searchUrl: string;
      };
      expect(task.searchUrl).toContain("www.neb.com/en-us/search");

      const committed = await dispatch({
        jsonrpc: "2.0",
        id: 52,
        method: "tools/call",
        params: {
          name: "neb_search_commit",
          arguments: {
            captureId: task.captureId,
            results: [{
              title: "Gibson Assembly Protocol",
              url: "https://www.neb.com/en-us/protocols/gibson-assembly",
              snippet: "Rendered by NEB",
              html: "<main><h1>Gibson Assembly</h1><p>Mix and incubate for 15 minutes.</p></main>",
            }],
          },
        },
      });
      const committedText = (committed!.result as { content: { text: string }[] }).content[0]!.text;
      expect(committedText).toContain("Gibson Assembly Protocol");
      expect(committedText).toContain("Host-browser NEB captures cached");

      const fetched = await dispatch({
        jsonrpc: "2.0",
        id: 53,
        method: "tools/call",
        params: {
          name: "fetch",
          arguments: { id: "url:https://www.neb.com/en-us/protocols/gibson-assembly" },
        },
      });
      const fetchedText = (fetched!.result as { content: { text: string }[] }).content[0]!.text;
      expect(fetchedText).toContain("HTML captured by Codex's integrated Browser during NEB search");
      expect(fetchedText).toContain("<h1>Gibson Assembly</h1>");
      expect(fetchedText).toContain("_status: display-only-full-text_");
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

    it("commits connected-Chrome PDF text and serves it from the original DOI", async () => {
      const id = "doi:10.1038/nprot.2016.055";
      const task = prepareChromeSessionFetch(
        id,
        "https://doi.org/10.1038/nprot.2016.055",
        "# Gibson assembly protocol\n\n_status: abstract-only_",
      );
      const text = "Gibson assembly protocol doi:10.1038/nprot.2016.055. " +
        "Materials, reaction setup, incubation, transformation, and validation steps. ".repeat(5);
      const committed = await dispatch({
        jsonrpc: "2.0",
        id: 71,
        method: "tools/call",
        params: {
          name: "chrome_fetch_commit",
          arguments: {
            captureId: task.captureId,
            title: "Gibson assembly protocol",
            url: task.url,
            finalUrl: "https://www.nature.com/articles/nprot.2016.055.pdf",
            text,
          },
        },
      });
      const committedText = (committed!.result as { content: { text: string }[] }).content[0]!.text;
      expect(committedText).toContain("Connected-Chrome capture cached");
      expect(committedText).toContain("_status: entitled-full-text_");

      const fetched = await dispatch({
        jsonrpc: "2.0",
        id: 72,
        method: "tools/call",
        params: { name: "fetch", arguments: { id } },
      });
      const fetchedText = (fetched!.result as { content: { text: string }[] }).content[0]!.text;
      expect(fetchedText).toContain(text);
      expect(fetchedText).toContain("_status: entitled-full-text_");
      resetHostBrowserStateForTests();
    });

    it("fetches a batch of ids into one response, each under its own header", async () => {
      const ids = ["url:mailto:orders@neb.com", "url:mailto:support@qiagen.com"];
      const res = await dispatch({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "fetch",
          // Non-HTTP ids make this protocol-format test hermetic. Network
          // retrieval behavior is covered with mocked fetches elsewhere.
          arguments: { ids },
        },
      });
      const text = (res!.result as { content: { text: string }[] }).content[0]!.text;
      expect(text).toContain(`# ${ids[0]}`);
      expect(text).toContain(`# ${ids[1]}`);
      expect(text).toContain("---");
    });
  });

  describe("deep-search tools", () => {
    it("validates required start/get/cancel arguments without starting network work", async () => {
      for (const [name, arguments_] of [
        ["deep_search_start", {}],
        ["deep_search_get", {}],
        ["deep_search_cancel", {}],
      ] as const) {
        const res = await dispatch({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name, arguments: arguments_ },
        });
        expect(res?.result).toMatchObject({ isError: true });
      }
    });
  });
});

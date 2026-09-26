import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { runHttpServer } from "../src/http.ts";
import {
  assertRemoteMcpUrl,
  messageMayNeedResidential,
  RemoteMcpClient,
  remoteMcpConfig,
  runStdioProxy,
  transportErrorResponse,
} from "../src/stdio-proxy.ts";
import {
  decodeResidentialOffer,
  RESIDENTIAL_OFFER_HEADER,
  type ResidentialOffer,
} from "../src/residential.ts";

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
});

describe("remote MCP stdio proxy", () => {
  it("defaults to the deployed endpoint and accepts only HTTPS or loopback HTTP", () => {
    expect(remoteMcpConfig({}).url).toBe("https://labee.online/api/protocols/mcp");
    expect(assertRemoteMcpUrl("http://127.0.0.1:3001/mcp")).toBe("http://127.0.0.1:3001/mcp");
    expect(() => assertRemoteMcpUrl("http://example.com/mcp")).toThrow(/HTTPS/);
    expect(() => assertRemoteMcpUrl("https://user:pass@example.com/mcp")).toThrow(/credentials/);
  });

  it("supports a dedicated remote token and documented compatibility aliases", () => {
    expect(remoteMcpConfig({ PROTOCOLS_REMOTE_MCP_TOKEN: "new" }).token).toBe("new");
    expect(remoteMcpConfig({ MCP_BEARER_TOKEN: "host" }).token).toBe("host");
    expect(remoteMcpConfig({ PROTOCOLS_MCP_TOKEN: "server" }).token).toBe("server");
  });

  it("forwards the exact JSON-RPC body, bearer token, session, and protocol version", async () => {
    const seen: Array<{ body: string; headers: Headers }> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push({ body: String(init?.body), headers: new Headers(init?.headers) });
      if (seen.length === 1) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "1" } },
        }), {
          headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = new RemoteMcpClient(
      { url: "https://remote.example/mcp", token: "secret", timeoutMs: 1_000 },
      { fetchImpl },
    );

    await client.forward(INIT);
    await client.forward(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }));

    expect(seen[0]!.body).toBe(INIT);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer secret");
    expect(seen[1]!.headers.get("mcp-session-id")).toBe("session-1");
    expect(seen[1]!.headers.get("mcp-protocol-version")).toBe("2025-06-18");
  });

  it("carries only non-secret residential capability metadata", async () => {
    let received: ResidentialOffer | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const encoded = new Headers(init?.headers).get(RESIDENTIAL_OFFER_HEADER) ?? undefined;
      received = decodeResidentialOffer(encoded);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 3, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = new RemoteMcpClient(
      { url: "https://remote.example/mcp", timeoutMs: 1_000 },
      { fetchImpl },
    );
    const offer: ResidentialOffer = {
      agentId: "local-agent",
      allowHosts: ["*.nature.com"],
      selector: { country: "US", region: "CA" },
    };
    await client.forward(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }), offer);
    expect(received).toEqual(offer);
  });

  it("advertises residential capability only for search/fetch calls", () => {
    expect(messageMayNeedResidential(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: {} },
    }))).toBe(true);
    expect(messageMayNeedResidential(JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch", arguments: {} },
    }))).toBe(true);
    expect(messageMayNeedResidential(INIT)).toBe(false);
    expect(messageMayNeedResidential(JSON.stringify({
      jsonrpc: "2.0", id: 4, method: "tools/list",
    }))).toBe(false);
  });

  it("returns no local response for a forwarded notification", async () => {
    const client = new RemoteMcpClient(
      { url: "https://remote.example/mcp", timeoutMs: 1_000 },
      { fetchImpl: (async () => new Response(null, { status: 202 })) as typeof fetch },
    );
    await expect(client.forward(JSON.stringify({
      jsonrpc: "2.0", method: "notifications/initialized",
    }))).resolves.toBeNull();
  });

  it("maps transport failures to the original request id but stays silent for notifications", () => {
    expect(JSON.parse(transportErrorResponse(
      JSON.stringify({ jsonrpc: "2.0", id: "abc", method: "ping" }),
      "Remote MCP HTTP 503",
    )!)).toEqual({
      jsonrpc: "2.0",
      id: "abc",
      error: { code: -32002, message: "Remote MCP HTTP 503" },
    });
    expect(transportErrorResponse(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "offline",
    )).toBeNull();
  });

  it("runs a real newline-delimited stdio-to-HTTP bridge", async () => {
    const token = "stdio-integration-token";
    const server = await runHttpServer(0, "127.0.0.1", { token });
    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = "";
    output.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    const bridge = runStdioProxy({
      client: new RemoteMcpClient({
        url: `http://127.0.0.1:${server.port}/mcp`,
        token,
        timeoutMs: 2_000,
      }),
      input,
      output,
      log: () => {},
    });
    input.end(`${INIT}\n`);
    await bridge;
    await server.close();

    const response = JSON.parse(stdout.trim()) as { result: { serverInfo: { name: string } } };
    expect(response.result.serverInfo.name).toBe("labee-protocol-searcher");
  }, 10_000);
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runHttpServer } from "../src/http.ts";

const TOKEN = "test-token-abcdefghijklmnop";

let base: string;
let close: () => Promise<void>;

// Port 0 → the OS picks a free port, so tests never collide with a real server.
beforeAll(async () => {
  const server = await runHttpServer(0, "127.0.0.1", { token: TOKEN });
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
});

afterAll(async () => {
  await close();
});

/** POST a JSON-RPC message with the good token unless a header overrides it. */
function post(body: unknown, init: RequestInit = {}): Promise<Response> {
  const { headers, ...rest } = init;
  return fetch(`${base}/mcp`, {
    method: "POST",
    ...rest,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      ...((headers as Record<string, string>) ?? {}),
    },
    body: JSON.stringify(body),
  });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };

describe("MCP Streamable HTTP transport", () => {
  it("completes an initialize handshake", async () => {
    const res = await post(INIT);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result).toMatchObject({
      protocolVersion: expect.any(String),
      capabilities: { tools: {} },
      serverInfo: { name: "labee-protocol-searcher" },
    });
  });

  it("lists the same tools the stdio transport serves", async () => {
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "deep_search_cancel",
      "deep_search_get",
      "deep_search_start",
      "fetch",
      "list_sources",
      "search",
    ]);
  });

  it("rejects a missing or wrong bearer token", async () => {
    const none = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(INIT),
    });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");

    const wrong = await post(INIT, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("answers a notification with 202 and no body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("returns 405 with an Allow header for GET and DELETE", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${base}/mcp`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("reports a parse error for malformed JSON", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("serves an unauthenticated health probe", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("404s an unknown path", async () => {
    const res = await fetch(`${base}/nope`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it("handles a batch as an array of responses", async () => {
    const res = await post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });
});

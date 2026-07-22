// The MCP Streamable HTTP transport, as a counterpart to the stdio transport in
// ./mcp.ts. Both feed the same pure `dispatch`, so the tool surface is identical
// however a client connects.
//
// This server is deliberately *sessionless*: `dispatch` keeps no per-client
// state, so there is nothing to pin a session to. The spec makes `Mcp-Session-Id`
// optional for exactly this case, and omitting it means clients never have to
// resume or re-initialize. It also means we don't offer a server-initiated SSE
// stream, so GET returns 405 as the spec requires of servers that don't.
//
// https://modelcontextprotocol.io/specification — "Streamable HTTP"

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { dispatch, type JsonRpcRequest, type JsonRpcResponse } from "./mcp.ts";

/** Cap request bodies. The box this runs on is memory-tight and no legitimate
 *  MCP message is anywhere near this large. */
const MAX_BODY_BYTES = 1_000_000;

export interface HttpServerOptions {
  /** Path the MCP endpoint is mounted at. Default `/mcp`. */
  path?: string;
  /** Shared secret required as `Authorization: Bearer <token>`. When unset the
   *  endpoint is unauthenticated — only acceptable when bound to loopback. */
  token?: string;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** JSON-RPC error shaped as a top-level response (no id — the request never parsed). */
function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  jsonResponse(res, status, { jsonrpc: "2.0", id: null, error: { code, message } });
}

/**
 * Constant-time bearer check. Compares lengths first because timingSafeEqual
 * throws on a length mismatch — that leaks length only, which the token's fixed
 * width already does.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/** Read the whole body, rejecting anything over MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Handle one MCP HTTP request. Exported so it can be mounted inside another
 * Node HTTP server rather than only run standalone.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpServerOptions = {},
): Promise<void> {
  const { token } = options;

  // Auth first, so an unauthenticated caller learns nothing about the endpoint
  // beyond its existence.
  if (token) {
    const presented = bearerFrom(req);
    if (!presented || !tokenMatches(presented, token)) {
      res.setHeader("www-authenticate", 'Bearer realm="mcp"');
      rpcError(res, 401, -32001, "Unauthorized");
      return;
    }
  }

  if (req.method === "GET" || req.method === "DELETE") {
    // No SSE stream and no session to terminate.
    res.setHeader("allow", "POST");
    rpcError(res, 405, -32000, `${req.method} is not supported by this endpoint`);
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    rpcError(res, 405, -32000, "Method Not Allowed");
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not read request body";
    rpcError(res, 413, -32600, message);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    rpcError(res, 400, -32700, "Parse error");
    return;
  }

  // A batch is only legal pre-2025-06-18, but accepting one costs nothing and
  // keeps older clients working.
  const batch = Array.isArray(parsed);
  const messages = (batch ? parsed : [parsed]) as JsonRpcRequest[];
  if (batch && messages.length === 0) {
    rpcError(res, 400, -32600, "Invalid Request: empty batch");
    return;
  }

  const results: JsonRpcResponse[] = [];
  for (const message of messages) {
    const response = await dispatch(message);
    if (response) results.push(response);
  }

  // Every message was a notification — nothing to say back.
  if (results.length === 0) {
    res.writeHead(202).end();
    return;
  }

  jsonResponse(res, 200, batch ? results : results[0]);
}

/**
 * Start the MCP server over Streamable HTTP. Resolves with a `close` handle once
 * the server is listening.
 */
export function runHttpServer(
  port: number,
  host: string,
  options: HttpServerOptions = {},
): Promise<{ close: () => Promise<void>; port: number }> {
  const path = options.path ?? "/mcp";

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    // Unauthenticated liveness probe for systemd/nginx. Reveals nothing.
    if (pathname === "/healthz") {
      jsonResponse(res, 200, { status: "ok" });
      return;
    }

    if (pathname !== path) {
      rpcError(res, 404, -32601, `Not found: ${pathname}`);
      return;
    }

    void handleMcpRequest(req, res, options).catch((err) => {
      const message = err instanceof Error ? err.message : "internal error";
      process.stderr.write(`[labee-protocol-searcher] request failed: ${message}\n`);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      process.stderr.write(
        `[labee-protocol-searcher] MCP server ready on http://${host}:${actualPort}${path}` +
          `${options.token ? " (bearer auth enabled)" : " (UNAUTHENTICATED)"}\n`,
      );
      resolve({
        port: actualPort,
        close: () =>
          new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

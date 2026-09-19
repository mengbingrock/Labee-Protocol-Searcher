// Thin local MCP transport.
//
// The stdio process owns no search or fetch implementation. It forwards every
// newline-delimited JSON-RPC message to the remote Streamable HTTP endpoint and
// relays the response. When the same process has a connected residential exit,
// it advertises that capability only on search/fetch tool calls; the remote
// backend consumes the exit only for a publisher configured to prefer it or
// for a retry after the datacenter route was insufficient.

import {
  activeResidentialOffer,
  awaitResidentialReady,
  encodeResidentialOffer,
  RESIDENTIAL_OFFER_HEADER,
  type ResidentialOffer,
} from "./residential.ts";

export const DEFAULT_REMOTE_MCP_URL = "https://labee.online/mcp";
const DEFAULT_REMOTE_TIMEOUT_MS = 300_000;
const TRANSPORT_ERROR_CODE = -32002;

export interface RemoteMcpConfig {
  timeoutMs: number;
  token?: string | undefined;
  url: string;
}

export interface RemoteMcpClientOptions {
  fetchImpl?: typeof fetch;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function assertRemoteMcpUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password) {
    throw new Error("Remote MCP URL must not contain credentials");
  }
  if (parsed.hash) throw new Error("Remote MCP URL must not contain a fragment");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    throw new Error("Remote MCP URL must use HTTPS unless it is loopback");
  }
  return parsed.toString();
}

export function remoteMcpConfig(env: NodeJS.ProcessEnv = process.env): RemoteMcpConfig {
  const rawTimeout = Number(env.PROTOCOLS_REMOTE_MCP_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.floor(rawTimeout)
    : DEFAULT_REMOTE_TIMEOUT_MS;
  const url = assertRemoteMcpUrl(
    optional(env.PROTOCOLS_REMOTE_MCP_URL) ?? DEFAULT_REMOTE_MCP_URL,
  );
  const token = optional(env.PROTOCOLS_REMOTE_MCP_TOKEN)
    ?? optional(env.MCP_BEARER_TOKEN)
    ?? optional(env.PROTOCOLS_MCP_TOKEN);
  return { timeoutMs, token, url };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isResidentialToolCall(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isResidentialToolCall);
  if (!value || typeof value !== "object") return false;
  const request = value as { method?: unknown; params?: { name?: unknown } };
  return request.method === "tools/call"
    && (request.params?.name === "search" || request.params?.name === "fetch");
}

/** Only search/fetch can cause a publisher browser route. */
export function messageMayNeedResidential(raw: string): boolean {
  return isResidentialToolCall(parseJson(raw));
}

function responseIds(raw: string): Array<string | number | null> | null {
  const parsed = parseJson(raw);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (parsed === undefined || (Array.isArray(parsed) && parsed.length === 0)) return [null];

  const ids: Array<string | number | null> = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      ids.push(null);
      continue;
    }
    const request = message as { id?: unknown; method?: unknown };
    // A well-formed method without an id is a notification and gets no reply.
    if (typeof request.method === "string" && request.id === undefined) continue;
    if (request.id === null || typeof request.id === "string" || typeof request.id === "number") {
      ids.push(request.id);
    } else {
      ids.push(null);
    }
  }
  return ids.length ? ids : null;
}

export function transportErrorResponse(raw: string, message: string): string | null {
  const ids = responseIds(raw);
  if (!ids) return null;
  const responses = ids.map((id) => ({
    jsonrpc: "2.0" as const,
    id,
    error: { code: TRANSPORT_ERROR_CODE, message },
  }));
  return JSON.stringify(Array.isArray(parseJson(raw)) ? responses : responses[0]);
}

function parseEventStream(body: string): unknown {
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    const parsed = parseJson(data);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function normalizedRemoteBody(contentType: string, body: string): string {
  const parsed = contentType.includes("text/event-stream")
    ? parseEventStream(body)
    : parseJson(body);
  if (parsed === undefined) throw new Error("Remote MCP returned a malformed response");
  return JSON.stringify(parsed);
}

function remoteErrorMessage(status: number, body: string): string {
  const parsed = parseJson(body) as { error?: { message?: unknown } } | undefined;
  const detail = typeof parsed?.error?.message === "string" ? `: ${parsed.error.message}` : "";
  return `Remote MCP HTTP ${status}${detail}`;
}

/** Sessionless today, but preserves MCP session/version headers for compatible remotes. */
export class RemoteMcpClient {
  private readonly fetchImpl: typeof fetch;
  private protocolVersion: string | undefined;
  private sessionId: string | undefined;

  public constructor(
    private readonly config: RemoteMcpConfig,
    options: RemoteMcpClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async forward(raw: string, offer: ResidentialOffer | null = null): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      };
      if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
      if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
      if (offer) headers[RESIDENTIAL_OFFER_HEADER] = encodeResidentialOffer(offer);

      const response = await this.fetchImpl(this.config.url, {
        body: raw,
        headers,
        method: "POST",
        redirect: "error",
        signal: controller.signal,
      });
      const returnedSession = response.headers.get("mcp-session-id")?.trim();
      if (returnedSession) this.sessionId = returnedSession;
      if (response.status === 202 || response.status === 204) return null;

      const body = await response.text();
      if (!response.ok) throw new Error(remoteErrorMessage(response.status, body));
      const normalized = normalizedRemoteBody(response.headers.get("content-type") ?? "", body);
      const request = parseJson(raw) as { method?: unknown } | undefined;
      if (request?.method === "initialize") {
        const reply = parseJson(normalized) as { result?: { protocolVersion?: unknown } };
        if (typeof reply.result?.protocolVersion === "string") {
          this.protocolVersion = reply.result.protocolVersion;
        }
      }
      return normalized;
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface StdioInput {
  on(event: "data", listener: (chunk: string) => void): this;
  once(event: "end" | "close", listener: () => void): this;
  setEncoding(encoding: BufferEncoding): this;
}

interface StdioOutput {
  write(chunk: string): unknown;
}

export interface StdioProxyOptions {
  client?: RemoteMcpClient;
  input?: StdioInput;
  log?: (message: string) => void;
  output?: StdioOutput;
  residentialReadyTimeoutMs?: number;
}

function configuredResidentialReadyTimeout(): number {
  const value = Number(process.env.RESIDENTIAL_PROXY_READY_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 4_000;
}

/** Start the local stdio-to-remote HTTP bridge. Resolves after stdin and in-flight calls drain. */
export function runStdioProxy(options: StdioProxyOptions = {}): Promise<void> {
  const client = options.client ?? new RemoteMcpClient(remoteMcpConfig());
  const input = options.input ?? (process.stdin as unknown as StdioInput);
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const readyTimeout = options.residentialReadyTimeoutMs ?? configuredResidentialReadyTimeout();

  return new Promise((resolve) => {
    let buffer = "";
    let inputClosed = false;
    let pending = 0;
    const maybeResolve = () => {
      if (inputClosed && pending === 0) resolve();
    };
    const closeInput = () => {
      inputClosed = true;
      maybeResolve();
    };
    const forwardLine = (line: string) => {
      pending++;
      void (async () => {
        try {
          let offer: ResidentialOffer | null = null;
          if (messageMayNeedResidential(line)) {
            await awaitResidentialReady(readyTimeout);
            offer = activeResidentialOffer();
          }
          const response = await client.forward(line, offer);
          if (response) output.write(`${response}\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Remote MCP request failed";
          const response = transportErrorResponse(line, message);
          if (response) output.write(`${response}\n`);
        } finally {
          pending--;
          maybeResolve();
        }
      })();
    };

    log("[labee-protocol-searcher] stdio proxy ready; all MCP requests forward to the remote service");
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) forwardLine(line);
      }
    });
    input.once("end", closeInput);
    input.once("close", closeInput);
  });
}

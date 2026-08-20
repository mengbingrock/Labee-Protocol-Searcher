import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { CdpBrowserAdapter, looksLikeProtocolEvidence } from "../src/agent/browser.ts";
import {
  assertLoopbackCdpEndpoint,
  assertLoopbackCdpWebSocketEndpoint,
  assertSafePublicUrl,
  isPublicAddress,
} from "../src/agent/url-policy.ts";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

describe("URL policy", () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }] as never;
  const privateLookup = async () => [{ address: "169.254.169.254", family: 4 }] as never;

  it("accepts allow-listed public HTTPS and rejects unsafe destinations", async () => {
    await expect(assertSafePublicUrl("https://example.com/article", ["example.com"], publicLookup)).resolves.toBeInstanceOf(URL);
    await expect(assertSafePublicUrl("http://example.com", ["example.com"], publicLookup)).rejects.toThrow("HTTPS");
    await expect(assertSafePublicUrl("https://user:pass@example.com", ["example.com"], publicLookup)).rejects.toThrow("credentials");
    await expect(assertSafePublicUrl("https://other.example/article", ["example.com"], publicLookup)).rejects.toThrow("allowlist");
    await expect(assertSafePublicUrl("https://metadata.invalid", [], privateLookup)).rejects.toThrow("non-public");
  });

  it("classifies private, reserved, mapped, and public addresses", () => {
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicAddress("::ffff:a00:1")).toBe(false);
    expect(isPublicAddress("64:ff9b::7f00:1")).toBe(false);
    expect(isPublicAddress("64:ff9b::a9fe:a9fe")).toBe(false);
    expect(isPublicAddress("64:ff9b:1::1")).toBe(false);
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("allows only bare literal-loopback CDP control origins", () => {
    expect(assertLoopbackCdpEndpoint("http://127.0.0.1:9222").port).toBe("9222");
    expect(assertLoopbackCdpEndpoint("http://[::1]:9222").port).toBe("9222");
    expect(() => assertLoopbackCdpEndpoint("http://localhost:9222")).toThrow("literal loopback");
    expect(() => assertLoopbackCdpEndpoint("https://browser.example.com")).toThrow("loopback");
    expect(() => assertLoopbackCdpEndpoint("http://127.0.0.1:9222/devtools")).toThrow("no path");
    expect(() => assertLoopbackCdpEndpoint("http://127.0.0.1:9222/?target=x")).toThrow("no path");
    expect(() => assertLoopbackCdpEndpoint("http://127.0.0.1:9222/?")).toThrow("no path");
    expect(() => assertLoopbackCdpEndpoint("http://127.0.0.1:9222/#x")).toThrow("no path");
    expect(() => assertLoopbackCdpEndpoint("http://127.0.0.1:9222/#")).toThrow("no path");
    expect(() => assertLoopbackCdpEndpoint("http://user:pass@127.0.0.1:9222")).toThrow("credentials");
    expect(() => new CdpBrowserAdapter("http://10.0.0.2:9222")).toThrow("loopback");
  });

  it("requires the advertised CDP websocket to remain on the discovery origin", () => {
    const control = assertLoopbackCdpEndpoint("http://127.0.0.1:9222");
    expect(assertLoopbackCdpWebSocketEndpoint(
      "ws://127.0.0.1:9222/devtools/browser/test-id",
      control,
    ).pathname).toBe("/devtools/browser/test-id");
    expect(() => assertLoopbackCdpWebSocketEndpoint(
      "ws://127.0.0.1:9333/devtools/browser/test-id",
      control,
    )).toThrow("same loopback");
    expect(() => assertLoopbackCdpWebSocketEndpoint(
      "ws://localhost:9222/devtools/browser/test-id",
      control,
    )).toThrow("literal loopback");
    expect(() => assertLoopbackCdpWebSocketEndpoint(
      "wss://127.0.0.1:9222/devtools/browser/test-id",
      control,
    )).toThrow("use WS");
  });
});

describe("CDP discovery", () => {
  it("does not follow discovery redirects", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(302, { Location: "https://browser.example.com/json/version" });
      res.end();
    });
    const port = await listen(server);
    try {
      const state = await new CdpBrowserAdapter(`http://127.0.0.1:${port}`).available();
      expect(state).toMatchObject({ available: false });
      expect(state.reason).toContain("HTTP 302");
    } finally {
      await close(server);
    }
  });

  it("rejects an external websocket advertised by loopback discovery", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://browser.example.com/devtools/browser/evil" }));
    });
    const port = await listen(server);
    try {
      const state = await new CdpBrowserAdapter(`http://127.0.0.1:${port}`).available();
      expect(state).toMatchObject({ available: false });
      expect(state.reason).toContain("literal loopback");
    } finally {
      await close(server);
    }
  });

  it("classifies CDP connection failure as unavailable and preserves operator Chrome on close", async () => {
    const server = createServer((_req, res) => {
      const port = (server.address() as AddressInfo).port;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test-id` }));
    });
    const port = await listen(server);
    let endpoint = "";
    try {
      const adapter = new CdpBrowserAdapter(`http://127.0.0.1:${port}`, async (verified) => {
        endpoint = verified;
        throw new Error("websocket refused");
      });
      const hit = await adapter.retrieve({
        url: "https://93.184.216.34/article",
        sourceId: "fixture",
        allowedHosts: ["93.184.216.34"],
        maxChars: 1_000,
        timeoutMs: 1_000,
      });
      expect(endpoint).toBe(`ws://127.0.0.1:${port}/devtools/browser/test-id`);
      expect(hit).toMatchObject({ status: "unavailable", detail: "websocket refused" });
      await adapter.close();
    } finally {
      await close(server);
    }
  });

  it("does not call Browser.close on an operator-owned CDP browser", async () => {
    const server = createServer((_req, res) => {
      const port = (server.address() as AddressInfo).port;
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test-id` }));
    });
    const port = await listen(server);
    let closeCalls = 0;
    const fakeBrowser = {
      isConnected: () => true,
      contexts: () => [],
      close: async () => { closeCalls++; },
    } as unknown as import("playwright-core").Browser;
    try {
      const adapter = new CdpBrowserAdapter(`http://127.0.0.1:${port}`, async () => fakeBrowser);
      const hit = await adapter.retrieve({
        url: "https://93.184.216.34/article",
        sourceId: "fixture",
        allowedHosts: ["93.184.216.34"],
        maxChars: 1_000,
        timeoutMs: 1_000,
      });
      expect(hit).toMatchObject({ status: "unavailable", detail: "CDP browser has no context" });
      await adapter.close();
      expect(closeCalls).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("closes a Labee-owned CDP browser", async () => {
    const server = createServer((_req, res) => {
      const port = (server.address() as AddressInfo).port;
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test-id` }));
    });
    const port = await listen(server);
    let closeCalls = 0;
    const fakeBrowser = {
      isConnected: () => true,
      contexts: () => [],
      close: async () => { closeCalls++; },
    } as unknown as import("playwright-core").Browser;
    try {
      const adapter = new CdpBrowserAdapter(
        `http://127.0.0.1:${port}`,
        async () => fakeBrowser,
        true,
      );
      await adapter.retrieve({
        url: "https://93.184.216.34/article",
        sourceId: "fixture",
        allowedHosts: ["93.184.216.34"],
        maxChars: 1_000,
        timeoutMs: 1_000,
      });
      await adapter.close();
      expect(closeCalls).toBe(1);
    } finally {
      await close(server);
    }
  });
});

describe("browser evidence classification", () => {
  it("accepts procedural content and rejects access or citation shells", () => {
    const protocol = [
      "PCR protocol and materials and methods",
      "Step 1: Add 5 µL template and mix thoroughly.",
      "Step 2: Incubate at 37 °C for 30 minutes.",
      "Wash and centrifuge at 12,000 × g before resuspending the pellet.",
    ].join("\n").repeat(20);
    const accessWall = `Sign in to access this article through your institution. ${"Citation and related articles. ".repeat(80)}`;
    const abstractOnly = `This study discusses amplification outcomes in several organisms. ${"Background and references. ".repeat(80)}`;
    expect(looksLikeProtocolEvidence(protocol)).toBe(true);
    expect(looksLikeProtocolEvidence(accessWall)).toBe(false);
    expect(looksLikeProtocolEvidence(abstractOnly)).toBe(false);
  });
});

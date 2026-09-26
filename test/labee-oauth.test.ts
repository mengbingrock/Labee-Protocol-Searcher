import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LabeeOAuthClient } from "../src/labee-oauth.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Labee OAuth client", () => {
  it("runs PKCE through a loopback callback and persists tokens privately", async () => {
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      requests.push(req.url ?? "");
      if (req.url === "/oauth/register") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ client_id: "codex-client" }));
        return;
      }
      if (req.url === "/oauth/token") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const params = new URLSearchParams(body);
        expect(params.get("resource")).toMatch(/\/api\/protocols\/mcp$/);
        expect(params.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "protocols:search openid email",
        }));
        return;
      }
      if (req.url === "/oauth/revoke") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const root = mkdtempSync(join(tmpdir(), "labee-oauth-client-"));
    roots.push(root);
    const authFile = join(root, "auth.json");
    const resource = `http://127.0.0.1:${address.port}/api/protocols/mcp`;
    const client = new LabeeOAuthClient({ authFile, resource, log: () => {} });
    const authorizationUrl = new URL(await client.beginAuthorization());
    expect(authorizationUrl.pathname).toBe("/oauth/authorize");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
    const completed = await fetch(callback);
    expect(completed.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(client.status().authenticated).toBe(true);
    expect(await client.accessToken()).toBe("access-token");
    expect(readFileSync(authFile, "utf8")).toContain("refresh-token");
    const reloaded = new LabeeOAuthClient({ authFile, resource, log: () => {} });
    expect(await reloaded.accessToken()).toBe("access-token");
    await reloaded.disconnect();
    expect(reloaded.status().authenticated).toBe(false);
    expect(requests).toEqual(["/oauth/register", "/oauth/token", "/oauth/revoke"]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

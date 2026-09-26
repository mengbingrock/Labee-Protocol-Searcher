import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface StoredOAuthSession {
  accessToken: string;
  clientId: string;
  expiresAt: number;
  issuer: string;
  refreshToken: string;
  resource: string;
  scope: string;
}

interface PendingAuthorization {
  authorizationUrl: string;
  server: Server;
  timer: NodeJS.Timeout;
}

export interface LabeeOAuthOptions {
  authFile?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  resource: string;
}

export interface LabeeAuthStatus {
  authenticated: boolean;
  authorizationUrl?: string;
  expiresAt?: string;
  source: "oauth" | "none";
}

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

function defaultAuthFile(): string {
  return process.env.LABEE_OAUTH_FILE?.trim()
    || join(homedir(), ".config", "labee", "protocol-search-oauth.json");
}

function issuerFor(resource: string): string {
  return new URL(resource).origin;
}

function randomValue(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function challenge(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function readSession(file: string, resource: string): StoredOAuthSession | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredOAuthSession>;
    if (
      typeof value.accessToken !== "string" || typeof value.clientId !== "string" ||
      typeof value.expiresAt !== "number" || typeof value.issuer !== "string" ||
      typeof value.refreshToken !== "string" || value.resource !== resource ||
      typeof value.scope !== "string"
    ) return null;
    return value as StoredOAuthSession;
  } catch {
    return null;
  }
}

function saveSession(file: string, session: StoredOAuthSession): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(session)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
}

function doneHtml(ok: boolean, message: string): string {
  const title = ok ? "Labee connected" : "Labee connection failed";
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f7f3;color:#222}main{max-width:520px;padding:32px;text-align:center}</style><main><h1>${title}</h1><p>${message}</p></main>`;
}

export class LabeeOAuthClient {
  private readonly authFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly issuer: string;
  private readonly log: (message: string) => void;
  private pending: PendingAuthorization | null = null;
  private session: StoredOAuthSession | null;

  public constructor(private readonly options: LabeeOAuthOptions) {
    this.authFile = options.authFile ?? defaultAuthFile();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.issuer = issuerFor(options.resource);
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.session = readSession(this.authFile, options.resource);
  }

  public status(): LabeeAuthStatus {
    return {
      authenticated: Boolean(this.session && this.session.expiresAt > Date.now()),
      ...(this.pending ? { authorizationUrl: this.pending.authorizationUrl } : {}),
      ...(this.session ? { expiresAt: new Date(this.session.expiresAt).toISOString() } : {}),
      source: this.session ? "oauth" : "none",
    };
  }

  public async disconnect(): Promise<void> {
    const refreshToken = this.session?.refreshToken;
    this.closePending();
    this.session = null;
    try { rmSync(this.authFile, { force: true }); } catch { /* best effort */ }
    if (!refreshToken) return;
    try {
      await this.fetchImpl(`${this.issuer}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token" }),
      });
    } catch (error) {
      this.log(`[labee-auth] token revocation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async accessToken(): Promise<string | undefined> {
    if (!this.session) return undefined;
    if (this.session.expiresAt > Date.now() + REFRESH_SKEW_MS) return this.session.accessToken;
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.session.refreshToken,
        client_id: this.session.clientId,
        resource: this.options.resource,
      });
      const response = await this.fetchImpl(`${this.issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await this.acceptTokens(await response.json(), this.session.clientId);
      return this.session?.accessToken;
    } catch (error) {
      this.log(`[labee-auth] token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.disconnect();
      return undefined;
    }
  }

  public async beginAuthorization(): Promise<string> {
    if (this.pending) return this.pending.authorizationUrl;
    const codeVerifier = randomValue(48);
    const state = randomValue(24);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Could not start the Labee OAuth callback listener");
    }
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const registration = await this.fetchImpl(`${this.issuer}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Labee Protocol Searcher for Codex",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    if (!registration.ok) {
      server.close();
      throw new Error(`Labee OAuth registration failed (HTTP ${registration.status})`);
    }
    const registered = await registration.json() as { client_id?: unknown };
    if (typeof registered.client_id !== "string") {
      server.close();
      throw new Error("Labee OAuth registration returned no client id");
    }
    const url = new URL(`${this.issuer}/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge(codeVerifier),
      code_challenge_method: "S256",
      resource: this.options.resource,
      scope: "protocols:search openid email",
      state,
    }).toString();

    server.on("request", (request, response) => {
      void this.handleCallback(request.url ?? "/", response, {
        clientId: registered.client_id as string,
        codeVerifier,
        redirectUri,
        state,
      });
    });
    const timer = setTimeout(() => {
      this.log("[labee-auth] authorization timed out");
      this.closePending();
    }, AUTH_TIMEOUT_MS);
    timer.unref();
    this.pending = { authorizationUrl: url.toString(), server, timer };
    return url.toString();
  }

  private async handleCallback(
    rawUrl: string,
    response: ServerResponse,
    flow: { clientId: string; codeVerifier: string; redirectUri: string; state: string },
  ): Promise<void> {
    try {
      const callback = new URL(rawUrl, flow.redirectUri);
      if (callback.pathname !== "/callback" || callback.searchParams.get("state") !== flow.state) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(doneHtml(false, "The OAuth callback could not be verified."));
        return;
      }
      const code = callback.searchParams.get("code");
      const authError = callback.searchParams.get("error");
      if (!code) throw new Error(authError || "No authorization code was returned");
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: flow.clientId,
        redirect_uri: flow.redirectUri,
        code_verifier: flow.codeVerifier,
        resource: this.options.resource,
      });
      const tokenResponse = await this.fetchImpl(`${this.issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!tokenResponse.ok) throw new Error(`Token exchange failed (HTTP ${tokenResponse.status})`);
      await this.acceptTokens(await tokenResponse.json(), flow.clientId);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(doneHtml(true, "You can close this tab and return to Codex."));
      this.log("[labee-auth] connected to Labee");
    } catch (error) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(doneHtml(false, error instanceof Error ? error.message : String(error)));
      this.log(`[labee-auth] authorization failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTimeout(() => this.closePending(), 100).unref();
    }
  }

  private async acceptTokens(raw: unknown, clientId: string): Promise<void> {
    const value = raw as {
      access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; scope?: unknown;
    };
    if (
      typeof value.access_token !== "string" || typeof value.refresh_token !== "string" ||
      typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in)
    ) throw new Error("Labee returned a malformed OAuth token response");
    this.session = {
      accessToken: value.access_token,
      clientId,
      expiresAt: Date.now() + Math.max(1, value.expires_in) * 1000,
      issuer: this.issuer,
      refreshToken: value.refresh_token,
      resource: this.options.resource,
      scope: typeof value.scope === "string" ? value.scope : "protocols:search",
    };
    try {
      saveSession(this.authFile, this.session);
    } catch (error) {
      this.log(`[labee-auth] could not persist credentials: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private closePending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.server.close();
    this.pending = null;
  }
}

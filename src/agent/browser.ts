import { looksLikeBotWall } from "../extract.ts";
import type {
  BrowserAdapter,
  BrowserEvidence,
  BrowserRequest,
  BrowserSearchEvidence,
  BrowserSearchRequest,
} from "./types.ts";
import {
  assertLoopbackCdpEndpoint,
  assertLoopbackCdpWebSocketEndpoint,
  assertSafePublicUrl,
} from "./url-policy.ts";

const MAX_BROWSER_TEXT = 80_000;
const ACCESS_WALL_RE = /sign in to (?:view|access|continue)|institutional access|purchase (?:this )?article|subscribe to (?:read|access)|log in through your institution/i;

/** Require multiple independent signals before browser DOM counts as protocol content. */
export function looksLikeProtocolEvidence(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 800 || ACCESS_WALL_RE.test(normalized.slice(0, 3_000))) return false;
  const signals = [
    /\b(?:protocol|materials and methods|procedure|step\s*\d+)\b/i,
    /\b(?:add|mix|incubate|centrifuge|wash|resuspend|pipette|amplif(?:y|ication))\b/i,
    /\b\d+(?:\.\d+)?\s*(?:µl|μl|ul|ml|µg|μg|mg|°c|rpm|×?\s*g|min(?:ute)?s?|hours?)\b/i,
  ].filter((pattern) => pattern.test(normalized)).length;
  return signals >= 2;
}
const MAX_DISCOVERY_BYTES = 64 * 1024;

type ConnectOverCdp = (endpoint: string) => Promise<import("playwright-core").Browser>;

function evidence(
  status: BrowserEvidence["status"],
  detail?: string,
  extra: Partial<BrowserEvidence> = {},
): BrowserEvidence {
  return {
    status,
    ...(detail ? { detail } : {}),
    ...extra,
    provenance: extra.provenance ?? { adapter: "playwright-cdp", route: "publisher-dom" },
  };
}

export class CdpBrowserAdapter implements BrowserAdapter {
  readonly id = "playwright-cdp";
  readonly attemptRoute = "browser-cdp" as const;
  private readonly endpoint: URL;
  private readonly connectOverCdp: ConnectOverCdp | undefined;
  private browser: import("playwright-core").Browser | undefined;
  private verifiedWebSocketEndpoint: string | undefined;

  constructor(
    endpoint = process.env.PROTOCOLS_BROWSER_CDP_URL ?? "http://127.0.0.1:9222",
    connectOverCdp?: ConnectOverCdp,
    private readonly ownsBrowser = false,
  ) {
    this.endpoint = assertLoopbackCdpEndpoint(endpoint);
    this.connectOverCdp = connectOverCdp;
  }

  async available(): Promise<{ available: boolean; reason?: string }> {
    this.verifiedWebSocketEndpoint = undefined;
    try {
      const probe = new URL("/json/version", this.endpoint);
      const res = await fetch(probe, {
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return { available: false, reason: `CDP probe returned HTTP ${res.status}` };
      const raw = await res.text();
      if (Buffer.byteLength(raw) > MAX_DISCOVERY_BYTES) {
        return { available: false, reason: "CDP discovery response exceeded 64 KiB" };
      }
      const parsed = JSON.parse(raw) as { webSocketDebuggerUrl?: unknown };
      if (typeof parsed.webSocketDebuggerUrl !== "string") {
        return { available: false, reason: "CDP discovery response omitted webSocketDebuggerUrl" };
      }
      this.verifiedWebSocketEndpoint = assertLoopbackCdpWebSocketEndpoint(
        parsed.webSocketDebuggerUrl,
        this.endpoint,
      ).toString();
      return { available: true };
    } catch (err) {
      return { available: false, reason: err instanceof Error ? err.message : "CDP unavailable" };
    }
  }

  private async connectedBrowser(): Promise<{ browser?: import("playwright-core").Browser; reason?: string }> {
    if (this.browser?.isConnected()) return { browser: this.browser };
    if (!this.verifiedWebSocketEndpoint) return { reason: "CDP websocket was not verified" };
    try {
      const connect = this.connectOverCdp ?? (async (endpoint: string) => {
        const { chromium } = await import("playwright-core");
        return chromium.connectOverCDP(endpoint, {
          timeout: 5_000,
          isLocal: true,
          noDefaults: true,
        });
      });
      this.browser = await connect(this.verifiedWebSocketEndpoint);
      return { browser: this.browser };
    } catch (err) {
      this.browser = undefined;
      return { reason: err instanceof Error ? err.message : "CDP connection unavailable" };
    }
  }

  async retrieve(request: BrowserRequest): Promise<BrowserEvidence> {
    try {
      await assertSafePublicUrl(request.url, request.allowedHosts);
    } catch (err) {
      return evidence("unsafe-url", err instanceof Error ? err.message : "unsafe URL");
    }

    const state = await this.available();
    if (!state.available) return evidence("unavailable", state.reason);

    const connected = await this.connectedBrowser();
    if (!connected.browser) return evidence("unavailable", connected.reason);

    let page: import("playwright-core").Page | undefined;
    let keepPage = false;
    try {
      const context = connected.browser.contexts()[0];
      if (!context) return evidence("unavailable", "CDP browser has no context");
      page = await context.newPage();
      page.on("popup", (popup) => void popup.close());
      page.on("download", (download) => void download.cancel());
      await page.route("**/*", async (route) => {
        const req = route.request();
        if (!this.ownsBrowser && ["image", "media", "font", "websocket"].includes(req.resourceType())) {
          await route.abort("blockedbyclient");
          return;
        }
        try {
          const policyUrl = req.url().replace(/^wss:/i, "https:");
          await assertSafePublicUrl(policyUrl, request.allowedHosts);
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      const response = await page.goto(request.url, {
        waitUntil: "domcontentloaded",
        timeout: request.timeoutMs,
      });
      if (!response || response.status() === 404) return evidence("not-found", "browser navigation returned 404");
      await assertSafePublicUrl(page.url(), request.allowedHosts);
      const readContent = async (): Promise<{ text: string; html: string }> => {
        let fallback = { text: "", html: "" };
        for (const selector of ["article", "main", "body"]) {
          const locator = page!.locator(selector).first();
          const text = (await locator.innerText({ timeout: 2_000 }).catch(() => "")).trim();
          const html = text
            ? (await locator.innerHTML({ timeout: 2_000 }).catch(() => "")).trim()
            : "";
          if (text.length > fallback.text.length) fallback = { text, html };
          if (text.length >= 200) {
            return { text, html };
          }
        }
        return fallback;
      };
      const challengePresent = async (text: string): Promise<boolean> => {
        if (looksLikeBotWall(text)) return true;
        const title = await page!.title().catch(() => "");
        if (/just a moment|security verification|verify (?:you are|that you are) human/i.test(title)) return true;
        return (await page!.locator(
          'iframe[src*="challenges.cloudflare.com"], #challenge-running, #challenge-stage, .cf-challenge',
        ).count().catch(() => 0)) > 0;
      };
      let { text, html } = await readContent();
      const responseStatus = response.status();
      const startedOnBotWall = await challengePresent(text);
      if (startedOnBotWall && (request.interactionTimeoutMs ?? 0) > 0) {
        const deadline = Date.now() + request.interactionTimeoutMs!;
        while (Date.now() < deadline && await challengePresent(text)) {
          if (request.signal?.aborted) return evidence("timeout", "browser request cancelled");
          await page.waitForTimeout(Math.min(1_000, Math.max(1, deadline - Date.now())));
          ({ text, html } = await readContent());
        }
      }
      if (!text) {
        return evidence("blocked", responseStatus >= 400
          ? `browser navigation returned HTTP ${responseStatus}`
          : "page is empty");
      }
      if (await challengePresent(text)) {
        keepPage = true;
        return evidence("interaction-required", "complete the visible browser verification, then retry", {
          finalUrl: page.url(),
          title: await page.title(),
        });
      }
      // A challenge may initially return 403 and then navigate in-place after
      // the user completes it. In that case the current protocol DOM, not the
      // stale response object from page.goto, is authoritative.
      if (responseStatus >= 400 && !startedOnBotWall) {
        return evidence("blocked", `browser navigation returned HTTP ${responseStatus}`);
      }
      if (!looksLikeProtocolEvidence(text)) {
        return evidence("not-found", "page did not contain enough procedural evidence");
      }
      const links = await page.locator("a[href]").evaluateAll((anchors) =>
        anchors
          .map((anchor) => (anchor as HTMLAnchorElement).href)
          .filter((href) => /^https?:\/\//i.test(href))
          .slice(0, 100),
      ).catch(() => [] as string[]);
      const maxChars = Math.min(request.maxChars, MAX_BROWSER_TEXT);
      const bounded = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n…[truncated]` : text;
      const boundedHtml = html.length > maxChars ? `${html.slice(0, maxChars)}\n<!-- truncated -->` : html;
      return evidence("ok", undefined, {
        finalUrl: page.url(),
        title: await page.title(),
        text: bounded,
        ...(boundedHtml ? { html: boundedHtml } : {}),
        links: [...new Set(links)],
        format: "dom",
        provenance: { adapter: this.id, route: "publisher-dom", capturedUrl: page.url() },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "browser retrieval failed";
      return evidence(/timeout/i.test(message) ? "timeout" : "blocked", message);
    } finally {
      if (!keepPage) await page?.close().catch(() => undefined);
      // Do not close a CDP-attached browser: the endpoint belongs to the operator.
    }
  }

  async search(request: BrowserSearchRequest): Promise<BrowserSearchEvidence> {
    const provenance = { adapter: this.id, route: "semanticscholar-json-xhr" };
    const state = await this.available();
    if (!state.available) {
      return { status: "unavailable", results: [], ...(state.reason ? { detail: state.reason } : {}), provenance };
    }
    const connected = await this.connectedBrowser();
    if (!connected.browser) {
      return {
        status: "unavailable",
        results: [],
        ...(connected.reason ? { detail: connected.reason } : {}),
        provenance,
      };
    }
    let page: import("playwright-core").Page | undefined;
    try {
      const context = connected.browser.contexts()[0];
      if (!context) return { status: "unavailable", results: [], detail: "CDP browser has no context", provenance };
      page = await context.newPage();
      await page.route("**/*", async (route) => {
        const req = route.request();
        if (["image", "media", "font", "websocket"].includes(req.resourceType())) {
          await route.abort("blockedbyclient");
          return;
        }
        try {
          const url = new URL(req.url());
          if (url.protocol !== "https:" || !(url.hostname === "semanticscholar.org" || url.hostname.endsWith(".semanticscholar.org"))) {
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      const xhr = page.waitForResponse(
        (res) => res.url() === "https://www.semanticscholar.org/api/1/search" && res.request().method() === "POST",
        { timeout: request.timeoutMs },
      );
      const searchUrl = `https://www.semanticscholar.org/search?q=${encodeURIComponent(`${request.query} ${request.venue}`)}&sort=relevance`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: request.timeoutMs });
      const response = await xhr;
      if (response.status() !== 200) {
        return { status: response.status() === 403 ? "blocked" : "not-found", results: [], detail: `XHR HTTP ${response.status()}`, provenance };
      }
      const body = await response.body();
      if (body.length > 2 * 1024 * 1024) return { status: "blocked", results: [], detail: "XHR response exceeded 2 MiB", provenance };
      const payload = JSON.parse(body.toString("utf8")) as {
        results?: Array<{
          id?: string;
          slug?: string;
          title?: { text?: string };
          venue?: { text?: string };
          doiInfo?: { doiUrl?: string };
          primaryPaperLink?: { url?: string };
          paperAbstract?: { text?: string };
          tldr?: { text?: string };
        }>;
      };
      const venue = request.venue.trim().toLowerCase();
      const results = (payload.results ?? [])
        .filter((row) => (row.venue?.text ?? "").trim().toLowerCase() === venue)
        .map((row) => {
          const title = row.title?.text?.trim() ?? "";
          const fallback = row.id && row.slug
            ? `https://www.semanticscholar.org/paper/${encodeURIComponent(row.slug)}/${row.id}`
            : "";
          const url = row.doiInfo?.doiUrl ?? row.primaryPaperLink?.url ?? fallback;
          const snippet = row.paperAbstract?.text ?? row.tldr?.text ?? "";
          return { title, url, snippet };
        })
        .filter((row) => row.title && row.url)
        .slice(0, request.limit);
      return {
        status: results.length > 0 ? "ok" : "not-found",
        results,
        provenance: { ...provenance, capturedUrl: response.url() },
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Semantic Scholar browser search failed";
      return { status: /timeout/i.test(detail) ? "timeout" : "blocked", results: [], detail, provenance };
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.ownsBrowser) {
      if (!this.browser?.isConnected()) {
        const state = await this.available();
        if (state.available) await this.connectedBrowser();
      }
      await this.browser?.close().catch(() => undefined);
    }
    // Operator-owned CDP sessions are only forgotten; owned sessions opt in
    // to Browser.close through `ownsBrowser`.
    this.browser = undefined;
    this.verifiedWebSocketEndpoint = undefined;
  }
}

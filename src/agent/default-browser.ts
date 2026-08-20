import { execFile } from "node:child_process";
import { looksLikeBotWall } from "../extract.ts";
import { CdpBrowserAdapter } from "./browser.ts";
import type { BrowserAdapter, BrowserEvidence, BrowserRequest } from "./types.ts";
import { assertSafePublicUrl } from "./url-policy.ts";

export type DefaultBrowserState =
  | "stopped"
  | "starting"
  | "ready"
  | "interaction-required"
  | "permission-required"
  | "error";

export interface DefaultBrowserStatus {
  state: DefaultBrowserState;
  profile: "default";
  windowId?: number;
  detail?: string;
}

type RunAppleScript = (script: string) => Promise<string>;

export interface DefaultBrowserOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  interactionTimeoutMs?: number;
  runAppleScript?: RunAppleScript;
  sleepImpl?: (ms: number) => Promise<void>;
}

interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  html: string;
  links: string[];
  readyState: string;
}

const MAX_BROWSER_TEXT = 80_000;
const APPLE_EVENTS_PERMISSION =
  "In Chrome, enable View > Developer > Allow JavaScript from Apple Events, then retry.";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function appleString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function defaultAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

function isJavaScriptPermissionError(error: unknown): boolean {
  return /javascript through applescript is turned off|allow javascript from apple events/i.test(String(error));
}

function pageScript(): string {
  return `(() => { const body = document.body; const text = (body?.innerText || "").trim(); const html = body?.innerHTML || ""; const links = Array.from(document.querySelectorAll("a[href]"), a => a.href).filter(h => /^https?:\\/\\//i.test(h)).slice(0, 100); return JSON.stringify({ url: location.href, title: document.title, text, html, links, readyState: document.readyState }); })()`;
}

function browserEvidence(
  status: BrowserEvidence["status"],
  detail?: string,
  extra: Partial<BrowserEvidence> = {},
): BrowserEvidence {
  return {
    status,
    ...(detail ? { detail } : {}),
    ...extra,
    provenance: extra.provenance ?? { adapter: "chrome-default-applescript", route: "default-profile-dom" },
  };
}

/**
 * Drives one Labee-owned window in the user's ordinary Chrome profile.
 * Existing windows and tabs are never enumerated, inspected, or closed.
 */
export class DefaultBrowserAdapter implements BrowserAdapter {
  readonly id = "chrome-default-applescript";
  readonly attemptRoute = "browser-default" as const;

  private readonly platform: NodeJS.Platform;
  private readonly interactionTimeoutMs: number;
  private readonly runAppleScript: RunAppleScript;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private state: DefaultBrowserState = "stopped";
  private detail: string | undefined;
  private windowId: number | undefined;
  private launchPromise: Promise<DefaultBrowserStatus> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, BrowserEvidence>();

  constructor(options: DefaultBrowserOptions = {}) {
    this.platform = options.platform ?? process.platform;
    const configuredInteractionTimeout = Number((options.env ?? process.env).PROTOCOLS_BROWSER_INTERACTION_TIMEOUT_MS);
    this.interactionTimeoutMs = options.interactionTimeoutMs ?? (
      Number.isFinite(configuredInteractionTimeout) && configuredInteractionTimeout >= 0
        ? Math.min(configuredInteractionTimeout, 120_000)
        : 20_000
    );
    this.runAppleScript = options.runAppleScript ?? defaultAppleScript;
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  status(): DefaultBrowserStatus {
    return {
      state: this.state,
      profile: "default",
      ...(this.windowId !== undefined ? { windowId: this.windowId } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }

  private script(body: string): Promise<string> {
    return this.runAppleScript(`tell application "Google Chrome"\n${body}\nend tell`);
  }

  private async windowExists(): Promise<boolean> {
    if (this.windowId === undefined) return false;
    try {
      return (await this.script(`return exists window id ${this.windowId}`)).trim() === "true";
    } catch {
      return false;
    }
  }

  private async createWindow(): Promise<number> {
    const raw = await this.script("set labeeWindow to make new window\nreturn id of labeeWindow");
    const id = Number(raw.trim());
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Chrome did not return a valid window id");
    return id;
  }

  private async executeJavaScript(javascript: string): Promise<string> {
    if (this.windowId === undefined) throw new Error("Labee Chrome window is not open");
    return this.script(
      `return execute active tab of window id ${this.windowId} javascript ${appleString(javascript)}`,
    );
  }

  async launch(): Promise<DefaultBrowserStatus> {
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this.launchOnce().finally(() => {
      this.launchPromise = undefined;
    });
    return this.launchPromise;
  }

  private async launchOnce(): Promise<DefaultBrowserStatus> {
    if (this.platform !== "darwin") {
      this.state = "error";
      this.detail = "default-profile mode currently requires macOS and Google Chrome";
      return this.status();
    }
    this.state = "starting";
    this.detail = undefined;
    try {
      if (!await this.windowExists()) this.windowId = await this.createWindow();
      await this.executeJavaScript("document.title");
      this.state = "ready";
    } catch (error) {
      if (isJavaScriptPermissionError(error)) {
        this.state = "permission-required";
        this.detail = APPLE_EVENTS_PERMISSION;
      } else {
        this.state = "error";
        this.detail = error instanceof Error ? error.message : "could not open the default Chrome profile";
      }
    }
    return this.status();
  }

  async available(): Promise<{ available: boolean; reason?: string }> {
    const status = await this.launch();
    return status.state === "ready" || status.state === "interaction-required"
      ? { available: true }
      : { available: false, ...(status.detail ? { reason: status.detail } : {}) };
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private cacheKey(url: string): string {
    try {
      return new URL(url).toString();
    } catch {
      return url;
    }
  }

  private async snapshot(): Promise<PageSnapshot> {
    const raw = await this.executeJavaScript(pageScript());
    const parsed = JSON.parse(raw) as Partial<PageSnapshot>;
    return {
      url: typeof parsed.url === "string" ? parsed.url : "",
      title: typeof parsed.title === "string" ? parsed.title : "",
      text: typeof parsed.text === "string" ? parsed.text : "",
      html: typeof parsed.html === "string" ? parsed.html : "",
      links: Array.isArray(parsed.links) ? parsed.links.filter((link): link is string => typeof link === "string") : [],
      readyState: typeof parsed.readyState === "string" ? parsed.readyState : "",
    };
  }

  private isChallenge(snapshot: PageSnapshot): boolean {
    return looksLikeBotWall(snapshot.text) ||
      /just a moment|security verification|verify (?:you are|that you are) human/i.test(snapshot.title) ||
      /challenges\.cloudflare\.com|challenge-running|challenge-stage|cf-challenge/i.test(snapshot.html);
  }

  async retrieve(request: BrowserRequest): Promise<BrowserEvidence> {
    return this.serialized(async () => {
      try {
        await assertSafePublicUrl(request.url, request.allowedHosts);
      } catch (error) {
        return browserEvidence("unsafe-url", error instanceof Error ? error.message : "unsafe URL");
      }

      const cached = this.cache.get(this.cacheKey(request.url));
      if (cached) {
        return {
          ...cached,
          provenance: { ...cached.provenance, adapter: this.id, route: `${cached.provenance.route}-cache` },
        };
      }

      const available = await this.available();
      if (!available.available || this.windowId === undefined) {
        return browserEvidence("unavailable", available.reason, {
          provenance: { adapter: this.id, route: "default-profile-launch" },
        });
      }

      try {
        const previousUrl = await this.script(`return URL of active tab of window id ${this.windowId}`)
          .catch(() => "");
        await this.script(`set URL of active tab of window id ${this.windowId} to ${appleString(request.url)}`);
        const navigationDeadline = Date.now() + request.timeoutMs;
        let snapshot: PageSnapshot | undefined;
        let navigationComplete = false;
        const requestedUrl = new URL(request.url).toString();
        while (Date.now() < navigationDeadline) {
          if (request.signal?.aborted) return browserEvidence("timeout", "browser request cancelled");
          try {
            snapshot = await this.snapshot();
          } catch (error) {
            if (isJavaScriptPermissionError(error)) throw error;
            await this.sleepImpl(250);
            continue;
          }
          const navigationObserved = snapshot.url === requestedUrl || snapshot.url !== previousUrl;
          let snapshotUrl: URL | undefined;
          try {
            snapshotUrl = new URL(snapshot.url);
          } catch {
            // Chrome may expose an empty URL while replacing the current document.
          }
          const isHttpsDocument = snapshotUrl?.protocol === "https:";
          if (
            navigationObserved &&
            isHttpsDocument &&
            (snapshot.readyState === "interactive" || snapshot.readyState === "complete")
          ) {
            // Validate only a real web document. During navigation Chrome can
            // briefly expose chrome-error://chromewebdata/ with readyState
            // "complete" before the requested HTTPS page replaces it.
            try {
              await assertSafePublicUrl(snapshot.url, request.allowedHosts);
            } catch (error) {
              return browserEvidence("unsafe-url", error instanceof Error ? error.message : "unsafe URL");
            }
            navigationComplete = true;
            break;
          }
          await this.sleepImpl(250);
        }
        if (!snapshot || !navigationComplete) {
          return browserEvidence("timeout", "default-profile browser navigation timed out");
        }

        if (this.isChallenge(snapshot) && (request.interactionTimeoutMs ?? this.interactionTimeoutMs) > 0) {
          this.state = "interaction-required";
          this.detail = "complete the visible browser verification, then retry";
          const deadline = Date.now() + (request.interactionTimeoutMs ?? this.interactionTimeoutMs);
          while (Date.now() < deadline && this.isChallenge(snapshot)) {
            if (request.signal?.aborted) return browserEvidence("timeout", "browser request cancelled");
            await this.sleepImpl(Math.min(1_000, Math.max(1, deadline - Date.now())));
            snapshot = await this.snapshot();
          }
        }
        await assertSafePublicUrl(snapshot.url, request.allowedHosts);
        if (this.isChallenge(snapshot)) {
          return browserEvidence("interaction-required", "complete the visible browser verification, then retry", {
            finalUrl: snapshot.url,
            title: snapshot.title,
          });
        }
        if (!snapshot.text.trim()) return browserEvidence("blocked", "page is empty");
        if (/\b(?:404|page not found|not found)\b/i.test(`${snapshot.title} ${snapshot.text.slice(0, 500)}`)) {
          return browserEvidence("not-found", "browser page reported that the resource was not found");
        }

        const maxChars = Math.min(request.maxChars, MAX_BROWSER_TEXT);
        const text = snapshot.text.length > maxChars
          ? `${snapshot.text.slice(0, maxChars)}\n\n…[truncated]`
          : snapshot.text;
        const html = snapshot.html.length > maxChars
          ? `${snapshot.html.slice(0, maxChars)}\n<!-- truncated -->`
          : snapshot.html;
        const result = browserEvidence("ok", undefined, {
          finalUrl: snapshot.url,
          title: snapshot.title,
          text,
          ...(html ? { html } : {}),
          links: [...new Set(snapshot.links)],
          format: "dom",
          provenance: { adapter: this.id, route: "default-profile-dom", capturedUrl: snapshot.url },
        });
        this.state = "ready";
        this.detail = undefined;
        this.cache.set(this.cacheKey(request.url), result);
        if (snapshot.url) this.cache.set(this.cacheKey(snapshot.url), result);
        return result;
      } catch (error) {
        if (isJavaScriptPermissionError(error)) {
          this.state = "permission-required";
          this.detail = APPLE_EVENTS_PERMISSION;
          return browserEvidence("unavailable", this.detail);
        }
        const message = error instanceof Error ? error.message : "default-profile browser retrieval failed";
        return browserEvidence(/timeout/i.test(message) ? "timeout" : "blocked", message);
      }
    });
  }

  async close(): Promise<void> {
    const id = this.windowId;
    this.windowId = undefined;
    if (id !== undefined) {
      await this.script(`if exists window id ${id} then close window id ${id}`).catch(() => undefined);
    }
    this.state = "stopped";
    this.detail = undefined;
    this.cache.clear();
  }
}

let singleton: DefaultBrowserAdapter | undefined;

export function defaultBrowser(): DefaultBrowserAdapter {
  singleton ??= new DefaultBrowserAdapter();
  return singleton;
}

export async function shutdownDefaultBrowser(): Promise<void> {
  await singleton?.close();
}

export function browserAdapterForMode(
  mode: "auto" | "off" | "cdp" | "default" | undefined,
): BrowserAdapter | undefined {
  if (!mode || mode === "off") return undefined;
  return mode === "default" ? defaultBrowser() : new CdpBrowserAdapter();
}

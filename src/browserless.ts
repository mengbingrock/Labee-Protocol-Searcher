// Remote-browser publisher search and retrieval.
//
// Several sources this server searches serve their pages only to a real
// browser: neb.com answers a plain request with a Cloudflare interstitial,
// emdmillipore.com with an Akamai "Access Denied", and sigmaaldrich.com rejects
// the HTTP/2 fingerprint outright. Those are the sources graded `none` in
// vendors.ts, and until now `fetch` could only hand back their link.
//
// The existing browser adapters (agent/) all need a browser on the machine
// running this server — a loopback CDP endpoint, or macOS Chrome driven by
// Apple Events. Neither works on a headless server or in CI. Browserless is a
// hosted Chrome reachable over HTTPS, so it works with no local Chrome window.
//
// It is the primary route for catalog publisher search and publisher-page
// retrieval. Direct HTTP and external indexes remain fallbacks. It is never
// used for entitled retrieval: entitlement is decided by IP, so a request
// routed through a datacenter would be a different network than the one the
// entitlement verdict describes. See extract.ts.
//
// Which build answers matters, because the two do not serve the same routes.
// Our own fork (github.com/mengbingrock/browserless, which adds the residential
// exit this module can use) serves `/content` and has no `/unblock` at all —
// that is a hosted-browserless.io feature. Posting to the wrong one fails
// silently: a 404 becomes `res.ok === false` becomes null, and the caller sees
// "no result" rather than "misconfigured". So the route is chosen from the
// endpoint, never from whether a residential exit happens to be registered.
//
// Measured behaviour, and it has already drifted once:
//   - 2026-08-28: hosted `/unblock` retrieved neb.com, sigmaaldrich.com and
//     emdmillipore.com; plain `/content` was refused by all three.
//   - 2026-09-17: hosted `/unblock` retrieves only neb.com. Both Merck sites
//     now answer it with Akamai "Access Denied" from every region tried.
// Re-measure before treating either line as current.

import type { ResidentialSelector } from "./residential.ts";
import { decodeEntities, stripTags } from "./providers/types.ts";

/**
 * Our own deployment, running the fork. Deliberately not a hosted
 * browserless.io region: that service is a different codebase without the
 * residential exit, and defaulting to it would silently send traffic to a
 * third party that this project does not control.
 */
const DEFAULT_ENDPOINT = "https://browserless.truegrit.dev";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const RESIDENTIAL_RETRY_DELAY_MS = 1_500;
const SEARCH_SELECTOR_TIMEOUT_MS = 5_000;

export interface BrowserlessConfig {
  endpoint: string;
  token: string;
  timeoutMs: number;
}

export interface BrowserlessSearchLink {
  href: string;
  text: string;
  snippet: string;
  className?: string;
}

export interface BrowserlessSearchPage {
  title: string;
  url: string;
  bodyText: string;
  links: BrowserlessSearchLink[];
}

export interface BrowserlessSearchInteraction {
  startUrl: string;
  inputSelector?: string;
  submitSelector?: string;
}

interface BrowserlessScrapeAttribute {
  name: string;
  value: string;
}

interface BrowserlessScrapeResult {
  attributes?: BrowserlessScrapeAttribute[];
  text?: string;
}

/**
 * Read the configuration, or null when the fallback is unavailable. An absent
 * token is "not configured", never an error: the whole feature is opt-in, and
 * an install without it must behave exactly as it did before.
 */
export function browserlessConfig(env: NodeJS.ProcessEnv = process.env): BrowserlessConfig | null {
  if (env.PROTOCOLS_BROWSERLESS?.trim().toLowerCase() === "off") return null;
  const token = env.BROWSERLESS_TOKEN?.trim();
  if (!token) return null;
  const endpoint = (env.BROWSERLESS_URL?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const configured = Number(env.BROWSERLESS_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0
    ? Math.min(configured, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  return { endpoint, token, timeoutMs };
}

/**
 * The control endpoint must be HTTPS, or loopback for a self-hosted container.
 * Credentials in the URL are refused: the token belongs in the query string the
 * caller builds, not somewhere it can be logged as part of an origin.
 */
export function assertBrowserlessEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("browserless endpoint is not a valid URL");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("browserless endpoint must use HTTPS unless it is loopback");
  }
  if (url.username || url.password) {
    throw new Error("browserless endpoint credentials are forbidden");
  }
  return url;
}

/**
 * Which codebase answers at this endpoint, and therefore which routes exist.
 *
 * "hosted" is browserless.io's own service: it serves `/unblock`, whose stealth
 * patching is the only thing measured to clear neb.com's Cloudflare challenge.
 * Everything else is treated as our fork, which serves `/content` and can route
 * through a registered residential exit, but has no `/unblock` — verified
 * against github.com/mengbingrock/browserless, whose HTTP routes are exactly
 * content, download, function, json-*, pdf, performance, scrape and screenshot.
 *
 * Host-suffix matching, so a lookalike like `browserless.io.example.com` is
 * treated as self-hosted rather than inheriting the hosted contract.
 */
export function endpointFlavor(endpoint: URL): "hosted" | "self-hosted" {
  const host = endpoint.hostname.toLowerCase().replace(/\.$/, "");
  return host === "browserless.io" || host.endsWith(".browserless.io")
    ? "hosted"
    : "self-hosted";
}

/**
 * Pages whose rendered body is a "not found" notice rather than content.
 *
 * `/unblock` returns the rendered HTML and no HTTP status, so the usual
 * `res.status !== 200` guard is unavailable — a soft 404 arrives looking
 * exactly like a successful retrieval. Observed case: a dead neb.com protocol
 * URL renders 4.7k characters of "We're very sorry, but we cannot find the URL
 * that you have requested", which without this check is reported as content.
 *
 * Kept deliberately narrow, and applied only to the first part of the document:
 * a protocol that discusses HTTP status codes must not be discarded.
 */
const SOFT_NOT_FOUND =
  /we (?:cannot|can(?:'|’)t|could not|are unable to) find the (?:url|page|document)|page not found|404 (?:-|—|:)? ?not found|the requested page (?:could not be found|does not exist)/i;

export function looksLikeSoftNotFound(text: string): boolean {
  return SOFT_NOT_FOUND.test(text.slice(0, 1_200));
}

/**
 * Render `url` in a remote browser and return its HTML, or null on any failure.
 * Never throws: this is a fallback, and a fallback that can fail the call it was
 * meant to rescue is worse than no fallback at all.
 *
 * `doFetch` is the caller's injected fetch, so tests drive this without a token
 * or a network, exactly like every other network path in this codebase.
 *
 * `residential` asks the server to route the render back out through a
 * registered residential exit — see residential.ts. Pass it only when one is
 * actually registered: with no matching agent the server rejects the call, and
 * a fallback that fails is worse than one that calls from a datacenter.
 */
export async function renderWithBrowserless(
  url: string,
  doFetch: typeof fetch,
  cfg: BrowserlessConfig,
  residential?: ResidentialSelector | null,
): Promise<string | null> {
  let endpoint: URL;
  try {
    endpoint = assertBrowserlessEndpoint(cfg.endpoint);
  } catch {
    return null;
  }

  // The route follows the endpoint, not the residential selector. Keying it on
  // the selector meant the first fetch after startup — before registration
  // completed — took the `/unblock` path and 404'd against our own fork, which
  // has no such route.
  const hosted = endpointFlavor(endpoint) === "hosted";
  const params = new URLSearchParams({ token: cfg.token });
  if (!hosted) params.set("timeout", String(MAX_TIMEOUT_MS));
  if (residential && !hosted) {
    params.set("residentialProxy", "true");
    params.set("residentialProxyCountry", residential.country);
    if (residential.region) params.set("residentialProxyRegion", residential.region);
    if (residential.city) params.set("residentialProxyCity", residential.city);
  }

  const route = `${endpoint.origin}${hosted ? "/unblock" : "/content"}?${params.toString()}`;
  const body = JSON.stringify(
    hosted
      ? { url, content: true, browserWSEndpoint: false, cookies: false, screenshot: false }
      : {
          url,
          gotoOptions: { waitUntil: "domcontentloaded", timeout: MAX_TIMEOUT_MS },
          waitForTimeout: DEFAULT_TIMEOUT_MS,
          solveCaptchas: true,
        },
  );

  // A residential render can fail on the server for reasons that clear within
  // a second: the self-hosted build launches a fresh browser per request and
  // tears the previous one down afterwards, and a render that lands during
  // that teardown is refused as ERR_TUNNEL_CONNECTION_FAILED before it ever
  // reaches the target. One retry after a short pause covers it; a datacenter
  // or hosted render has no such window and is not retried.
  const attempts = residential && !hosted ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    // A self-hosted render deliberately waits 30 seconds after navigation, so
    // its client deadline must include that settle window plus navigation.
    const requestTimeout = hosted ? cfg.timeoutMs : Math.max(cfg.timeoutMs, 90_000);
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const res = await doFetch(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, RESIDENTIAL_RETRY_DELAY_MS));
          continue;
        }
        return null;
      }
      const raw = await res.text();
      if (raw.length > MAX_HTML_BYTES) return null;
      // `/content` returns the HTML itself; `/unblock` wraps it in JSON.
      if (!hosted) return raw.trim() ? raw : null;
      const content = (JSON.parse(raw) as { content?: unknown }).content;
      return typeof content === "string" && content.trim() ? content : null;
    } catch {
      // Includes the abort above, a malformed JSON body, and any transport error.
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, RESIDENTIAL_RETRY_DELAY_MS));
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Kept server-side so search can see links populated by JavaScript and links
// inside open shadow roots (IDT), without opening Chrome on the caller's Mac.
const SEARCH_FUNCTION = String.raw`
export default async function ({ page, context }) {
  // Commerce/search pages often keep analytics and chat connections alive, so
  // networkidle2 may never fire. DOMContentLoaded plus the explicit 30-second
  // settle below is deterministic and was the successful live-test shape.
  await page.goto(context.entryUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await new Promise((resolve) => setTimeout(resolve, 5000));

  if (context.interactive) {
    let input = context.inputSelector ? await page.$(context.inputSelector) : null;
    if (!input) {
      const inputs = await page.$$('input');
      for (const candidate of inputs) {
        const meta = await candidate.evaluate((el) => ({
          placeholder: el.getAttribute('placeholder') || '',
          name: el.getAttribute('name') || '',
          aria: el.getAttribute('aria-label') || '',
          type: el.getAttribute('type') || '',
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        }));
        const label = (meta.placeholder + ' ' + meta.name + ' ' + meta.aria).toLowerCase();
        if (meta.visible && meta.type !== 'hidden' && /search|keyword|query|term/.test(label) && !/cookie|vendor/.test(label)) {
          input = candidate;
          break;
        }
      }
    }
    if (!input) throw new Error('publisher search input not found');
    await input.click({ clickCount: 3 });
    await input.type(context.query, { delay: 25 });
    const submit = context.submitSelector ? await page.$(context.submitSelector) : null;
    if (submit) await submit.click(); else await input.press('Enter');
  }

  await new Promise((resolve) => setTimeout(resolve, context.waitMs));
  const data = await page.evaluate((shadowDom) => {
    const links = [];
    const roots = new Set();
    function visit(root) {
      if (!root || roots.has(root)) return;
      roots.add(root);
      for (const anchor of root.querySelectorAll('a[href]')) {
        if (links.length >= 2500) break;
        const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
        const className = typeof anchor.className === 'string' ? anchor.className : '';
        links.push({ href: anchor.href, text, snippet: '', className });
      }
      if (shadowDom) {
        for (const element of root.querySelectorAll('*')) if (element.shadowRoot) visit(element.shadowRoot);
      }
    }
    visit(document);
    return {
      title: document.title,
      url: location.href,
      bodyText: (document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30000),
      links: links.slice(0, 2500),
    };
  }, context.shadowDom);
  return { data, type: 'application/json' };
}`;

function searchPageFromHtml(html: string, requestedUrl: string): BrowserlessSearchPage {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const withoutNoise = html.replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)>/gi, " ");
  const bodyText = decodeEntities(stripTags(withoutNoise)).replace(/\s+/g, " ").trim().slice(0, 30_000);
  const links: BrowserlessSearchLink[] = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) && links.length < 2_500) {
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]!);
    const href = decodeEntities(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "").trim();
    if (!href) continue;
    let absolute: string;
    try {
      absolute = new URL(href, requestedUrl).toString();
    } catch {
      continue;
    }
    const text = decodeEntities(stripTags(match[2]!)).replace(/\s+/g, " ").trim();
    const classMatch = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]!);
    const className = decodeEntities(classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "");
    links.push({ href: absolute, text, snippet: "", ...(className ? { className } : {}) });
  }
  return {
    title: decodeEntities(stripTags(titleMatch?.[1] ?? "")).trim(),
    url: requestedUrl,
    bodyText,
    links,
  };
}

/**
 * Extract live result anchors through the self-hosted `/scrape` route.
 *
 * This is intentionally separate from `/function`: scrape enables the fork's
 * configured public-page challenge solver and stealth launch mode, while still
 * returning structured DOM attributes. NEB's Coveo cards require exactly this
 * combination—the cards are visible in a screenshot but absent from the HTML
 * serialized by `/content`.
 */
export async function scrapeSearchWithBrowserless(
  searchUrl: string,
  selector: string,
  doFetch: typeof fetch,
  cfg: BrowserlessConfig,
  residential?: ResidentialSelector | null,
): Promise<BrowserlessSearchPage | null> {
  let endpoint: URL;
  try {
    endpoint = assertBrowserlessEndpoint(cfg.endpoint);
  } catch {
    return null;
  }
  if (endpointFlavor(endpoint) !== "self-hosted") return null;

  const params = new URLSearchParams({ token: cfg.token, timeout: String(MAX_TIMEOUT_MS) });
  if (residential) {
    params.set("residentialProxy", "true");
    params.set("residentialProxyCountry", residential.country);
    if (residential.region) params.set("residentialProxyRegion", residential.region);
    if (residential.city) params.set("residentialProxyCity", residential.city);
  }

  const body = JSON.stringify({
    url: searchUrl,
    gotoOptions: { waitUntil: "domcontentloaded", timeout: MAX_TIMEOUT_MS },
    waitForTimeout: DEFAULT_TIMEOUT_MS,
    solveCaptchas: true,
    // The page already gets a 30-second settle. A missing selector after that
    // is a failed publisher search, not a reason to hold the datacenter browser
    // for another two minutes before trying the residential route.
    elements: [{ selector, timeout: SEARCH_SELECTOR_TIMEOUT_MS }],
  });
  const attempts = residential ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MAX_TIMEOUT_MS);
    try {
      const response = await doFetch(`${endpoint.origin}/scrape?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, RESIDENTIAL_RETRY_DELAY_MS));
          continue;
        }
        return null;
      }
      const raw = await response.text();
      if (!raw.trim() || raw.length > MAX_HTML_BYTES) return null;
      const parsed = JSON.parse(raw) as {
        data?: Array<{ results?: BrowserlessScrapeResult[]; selector?: string }>;
      };
      const results = parsed.data?.find((row) => row.selector === selector)?.results;
      if (!Array.isArray(results)) return null;

      const links: BrowserlessSearchLink[] = [];
      for (const result of results) {
        const attributes = Array.isArray(result.attributes) ? result.attributes : [];
        const href = attributes.find((attribute) => attribute.name.toLowerCase() === "href")?.value;
        if (!href) continue;
        let absolute: string;
        try {
          absolute = new URL(href, searchUrl).toString();
        } catch {
          continue;
        }
        const className = attributes.find(
          (attribute) => attribute.name.toLowerCase() === "class",
        )?.value;
        links.push({
          href: absolute,
          text: typeof result.text === "string" ? result.text.replace(/\s+/g, " ").trim() : "",
          snippet: "",
          ...(className ? { className } : {}),
        });
      }
      return { title: "", url: searchUrl, bodyText: "", links };
    } catch {
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, RESIDENTIAL_RETRY_DELAY_MS));
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Render a publisher search UI and return its populated links. */
export async function searchWithBrowserless(
  searchUrl: string,
  query: string,
  doFetch: typeof fetch,
  cfg: BrowserlessConfig,
  interaction?: BrowserlessSearchInteraction,
  shadowDom = false,
  residential?: ResidentialSelector | null,
): Promise<BrowserlessSearchPage | null> {
  let endpoint: URL;
  try {
    endpoint = assertBrowserlessEndpoint(cfg.endpoint);
  } catch {
    return null;
  }
  // Hosted browserless.io is not the deployment tested for publisher search;
  // let the normal database fallback handle that configuration.
  if (endpointFlavor(endpoint) !== "self-hosted") return null;

  // The measured successful route for ordinary publisher pages is /content.
  // /function is needed only to submit an interactive form or traverse Shadow
  // DOM; using it everywhere is slower and some commerce pages keep enough
  // background activity to exhaust the function protocol timeout.
  if (!interaction && !shadowDom) {
    const html = await renderWithBrowserless(searchUrl, doFetch, cfg, residential);
    return html ? searchPageFromHtml(html, searchUrl) : null;
  }

  const params = new URLSearchParams({ token: cfg.token, timeout: String(MAX_TIMEOUT_MS) });
  if (residential) {
    params.set("residentialProxy", "true");
    params.set("residentialProxyCountry", residential.country);
    if (residential.region) params.set("residentialProxyRegion", residential.region);
    if (residential.city) params.set("residentialProxyCity", residential.city);
  }
  const context = {
    entryUrl: interaction?.startUrl ?? searchUrl,
    query,
    waitMs: DEFAULT_TIMEOUT_MS,
    interactive: Boolean(interaction),
    shadowDom,
    ...(interaction?.inputSelector ? { inputSelector: interaction.inputSelector } : {}),
    ...(interaction?.submitSelector ? { submitSelector: interaction.submitSelector } : {}),
  };
  const attempts = residential ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MAX_TIMEOUT_MS);
    try {
      const response = await doFetch(`${endpoint.origin}/function?${params.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: SEARCH_FUNCTION, context }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, RESIDENTIAL_RETRY_DELAY_MS));
          continue;
        }
        return null;
      }
      const raw = await response.text();
      if (!raw.trim() || raw.length > MAX_HTML_BYTES) return null;
      const parsed = JSON.parse(raw) as { data?: Partial<BrowserlessSearchPage> };
      const data = parsed.data;
      if (!data || !Array.isArray(data.links)) return null;
      return {
        title: typeof data.title === "string" ? data.title : "",
        url: typeof data.url === "string" ? data.url : searchUrl,
        bodyText: typeof data.bodyText === "string" ? data.bodyText : "",
        links: data.links.filter(
          (link): link is BrowserlessSearchLink =>
            Boolean(link) &&
            typeof link.href === "string" &&
            typeof link.text === "string" &&
            typeof link.snippet === "string" &&
            (link.className === undefined || typeof link.className === "string"),
        ),
      };
    } catch {
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, RESIDENTIAL_RETRY_DELAY_MS));
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

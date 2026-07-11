// Keyless DuckDuckGo provider.
//
// DuckDuckGo exposes two server-rendered (no-JS) endpoints we can parse from a
// plain Node process: lite.duckduckgo.com (most bot-tolerant) and
// html.duckduckgo.com (fallback). Both rate-limit: a flagged IP gets a 202
// CAPTCHA page instead of results. We try lite then html, retrying each with
// jittered backoff and a rotating User-Agent. It's the default keyless
// provider; for rate-limit-free reliability, configure a Brave or Google key.

import {
  type ProviderOptions,
  type ProviderQueryResult,
  type RawResult,
  type WebProvider,
  decodeEntities,
  fetchWithTimeout,
  sleep,
  stripTags,
  userAgent,
} from "./types.ts";

const ENDPOINTS = ["https://lite.duckduckgo.com/lite/", "https://html.duckduckgo.com/html/"];
const DEFAULT_TIMEOUT_MS = 9000;
const MAX_ATTEMPTS_PER_ENDPOINT = 2;

function headers(seed: number): Record<string, string> {
  return {
    "User-Agent": userAgent(seed),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://duckduckgo.com/",
  };
}

/** Pull the real destination out of a DuckDuckGo result href. */
function unwrapHref(href: string): string {
  const decoded = decodeEntities(href);
  const m = decoded.match(/[?&]uddg=([^&]+)/);
  if (m && m[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return "";
    }
  }
  if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
  if (decoded.startsWith("//")) return "https:" + decoded;
  return "";
}

function push(out: RawResult[], seen: Set<string>, r: RawResult, limit: number): void {
  if (out.length >= limit || !r.url || !r.title || seen.has(r.url)) return;
  seen.add(r.url);
  out.push(r);
}

interface Anchor {
  href: string;
  text: string;
  index: number;
}

/** Match every `<a>` whose class contains `cls`, regardless of attribute order. */
function matchAnchors(html: string, cls: string): Anchor[] {
  const re = new RegExp(
    `<a\\b((?:[^>]*?\\bclass="[^"]*\\b${cls}\\b[^"]*"[^>]*?))>([\\s\\S]*?)<\\/a>`,
    "g",
  );
  const out: Anchor[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const hrefMatch = m[1]!.match(/\bhref="([^"]+)"/);
    out.push({ href: hrefMatch ? hrefMatch[1]! : "", text: m[2]!, index: m.index });
  }
  return out;
}

/** Parse the rich html.duckduckgo.com markup. */
export function parseHtmlResults(html: string, limit: number): RawResult[] {
  const out: RawResult[] = [];
  const seen = new Set<string>();
  const snippetRe = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]!));

  let i = 0;
  for (const a of matchAnchors(html, "result__a")) {
    if (out.length >= limit) break;
    const idx = i++;
    push(
      out,
      seen,
      { title: stripTags(a.text), url: unwrapHref(a.href), snippet: snippets[idx] ?? "" },
      limit,
    );
  }
  return out;
}

/** Parse the minimal lite.duckduckgo.com table markup. */
export function parseLiteResults(html: string, limit: number): RawResult[] {
  const out: RawResult[] = [];
  const seen = new Set<string>();
  const snippetRe = /<td\b[^>]*class="[^"]*\bresult-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
  const snippets: { index: number; text: string }[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push({ index: sm.index, text: stripTags(sm[1]!) });
  }
  const snippetAfter = (pos: number): string => {
    for (const s of snippets) if (s.index > pos) return s.text;
    return "";
  };
  for (const a of matchAnchors(html, "result-link")) {
    if (out.length >= limit) break;
    push(
      out,
      seen,
      { title: stripTags(a.text), url: unwrapHref(a.href), snippet: snippetAfter(a.index) },
      limit,
    );
  }
  return out;
}

export const duckduckgoProvider: WebProvider = {
  id: "duckduckgo",
  available: () => true,
  async run(query, limit, opts: ProviderOptions = {}): Promise<ProviderQueryResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const doFetch = opts.fetchImpl ?? fetch;
    let lastStatus = 0;
    let lastError = "";
    let seed = 0;
    for (const endpoint of ENDPOINTS) {
      const isLite = endpoint.includes("/lite");
      const url = `${endpoint}?q=${encodeURIComponent(query)}&kl=us-en`;
      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ENDPOINT; attempt++) {
        if (seed > 0) await sleep(300 * Math.pow(2, attempt) + Math.floor(seed * 53) % 200);
        try {
          const res = await fetchWithTimeout(
            doFetch,
            url,
            { headers: headers(seed++), redirect: "follow" },
            timeoutMs,
          );
          lastStatus = res.status;
          const body = await res.text();
          const results = isLite
            ? parseLiteResults(body, limit)
            : parseHtmlResults(body, limit);
          if (results.length > 0) return { results, status: res.status };
          lastError =
            res.status === 200
              ? "no results (or rate-limited challenge page)"
              : `search returned HTTP ${res.status}`;
        } catch (err) {
          lastError =
            err instanceof Error && err.name === "AbortError"
              ? `search timed out after ${timeoutMs}ms`
              : err instanceof Error
                ? err.message
                : "search failed";
        }
      }
    }
    return { results: [], status: lastStatus, error: lastError };
  },
};

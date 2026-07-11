// Brave Search API provider (optional).
//
// Brave offers a free API tier (https://brave.com/search/api/) that returns
// clean JSON and — unlike scraping — never rate-limits a normal query volume
// or serves CAPTCHAs. Enable it by setting BRAVE_API_KEY (or BRAVE_SEARCH_API_KEY).
// When set, it becomes the primary provider for vendor searches, making every
// vendor reliable.

import {
  type ProviderOptions,
  type ProviderQueryResult,
  type RawResult,
  type WebProvider,
  fetchWithTimeout,
} from "./types.ts";

const DEFAULT_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_TIMEOUT_MS = 9000;

function apiKey(): string | undefined {
  return process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || undefined;
}

/** Endpoint override for self-hosted gateways / enterprise proxies / testing. */
function endpoint(): string {
  return process.env.BRAVE_API_ENDPOINT || DEFAULT_ENDPOINT;
}

interface BraveResponse {
  web?: { results?: { title?: string; url?: string; description?: string }[] };
}

export const braveProvider: WebProvider = {
  id: "brave",
  available: () => Boolean(apiKey()),
  async run(query, limit, opts: ProviderOptions = {}): Promise<ProviderQueryResult> {
    const key = apiKey();
    if (!key) return { results: [], status: 0, error: "BRAVE_API_KEY not set" };
    const doFetch = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url =
      `${endpoint()}?q=${encodeURIComponent(query)}` +
      `&count=${Math.min(20, Math.max(1, limit))}&country=us&search_lang=en`;
    try {
      const res = await fetchWithTimeout(
        doFetch,
        url,
        {
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": key,
          },
        },
        timeoutMs,
      );
      const text = await res.text();
      if (res.status !== 200) {
        return { results: [], status: res.status, error: `Brave API HTTP ${res.status}` };
      }
      let json: BraveResponse;
      try {
        json = JSON.parse(text) as BraveResponse;
      } catch {
        return { results: [], status: res.status, error: "Brave API returned non-JSON" };
      }
      const results: RawResult[] = (json.web?.results ?? [])
        .filter((r) => r.url && r.title)
        .slice(0, limit)
        .map((r) => ({ title: r.title!, url: r.url!, snippet: r.description ?? "" }));
      return results.length > 0
        ? { results, status: res.status }
        : { results: [], status: res.status, error: "Brave API returned no results" };
    } catch (err) {
      const error =
        err instanceof Error && err.name === "AbortError"
          ? `Brave API timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : "Brave API request failed";
      return { results: [], status: 0, error };
    }
  },
};

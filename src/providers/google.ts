// Google Programmable Search Engine (Custom Search JSON API) provider (optional).
//
// Free tier: 100 queries/day (https://developers.google.com/custom-search/v1/overview).
// Enable by setting GOOGLE_API_KEY and GOOGLE_CSE_CX (the search-engine id of a
// Programmable Search Engine configured to "search the entire web"). Returns
// clean JSON with no CAPTCHAs, making vendor searches reliable.

import {
  type ProviderOptions,
  type ProviderQueryResult,
  type RawResult,
  type WebProvider,
  fetchWithTimeout,
} from "./types.ts";

const DEFAULT_ENDPOINT = "https://www.googleapis.com/customsearch/v1";
const DEFAULT_TIMEOUT_MS = 9000;

function creds(): { key: string; cx: string } | undefined {
  const key = process.env.GOOGLE_API_KEY || process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_CSE_ID;
  return key && cx ? { key, cx } : undefined;
}

/** Endpoint override for self-hosted gateways / enterprise proxies / testing. */
function endpoint(): string {
  return process.env.GOOGLE_API_ENDPOINT || DEFAULT_ENDPOINT;
}

interface GoogleResponse {
  items?: { title?: string; link?: string; snippet?: string }[];
  error?: { message?: string };
}

export const googleProvider: WebProvider = {
  id: "google",
  available: () => Boolean(creds()),
  async run(query, limit, opts: ProviderOptions = {}): Promise<ProviderQueryResult> {
    const c = creds();
    if (!c) return { results: [], status: 0, error: "GOOGLE_API_KEY/GOOGLE_CSE_CX not set" };
    const doFetch = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url =
      `${endpoint()}?key=${encodeURIComponent(c.key)}&cx=${encodeURIComponent(c.cx)}` +
      `&q=${encodeURIComponent(query)}&num=${Math.min(10, Math.max(1, limit))}`;
    try {
      const res = await fetchWithTimeout(doFetch, url, { headers: { Accept: "application/json" } }, timeoutMs);
      const text = await res.text();
      let json: GoogleResponse;
      try {
        json = JSON.parse(text) as GoogleResponse;
      } catch {
        return { results: [], status: res.status, error: "Google API returned non-JSON" };
      }
      if (res.status !== 200) {
        return {
          results: [],
          status: res.status,
          error: json.error?.message ?? `Google API HTTP ${res.status}`,
        };
      }
      const results: RawResult[] = (json.items ?? [])
        .filter((r) => r.link && r.title)
        .slice(0, limit)
        .map((r) => ({ title: r.title!, url: r.link!, snippet: r.snippet ?? "" }));
      return results.length > 0
        ? { results, status: res.status }
        : { results: [], status: res.status, error: "Google API returned no results" };
    } catch (err) {
      const error =
        err instanceof Error && err.name === "AbortError"
          ? `Google API timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : "Google API request failed";
      return { results: [], status: 0, error };
    }
  },
};

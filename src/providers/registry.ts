// Selects which web-search providers are active, in priority order. Both are
// keyed APIs; an operator can pin a single one with
// PROTOCOLS_SEARCH_PROVIDER=brave|google.
//
// There is deliberately no keyless fallback. A DuckDuckGo scraper used to hold
// that slot, but it answered every request with HTTP 202 and a CAPTCHA for
// months — so an unkeyed install got silence dressed up as a working chain.
// Vendor search now requires a key, and says so when it has none.

import type { ProviderOptions, RawResult, WebProvider } from "./types.ts";
import { braveProvider } from "./brave.ts";
import { googleProvider } from "./google.ts";

const ALL: WebProvider[] = [braveProvider, googleProvider];

/** Shown wherever an unkeyed install would otherwise just report "no results". */
export const NO_PROVIDER_CONFIGURED =
  "no web-search provider is configured — set BRAVE_API_KEY, or GOOGLE_API_KEY with GOOGLE_CSE_CX";

/** The active providers, highest priority first. */
export function activeProviders(): WebProvider[] {
  const pin = process.env.PROTOCOLS_SEARCH_PROVIDER?.trim().toLowerCase();
  if (pin) {
    const chosen = ALL.find((p) => p.id === pin);
    if (chosen) return [chosen];
  }
  // Keyed providers only when configured — with no key, the set is empty.
  return ALL.filter((p) => p.available());
}

/** Ids of every known provider and whether each is currently usable. */
export function providerStatus(): { id: string; available: boolean }[] {
  return ALL.map((p) => ({ id: p.id, available: p.available() }));
}

export interface WebSearchOutcome {
  results: RawResult[];
  /** Ids of providers that produced results, joined in priority order. */
  provider: string;
  providers: WebProviderOutcome[];
  error?: string;
}

export interface WebProviderOutcome {
  id: string;
  status: "ok" | "empty" | "error" | "unavailable";
  count: number;
  elapsedMs: number;
  error?: string;
}

function resultKey(result: RawResult): string {
  try {
    const url = new URL(result.url);
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return `${result.title.toLowerCase()}|${result.url.toLowerCase()}`;
  }
}

/**
 * Run `query` through every active provider, merging unique results and
 * retaining per-backend coverage. Explicit provider pinning still limits the set.
 */
export async function webSearch(
  query: string,
  limit: number,
  opts?: ProviderOptions,
): Promise<WebSearchOutcome> {
  const providers = activeProviders();
  const attempts: WebProviderOutcome[] = [];
  const errors: string[] = [];
  const merged = new Map<string, RawResult>();
  // Without a key there is nothing to try. Say why, rather than returning an
  // empty list the caller would report as "the vendor had no results".
  if (providers.length === 0) {
    return {
      results: [],
      provider: "none",
      providers: ALL.map((p) => ({ id: p.id, status: "unavailable" as const, count: 0, elapsedMs: 0 })),
      error: NO_PROVIDER_CONFIGURED,
    };
  }
  const pin = process.env.PROTOCOLS_SEARCH_PROVIDER?.trim().toLowerCase();
  if (!pin) {
    for (const provider of ALL) {
      if (!provider.available()) attempts.push({ id: provider.id, status: "unavailable", count: 0, elapsedMs: 0 });
    }
  }
  for (const provider of providers) {
    const started = Date.now();
    try {
      const res = await provider.run(query, limit, opts);
      const status = res.results.length > 0 ? "ok" : res.error ? "error" : "empty";
      attempts.push({
        id: provider.id, status, count: res.results.length, elapsedMs: Date.now() - started,
        ...(res.error ? { error: res.error } : {}),
      });
      if (res.results.length === 0) errors.push(`${provider.id}: ${res.error ?? "no results"}`);
      for (const result of res.results) {
        const key = resultKey(result);
        const current = merged.get(key);
        if (!current) merged.set(key, result);
        else if (!current.snippet && result.snippet) merged.set(key, { ...current, snippet: result.snippet });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed";
      errors.push(`${provider.id}: ${message}`);
      attempts.push({ id: provider.id, status: "error", count: 0, elapsedMs: Date.now() - started, error: message });
    }
  }
  const successful = attempts.filter((attempt) => attempt.status === "ok").map((attempt) => attempt.id);
  return {
    results: [...merged.values()],
    provider: successful.join("+") || providers.at(-1)?.id || "none",
    providers: attempts,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

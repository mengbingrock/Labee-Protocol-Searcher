// Selects which web-search providers are active, in priority order. Keyed APIs
// (Brave, Google) come first because they're reliable and never CAPTCHA;
// keyless DuckDuckGo is always present as the final fallback. An operator can
// pin a single provider with PROTOCOLS_SEARCH_PROVIDER=brave|google|duckduckgo.

import type { ProviderOptions, RawResult, WebProvider } from "./types.ts";
import { braveProvider } from "./brave.ts";
import { googleProvider } from "./google.ts";
import { duckduckgoProvider } from "./duckduckgo.ts";

const ALL: WebProvider[] = [braveProvider, googleProvider, duckduckgoProvider];

/** The active providers, highest priority first. */
export function activeProviders(): WebProvider[] {
  const pin = process.env.PROTOCOLS_SEARCH_PROVIDER?.trim().toLowerCase();
  if (pin) {
    const chosen = ALL.find((p) => p.id === pin);
    if (chosen) return [chosen];
  }
  // Keyed providers only when configured; DuckDuckGo is always available.
  return ALL.filter((p) => p.available());
}

/** Ids of every known provider and whether each is currently usable. */
export function providerStatus(): { id: string; available: boolean }[] {
  return ALL.map((p) => ({ id: p.id, available: p.available() }));
}

export interface WebSearchOutcome {
  results: RawResult[];
  /** Id of the provider that produced the results, or the last one tried. */
  provider: string;
  error?: string;
}

/**
 * Run `query` through the active providers in order, returning the first
 * non-empty result set. Falls through on rate-limits / empty responses.
 */
export async function webSearch(
  query: string,
  limit: number,
  opts?: ProviderOptions,
): Promise<WebSearchOutcome> {
  const providers = activeProviders();
  let lastError = "no search provider available";
  let lastProvider = "none";
  for (const provider of providers) {
    lastProvider = provider.id;
    const res = await provider.run(query, limit, opts);
    if (res.results.length > 0) return { results: res.results, provider: provider.id };
    lastError = res.error ?? "no results";
  }
  return { results: [], provider: lastProvider, error: lastError };
}

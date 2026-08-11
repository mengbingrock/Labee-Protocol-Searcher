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

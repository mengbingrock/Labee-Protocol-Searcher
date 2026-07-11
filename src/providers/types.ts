// A web-search provider runs one already-`site:`-scoped query and returns
// ranked results. Providers are tried in priority order (keyed APIs first,
// then the keyless DuckDuckGo scraper) until one returns results, so a
// rate-limited or unconfigured provider transparently falls through to the
// next. See registry.ts for selection and search.ts for orchestration.

export interface RawResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ProviderQueryResult {
  results: RawResult[];
  /** HTTP status of the last attempt (0 when the request never completed). */
  status: number;
  /** Set when the provider returned nothing / errored. */
  error?: string;
}

export interface ProviderOptions {
  /** Injectable fetch for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export interface WebProvider {
  /** Stable id (e.g. "brave", "google", "duckduckgo"). */
  id: string;
  /** True when this provider is configured and usable (e.g. has its API key). */
  available(): boolean;
  /**
   * Run `query` (which already includes any `site:` operators) and return up
   * to `limit` results. Must never throw — surface failures via `error`.
   */
  run(query: string, limit: number, opts?: ProviderOptions): Promise<ProviderQueryResult>;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

export function userAgent(seed: number): string {
  return USER_AGENTS[Math.abs(seed) % USER_AGENTS.length]!;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** fetch with an AbortController timeout. Resolves the Response or throws. */
export async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP statuses worth retrying: rate-limited and transient server errors.
 *  (NCBI's eutils flap with 500s, so 500 is included.) */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface RetryOptions {
  /** Extra attempts after the first (default 2 → up to 3 total). */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) to ms, capped. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, 30_000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), 30_000);
  return null;
}

/** Exponential backoff with ±25% full jitter. */
function backoffMs(base: number, max: number, attempt: number): number {
  const raw = Math.min(base * 2 ** attempt, max);
  return Math.round(raw * (0.75 + 0.5 * Math.random()));
}

/**
 * `fetchWithTimeout` plus retry-with-backoff on transient failures (HTTP 429 /
 * 5xx and network/timeout errors), honouring `Retry-After`. Retrying the same
 * endpoint on a transient blip avoids needlessly falling through to a
 * lower-priority provider. Non-retryable responses (2xx, 4xx≠429) return
 * immediately. Throws the last error only if every attempt failed to connect.
 */
export async function fetchWithRetry(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retry: RetryOptions = {},
): Promise<Response> {
  const retries = retry.retries ?? 2;
  const base = retry.baseDelayMs ?? 400;
  const max = retry.maxDelayMs ?? 4000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(doFetch, url, init, timeoutMs);
      if (!RETRYABLE_STATUS.has(res.status) || attempt === retries) return res;
      await sleep(retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(base, max, attempt));
    } catch (err) {
      lastErr = err;
      if (attempt === retries) throw err;
      await sleep(backoffMs(base, max, attempt));
    }
  }
  throw lastErr ?? new Error("fetch failed after retries");
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

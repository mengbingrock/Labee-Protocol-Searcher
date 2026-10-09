import { fetchWithTimeout, stripTags, type ProviderOptions, type RawResult } from "./providers/types.ts";
import { effectiveProtocolsIoSearchOptions, protocolsIoAdvancedQuery, protocolsIoSearchUrl, type ProtocolsIoSearchOptions } from "./protocols-io.ts";
import type { ProtocolsIoFacets } from "./protocols-io-refinement.ts";

// This is the website's observed JSON search API, not the documented /api/v3/protocols.
// The latter lacks native facets and currently errors for relevance sorting.
const ENDPOINT = "https://www.protocols.io/api/v1/search";
const DEFAULT_TIMEOUT_MS = 12_000;

export interface ProtocolsIoApiOutcome {
  status: "ok" | "error" | "unavailable";
  results: RawResult[];
  elapsedMs: number;
  protocolsIo?: ProtocolsIoFacets;
  error?: string;
}

export function protocolsIoApiAvailable(): boolean {
  return Boolean(process.env.PROTOCOLS_IO_ACCESS_TOKEN?.trim());
}

export function protocolsIoApiSearchUrl(query: string, options: ProtocolsIoSearchOptions = {}): string {
  const publicUrl = new URL(protocolsIoSearchUrl(query, options)); // validates input
  const effective = effectiveProtocolsIoSearchOptions(options);
  const advanced = effective.mode === "advanced";
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    q: advanced ? protocolsIoAdvancedQuery(query, effective) : query.trim(),
    types: "1", // protocols only; never workspace/user searches
    sort_by: effective.sortBy ?? "relevance",
    sort_dir: effective.order ?? (effective.sortBy === "title" ? "asc" : "desc"),
    page_id: String(effective.page ?? 1), // native API is one-indexed
    // The native UI uses 30 rows per page. limit only truncates the returned rows.
    page_size: "30",
    use_fields_boosters: "true",
    is_advanced: String(advanced),
    ...(!advanced ? { entity_facets: "true" } : {}),
  }).toString();
  if (!advanced) for (const key of ["access", "techniques", "antibodies", "organisms", "cell_lines"]) {
    const value = publicUrl.searchParams.get(key);
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function facets(body: Record<string, unknown>, advanced: boolean): ProtocolsIoFacets {
  const state: ProtocolsIoFacets = {
    totalMatches: count(record(body.pagination)?.total_results),
    facetsAvailable: false,
    availableFacets: {},
  };
  if (advanced) return state;
  const access = record(body.access_facets);
  if (access) {
    state.facetsAvailable = true;
    state.availableFacets.access = { complete: false, options: Object.entries(access).flatMap(([value, data]) =>
      ["open_access", "springer_protocols"].includes(value) ? [{
        value, label: value === "open_access" ? "Open Access" : "Springer Protocols", count: count(record(data)?.count),
      }] : []) };
  }
  const entities = record(body.entity_facets);
  for (const [key, target] of [["techniques", "techniques"], ["antibodies", "antibodies"],
    ["organisms", "organisms"], ["cell_lines", "cellLines"]] as const) {
    const options = entities?.[key];
    if (!Array.isArray(options)) continue;
    state.facetsAvailable = true;
    state.availableFacets[target] = { complete: false, options: options.flatMap(value => {
      const item = record(value);
      const label = typeof item?.label === "string" ? item.label.trim() : "";
      return label ? [{ value: label, label, count: count(item?.count) }] : [];
    }) };
  }
  return state;
}

/** Authenticated public discovery only. Failures retain the exact browser fallback. */
export async function searchProtocolsIoApi(
  query: string, limit: number, options: ProtocolsIoSearchOptions = {}, opts: ProviderOptions = {},
): Promise<ProtocolsIoApiOutcome> {
  const started = Date.now();
  const outcome = (status: ProtocolsIoApiOutcome["status"], error: string): ProtocolsIoApiOutcome => ({
    status, results: [], elapsedMs: Date.now() - started, error,
  });
  const token = process.env.PROTOCOLS_IO_ACCESS_TOKEN?.trim();
  if (!token) return outcome("unavailable", "PROTOCOLS_IO_ACCESS_TOKEN is not configured");
  try {
    const url = protocolsIoApiSearchUrl(query, options);
    await opts.validateUrl?.(url);
    const response = await fetchWithTimeout(opts.fetchImpl ?? fetch, url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      // Never forward the credential to a redirect target or a configurable endpoint.
      redirect: "error",
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (!response.ok) return outcome("error", `protocols.io search API HTTP ${response.status}`);
    const body = record(await response.json());
    if (!body || body.status_code !== 0 || !Array.isArray(body.items)) {
      return outcome("error", "protocols.io search API returned an invalid response");
    }
    const state = facets(body, options.mode === "advanced");
    const page = count(record(body.pagination)?.current_page);
    if (state.totalMatches === null || page !== (options.page ?? 1)) {
      return outcome("error", "protocols.io search API returned invalid pagination");
    }
    const results: RawResult[] = [];
    const seen = new Set<string>();
    for (const value of body.items) {
      const item = record(value);
      // A client token can also access its owner's private data. Do not expose it.
      if (!item || (item.public !== 1 && item.public !== true)) {
        return outcome("error", "protocols.io search API returned a non-public or invalid item");
      }
      const uri = typeof item.version_uri === "string" ? item.version_uri : item.uri;
      const title = typeof item.title === "string" ? stripTags(stripTags(item.title)) : "";
      if (typeof uri !== "string" || !/^[a-z0-9][a-z0-9-]*(?:\/v\d+)?$/i.test(uri) || !title) {
        return outcome("error", "protocols.io search API returned an invalid protocol");
      }
      const url = `https://www.protocols.io/view/${uri}`;
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({ title, url, snippet: typeof item.description === "string" ? stripTags(stripTags(item.description)).slice(0, 500) : "",
        discoveredBy: ["protocols-io-api"] });
    }
    if (state.totalMatches === 0 && results.length > 0) return outcome("error", "protocols.io search API returned inconsistent results");
    if (state.totalMatches > 0 && results.length === 0 && (options.page ?? 1) === 1) {
      return outcome("error", "protocols.io search API returned incomplete results");
    }
    return { status: "ok", results: results.slice(0, limit), protocolsIo: state, elapsedMs: Date.now() - started };
  } catch (error) {
    // Upstream bodies and exception messages may reflect credentials. Report neither.
    return outcome("error", error instanceof Error && error.name === "AbortError"
      ? "protocols.io search API timed out" : "protocols.io search API request failed");
  }
}

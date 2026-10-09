import { randomUUID } from "node:crypto";
import { decodeEntities, stripTags } from "./providers/types.ts";
import { parseProtocolsIoSearchOptions, PROTOCOLS_IO_FACET_KEYS, type ProtocolsIoFacetKey, type ProtocolsIoSearchOptions } from "./protocols-io.ts";

export interface ProtocolsIoFacets {
  totalMatches: number | null;
  facetsAvailable: boolean;
  /** Only rendered options, never claimed to be the complete publisher vocabulary. */
  availableFacets: Partial<Record<ProtocolsIoFacetKey, {
    complete: false;
    options: Array<{ value: string; label: string; count: number | null }>;
  }>>;
}

/** Read publisher-rendered facet counts, not counts calculated from returned rows. */
export function protocolsIoFacetsFromHtml(html: string, url: string): ProtocolsIoFacets {
  const visible = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const text = decodeEntities(stripTags(visible.replace(/</g, " <"))).replace(/\s+/g, " ");
  const total = /\b([\d,]+)\s+results?\s+(?:for|found)\b/i.exec(text);
  const result: ProtocolsIoFacets = {
    totalMatches: total ? Number(total[1]!.replaceAll(",", "")) : /\bNo results? for\b/i.test(text) ? 0 : null,
    facetsAvailable: false,
    availableFacets: {},
  };
  if (new URL(url).searchParams.get("is_advanced") === "1") return result;
  const groups: Record<string, ProtocolsIoFacetKey> = { access: "access", techniques: "techniques", antibodies: "antibodies", organisms: "organisms", cell_lines: "cellLines" };
  for (const input of visible.matchAll(/<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of input[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
    const match = /^checkbox-filter-option-(access|techniques|antibodies|organisms|cell_lines)-/.exec(attrs["data-testid"] ?? "");
    const label = attrs["data-option-label"];
    if (!match || !label) continue;
    const group = groups[match[1]!]!;
    const value = group === "access" ? ({ "Open Access": "open_access", "Springer Protocols": "springer_protocols" } as Record<string, string>)[label] : label;
    if (!value) continue;
    const count = /,\s*([\d,]+)\s*$/.exec(attrs["aria-label"] ?? "");
    const facet = result.availableFacets[group] ??= { complete: false, options: [] };
    if (!facet.options.some(o => o.value === value)) facet.options.push({ value, label, count: count ? Number(count[1]!.replaceAll(",", "")) : null });
    result.facetsAvailable = true;
  }
  return result;
}

interface SavedSearch { query: string; options: ProtocolsIoSearchOptions; limit: number }

/** Opaque capability IDs; bounded, process-local, expiring, and storing no result text. */
export class ProtocolsIoSearchStore {
  private states = new Map<string, SavedSearch & { expires: number }>();
  private now: () => number;
  private ttlMs: number;
  private maxEntries: number;
  constructor(now = Date.now, ttlMs = 30 * 60_000, maxEntries = 256) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = Math.max(1, maxEntries);
  }
  save(state: SavedSearch): { searchId: string; expiresAt: string } {
    for (const [id, s] of this.states) if (s.expires <= this.now()) this.states.delete(id);
    while (this.states.size >= this.maxEntries) this.states.delete(this.states.keys().next().value!);
    const searchId = randomUUID();
    const expires = this.now() + this.ttlMs;
    this.states.set(searchId, { ...structuredClone(state), expires });
    return { searchId, expiresAt: new Date(expires).toISOString() };
  }
  refine(searchId: unknown, patch: unknown): SavedSearch {
    const state = typeof searchId === "string" ? this.states.get(searchId) : undefined;
    if (!state || state.expires <= this.now()) throw new Error("Unknown or expired searchId; run search again (state expires after 30 minutes or server restart)");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("changes must be an object");
    const changes = patch as Record<string, unknown>;
    if (changes.mode !== undefined && changes.mode !== (state.options.mode ?? "simple")) throw new Error("Changing search mode requires a new search; filters are never converted automatically");
    const merged = { ...state.options, ...changes };
    if (Object.keys(changes).some(k => k !== "page") && changes.page === undefined) merged.page = 1;
    const options = parseProtocolsIoSearchOptions(merged) ?? {};
    return { query: state.query, options, limit: state.limit };
  }
}

export function selectedProtocolsIoFilters(options: ProtocolsIoSearchOptions): object {
  return Object.fromEntries(PROTOCOLS_IO_FACET_KEYS.map(key => [key, options[key] ?? []]));
}

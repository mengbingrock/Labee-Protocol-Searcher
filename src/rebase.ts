// Restriction-enzyme lookup backed by REBASE — NEB's own open Restriction
// Enzyme Database. neb.com bot-blocks automated fetches, but REBASE publishes
// the same enzyme facts as a keyless flat file, so we retrieve them from the
// canonical structured source instead of scraping product pages.
//
// We fetch the "withrefm" release file once and parse it into an in-memory
// index. The file uses a tagged, blank-line-agnostic record format (each field
// introduced by a `<n>` tag, references in <8> may wrap across lines):
//
//   <1>EcoRI               enzyme name
//   <2>...                 isoschizomers (same recognition specificity)
//   <3>G^AATTC             recognition site (^ = cut; (a/b) = offset cutters)
//   <4>...                 methylation site / sensitivity
//   <5>Escherichia coli    source microorganism
//   <6>...                 who it was obtained from
//   <7>N                   commercial-supplier codes (N = New England Biolabs)
//   <8>Roberts, R.J., ...  primary references
//
// A legend near the top of the file maps the single-letter <7> codes to
// company names; we parse it so we can say which vendors (incl. NEB) supply an
// enzyme. The parsed index is cached in module memory behind a TTL — REBASE is
// a monthly release, so one fetch serves many lookups.

import { type ProviderOptions, fetchWithRetry } from "./providers/types.ts";

const REBASE_URL = "https://rebase.neb.com/rebase/link_withrefm";
const DEFAULT_TIMEOUT_MS = 15000; // the file is several MB; allow a generous read
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — REBASE ships monthly
const NEB_CODE = "N"; // supplier legend: N = New England Biolabs

export interface EnzymeRecord {
  name: string; // <1>
  isoschizomers: string; // <2>
  site: string; // <3> raw, e.g. "G^AATTC" or "GGTCTC(1/5)"
  methylation: string; // <4>
  organism: string; // <5>
  source: string; // <6>
  suppliers: string; // <7> supplier-code letters, e.g. "N" or "JKN"
}

interface RebaseIndex {
  /** Enzyme name (uppercased) → record. */
  byName: Map<string, EnzymeRecord>;
  /** Normalized recognition site → enzyme names sharing it. */
  bySite: Map<string, string[]>;
  /** Supplier-code letter → company name (from the file's legend). */
  suppliers: Map<string, string>;
}

interface CacheEntry {
  index: RebaseIndex;
  fetchedAt: number;
}
let cache: CacheEntry | null = null;

/** Strip cut markers and offset annotations, leaving bare IUPAC bases. */
export function normalizeSite(site: string): string {
  return site
    .replace(/\([^)]*\)/g, "") // (1/5), (12/17) offset cutters
    .replace(/[\^\s]/g, "") // cut marker + whitespace
    .toUpperCase();
}

/** Parse the supplier legend (letter → company) from the file header. */
function parseSuppliers(text: string): Map<string, string> {
  const out = new Map<string, string>();
  // Legend lines look like: "                N        New England Biolabs (8/24)"
  // Only the block before the first record; stop at the first `<1>`.
  const header = text.split(/\n<1>/, 1)[0] ?? "";
  for (const line of header.split("\n")) {
    const m = /^\s+([A-Z])\s{2,}(\S.*?)\s*(?:\(\d+\/\d+\))?\s*$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/**
 * Parse the withrefm flat file into an index. Records start at `<1>`; each
 * `<n>` tag sets the current field and any following untagged lines append to
 * it (so multi-line <8> references are captured whole).
 */
export function parseRebase(text: string): RebaseIndex {
  const byName = new Map<string, EnzymeRecord>();
  const bySite = new Map<string, string[]>();
  const suppliers = parseSuppliers(text);

  let fields: string[] = [];
  let cur = 0;

  const flush = (): void => {
    const name = (fields[1] ?? "").trim();
    if (!name) return;
    const rec: EnzymeRecord = {
      name,
      isoschizomers: (fields[2] ?? "").trim(),
      site: (fields[3] ?? "").trim(),
      methylation: (fields[4] ?? "").trim(),
      organism: (fields[5] ?? "").trim(),
      source: (fields[6] ?? "").trim(),
      suppliers: (fields[7] ?? "").replace(/\s+/g, "").trim(),
    };
    byName.set(name.toUpperCase(), rec);
    const norm = normalizeSite(rec.site);
    if (norm) {
      const list = bySite.get(norm);
      if (list) list.push(name);
      else bySite.set(norm, [name]);
    }
  };

  for (const line of text.split("\n")) {
    const m = /^<(\d)>(.*)$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (n === 1) {
        flush();
        fields = [];
      }
      cur = n;
      fields[n] = m[2]!;
    } else if (cur > 0 && line.length > 0) {
      // Continuation of the current field (e.g. a wrapped reference).
      fields[cur] = `${fields[cur] ?? ""} ${line.trim()}`;
    }
  }
  flush(); // last record

  return { byName, bySite, suppliers };
}

/** Fetch + parse REBASE, memoised in module memory behind a TTL. */
async function loadIndex(opts: ProviderOptions): Promise<RebaseIndex> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.index;
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await fetchWithRetry(
    doFetch,
    REBASE_URL,
    { headers: { Accept: "text/plain", "User-Agent": "mcp-protocols" } },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (res.status !== 200) throw new Error(`REBASE HTTP ${res.status}`);
  const text = await res.text();
  const index = parseRebase(text);
  cache = { index, fetchedAt: now };
  return index;
}

/** Reset the module cache (tests). */
export function _resetRebaseCache(): void {
  cache = null;
}

const IUPAC = /^[ACGTRYSWKMBDHVN]+$/;

/** Decide whether a query looks like a recognition site vs an enzyme name. */
function looksLikeSite(query: string): boolean {
  const q = query.replace(/\s+/g, "").toUpperCase();
  // Enzyme names carry a trailing Roman numeral (…I/…II/…IV) whose `I` is not
  // an IUPAC base, so any real name fails this test; pure sites pass.
  return q.length >= 3 && IUPAC.test(q);
}

function suppliedBy(rec: EnzymeRecord, suppliers: Map<string, string>): string {
  const codes = rec.suppliers.split("");
  if (codes.length === 0) return "No commercial supplier listed in REBASE.";
  const names = codes.map((c) => suppliers.get(c) ?? `code ${c}`);
  const neb = codes.includes(NEB_CODE);
  return (
    `${neb ? "**Supplied by NEB.** " : "Not listed as an NEB product. "}` +
    `Commercial suppliers: ${names.join(", ")}.`
  );
}

function renderRecord(rec: EnzymeRecord, index: RebaseIndex): string {
  const lines = [
    `# ${rec.name}`,
    "",
    `- **Recognition site / cut:** \`${rec.site || "unknown"}\``,
    `- **Isoschizomers:** ${rec.isoschizomers || "none listed"}`,
    `- **Methylation sensitivity:** ${rec.methylation || "none listed"}`,
    `- **Source organism:** ${rec.organism || "unknown"}`,
    `- ${suppliedBy(rec, index.suppliers)}`,
    "",
    "_Source: REBASE (rebase.neb.com), NEB's open Restriction Enzyme Database._",
  ];
  return lines.join("\n");
}

/** Suggest up to `n` enzyme names containing the query (case-insensitive). */
function suggestNames(index: RebaseIndex, query: string, n = 8): string[] {
  const q = query.toUpperCase();
  const out: string[] = [];
  for (const rec of index.byName.values()) {
    if (rec.name.toUpperCase().includes(q)) {
      out.push(rec.name);
      if (out.length >= n) break;
    }
  }
  return out;
}

export interface EnzymeLookupOptions extends ProviderOptions {
  by?: "name" | "site";
}

/**
 * Look up a restriction enzyme by name (e.g. "EcoRI") or recognition site
 * (e.g. "GAATTC"), returning model-friendly markdown. Auto-detects the mode
 * when `by` is omitted. Never throws for "not found" — returns guidance text.
 */
export async function findRestrictionEnzyme(
  query: string,
  opts: EnzymeLookupOptions = {},
): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return "Error: `query` is required (an enzyme name or recognition site).";
  const index = await loadIndex(opts);
  const by = opts.by ?? (looksLikeSite(trimmed) ? "site" : "name");

  if (by === "site") {
    const norm = normalizeSite(trimmed);
    const names = index.bySite.get(norm);
    if (!names || names.length === 0) {
      return `No REBASE enzymes recognise \`${norm}\`. Sites use IUPAC codes (e.g. GAATTC, GGTCTC).`;
    }
    const header = `# Enzymes recognising \`${norm}\`\n\n${names.length} match${
      names.length === 1 ? "" : "es"
    }: ${names.join(", ")}\n`;
    // Detail the first few, prioritising NEB-supplied enzymes.
    const ranked = names
      .map((nm) => index.byName.get(nm.toUpperCase()))
      .filter((r): r is EnzymeRecord => Boolean(r))
      .sort((a, b) => Number(b.suppliers.includes(NEB_CODE)) - Number(a.suppliers.includes(NEB_CODE)));
    const detail = ranked.slice(0, 3).map((r) => renderRecord(r, index)).join("\n\n---\n\n");
    return `${header}\n${detail}`;
  }

  const rec = index.byName.get(trimmed.toUpperCase());
  if (rec) return renderRecord(rec, index);
  const suggestions = suggestNames(index, trimmed);
  const tail = suggestions.length
    ? ` Did you mean: ${suggestions.join(", ")}?`
    : " No similar enzyme names found in REBASE.";
  return `No REBASE enzyme named "${trimmed}".${tail}`;
}

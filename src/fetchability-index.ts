import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FETCHABILITY_INDEX_SCHEMA_VERSION = 1;

export type ObservedFetchStatus =
  | "ok"
  | "oa-link"
  | "abstract-only"
  | "no-open-fulltext"
  | "not-found"
  | "not-fetchable"
  | "error"
  | "bad-id"
  | "no-status";

export interface DoiFetchabilityObservation {
  status: ObservedFetchStatus;
  checkedAt: string;
  source?: string;
  title?: string;
  retrievalTier?: string;
  discoveredBy?: string[];
}

export interface FetchabilityIndex {
  schemaVersion: 1;
  generatedAt: string;
  dois: Record<string, DoiFetchabilityObservation>;
}

export type Availability =
  | "verified-full-text"
  | "verified-open-link"
  | "verified-abstract-only"
  | "verified-unavailable"
  | "likely-fetchable"
  | "unknown"
  | "unlikely-fetchable";

export interface DoiAvailabilityEvidence {
  availability: Availability;
  confidence: "verified" | "metadata" | "journal-prior";
  journalPrior: "full" | "partial" | "none";
  status?: ObservedFetchStatus;
  checkedAt?: string;
  retrievalTier?: string;
  signals?: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const DEFAULT_LOCAL_PATH = resolve(packageRoot, "fetchability-index.json");
const DEFAULT_REMOTE_URL =
  "https://raw.githubusercontent.com/mengbingrock/Labee-Protocol-Searcher/main/fetchability-index.json";
const DEFAULT_REFRESH_MS = 15 * 60_000;
const DEFAULT_REMOTE_TIMEOUT_MS = 2_500;
const MAX_INDEX_BYTES = 5_000_000;
const MAX_INDEX_ENTRIES = 5_000;

let cached: { index: FetchabilityIndex; loadedAt: number } | undefined;

export function normalizeDoi(value: string): string | undefined {
  let doi = value.trim();
  doi = doi.replace(/^doi:/i, "");
  doi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  try {
    doi = decodeURIComponent(doi);
  } catch {
    // Keep the original text; malformed percent escapes are not a valid DOI,
    // and the shape check below will reject them when appropriate.
  }
  doi = doi.trim().replace(/[\s.,;]+$/, "").toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = [...new Set(value.filter((v): v is string => typeof v === "string" && v.length <= 500))];
  return out.length > 0 ? out : undefined;
}

const STATUSES = new Set<ObservedFetchStatus>([
  "ok",
  "oa-link",
  "abstract-only",
  "no-open-fulltext",
  "not-found",
  "not-fetchable",
  "error",
  "bad-id",
  "no-status",
]);

/** Validate untrusted CI JSON before search uses it to label results. */
export function parseFetchabilityIndex(value: unknown): FetchabilityIndex | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== FETCHABILITY_INDEX_SCHEMA_VERSION) return null;
  if (typeof raw.generatedAt !== "string" || Number.isNaN(Date.parse(raw.generatedAt))) return null;
  if (!raw.dois || typeof raw.dois !== "object" || Array.isArray(raw.dois)) return null;

  const dois: Record<string, DoiFetchabilityObservation> = {};
  const entries = Object.entries(raw.dois as Record<string, unknown>);
  if (entries.length > MAX_INDEX_ENTRIES) return null;
  for (const [key, value] of entries) {
    const doi = normalizeDoi(key);
    if (!doi || !value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (typeof row.status !== "string" || !STATUSES.has(row.status as ObservedFetchStatus)) continue;
    if (typeof row.checkedAt !== "string" || Number.isNaN(Date.parse(row.checkedAt))) continue;
    const observation: DoiFetchabilityObservation = {
      status: row.status as ObservedFetchStatus,
      checkedAt: row.checkedAt,
    };
    if (typeof row.source === "string" && row.source.length <= 100) observation.source = row.source;
    if (typeof row.title === "string" && row.title.length <= 1_000) observation.title = row.title;
    if (typeof row.retrievalTier === "string" && row.retrievalTier.length <= 200) {
      observation.retrievalTier = row.retrievalTier;
    }
    const discoveredBy = stringArray(row.discoveredBy);
    if (discoveredBy) observation.discoveredBy = discoveredBy;
    dois[doi] = observation;
  }
  return { schemaVersion: 1, generatedAt: raw.generatedAt, dois };
}

async function parseResponse(response: Response): Promise<FetchabilityIndex | null> {
  if (!response.ok) return null;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_INDEX_BYTES) return null;
  const body = await response.text();
  if (body.length > MAX_INDEX_BYTES) return null;
  try {
    return parseFetchabilityIndex(JSON.parse(body));
  } catch {
    return null;
  }
}

async function loadRemote(url: string): Promise<FetchabilityIndex | null> {
  if (!/^https:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.PROTOCOLS_FETCHABILITY_INDEX_TIMEOUT_MS) || DEFAULT_REMOTE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), Math.max(250, Math.min(timeoutMs, 10_000)));
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "labee-protocol-searcher/fetchability-index" },
      redirect: "error",
      signal: controller.signal,
    });
    return await parseResponse(response);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadLocal(path: string): Promise<FetchabilityIndex | null> {
  try {
    const body = await readFile(path, "utf8");
    if (body.length > MAX_INDEX_BYTES) return null;
    return parseFetchabilityIndex(JSON.parse(body));
  } catch {
    return null;
  }
}

export interface LoadFetchabilityIndexOptions {
  /** Hermetic callers can disable the remote refresh and use the committed file. */
  allowRemote?: boolean;
  now?: number;
}

/**
 * Load the newest validated CI index. Production checks the raw default-branch
 * copy, then falls back to the committed local snapshot. Results are cached so
 * normal searches do not add one GitHub request per query.
 */
export async function loadFetchabilityIndex(
  options: LoadFetchabilityIndexOptions = {},
): Promise<FetchabilityIndex> {
  const now = options.now ?? Date.now();
  const refreshMs = Number(process.env.PROTOCOLS_FETCHABILITY_INDEX_REFRESH_MS) || DEFAULT_REFRESH_MS;
  if (cached && now - cached.loadedAt < Math.max(1_000, refreshMs)) return cached.index;

  const configuredUrl = process.env.PROTOCOLS_FETCHABILITY_INDEX_URL;
  const remoteDisabled = configuredUrl === "off" || configuredUrl === "none" || configuredUrl === "";
  const remoteUrl = configuredUrl ?? DEFAULT_REMOTE_URL;
  const localPath = process.env.PROTOCOLS_FETCHABILITY_INDEX_PATH || DEFAULT_LOCAL_PATH;
  const [remote, local] = await Promise.all([
    options.allowRemote === false || remoteDisabled ? Promise.resolve(null) : loadRemote(remoteUrl),
    loadLocal(localPath),
  ]);
  const candidates = [remote, local].filter((entry): entry is FetchabilityIndex => Boolean(entry));
  candidates.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  const index: FetchabilityIndex = candidates[0] ?? {
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    dois: {},
  };
  cached = { index, loadedAt: now };
  return index;
}

export function resetFetchabilityIndexCache(): void {
  cached = undefined;
}

function ttlMs(status: ObservedFetchStatus): number {
  const day = 86_400_000;
  if (status === "ok") return 30 * day;
  if (status === "oa-link") return 14 * day;
  if (status === "abstract-only" || status === "no-open-fulltext" || status === "not-found") {
    return 7 * day;
  }
  if (status === "not-fetchable") return 3 * day;
  return day;
}

export function freshDoiObservation(
  index: FetchabilityIndex,
  doi: string,
  now = Date.now(),
): DoiFetchabilityObservation | undefined {
  const normalized = normalizeDoi(doi);
  if (!normalized) return undefined;
  const row = index.dois[normalized];
  if (!row) return undefined;
  const checked = Date.parse(row.checkedAt);
  if (!Number.isFinite(checked) || checked > now + 5 * 60_000 || now - checked > ttlMs(row.status)) {
    return undefined;
  }
  return row;
}

function availabilityForStatus(status: ObservedFetchStatus): Availability {
  if (status === "ok") return "verified-full-text";
  if (status === "oa-link") return "verified-open-link";
  if (status === "abstract-only" || status === "no-open-fulltext") {
    return "verified-abstract-only";
  }
  if (status === "not-found" || status === "not-fetchable" || status === "bad-id") {
    return "verified-unavailable";
  }
  return "unknown";
}

/** Journal prior first; provider signals refine it; fresh DOI evidence wins. */
export function assessDoiAvailability(
  doi: string,
  journalPrior: "full" | "partial" | "none",
  index: FetchabilityIndex,
  oaSignals: readonly string[] = [],
  now = Date.now(),
): DoiAvailabilityEvidence {
  const observation = freshDoiObservation(index, doi, now);
  if (observation && observation.status !== "error" && observation.status !== "no-status") {
    return {
      availability: availabilityForStatus(observation.status),
      confidence: "verified",
      journalPrior,
      status: observation.status,
      checkedAt: observation.checkedAt,
      ...(observation.retrievalTier ? { retrievalTier: observation.retrievalTier } : {}),
    };
  }
  if (oaSignals.length > 0) {
    return {
      availability: "likely-fetchable",
      confidence: "metadata",
      journalPrior,
      signals: [...new Set(oaSignals)],
    };
  }
  return {
    availability:
      journalPrior === "full" ? "likely-fetchable" : journalPrior === "none" ? "unlikely-fetchable" : "unknown",
    confidence: "journal-prior",
    journalPrior,
  };
}

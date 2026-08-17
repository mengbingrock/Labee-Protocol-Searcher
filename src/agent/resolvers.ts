import type { UnifiedResult } from "../search.ts";
import type { AttemptRoute, FetchStatus } from "./types.ts";

const STATUS_RE = /_status:\s*([a-z-]+)_/gi;
const URL_RE = /https?:\/\/[^\s<>()\[\]{}"']+/gi;

export function parseFetchStatus(text: string): FetchStatus {
  let status: FetchStatus = "no-status";
  for (const match of text.matchAll(STATUS_RE)) status = match[1] as FetchStatus;
  return status;
}

export function extractHttpUrls(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0]!.replace(/[.,;:!?]+$/, "");
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") out.add(url.toString());
    } catch {
      // Ignore malformed prose fragments.
    }
  }
  return [...out];
}

export interface ResolutionCandidate {
  url: string;
  route: Exclude<AttemptRoute, "native-fetch" | "browser-cdp">;
}

function bioProtocolId(value: string): string | undefined {
  const match = /(?:bioprotoc(?:ol)?[./_-]?|bpdetail\?id=)(\d{3,})/i.exec(value);
  return match?.[1];
}

export function resolutionCandidates(result: UnifiedResult, fetchedText: string): ResolutionCandidate[] {
  const candidates: ResolutionCandidate[] = [];
  const seen = new Set<string>();
  const add = (url: string, route: ResolutionCandidate["route"]) => {
    try {
      const normalized = new URL(url).toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        candidates.push({ url: normalized, route });
      }
    } catch {
      // Ignore malformed candidates.
    }
  };

  for (const url of extractHttpUrls(fetchedText)) add(url, "oa-link");
  if (result.url) add(result.url, "publisher-url");

  const combined = `${result.id} ${result.url ?? ""} ${fetchedText}`;
  const bpId = bioProtocolId(combined);
  if (bpId) add(`https://bio-protocol.org/pdf/Bio-protocol${bpId}.pdf`, "deterministic-pdf");
  return candidates;
}

export function isVerifiedStatus(status: FetchStatus): boolean {
  return status === "ok" || status === "entitled-full-text" || status === "display-only-full-text";
}

export function verificationFor(status: FetchStatus): "verified" | "partial" | "unresolved" | "blocked" {
  if (isVerifiedStatus(status)) return "verified";
  if (status === "abstract-only" || status === "oa-link" || status === "display-only-link") return "partial";
  if (status === "blocked" || status === "unsafe-url") return "blocked";
  return "unresolved";
}

export function betterStatus(current: FetchStatus, candidate: FetchStatus): FetchStatus {
  const score: Record<FetchStatus, number> = {
    ok: 100,
    "display-only-full-text": 95,
    "entitled-full-text": 90,
    "display-only-link": 75,
    "abstract-only": 80,
    "oa-link": 70,
    "no-open-fulltext": 50,
    "not-fetchable": 40,
    blocked: 30,
    timeout: 20,
    "browser-unavailable": 25,
    "not-found": 20,
    error: 10,
    "bad-id": 5,
    "unsafe-url": 0,
    "no-status": 0,
    empty: 0,
    unavailable: 0,
  };
  return score[candidate] > score[current] ? candidate : current;
}

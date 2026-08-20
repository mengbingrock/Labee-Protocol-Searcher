import type { FetchStatus } from "./types.ts";

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

export function isVerifiedStatus(status: FetchStatus): boolean {
  return status === "ok" || status === "entitled-full-text" || status === "display-only-full-text";
}

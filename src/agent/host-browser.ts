import { randomUUID } from "node:crypto";
import type { UnifiedResponse, UnifiedResult } from "../search.ts";

const TASK_TTL_MS = 10 * 60 * 1_000;
const MAX_CAPTURE_CHARS = 250_000;
const MAX_COMMIT_CHARS = 1_000_000;
const MAX_CACHE_ENTRIES = 100;

export interface HostBrowserSearchTask {
  kind: "neb-search";
  captureId: string;
  query: string;
  limit: number;
  searchUrl: string;
  instructions: string[];
}

export interface HostBrowserCaptureInput {
  title: string;
  url: string;
  finalUrl?: string;
  snippet?: string;
  html?: string;
  text?: string;
}

export interface HostBrowserCommitResult {
  response: UnifiedResponse;
  capturedIds: string[];
  formats: Record<string, "html" | "rendered-text">;
}

interface PendingSearch {
  query: string;
  limit: number;
  searchUrl: string;
  base: UnifiedResponse;
  createdAt: number;
}

interface CachedCapture {
  id: string;
  url: string;
  title: string;
  html?: string;
  text?: string;
  format: "html" | "rendered-text";
  createdAt: number;
}

const pendingSearches = new Map<string, PendingSearch>();
const captureCache = new Map<string, CachedCapture>();

function cleanExpired(now = Date.now()): void {
  for (const [id, pending] of pendingSearches) {
    if (now - pending.createdAt > TASK_TTL_MS) pendingSearches.delete(id);
  }
}

function nebUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("capture URL is invalid");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("capture URL must be credential-free HTTPS");
  }
  if (host !== "neb.com" && !host.endsWith(".neb.com")) {
    throw new Error(`capture URL host ${host || "(empty)"} is not an NEB domain`);
  }
  return url;
}

function boundedString(
  value: unknown,
  field: string,
  required = false,
  preserveWhitespace = false,
): string | undefined {
  if (typeof value !== "string") {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (value.length > MAX_CAPTURE_CHARS) {
    throw new Error(`${field} exceeds ${MAX_CAPTURE_CHARS.toLocaleString()} characters`);
  }
  return preserveWhitespace ? value : trimmed;
}

function cacheCapture(capture: CachedCapture): void {
  captureCache.delete(capture.id);
  captureCache.set(capture.id, capture);
  while (captureCache.size > MAX_CACHE_ENTRIES) {
    const oldest = captureCache.keys().next().value as string | undefined;
    if (!oldest) break;
    captureCache.delete(oldest);
  }
}

export function prepareHostBrowserSearch(
  query: string,
  limit: number,
  base: UnifiedResponse,
): HostBrowserSearchTask {
  cleanExpired();
  const normalizedLimit = Math.max(1, Math.min(10, Math.floor(limit || 5)));
  const captureId = randomUUID();
  const searchUrl = `https://www.neb.com/en-us/search?searchValue=${encodeURIComponent(query.trim())}`;
  pendingSearches.set(captureId, {
    query: query.trim(),
    limit: normalizedLimit,
    searchUrl,
    base,
    createdAt: Date.now(),
  });
  return {
    kind: "neb-search",
    captureId,
    query: query.trim(),
    limit: normalizedLimit,
    searchUrl,
    instructions: [
      "Open searchUrl in ChatGPT's built-in Browser.",
      "Read the rendered NEB results; do not replace them with web-search results.",
      "Open up to limit result links in the same Browser profile and capture main/article HTML when available, otherwise visible text.",
      "Call neb_search_commit with captureId and the captured results.",
    ],
  };
}

export function commitHostBrowserSearch(
  captureId: string,
  captures: readonly HostBrowserCaptureInput[],
): HostBrowserCommitResult {
  cleanExpired();
  const pending = pendingSearches.get(captureId);
  if (!pending) throw new Error("captureId is invalid or expired; call search with browser=host again");
  if (captures.length === 0) throw new Error("at least one rendered NEB result is required");
  if (captures.length > pending.limit) throw new Error(`at most ${pending.limit} results may be committed`);

  const results: UnifiedResult[] = [];
  const capturedIds: string[] = [];
  const formats: Record<string, "html" | "rendered-text"> = {};
  const seen = new Set<string>();
  let totalChars = 0;

  for (const raw of captures) {
    const requested = nebUrl(raw.url);
    const final = raw.finalUrl ? nebUrl(raw.finalUrl) : requested;
    const title = boundedString(raw.title, "title", true)!;
    const snippet = boundedString(raw.snippet, "snippet");
    // Keep captured page bodies byte-for-byte (within JavaScript's string
    // representation). Trimming here would make fetch subtly differ from what
    // the host Browser actually returned.
    const html = boundedString(raw.html, "html", false, true);
    const text = boundedString(raw.text, "text", false, true);
    if (!html && !text) throw new Error(`capture for ${final.toString()} must include html or text`);
    totalChars += (html?.length ?? 0) + (text?.length ?? 0);
    if (totalChars > MAX_COMMIT_CHARS) {
      throw new Error(`capture batch exceeds ${MAX_COMMIT_CHARS.toLocaleString()} characters`);
    }

    const id = `url:${final.toString()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const format = html ? "html" : "rendered-text";
    cacheCapture({
      id,
      url: final.toString(),
      title,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      format,
      createdAt: Date.now(),
    });
    results.push({
      id,
      source: "neb",
      kind: "vendor-page",
      title,
      url: final.toString(),
      ...(snippet ? { snippet } : {}),
      fetchable: "full",
    });
    capturedIds.push(id);
    formats[id] = format;
  }

  pendingSearches.delete(captureId);
  const response: UnifiedResponse = {
    query: pending.query,
    results: [...pending.base.results, ...results],
    sources: [
      ...pending.base.sources,
      {
        id: "neb",
        name: "New England Biolabs (NEB)",
        kind: "vendor",
        query: `rendered NEB search: ${pending.query}`,
        searchUrl: pending.searchUrl,
        count: results.length,
      },
    ],
    unknownSources: pending.base.unknownSources,
    partial: pending.base.partial,
  };
  return { response, capturedIds, formats };
}

export function fetchHostBrowserCapture(id: string): string | undefined {
  const capture = captureCache.get(id.trim());
  if (!capture) return undefined;
  captureCache.delete(capture.id);
  captureCache.set(capture.id, capture);
  if (capture.html) {
    return [
      `<!-- Source: ${capture.url} — HTML captured by ChatGPT's built-in Browser during NEB search. ` +
        "No redistribution licence was detected. -->",
      "",
      capture.html,
      "",
      "_status: display-only-full-text_",
    ].join("\n");
  }
  return [
    `_Source: ${capture.url} (rendered text captured by ChatGPT's built-in Browser during NEB search; ` +
      "raw HTML was not available and no redistribution licence was detected)._",
    "",
    capture.text!,
    "",
    "_status: display-only-full-text_",
  ].join("\n");
}

export function resetHostBrowserStateForTests(): void {
  pendingSearches.clear();
  captureCache.clear();
}

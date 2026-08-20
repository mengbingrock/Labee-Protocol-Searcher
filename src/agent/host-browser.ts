import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
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

export interface ChromeSessionFetchTask {
  kind: "chrome-fetch";
  captureId: string;
  id: string;
  url: string;
  expectedTitle?: string;
  instructions: string[];
}

export interface ChromeSessionCaptureInput {
  title: string;
  url: string;
  finalUrl?: string;
  html?: string;
  text?: string;
}

export interface ChromeSessionCommitResult {
  id: string;
  format: "html" | "rendered-text";
  content: string;
}

interface PendingSearch {
  query: string;
  limit: number;
  searchUrl: string;
  base: UnifiedResponse;
  createdAt: number;
}

interface PendingFetch {
  id: string;
  url: string;
  expectedTitle?: string;
  createdAt: number;
}

interface CachedCapture {
  id: string;
  url: string;
  title: string;
  html?: string;
  text?: string;
  format: "html" | "rendered-text";
  origin: "neb-integrated-browser" | "chrome-session";
  createdAt: number;
}

const pendingSearches = new Map<string, PendingSearch>();
const pendingFetches = new Map<string, PendingFetch>();
const captureCache = new Map<string, CachedCapture>();

function cleanExpired(now = Date.now()): void {
  for (const [id, pending] of pendingSearches) {
    if (now - pending.createdAt > TASK_TTL_MS) pendingSearches.delete(id);
  }
  for (const [id, pending] of pendingFetches) {
    if (now - pending.createdAt > TASK_TTL_MS) pendingFetches.delete(id);
  }
}

function publicHttpsUrl(raw: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${field} is invalid`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${field} must be credential-free HTTPS`);
  }
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isIP(host.replace(/^\[|\]$/g, "")) !== 0
  ) {
    throw new Error(`${field} must use a public hostname`);
  }
  return url;
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
      "Open searchUrl in Codex's integrated Browser.",
      "Read the rendered NEB results; do not replace them with web-search results.",
      "Open up to limit result links in the same integrated Browser profile and capture main/article HTML when available, otherwise visible text.",
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
      origin: "neb-integrated-browser",
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

function expectedTitleFromNative(nativeText: string): string | undefined {
  const heading = nativeText.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || undefined;
}

function normalizedDoi(id: string): string | undefined {
  const raw = id.trim().replace(/^doi:\s*/i, "");
  const match = /^(10\.\d{4,9}\/\S+)$/i.exec(raw);
  return match?.[1]?.replace(/[.,;]+$/, "").toLowerCase();
}

function titleLooksRelated(expected: string | undefined, actual: string): boolean {
  if (!expected) return true;
  const tokens = (value: string) => new Set(
    value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [],
  );
  const wanted = tokens(expected);
  if (wanted.size === 0) return true;
  const observed = tokens(actual);
  let overlap = 0;
  for (const token of wanted) if (observed.has(token)) overlap += 1;
  return overlap / wanted.size >= 0.5;
}

export function prepareChromeSessionFetch(
  id: string,
  url: string,
  nativeText: string,
): ChromeSessionFetchTask {
  cleanExpired();
  const requested = publicHttpsUrl(url, "fallback URL").toString();
  const captureId = randomUUID();
  const expectedTitle = expectedTitleFromNative(nativeText);
  pendingFetches.set(captureId, {
    id: id.trim(),
    url: requested,
    ...(expectedTitle ? { expectedTitle } : {}),
    createdAt: Date.now(),
  });
  return {
    kind: "chrome-fetch",
    captureId,
    id: id.trim(),
    url: requested,
    ...(expectedTitle ? { expectedTitle } : {}),
    instructions: [
      "Use Codex's connected Chrome session only because the user explicitly authorized this fallback.",
      "Reuse an already-open matching article tab when possible; otherwise open url in that same Chrome session.",
      "Do not read, export, or print cookies. Chrome sends its own session state to the publisher.",
      "Verify the DOI and title, then capture main/article HTML or complete rendered text.",
      "If the publisher exposes only a Download PDF control, download it through Chrome and extract its text locally.",
      "Call chrome_fetch_commit with captureId, the requested url, finalUrl, title, and captured html or text.",
    ],
  };
}

export function commitChromeSessionFetch(
  captureId: string,
  raw: ChromeSessionCaptureInput,
): ChromeSessionCommitResult {
  cleanExpired();
  const pending = pendingFetches.get(captureId);
  if (!pending) throw new Error("captureId is invalid or expired; call fetch with browser=chrome again");
  const requested = publicHttpsUrl(raw.url, "url");
  if (requested.toString() !== pending.url) {
    throw new Error("url must exactly match the Chrome fallback task URL");
  }
  const final = raw.finalUrl ? publicHttpsUrl(raw.finalUrl, "finalUrl") : requested;
  const title = boundedString(raw.title, "title", true)!;
  const html = boundedString(raw.html, "html", false, true);
  const text = boundedString(raw.text, "text", false, true);
  if (!html && !text) throw new Error("Chrome capture must include html or text");
  const body = `${html ?? ""}\n${text ?? ""}`;
  if (body.trim().length < 200) throw new Error("Chrome capture is too short to be article full text");

  const doi = normalizedDoi(pending.id);
  let identityUrl = final.toString();
  try {
    identityUrl = decodeURIComponent(identityUrl);
  } catch {
    // A valid URL may still contain a literal percent. The undecoded form is
    // sufficient for title matching and most DOI URLs.
  }
  const identityText = `${identityUrl}\n${title}\n${body}`.toLowerCase();
  const doiMatches = doi ? identityText.includes(doi) || identityText.includes(doi.split("/")[1]!) : false;
  if (!doiMatches && !titleLooksRelated(pending.expectedTitle, title)) {
    throw new Error("Chrome capture title/DOI does not match the requested article");
  }

  const format = html ? "html" : "rendered-text";
  cacheCapture({
    id: pending.id,
    url: final.toString(),
    title,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    format,
    origin: "chrome-session",
    createdAt: Date.now(),
  });
  pendingFetches.delete(captureId);
  return { id: pending.id, format, content: fetchHostBrowserCapture(pending.id)! };
}

export function fetchHostBrowserCapture(id: string): string | undefined {
  const capture = captureCache.get(id.trim());
  if (!capture) return undefined;
  captureCache.delete(capture.id);
  captureCache.set(capture.id, capture);
  if (capture.origin === "chrome-session") {
    const source = capture.html
      ? `<!-- Source: ${capture.url} — entitled publisher HTML captured through the user's explicitly authorized connected Chrome session. Access and redistribution remain governed by the publisher or subscription terms. -->`
      : `_Source: ${capture.url} (entitled publisher text captured through the user's explicitly authorized connected Chrome session; access and redistribution remain governed by the publisher or subscription terms)._`;
    return [source, "", capture.html ?? capture.text!, "", "_status: entitled-full-text_"].join("\n");
  }
  if (capture.html) {
    return [
      `<!-- Source: ${capture.url} — HTML captured by Codex's integrated Browser during NEB search. ` +
        "No redistribution licence was detected. -->",
      "",
      capture.html,
      "",
      "_status: display-only-full-text_",
    ].join("\n");
  }
  return [
    `_Source: ${capture.url} (rendered text captured by Codex's integrated Browser during NEB search; ` +
      "raw HTML was not available and no redistribution licence was detected)._",
    "",
    capture.text!,
    "",
    "_status: display-only-full-text_",
  ].join("\n");
}

export function resetHostBrowserStateForTests(): void {
  pendingSearches.clear();
  pendingFetches.clear();
  captureCache.clear();
}

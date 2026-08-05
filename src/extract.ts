// Best-effort content extraction from an open-access location that isn't a
// structured PMC record — the Unpaywall `oa-link` case. Unlike Europe PMC's
// clean JATS, these are raw publisher/repository pages, so extraction is
// heuristic and clearly labelled "best-effort" to the caller.
//
//   HTML → readability-lite: keep the main <article>/<main>/<body>, drop
//          scripts/styles/chrome, flatten to text.
//   XML  → strip to the <body> text (handles JATS-ish repository copies).
//   PDF  → `unpdf` (pdf.js under the hood), loaded lazily so the PDF engine is
//          only pulled in when a PDF is actually fetched. A malformed/encrypted
//          PDF just returns null and the caller falls back to the plain OA link.

import { type ProviderOptions, decodeEntities, fetchWithRetry, stripTags, userAgent } from "./providers/types.ts";

export type ExtractFormat = "html" | "xml" | "pdf" | "json";

export interface Extracted {
  text: string;
  format: ExtractFormat;
}

// Don't pull a whole book into memory for a "best-effort" extraction.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** Collapse HTML-ish markup to text while preserving paragraph breaks. */
function htmlToText(html: string): string {
  // Prefer the main content region when the page marks one.
  const main =
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html) ??
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html) ??
    /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  let s = main ? main[1]! : html;
  s = s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  // Turn block-level boundaries into newlines so paragraphs survive.
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|section|h[1-6]|li|tr)\s*>/gi, "\n");
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extract text from a PDF response via `unpdf` (lazily loaded). */
async function pdfToText(res: Response): Promise<string | null> {
  try {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    const joined = Array.isArray(text) ? text.join("\n") : text;
    return typeof joined === "string" && joined.trim() ? joined : null;
  } catch {
    return null;
  }
}

function cap(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}\n\n…[truncated; full document at the link]`;
}

/**
 * protocols.io renders its protocol pages client-side — the served HTML is a
 * ~100-byte shell with no readable text — but appending `.json` to a
 * `/view/<slug>` URL returns the whole protocol, no API token needed. (The
 * documented /api/v3|v4 endpoints do require a bearer token; this one doesn't.)
 */
export function protocolsIoJsonUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)protocols\.io$/i.test(u.hostname)) return null;
    if (!/^\/view\/[^/]+/.test(u.pathname)) return null;
    if (u.pathname.endsWith(".json")) return url;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}.json`;
  } catch {
    return null;
  }
}

/** Render a protocols.io table entity (a 2D cell array) as a markdown table. */
function renderTableEntity(data: unknown): string {
  const rows = (data as { data?: unknown[][] })?.data;
  if (!Array.isArray(rows) || rows.length === 0) return "";
  // Cells carry inline markup (<strong>, and <br> separating sub-rows). Flatten
  // both: a literal "<strong>Component</strong>" in a cell is just noise.
  const cells = rows.map((r) =>
    Array.isArray(r)
      ? r.map((c) =>
          decodeEntities(
            String(c ?? "")
              .replace(/<br\s*\/?>/gi, " / ")
              .replace(/<[^>]+>/g, ""),
          )
            .replace(/\s+/g, " ")
            .replace(/\|/g, "\\|")
            .trim(),
        )
      : [],
  );
  const width = Math.max(...cells.map((r) => r.length));
  if (width === 0) return "";
  const pad = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  const [head, ...body] = cells;
  return [pad(head!), `|${" --- |".repeat(width)}`, ...body.map(pad)].join("\n");
}

/**
 * Steps arrive as Draft.js state. Plain prose is in `blocks[].text`, but the
 * reaction tables and notes — the part a bench scientist actually needs — are
 * `atomic` blocks pointing into `entityMap`. Reading only `blocks[].text` gets
 * you "Set up the following reaction:" and then silently drops the reaction.
 */
function draftJsText(step: unknown): string {
  if (typeof step !== "string") return "";
  try {
    const parsed = JSON.parse(step) as {
      blocks?: { text?: string; type?: string; entityRanges?: { key?: number }[] }[];
      entityMap?: Record<string, { type?: string; data?: unknown }>;
    };
    const entities = parsed.entityMap ?? {};
    const out: string[] = [];
    for (const b of parsed.blocks ?? []) {
      if (b.type === "atomic") {
        for (const range of b.entityRanges ?? []) {
          const ent = entities[String(range.key)];
          if (!ent) continue;
          if (ent.type === "tables") {
            const t = renderTableEntity(ent.data);
            if (t) out.push(t);
          } else if (ent.type === "notes") {
            // Notes nest another draft-js document.
            const nested = draftJsText(JSON.stringify(ent.data));
            if (nested) out.push(`> ${nested.split("\n").join("\n> ")}`);
          }
        }
        continue;
      }
      const text = (b.text ?? "").trim();
      if (text) out.push(text);
    }
    return out.join("\n");
  } catch {
    return "";
  }
}

/** Render a protocols.io protocol JSON payload as readable markdown. */
function renderProtocolsIo(payload: unknown): string {
  const p = payload as {
    title?: string;
    description?: string;
    authors?: { name?: string }[];
    steps?: { step?: unknown }[];
    document?: unknown;
  };
  if (!p || typeof p !== "object") return "";
  const out: string[] = [];
  if (p.title) out.push(`# ${p.title}`);
  const authors = (p.authors ?? []).map((a) => a?.name).filter(Boolean);
  if (authors.length) out.push(`_Authors: ${authors.join(", ")}_`);
  // `description` is HTML on some protocols and draft-js JSON on others (NEB's
  // workspace uses the latter). Try the structured parse first, or the raw JSON
  // gets dumped into the output verbatim.
  const desc = draftJsText(p.description) || stripTags(p.description ?? "").trim();
  if (desc) out.push(desc);
  const steps = Array.isArray(p.steps) ? p.steps : [];
  let body = 0;
  steps.forEach((s, i) => {
    const text = draftJsText(s?.step);
    if (text) {
      body++;
      out.push(`## Step ${i + 1}\n\n${text}`);
    }
  });
  // Not every protocol is step-structured: narrative ones carry the whole thing
  // in `document` (same draft-js shape) and ship an empty `steps` array. Without
  // this they extract to a title and an author line and still report success.
  if (body === 0) {
    const doc = draftJsText(p.document);
    if (doc) out.push(doc);
  }
  return out.join("\n\n").trim();
}

/** Does this error mean fetch gave up bouncing between redirects? */
function isRedirectLoop(err: unknown): boolean {
  const cause = (err as { cause?: { message?: string; code?: string } })?.cause;
  const msg = `${cause?.message ?? ""} ${cause?.code ?? ""} ${(err as Error)?.message ?? ""}`;
  return /redirect count exceeded|too many redirects|ERR_TOO_MANY_REDIRECTS/i.test(msg);
}

/** Absorb a response's Set-Cookie headers into `jar` (last value wins). */
function harvestCookies(res: Response, jar: Map<string, string>): void {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";", 1)[0]!.trim();
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

const MAX_REDIRECT_HOPS = 8;

/**
 * Follow redirects by hand, carrying cookies between hops the way a browser
 * would. `fetch` has no cookie jar, so a site that gates content behind one
 * (idtdna.com bounces you through a country-selection page that sets `Country`)
 * redirects forever and fetch eventually throws.
 */
async function fetchFollowingWithCookies(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const jar = new Map<string, string>();
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetchWithRetry(
      doFetch,
      current,
      {
        ...init,
        redirect: "manual",
        headers: {
          ...(init.headers as Record<string, string>),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      timeoutMs,
      { retries: 0 },
    );
    harvestCookies(res, jar);
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    current = new URL(location, current).toString();
  }
  throw new Error(`redirect count exceeded after ${MAX_REDIRECT_HOPS} hops`);
}

/**
 * `fetchWithRetry`, falling back to manual cookie-carrying redirect following
 * when — and only when — the plain request dies in a redirect loop.
 */
async function fetchAllowingCookieGate(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetchWithRetry(doFetch, url, init, timeoutMs, { retries: 1 });
  } catch (err) {
    if (!isRedirectLoop(err)) throw err;
    return fetchFollowingWithCookies(doFetch, url, init, timeoutMs);
  }
}

/**
 * Fetch `url` and extract its readable text. Returns null on any failure
 * (non-200, oversized, unsupported/undecodable, or a PDF with no `unpdf`
 * available) so the caller can fall back to returning the bare link. Never
 * throws.
 */
export async function extractOaContent(
  url: string,
  opts: ProviderOptions,
  maxChars: number,
): Promise<Extracted | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15000;
  try {
    const jsonUrl = protocolsIoJsonUrl(url);
    if (jsonUrl) {
      const jres = await fetchWithRetry(
        doFetch,
        jsonUrl,
        { headers: { "User-Agent": userAgent(url.length), Accept: "application/json" } },
        timeoutMs,
        { retries: 1 },
      );
      if (jres.status === 200) {
        const text = renderProtocolsIo(await jres.json());
        if (text) return { text: cap(text, maxChars), format: "json" };
      }
      // Fall through to the HTML path — it will almost certainly come back
      // empty, but a stub beats inventing a failure mode the caller can't see.
    }

    const res = await fetchAllowingCookieGate(
      doFetch,
      url,
      {
        headers: {
          "User-Agent": userAgent(url.length),
          Accept: "text/html,application/xhtml+xml,application/pdf,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      timeoutMs,
    );
    if (res.status !== 200) return null;


    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_DOWNLOAD_BYTES) return null;

    const isPdf = ct.includes("pdf") || /\.pdf($|\?)/i.test(url);
    if (isPdf) {
      const text = await pdfToText(res);
      return text && text.trim() ? { text: cap(text, maxChars), format: "pdf" } : null;
    }

    const isXml = ct.includes("xml") || /\.xml($|\?)/i.test(url);
    const raw = await res.text();
    if (isXml) {
      const body = /<body[\s>]([\s\S]*?)<\/body>/i.exec(raw);
      const text = stripTags(body ? body[1]! : raw);
      return text ? { text: cap(text, maxChars), format: "xml" } : null;
    }

    const text = htmlToText(raw);
    if (!text || looksLikeBotWall(text)) return null;
    return { text: cap(text, maxChars), format: "html" };
  } catch {
    return null;
  }
}

// Phrases that only ever appear on a challenge/interstitial page, never in an
// article. Kept narrow on purpose: a false positive silently hides real content.
const BOT_WALL_RE =
  /checking your browser before accessing|just a moment\.\.\.|enable javascript and cookies to continue|verifying you are (a )?human|request unsuccessful\.\s*incapsula|attention required!\s*\|\s*cloudflare|not automatically redirected after \d+ seconds|please (enable|turn on) (javascript|cookies) to (continue|proceed)/i;

/**
 * True when extraction produced a bot challenge rather than an article. Returning
 * one as content is worse than returning nothing: the caller records `ok`, the
 * agent reads "Checking your browser…" as the protocol, and the health table
 * counts a success. Short *and* matching — a real article that merely quotes one
 * of these phrases will run past the length bound.
 */
export function looksLikeBotWall(text: string): boolean {
  return text.length < 1500 && BOT_WALL_RE.test(text);
}

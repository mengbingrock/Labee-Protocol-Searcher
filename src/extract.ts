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

export type ExtractFormat = "html" | "xml" | "pdf";

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
    const res = await fetchWithRetry(
      doFetch,
      url,
      {
        headers: {
          "User-Agent": userAgent(url.length),
          Accept: "text/html,application/xhtml+xml,application/pdf,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      timeoutMs,
      { retries: 1 },
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
    return text ? { text: cap(text, maxChars), format: "html" } : null;
  } catch {
    return null;
  }
}

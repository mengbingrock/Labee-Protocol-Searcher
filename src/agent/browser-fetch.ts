import { fetchResource, fetchResources, type FetchOptions, type FetchRow } from "../fetch.ts";
import { extractHttpUrls, isVerifiedStatus, parseFetchStatus } from "./resolvers.ts";
import type { BrowserAdapter } from "./types.ts";

function withStatus(text: string, status: string): string {
  return `${text}\n\n_status: ${status}_`;
}

function requestedUrl(id: string, nativeText: string): string | undefined {
  const raw = id.trim();
  const candidate = raw.toLowerCase().startsWith("url:") ? raw.slice(4).trim() : raw;
  if (/^https?:\/\//i.test(candidate)) return candidate;
  return extractHttpUrls(nativeText)[0];
}

export function sourceForUrl(url: URL): string {
  if (url.hostname === "neb.com" || url.hostname.endsWith(".neb.com")) return "neb";
  return "web";
}

export function browserHosts(url: URL): string[] {
  const hosts = [url.hostname];
  if (url.hostname === "neb.com" || url.hostname.endsWith(".neb.com")) {
    hosts.push(
      "neb.com",
      "www.neb.com",
      "challenges.cloudflare.com",
      "static.cloudflareinsights.com",
    );
  }
  return [...new Set(hosts)];
}

function officialNebMirror(links: readonly string[] | undefined): string | undefined {
  for (const link of links ?? []) {
    try {
      const url = new URL(link);
      if (
        (url.hostname === "protocols.io" || url.hostname.endsWith(".protocols.io")) &&
        /^\/view\//.test(url.pathname)
      ) {
        return url.toString();
      }
    } catch {
      // Ignore malformed page links.
    }
  }
  return undefined;
}

export async function fetchResourceWithBrowser(
  id: string,
  opts: FetchOptions = {},
  browser?: BrowserAdapter,
): Promise<string> {
  const nativeText = await fetchResource(id, opts);
  if (!browser || isVerifiedStatus(parseFetchStatus(nativeText))) return nativeText;

  const rawUrl = requestedUrl(id, nativeText);
  if (!rawUrl) return nativeText;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return nativeText;
  }

  const state = await browser.available();
  if (!state.available) return nativeText;
  const hit = await browser.retrieve({
    url: url.toString(),
    sourceId: sourceForUrl(url),
    allowedHosts: browserHosts(url),
    maxChars: 80_000,
    timeoutMs: 20_000,
  });
  if (hit.status === "interaction-required") {
    return withStatus(
      `The Labee browser is waiting for manual verification at ${hit.finalUrl ?? url.toString()}. ` +
        "Complete the visible check, then retry this fetch.",
      "interaction-required",
    );
  }
  if (hit.status !== "ok" || !hit.text?.trim()) return nativeText;

  if (sourceForUrl(url) === "neb") {
    if (hit.html?.trim() && hit.provenance.route.endsWith("-cache")) {
      return withStatus(
        `<!-- Source: ${hit.finalUrl ?? url.toString()} — rendered HTML captured during NEB search ` +
          `in the same default Chrome profile. No redistribution licence was detected. -->\n\n${hit.html}`,
        "display-only-full-text",
      );
    }
    const mirror = officialNebMirror(hit.links);
    if (mirror) {
      const mirrored = await fetchResource(`url:${mirror}`, opts);
      if (isVerifiedStatus(parseFetchStatus(mirrored))) return mirrored;
    }
  }

  return withStatus(
    `_Source: ${hit.finalUrl ?? url.toString()} (public publisher page read in the Labee browser; ` +
      `no redistribution licence was detected)._\n\n${hit.text}`,
    "display-only-full-text",
  );
}

export async function fetchResourcesWithBrowser(
  ids: readonly string[],
  opts: FetchOptions = {},
  browser?: BrowserAdapter,
): Promise<FetchRow[]> {
  if (!browser) return fetchResources(ids, opts);
  const rows: FetchRow[] = [];
  for (const id of ids) {
    try {
      rows.push({ id, text: await fetchResourceWithBrowser(id, opts, browser) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "fetch failed";
      rows.push({ id, text: withStatus(`Error fetching \`${id}\`: ${message}`, "error") });
    }
  }
  return rows;
}

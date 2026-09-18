import { fetchResource, fetchResources, type FetchOptions, type FetchRow } from "../fetch.ts";
import { extractHttpUrls, isVerifiedStatus, parseFetchStatus } from "./resolvers.ts";
import { prepareChromeSessionFetch } from "./host-browser.ts";
import type { BrowserAdapter } from "./types.ts";
import { getVendor } from "../vendors.ts";

function withStatus(text: string, status: string): string {
  return `${text}\n\n_status: ${status}_`;
}

function requestedUrl(id: string, nativeText: string): string | undefined {
  const raw = id.trim();
  const candidate = raw.toLowerCase().startsWith("url:") ? raw.slice(4).trim() : raw;
  if (/^https?:\/\//i.test(candidate)) return candidate;
  return extractHttpUrls(nativeText)[0];
}

export function chromeFallbackUrl(id: string, nativeText: string): string | undefined {
  const raw = id.trim();
  const withoutPrefix = raw.replace(/^doi:\s*/i, "");
  const doi = /^(10\.\d{4,9}\/\S+)$/i.exec(withoutPrefix)?.[1]?.replace(/[.,;]+$/, "");
  if (doi) return `https://doi.org/${doi}`;
  const pmcid = raw.replace(/^pmcid:\s*/i, "").match(/^(PMC\d+)$/i)?.[1];
  if (pmcid) return `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid.toUpperCase()}/`;
  const pmid = raw.replace(/^pmid:\s*/i, "").match(/^(\d{5,10})$/)?.[1];
  if (pmid) return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  return requestedUrl(id, nativeText);
}

export async function fetchResourceWithChromeSessionFallback(
  id: string,
  opts: FetchOptions = {},
): Promise<string> {
  const nativeText = await fetchResource(id, opts);
  if (isVerifiedStatus(parseFetchStatus(nativeText))) return nativeText;
  const url = chromeFallbackUrl(id, nativeText);
  if (!url) return nativeText;
  const task = prepareChromeSessionFetch(id, url, nativeText);
  return [
    nativeText,
    "",
    "_status: chrome-browser-required_",
    "",
    "chromeBrowserTask:",
    JSON.stringify(task, null, 2),
  ].join("\n");
}

export function sourceForUrl(url: URL): string {
  if (url.hostname === "neb.com" || url.hostname.endsWith(".neb.com")) return "neb";
  return "web";
}

/**
 * Sibling domains a source legitimately redirects between, so a brand
 * consolidation does not read as an unsafe redirect.
 *
 * Merck is the motivating case: an emdmillipore.com product URL now lands on
 * www.sigmaaldrich.com. Real Chrome follows that happily, but with only the
 * requested hostname allowlisted the policy rejected the destination and the
 * adapter reported `unsafe-url` — which surfaces to the caller as
 * `not-fetchable`, indistinguishable from the site refusing us. The page was
 * never blocked at all.
 *
 * Each group is an explicit allowlist, not a wildcard: the policy still has to
 * name every host it will accept.
 */
const SIBLING_HOSTS: readonly (readonly string[])[] = [
  ["neb.com", "www.neb.com"],
  // Merck's life-science brands, which redirect into one another.
  [
    "emdmillipore.com",
    "www.emdmillipore.com",
    "merckmillipore.com",
    "www.merckmillipore.com",
    "sigmaaldrich.com",
    "www.sigmaaldrich.com",
  ],
];

function inGroup(hostname: string, group: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return group.some((base) => host === base || host.endsWith(`.${base}`));
}

export function browserHosts(url: URL): string[] {
  const hosts = [url.hostname];
  for (const group of SIBLING_HOSTS) {
    if (inGroup(url.hostname, group)) hosts.push(...group);
  }
  if (url.hostname === "neb.com" || url.hostname.endsWith(".neb.com")) {
    // Cloudflare's challenge assets, needed to clear NEB's interstitial.
    hosts.push("challenges.cloudflare.com", "static.cloudflareinsights.com");
  }
  return [...new Set(hosts)];
}

/**
 * The first link on a NEB page that matches the vendor's `ungated` pattern —
 * a PDF manual served without the Cloudflare challenge that gates the HTML.
 * The pattern lives on the vendor record so search and fetch agree on it.
 */
function ungatedNebDocument(links: readonly string[] | undefined): string | undefined {
  const pattern = getVendor("neb")?.ungated;
  if (!pattern) return undefined;
  return links?.find((link) => pattern.test(link));
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
    // Prefer a document NEB serves openly over the browser-rendered page:
    // native retrieval returns `ok` rather than display-only, costs no browser,
    // and the kit manual carries more of the protocol than the HTML summary.
    const manual = ungatedNebDocument(hit.links);
    if (manual) {
      const native = await fetchResource(`url:${manual}`, opts);
      if (isVerifiedStatus(parseFetchStatus(native))) return native;
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

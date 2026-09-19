import {
  browserlessConfig,
  scrapeSearchWithBrowserless,
  searchWithBrowserless,
  type BrowserlessSearchPage,
} from "./browserless.ts";
import type { ProviderOptions, RawResult } from "./providers/types.ts";
import { awaitResidentialReady, residentialSelectorFor } from "./residential.ts";
import type { Vendor } from "./vendors.ts";

export interface PublisherSearchOutcome {
  results: RawResult[];
  source?: "publisher-browserless" | "publisher-browserless-residential";
  status: "ok" | "empty" | "error" | "unavailable";
  elapsedMs: number;
  error?: string;
}

const CHALLENGE =
  /human verification|confirm you are human|verify (?:you are|that you are) human|just a moment|checking your browser|safeLine WAF|access denied|something went wrong/i;

function titleScore(title: string): number {
  const text = title.trim();
  if (!text) return -1_000;
  const generic =
    /^(promotion|view|learn more|read more|details|buy|shop|pdf|html|protocol|sds|price|specifications?(?:\s*&\s*change notifications)?|publications?)$/i.test(
      text,
    );
  return Math.min(text.length, 200) - (generic ? 500 : 0);
}

function canonicalResultUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

function resultsFromPage(vendor: Vendor, page: BrowserlessSearchPage, limit: number): RawResult[] {
  if (CHALLENGE.test(`${page.title}\n${page.bodyText.slice(0, 2_000)}`)) return [];
  const byUrl = new Map<string, RawResult>();
  for (const link of page.links) {
    if (!link.text.trim() || !vendor.publisherResult.test(link.href)) continue;
    if (vendor.publisherResultClass && !vendor.publisherResultClass.test(link.className ?? "")) continue;
    const url = canonicalResultUrl(link.href);
    const snippet = link.snippet.trim();
    const candidate: RawResult = {
      title: link.text.trim().slice(0, 500),
      url,
      snippet: snippet === link.text.trim() ? "" : snippet.slice(0, 700),
      discoveredBy: ["publisher-browserless"],
    };
    const current = byUrl.get(url);
    if (!current) byUrl.set(url, candidate);
    else if (titleScore(candidate.title) > titleScore(current.title)) byUrl.set(url, candidate);
  }
  return [...byUrl.values()].slice(0, limit);
}

/** Search one publisher's own rendered search UI, datacenter first. */
export async function searchPublisher(
  vendor: Vendor,
  query: string,
  limit: number,
  opts: ProviderOptions = {},
): Promise<PublisherSearchOutcome> {
  const started = Date.now();
  const cfg = browserlessConfig();
  if (!cfg) {
    return {
      results: [],
      status: "unavailable",
      elapsedMs: Date.now() - started,
      error: "BROWSERLESS_TOKEN is not configured",
    };
  }

  const searchUrl = vendor.searchUrl(query);
  const entryUrl = vendor.interactiveSearch?.startUrl ?? searchUrl;
  try {
    await opts.validateUrl?.(entryUrl);
  } catch {
    return {
      results: [],
      status: "error",
      elapsedMs: Date.now() - started,
      error: "publisher search URL rejected by URL policy",
    };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const runPublisherSearch = (residential?: ReturnType<typeof residentialSelectorFor>) =>
    vendor.publisherScrapeSelector
      ? scrapeSearchWithBrowserless(
          searchUrl,
          vendor.publisherScrapeSelector,
          doFetch,
          cfg,
          residential,
        )
      : searchWithBrowserless(
          searchUrl,
          query,
          doFetch,
          cfg,
          vendor.interactiveSearch,
          vendor.shadowSearch,
          residential,
        );

  // NEB's Coveo UI is known to render through the local exit and known to be
  // unreliable from the AWS address. Avoid paying for a doomed datacenter
  // attempt when an explicitly enabled residential agent is already present.
  let residentialSelector: ReturnType<typeof residentialSelectorFor> = null;
  let residentialAttempted = false;
  if (vendor.publisherResidentialFirst) {
    await awaitResidentialReady(4_000);
    residentialSelector = residentialSelectorFor(entryUrl);
    if (residentialSelector) {
      residentialAttempted = true;
      const residential = await runPublisherSearch(residentialSelector);
      const residentialResults = residential ? resultsFromPage(vendor, residential, limit) : [];
      if (residentialResults.length > 0) {
        return {
          results: residentialResults,
          source: "publisher-browserless-residential",
          status: "ok",
          elapsedMs: Date.now() - started,
        };
      }
    }
  }

  const direct = await runPublisherSearch();
  const directResults = direct ? resultsFromPage(vendor, direct, limit) : [];
  if (directResults.length > 0) {
    return {
      results: directResults,
      source: "publisher-browserless",
      status: "ok",
      elapsedMs: Date.now() - started,
    };
  }

  // Sources that did not already prefer the local exit get a residential retry
  // only after an empty datacenter search. The agent is started by stdio/CLI
  // setup; this bounded wait covers its asynchronous registration without
  // making publisher search depend on it.
  if (!residentialAttempted) await awaitResidentialReady(4_000);
  const selector = residentialAttempted
    ? null
    : (residentialSelector ?? residentialSelectorFor(entryUrl));
  if (selector) {
    const residential = await runPublisherSearch(selector);
    const residentialResults = residential ? resultsFromPage(vendor, residential, limit) : [];
    if (residentialResults.length > 0) {
      return {
        results: residentialResults,
        source: "publisher-browserless-residential",
        status: "ok",
        elapsedMs: Date.now() - started,
      };
    }
  }

  return {
    results: [],
    status: direct ? "empty" : "error",
    elapsedMs: Date.now() - started,
    error: direct
      ? "publisher page rendered but exposed no credible result links"
      : "publisher Browserless search failed",
  };
}

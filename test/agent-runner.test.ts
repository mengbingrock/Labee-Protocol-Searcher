import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { browserAllowedHosts, runDeepSearchJob } from "../src/agent/runner.ts";
import { normalizeDeepSearchInput } from "../src/agent/service.ts";
import { FileJobStore } from "../src/agent/store.ts";
import type { BrowserAdapter, BrowserEvidence, BrowserRequest, BrowserSearchRequest } from "../src/agent/types.ts";
import type { UnifiedResponse } from "../src/search.ts";

class FakeBrowser implements BrowserAdapter {
  readonly id = "fake-browser";
  requests: BrowserRequest[] = [];
  searchRequests: BrowserSearchRequest[] = [];
  async available() { return { available: true }; }
  async retrieve(request: BrowserRequest): Promise<BrowserEvidence> {
    this.requests.push(request);
    return { status: "ok", text: "browser full text", finalUrl: request.url, format: "dom", provenance: { adapter: this.id, route: "fixture", capturedUrl: `${request.url}#captured` } };
  }
  async search(request: BrowserSearchRequest) {
    this.searchRequests.push(request);
    return { status: "ok" as const, results: [{ title: "Browser S2 result", url: "https://doi.org/10.1/browser", snippet: "xhr" }], provenance: { adapter: this.id, route: "fixture-xhr", capturedUrl: "https://www.semanticscholar.org/api/1/search" } };
  }
  async close() {}
}

function response(query: string, suffix: string): UnifiedResponse {
  return {
    query,
    partial: false,
    unknownSources: [],
    sources: [{ id: "bio-protocol", name: "Bio-protocol", kind: "journal", count: 2 }],
    results: [
      { id: `doi:10.21769/BioProtoc.${suffix}`, source: "bio-protocol", kind: "article", title: `Protocol ${suffix}`, url: `https://doi.org/10.21769/BioProtoc.${suffix}`, fetchable: "partial" },
      { id: "doi:10.1/shared", source: "bio-protocol", kind: "article", title: "Shared", url: "https://example.com/shared", fetchable: "partial" },
    ],
  };
}

describe("deep-search runner", () => {
  it("derives trusted DOI redirect hosts from the result source", () => {
    const result = response("PCR", "5700").results[0]!;
    expect(browserAllowedHosts(result, result.url!)).toEqual(expect.arrayContaining(["doi.org", "bio-protocol.org"]));
  });
  it("searches exactly five keywords, native-fetches each unique id once, and recovers unresolved content", async () => {
    const store = new FileJobStore(await mkdtemp(join(tmpdir(), "labee-agent-runner-")));
    const spec = normalizeDeepSearchInput({ query: "PCR", limit: 1, browser: "cdp", maxRounds: 1 }, new Date("2026-08-10T00:00:00Z"));
    const created = await store.create(spec);
    const searchFn = vi.fn(async (keyword: string) => response(keyword, String(5700 + spec.keywords.indexOf(keyword))));
    const fetchedIds: string[] = [];
    const fetchManyFn = vi.fn(async (ids: readonly string[]) => {
      fetchedIds.push(...ids);
      return ids.map((id) => ({ id, text: id.includes("shared") ? "No content\n\n_status: not-fetchable_" : `OA: https://bio-protocol.org/article/${id.split(".").at(-1)}\n\n_status: oa-link_` }));
    });
    const fetchOneFn = vi.fn(async (id: string) => id.includes("Bio-protocol57") ? "PDF full text\n\n_status: ok_" : "_status: not-fetchable_");
    const browser = new FakeBrowser();

    const progress = await runDeepSearchJob(created.id, { store, searchFn, fetchManyFn, fetchOneFn, browser });
    expect(searchFn).toHaveBeenCalledTimes(5);
    expect(searchFn.mock.calls.map((call) => call[0])).toEqual(spec.keywords);
    expect(fetchedIds).toHaveLength(6);
    expect(progress.resultOccurrences).toBe(10);
    expect(progress.nativeFetchAttempts).toBe(6);
    expect(progress.fetchedResults).toBe(6);
    expect(progress.uniqueResults).toBe(6);
    expect(progress.searchedKeywords).toHaveLength(5);
    const attempts = await store.readAttempts(created.id);
    expect(attempts.filter((attempt) => attempt.route === "native-fetch")).toHaveLength(6);
    expect(attempts.find((attempt) => attempt.route === "browser-cdp" && attempt.status === "ok")).toMatchObject({
      adapter: "fake-browser",
      provenanceRoute: "fixture",
      finalUrl: "https://example.com/shared",
      capturedUrl: "https://example.com/shared#captured",
    });
    expect((await store.readFindings(created.id))).toHaveLength(6);
    expect(fetchOneFn.mock.calls.some((call) => String(call[0]).includes("Bio-protocol5700.pdf"))).toBe(true);
    expect(browser.requests.length).toBeGreaterThan(0);
  });

  it("does not repeat completed keywords after resume", async () => {
    const store = new FileJobStore(await mkdtemp(join(tmpdir(), "labee-agent-resume-")));
    const spec = normalizeDeepSearchInput({ query: "PCR", browser: "off", maxRounds: 1 }, new Date("2026-08-10T00:00:00Z"));
    const created = await store.create(spec);
    created.status = "running";
    created.searchedKeywords = [spec.keywords[0]!];
    await store.writeProgress(created.id, created);
    const searchFn = vi.fn(async (keyword: string) => ({ ...response(keyword, "5800"), results: [] }));
    await runDeepSearchJob(created.id, { store, searchFn, fetchManyFn: async () => [] });
    expect(searchFn).toHaveBeenCalledTimes(4);
    expect(searchFn.mock.calls.map((call) => call[0])).not.toContain(spec.keywords[0]);
  });

  it("uses Semantic Scholar browser XHR even when the API backend succeeds", async () => {
    const store = new FileJobStore(await mkdtemp(join(tmpdir(), "labee-agent-s2-browser-")));
    const spec = normalizeDeepSearchInput({ query: "PCR", browser: "cdp", maxRounds: 1 }, new Date("2026-08-10T00:00:00Z"));
    const created = await store.create(spec);
    const browser = new FakeBrowser();
    const fetched: string[] = [];
    const searchFn = async (query: string): Promise<UnifiedResponse> => ({
      query, partial: true, unknownSources: [], results: [],
      sources: [{
        id: "star-protocols", name: "STAR Protocols", kind: "journal", count: 0,
        providers: [{ id: "semanticscholar", status: "ok", count: 1, elapsedMs: 1 }],
      }],
    });
    const progress = await runDeepSearchJob(created.id, {
      store, browser, searchFn,
      fetchManyFn: async (ids) => {
        fetched.push(...ids);
        return ids.map((id) => ({ id, text: "browser result full text\n\n_status: ok_" }));
      },
    });
    expect(browser.searchRequests).toHaveLength(5);
    expect(browser.searchRequests.every((request) => request.venue === "STAR Protocols")).toBe(true);
    expect(fetched).toEqual(["doi:10.1/browser"]);
    expect(progress.resultOccurrences).toBe(5);
    expect(progress.uniqueResults).toBe(1);
    expect(progress.browserSearchPages).toBe(5);
    expect(progress.nativeFetchAttempts).toBe(1);
    const browserAttempts = (await store.readAttempts(created.id)).filter((attempt) => attempt.resultId.includes("semanticscholar-browser"));
    expect(browserAttempts).toHaveLength(5);
    expect(browserAttempts[0]).toMatchObject({
      adapter: "fake-browser",
      provenanceRoute: "fixture-xhr",
      capturedUrl: "https://www.semanticscholar.org/api/1/search",
    });
  });

  it("rejects keyword suites that are not exactly five distinct entries", () => {
    expect(() => normalizeDeepSearchInput({ query: "PCR", keywords: ["one"] })).toThrow("exactly five");
    expect(() => normalizeDeepSearchInput({ query: "PCR", keywords: ["a", "b", "c", "d", "a"] })).toThrow("distinct");
  });

  it("honors maxRounds=1 and searches exactly five keywords in that round", async () => {
    const store = new FileJobStore(await mkdtemp(join(tmpdir(), "labee-agent-one-round-")));
    const spec = normalizeDeepSearchInput({ query: "PCR", browser: "off", maxRounds: 1 });
    const created = await store.create(spec);
    const searchFn = vi.fn(async (query: string): Promise<UnifiedResponse> => ({
      query, partial: false, unknownSources: [], sources: [], results: [],
    }));
    const progress = await runDeepSearchJob(created.id, { store, searchFn, fetchManyFn: async () => [] });
    expect(searchFn).toHaveBeenCalledTimes(5);
    expect(progress.iteration).toBe(1);
    expect(progress.searchedKeywords).toEqual(spec.keywords);
    expect(progress).toMatchObject({ status: "completed", completionReason: "max-rounds" });
  });

  it("resumes at a persisted round boundary and performs five searches for the next round", async () => {
    const store = new FileJobStore(await mkdtemp(join(tmpdir(), "labee-agent-round-resume-")));
    const spec = normalizeDeepSearchInput({ query: "PCR", browser: "off", maxRounds: 2 });
    const created = await store.create(spec);
    created.status = "running";
    created.iteration = 1;
    created.searchedKeywords = [];
    created.roundVerifiedBaseline = 0;
    await store.writeProgress(created.id, created);
    const searchFn = vi.fn(async (query: string): Promise<UnifiedResponse> => ({
      query, partial: false, unknownSources: [], sources: [], results: [],
    }));
    const progress = await runDeepSearchJob(created.id, { store, searchFn, fetchManyFn: async () => [] });
    expect(searchFn).toHaveBeenCalledTimes(5);
    expect(progress).toMatchObject({ iteration: 2, status: "completed", completionReason: "max-rounds" });
    expect(progress.searchedKeywords).toEqual(spec.keywords);
  });

  it("maps out-of-order fetch rows by id", async () => {
    const store = new FileJobStore(await mkdtemp(join(tmpdir(), "labee-agent-row-map-")));
    const spec = normalizeDeepSearchInput({ query: "PCR", browser: "off", maxRounds: 1 });
    const created = await store.create(spec);
    const results = [
      { id: "doi:10.1/a", source: "bio-protocol", kind: "article" as const, title: "A", fetchable: "full" as const },
      { id: "doi:10.1/b", source: "bio-protocol", kind: "article" as const, title: "B", fetchable: "full" as const },
    ];
    await runDeepSearchJob(created.id, {
      store,
      searchFn: async (query) => ({ query, partial: false, unknownSources: [], sources: [], results }),
      fetchManyFn: async () => [
        { id: "doi:10.1/b", text: "content-b\n\n_status: ok_" },
        { id: "doi:10.1/a", text: "content-a\n\n_status: ok_" },
      ],
    });
    const findings = await store.readFindings(created.id);
    expect(findings.find((finding) => finding.result.id.endsWith("/a"))?.content).toContain("content-a");
    expect(findings.find((finding) => finding.result.id.endsWith("/b"))?.content).toContain("content-b");
  });

  it("preserves a concurrent durable cancellation before writing progress", async () => {
    const store = new FileJobStore(await mkdtemp(join(tmpdir(), "labee-agent-cancel-")));
    const spec = normalizeDeepSearchInput({ query: "PCR", browser: "off", maxRounds: 1 });
    const created = await store.create(spec);
    const searchFn = vi.fn(async (query: string): Promise<UnifiedResponse> => {
      const durable = await store.readProgress(created.id);
      durable.cancelRequested = true;
      await store.writeProgress(created.id, durable);
      return { query, partial: false, unknownSources: [], sources: [], results: [] };
    });
    const progress = await runDeepSearchJob(created.id, { store, searchFn, fetchManyFn: async () => [] });
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(progress).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect((await store.readProgress(created.id)).cancelRequested).toBe(true);
  });

  it("resumes a partial keyword without refetching or duplicating a durable finding", async () => {
    const store = new FileJobStore(await mkdtemp(join(tmpdir(), "labee-agent-partial-resume-")));
    const spec = normalizeDeepSearchInput({ query: "PCR", browser: "off", maxRounds: 1 });
    const created = await store.create(spec);
    await store.appendFinding(created.id, {
      ts: spec.createdAt,
      iteration: 1,
      keyword: spec.keywords[0]!,
      result: response(spec.keywords[0]!, "5900").results[1]!,
      nativeStatus: "ok",
      finalStatus: "ok",
      verification: "verified",
      route: "native-fetch",
      attemptedUrls: [],
      content: "already durable",
    });
    const fetched: string[] = [];
    await runDeepSearchJob(created.id, {
      store,
      searchFn: async (query) => response(query, "5900"),
      fetchManyFn: async (ids) => {
        fetched.push(...ids);
        return ids.map((id) => ({ id, text: "new content\n\n_status: ok_" }));
      },
    });
    expect(fetched).toEqual(["doi:10.21769/BioProtoc.5900"]);
    const findings = await store.readFindings(created.id);
    expect(findings.filter((finding) => finding.result.id === "doi:10.1/shared")).toHaveLength(1);
    expect(findings).toHaveLength(2);
  });

  it("persists a deadline stop without counting an incomplete round", async () => {
    const store = new FileJobStore(await mkdtemp(join(tmpdir(), "labee-agent-deadline-")));
    const spec = normalizeDeepSearchInput({ query: "PCR", browser: "off", maxRounds: 3, maxSeconds: 30 });
    const created = await store.create(spec);
    let clock = new Date("2026-08-10T00:00:00Z");
    const searchFn = vi.fn(async (query: string): Promise<UnifiedResponse> => {
      clock = new Date("2026-08-10T00:00:31Z");
      return { query, partial: false, unknownSources: [], sources: [], results: [] };
    });
    const progress = await runDeepSearchJob(created.id, {
      store,
      now: () => clock,
      searchFn,
      fetchManyFn: async () => [],
    });
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(progress).toMatchObject({ status: "completed", completionReason: "deadline", iteration: 0 });
    expect(progress.searchedKeywords).toEqual([]);
  });
});

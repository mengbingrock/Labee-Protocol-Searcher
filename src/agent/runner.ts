import { fetchResource, fetchResources, type FetchRow } from "../fetch.ts";
import { search, type UnifiedOptions, type UnifiedResponse, type UnifiedResult } from "../search.ts";
import {
  betterStatus,
  isVerifiedStatus,
  parseFetchStatus,
  resolutionCandidates,
  verificationFor,
} from "./resolvers.ts";
import type {
  AttemptRecord,
  AttemptRoute,
  BrowserAdapter,
  DeepSearchSpec,
  FetchStatus,
  FindingRecord,
  JobProgress,
  JobStore,
} from "./types.ts";
import { assertSafePublicUrl } from "./url-policy.ts";

export interface AgentDependencies {
  searchFn?: (query: string, options?: UnifiedOptions) => Promise<UnifiedResponse>;
  fetchManyFn?: (ids: readonly string[]) => Promise<FetchRow[]>;
  fetchOneFn?: (id: string) => Promise<string>;
  store: JobStore;
  browser?: BrowserAdapter;
  now?: () => Date;
  /** In-process cancellation; the durable flag remains the restart authority. */
  signal?: AbortSignal;
}

function nowIso(deps: AgentDependencies): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

interface Checkpoint {
  progress: JobProgress;
  stopped: boolean;
}

/** Merge the independently-written cancellation flag before every runner write. */
async function persistProgress(
  jobId: string,
  proposed: JobProgress,
  spec: DeepSearchSpec,
  deps: AgentDependencies,
): Promise<Checkpoint> {
  const durable = await deps.store.readProgress(jobId);
  const now = nowIso(deps);
  const startedAt = proposed.startedAt ?? durable.startedAt ?? now;
  const cancelRequested =
    proposed.cancelRequested ||
    durable.cancelRequested ||
    durable.status === "cancelled" ||
    deps.signal?.aborted === true;
  const deadlineReached = Date.parse(now) - Date.parse(startedAt) >= spec.maxSeconds * 1_000;
  const progress: JobProgress = {
    ...proposed,
    startedAt,
    cancelRequested,
    updatedAt: now,
    ...(cancelRequested
      ? { status: "cancelled" as const }
      : deadlineReached
        ? { status: "completed" as const, completionReason: "deadline" as const }
        : {}),
  };
  await deps.store.writeProgress(jobId, progress);
  return {
    progress,
    stopped: progress.status === "cancelled" || progress.completionReason === "deadline",
  };
}

function allowedHost(url: string): string[] {
  try {
    return [new URL(url).hostname];
  } catch {
    return [];
  }
}

const SOURCE_BROWSER_HOSTS: Record<string, string[]> = {
  "star-protocols": ["doi.org", "cell.com", "linkinghub.elsevier.com", "sciencedirect.com"],
  "nature-protocols": ["doi.org", "nature.com", "springernature.com"],
  jove: ["doi.org", "jove.com"],
  "bio-protocol": ["doi.org", "bio-protocol.org"],
  "current-protocols": ["doi.org", "currentprotocols.onlinelibrary.wiley.com", "onlinelibrary.wiley.com", "wiley.com"],
  "protocols-io": ["doi.org", "protocols.io"],
};

const SEMANTIC_SCHOLAR_VENUES: Record<string, string> = {
  "star-protocols": "STAR Protocols",
  "nature-protocols": "Nature Protocols",
  jove: "Journal of Visualized Experiments",
  "bio-protocol": "Bio-protocol",
  "current-protocols": "Current Protocols",
};

export function browserAllowedHosts(result: UnifiedResult, url: string): string[] {
  return [...new Set([...allowedHost(url), ...(SOURCE_BROWSER_HOSTS[result.source] ?? [])])];
}

function browserSearchResult(raw: { title: string; url: string; snippet: string }, source: string): UnifiedResult {
  const doi = /doi\.org\/(10\.\S+)/i.exec(raw.url);
  const pmid = /pubmed\/(\d+)/i.exec(raw.url);
  const id = doi ? `doi:${decodeURIComponent(doi[1]!)}` : pmid ? `pmid:${pmid[1]}` : `url:${raw.url}`;
  return {
    id,
    source,
    kind: "article",
    title: raw.title,
    url: raw.url,
    snippet: raw.snippet,
    fetchable: id.startsWith("url:") ? "none" : "partial",
  };
}

async function recordAttempt(
  store: JobStore,
  jobId: string,
  attempt: AttemptRecord,
): Promise<void> {
  await store.appendAttempt(jobId, attempt);
}

interface RecoveryResult {
  status: FetchStatus;
  route: AttemptRoute;
  content: string | undefined;
  attemptedUrls: string[];
}

async function recover(
  jobId: string,
  iteration: number,
  keyword: string,
  result: UnifiedResult,
  nativeText: string,
  spec: DeepSearchSpec,
  progress: JobProgress,
  deps: AgentDependencies,
): Promise<RecoveryResult> {
  let status = parseFetchStatus(nativeText);
  let route: AttemptRoute = "native-fetch";
  let content = status === "ok" || status === "abstract-only" ? nativeText : undefined;
  const attemptedUrls: string[] = [];
  if (isVerifiedStatus(status)) return { status, route, content, attemptedUrls };

  const candidates = resolutionCandidates(result, nativeText);
  for (const candidate of candidates) {
    attemptedUrls.push(candidate.url);
    const started = Date.now();
    let text = "";
    let candidateStatus: FetchStatus;
    try {
      await assertSafePublicUrl(candidate.url, allowedHost(candidate.url));
      text = deps.fetchOneFn
        ? await deps.fetchOneFn(`url:${candidate.url}`)
        : await fetchResource(`url:${candidate.url}`, {
          validateUrl: async (redirectUrl) => {
            await assertSafePublicUrl(redirectUrl, browserAllowedHosts(result, candidate.url));
          },
        });
      candidateStatus = parseFetchStatus(text);
    } catch (err) {
      candidateStatus = /unsafe-url/i.test(String(err)) ? "unsafe-url" : "error";
      text = err instanceof Error ? err.message : "candidate fetch failed";
    }
    await recordAttempt(deps.store, jobId, {
      ts: nowIso(deps),
      iteration,
      keyword,
      resultId: result.id,
      source: result.source,
      route: candidate.route,
      status: candidateStatus,
      elapsedMs: Date.now() - started,
      contentChars: text.length,
      url: candidate.url,
    });
    const best = betterStatus(status, candidateStatus);
    if (best !== status) {
      status = best;
      route = candidate.route;
      if (candidateStatus === "ok" || candidateStatus === "abstract-only") content = text;
    }
    if (isVerifiedStatus(status)) return { status, route, content, attemptedUrls };
  }

  if (spec.browser === "off" || !deps.browser || progress.browserPages >= spec.maxBrowserPages) {
    return { status, route, content, attemptedUrls };
  }
  const browserState = await deps.browser.available();
  if (!browserState.available) {
    await recordAttempt(deps.store, jobId, {
      ts: nowIso(deps), iteration, keyword, resultId: result.id, source: result.source,
      route: "browser-cdp", status: "browser-unavailable", elapsedMs: 0, contentChars: 0,
      adapter: deps.browser.id,
      ...(browserState.reason ? { detail: browserState.reason } : {}),
    });
    return { status: betterStatus(status, "browser-unavailable"), route, content, attemptedUrls };
  }

  const browserUrls = [...new Set([result.url, ...candidates.map((c) => c.url)].filter((x): x is string => Boolean(x)))];
  for (const url of browserUrls) {
    if (progress.browserPages >= spec.maxBrowserPages) break;
    progress.browserPages++;
    const started = Date.now();
    const hit = await deps.browser.retrieve({
      url,
      sourceId: result.source,
      allowedHosts: browserAllowedHosts(result, url),
      maxChars: 80_000,
      timeoutMs: 20_000,
    });
    const browserStatus: FetchStatus = hit.status === "unavailable" ? "browser-unavailable" : hit.status;
    await recordAttempt(deps.store, jobId, {
      ts: nowIso(deps), iteration, keyword, resultId: result.id, source: result.source,
      route: "browser-cdp", status: browserStatus, elapsedMs: Date.now() - started,
      contentChars: hit.text?.length ?? 0, url,
      adapter: hit.provenance.adapter,
      provenanceRoute: hit.provenance.route,
      ...(hit.provenance.capturedUrl ? { capturedUrl: hit.provenance.capturedUrl } : {}),
      ...(hit.finalUrl ? { finalUrl: hit.finalUrl } : {}),
      ...(hit.detail ? { detail: hit.detail } : {}),
    });
    const best = betterStatus(status, browserStatus);
    if (best !== status) {
      status = best;
      route = "browser-cdp";
      if (browserStatus === "ok") content = hit.text;
    }
    if (isVerifiedStatus(status)) break;
  }
  return { status, route, content, attemptedUrls };
}

export async function runDeepSearchJob(jobId: string, deps: AgentDependencies): Promise<JobProgress> {
  const spec = await deps.store.readSpec(jobId);
  let progress = await deps.store.readProgress(jobId);
  const prior = await deps.store.readFindings(jobId);
  const priorAttempts = await deps.store.readAttempts(jobId);
  const durableFindingIds = new Set(prior.map((finding) => finding.result.id));
  const uniqueIds = new Set(durableFindingIds);
  const verifiedIds = new Set(
    prior.filter((finding) => finding.verification === "verified").map((finding) => finding.result.id),
  );
  const searchFn = deps.searchFn ?? search;
  const fetchMany = deps.fetchManyFn ?? ((ids) => fetchResources(ids));
  progress = {
    ...progress,
    status: "running",
    uniqueResults: Math.max(progress.uniqueResults, uniqueIds.size),
    fetchedResults: durableFindingIds.size,
    verifiedResults: verifiedIds.size,
    nativeFetchAttempts: Math.max(
      progress.nativeFetchAttempts,
      priorAttempts.filter((attempt) => attempt.route === "native-fetch").length,
    ),
    backendAttempts: Math.max(
      progress.backendAttempts,
      priorAttempts.filter((attempt) => attempt.route === "search-backend").length,
    ),
  };
  let checkpoint = await persistProgress(jobId, progress, spec, deps);
  progress = checkpoint.progress;
  if (checkpoint.stopped) return progress;

  while (progress.iteration < spec.maxRounds) {
    const iteration = progress.iteration + 1;
    const verifiedBeforeRound = new Set(
      prior
        .filter((finding) => finding.iteration < iteration && finding.verification === "verified")
        .map((finding) => finding.result.id),
    ).size;
    progress.roundVerifiedBaseline ??= verifiedBeforeRound;

    for (const keyword of spec.keywords) {
      checkpoint = await persistProgress(jobId, progress, spec, deps);
      progress = checkpoint.progress;
      if (checkpoint.stopped) return progress;
      if (progress.searchedKeywords.includes(keyword)) continue;

      const response = await searchFn(keyword, {
        ...(spec.sources ? { sources: spec.sources } : {}),
        limit: spec.limit,
        concurrency: 6,
        providerOpts: { timeoutMs: 5_000 },
      });
      checkpoint = await persistProgress(jobId, progress, spec, deps);
      progress = checkpoint.progress;
      if (checkpoint.stopped) return progress;

      const resultsById = new Map<string, UnifiedResult>();
      for (const result of response.results) resultsById.set(result.id, result);

      if (spec.browser !== "off" && deps.browser?.search) {
        for (const source of response.sources) {
          const semanticScholar = source.providers?.find((provider) => provider.id === "semanticscholar");
          if (!semanticScholar || progress.browserSearchPages >= spec.maxBrowserSearchPages) continue;
          checkpoint = await persistProgress(jobId, progress, spec, deps);
          progress = checkpoint.progress;
          if (checkpoint.stopped) return progress;
          progress.browserSearchPages++;
          const started = Date.now();
          const hit = await deps.browser.search({
            query: keyword,
            sourceId: source.id,
            venue: SEMANTIC_SCHOLAR_VENUES[source.id] ?? source.name,
            limit: spec.limit,
            timeoutMs: 20_000,
          });
          const status: FetchStatus = hit.status === "not-found" ? "empty" : hit.status;
          await recordAttempt(deps.store, jobId, {
            ts: nowIso(deps), iteration, keyword,
            resultId: `backend:${source.id}/semanticscholar-browser`,
            source: source.id,
            route: "search-backend",
            status,
            elapsedMs: Date.now() - started,
            contentChars: 0,
            adapter: hit.provenance.adapter,
            provenanceRoute: hit.provenance.route,
            ...(hit.provenance.capturedUrl ? { capturedUrl: hit.provenance.capturedUrl } : {}),
            detail: `${hit.results.length} result(s)${hit.detail ? `; ${hit.detail}` : ""}`,
          });
          progress.backendAttempts++;
          for (const raw of hit.results) {
            const result = browserSearchResult(raw, source.id);
            if (!resultsById.has(result.id)) resultsById.set(result.id, result);
          }
          checkpoint = await persistProgress(jobId, progress, spec, deps);
          progress = checkpoint.progress;
          if (checkpoint.stopped) return progress;
        }
      }

      for (const source of response.sources) {
        for (const provider of source.providers ?? []) {
          await recordAttempt(deps.store, jobId, {
            ts: nowIso(deps),
            iteration,
            keyword,
            resultId: `backend:${source.id}/${provider.id}`,
            source: source.id,
            route: "search-backend",
            status: provider.status,
            elapsedMs: provider.elapsedMs,
            contentChars: 0,
            detail: `${provider.count} result(s)${provider.error ? `; ${provider.error}` : ""}`,
          });
          progress.backendAttempts++;
        }
      }

      const results = [...resultsById.values()];
      // Count the per-keyword result set after native and browser search have
      // been merged. IDs repeated by another keyword remain occurrences, while
      // duplicates inside this keyword are counted once.
      progress.resultOccurrences += results.length;
      for (const result of results) uniqueIds.add(result.id);
      progress.uniqueResults = uniqueIds.size;
      const unfetched = results.filter((result) => !durableFindingIds.has(result.id));

      checkpoint = await persistProgress(jobId, progress, spec, deps);
      progress = checkpoint.progress;
      if (checkpoint.stopped) return progress;
      const started = Date.now();
      const rows = unfetched.length > 0 ? await fetchMany(unfetched.map((result) => result.id)) : [];
      const rowById = new Map(rows.map((row) => [row.id, row.text]));
      progress.nativeFetchAttempts += unfetched.length;
      checkpoint = await persistProgress(jobId, progress, spec, deps);
      progress = checkpoint.progress;
      if (checkpoint.stopped) return progress;

      for (const result of unfetched) {
        // A restart may have persisted a finding after this keyword was searched
        // but before its completion marker was written.
        if (durableFindingIds.has(result.id)) continue;
        const nativeText = rowById.get(result.id) ?? "_status: error_";
        const nativeStatus = parseFetchStatus(nativeText);
        await recordAttempt(deps.store, jobId, {
          ts: nowIso(deps), iteration, keyword, resultId: result.id, source: result.source,
          route: "native-fetch", status: nativeStatus,
          elapsedMs: Math.floor((Date.now() - started) / Math.max(1, unfetched.length)),
          contentChars: nativeText.length,
        });
        checkpoint = await persistProgress(jobId, progress, spec, deps);
        progress = checkpoint.progress;
        if (checkpoint.stopped) return progress;
        const recovered = await recover(jobId, iteration, keyword, result, nativeText, spec, progress, deps);
        const finding: FindingRecord = {
          ts: nowIso(deps), iteration, keyword, result, nativeStatus,
          finalStatus: recovered.status,
          verification: verificationFor(recovered.status),
          route: recovered.route,
          attemptedUrls: recovered.attemptedUrls,
          ...(recovered.content ? { content: recovered.content } : {}),
        };
        await deps.store.appendFinding(jobId, finding);
        durableFindingIds.add(result.id);
        if (finding.verification === "verified") verifiedIds.add(result.id);
        progress.fetchedResults = durableFindingIds.size;
        progress.verifiedResults = verifiedIds.size;
        checkpoint = await persistProgress(jobId, progress, spec, deps);
        progress = checkpoint.progress;
        if (checkpoint.stopped) return progress;
      }

      progress.searchedKeywords = [...progress.searchedKeywords, keyword];
      checkpoint = await persistProgress(jobId, progress, spec, deps);
      progress = checkpoint.progress;
      if (checkpoint.stopped) return progress;
    }

    progress.iteration = iteration;
    progress.staleCount =
      verifiedIds.size > (progress.roundVerifiedBaseline ?? verifiedBeforeRound)
        ? 0
        : progress.staleCount + 1;
    progress.roundVerifiedBaseline = verifiedIds.size;

    if (progress.staleCount >= 4) {
      progress.status = "completed";
      progress.completionReason = "stale-limit";
    } else if (progress.iteration >= spec.maxRounds) {
      progress.status = "completed";
      progress.completionReason = "max-rounds";
    } else {
      // This marker is the durable transaction boundary between rounds. An
      // empty list means the next resume starts a fresh five-keyword round.
      progress.searchedKeywords = [];
    }
    checkpoint = await persistProgress(jobId, progress, spec, deps);
    progress = checkpoint.progress;
    if (checkpoint.stopped || progress.status === "completed") return progress;
  }

  progress.status = "completed";
  progress.completionReason = "max-rounds";
  checkpoint = await persistProgress(jobId, progress, spec, deps);
  return checkpoint.progress;
}

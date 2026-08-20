import { browserAdapterForMode } from "./default-browser.ts";
import { runDeepSearchJob, type AgentDependencies } from "./runner.ts";
import { FileJobStore } from "./store.ts";
import type { DeepSearchInput, DeepSearchSpec, JobProgress, JobSnapshot, JobStore } from "./types.ts";

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value!) : fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeDeepSearchInput(input: DeepSearchInput, now = new Date()): DeepSearchSpec {
  const query = input.query?.trim();
  if (!query) throw new Error("`query` is required");
  const supplied = input.keywords?.map((keyword) => keyword.trim()).filter(Boolean);
  if (supplied && supplied.length !== 5) throw new Error("`keywords` must contain exactly five entries");
  const keywords = supplied ?? [query, `${query} protocol`, `${query} methods`, `${query} step-by-step`, `${query} open access`];
  if (new Set(keywords.map((keyword) => keyword.toLowerCase())).size !== 5) {
    throw new Error("`keywords` must contain five distinct entries");
  }
  return {
    query,
    keywords,
    ...(input.sources?.length ? { sources: [...new Set(input.sources.map((source) => source.trim()).filter(Boolean))] } : {}),
    limit: clamp(input.limit, 1, 1, 10),
    maxRounds: clamp(input.maxRounds, 2, 1, 15),
    maxSeconds: clamp(input.maxSeconds, 300, 30, 1_800),
    maxBrowserPages: clamp(input.maxBrowserPages, 5, 0, 20),
    maxBrowserSearchPages: clamp(input.maxBrowserSearchPages, 30, 0, 50),
    browser: input.browser ?? "auto",
    createdAt: now.toISOString(),
  };
}

export class DeepSearchService {
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly store: JobStore;
  private readonly dependencies: Omit<AgentDependencies, "store">;

  constructor(store: JobStore = new FileJobStore(), dependencies: Omit<AgentDependencies, "store"> = {}) {
    this.store = store;
    this.dependencies = dependencies;
  }

  async start(input: DeepSearchInput): Promise<JobProgress> {
    const progress = await this.store.create(normalizeDeepSearchInput(input));
    this.schedule(progress.id);
    return progress;
  }

  private schedule(id: string): void {
    if (this.active.has(id)) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const promise = this.run(id, controller.signal).finally(() => {
      this.active.delete(id);
      this.controllers.delete(id);
    });
    this.active.set(id, promise);
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    try {
      const spec = await this.store.readSpec(id);
      const browser = this.dependencies.browser ?? browserAdapterForMode(spec.browser);
      await runDeepSearchJob(id, {
        store: this.store,
        ...this.dependencies,
        signal,
        ...(browser ? { browser } : {}),
      });
    } catch (err) {
      const progress = await this.store.readProgress(id);
      const cancelled = progress.cancelRequested || signal.aborted;
      progress.cancelRequested = cancelled;
      progress.status = cancelled ? "cancelled" : "failed";
      if (!cancelled) progress.error = err instanceof Error ? err.message : "deep search failed";
      progress.updatedAt = new Date().toISOString();
      await this.store.writeProgress(id, progress);
    }
  }

  async get(id: string): Promise<JobSnapshot> {
    const [spec, progress, findings, attempts] = await Promise.all([
      this.store.readSpec(id),
      this.store.readProgress(id),
      this.store.readFindings(id),
      this.store.readAttempts(id),
    ]);
    return { spec, progress, findings, attempts };
  }

  async cancel(id: string): Promise<JobProgress> {
    this.controllers.get(id)?.abort();
    const progress = await this.store.readProgress(id);
    if (progress.status === "completed" || progress.status === "failed" || progress.status === "cancelled") {
      return progress;
    }
    progress.cancelRequested = true;
    if (progress.status === "queued") progress.status = "cancelled";
    progress.updatedAt = new Date().toISOString();
    await this.store.writeProgress(id, progress);
    return progress;
  }

  async resumeIncompleteJobs(): Promise<string[]> {
    const ids = await this.store.listIncomplete();
    for (const id of ids) this.schedule(id);
    return ids;
  }
}

let singleton: DeepSearchService | undefined;

export function deepSearchService(): DeepSearchService {
  singleton ??= new DeepSearchService();
  return singleton;
}

import type { UnifiedResult } from "../search.ts";
import type { RawResult } from "../providers/types.ts";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type FetchStatus =
  | "ok"
  | "entitled-full-text"
  | "display-only-full-text"
  | "display-only-link"
  | "abstract-only"
  | "oa-link"
  | "no-open-fulltext"
  | "not-fetchable"
  | "not-found"
  | "bad-id"
  | "error"
  | "no-status"
  | "empty"
  | "unavailable"
  | "blocked"
  | "timeout"
  | "unsafe-url"
  | "browser-unavailable";

export type AttemptRoute =
  | "native-fetch"
  | "oa-link"
  | "deterministic-pdf"
  | "publisher-url"
  | "search-backend"
  | "browser-cdp";

export interface DeepSearchInput {
  query: string;
  keywords?: string[];
  sources?: string[];
  limit?: number;
  maxRounds?: number;
  maxSeconds?: number;
  maxBrowserPages?: number;
  maxBrowserSearchPages?: number;
  browser?: "auto" | "off" | "cdp";
}

export interface DeepSearchSpec {
  query: string;
  keywords: string[];
  sources?: string[];
  limit: number;
  maxRounds: number;
  maxSeconds: number;
  maxBrowserPages: number;
  maxBrowserSearchPages: number;
  browser: "auto" | "off" | "cdp";
  createdAt: string;
}

export interface JobProgress {
  id: string;
  status: JobStatus;
  iteration: number;
  staleCount: number;
  searchedKeywords: string[];
  resultOccurrences: number;
  uniqueResults: number;
  nativeFetchAttempts: number;
  backendAttempts: number;
  fetchedResults: number;
  verifiedResults: number;
  browserPages: number;
  browserSearchPages: number;
  cancelRequested: boolean;
  createdAt: string;
  /** Set once when execution first starts; deadlines survive process restarts. */
  startedAt?: string;
  /** Verified-result count at the start of the current, possibly partial round. */
  roundVerifiedBaseline?: number;
  completionReason?: "max-rounds" | "deadline" | "stale-limit";
  updatedAt: string;
  error?: string;
}

export interface AttemptRecord {
  ts: string;
  iteration: number;
  keyword: string;
  resultId: string;
  source: string;
  route: AttemptRoute;
  status: FetchStatus;
  elapsedMs: number;
  contentChars: number;
  url?: string;
  /** Browser-specific provenance, present for CDP retrieval and search attempts. */
  adapter?: string;
  provenanceRoute?: string;
  capturedUrl?: string;
  finalUrl?: string;
  detail?: string;
}

export interface FindingRecord {
  ts: string;
  iteration: number;
  keyword: string;
  result: UnifiedResult;
  nativeStatus: FetchStatus;
  finalStatus: FetchStatus;
  verification: "verified" | "partial" | "unresolved" | "blocked";
  route: AttemptRoute;
  attemptedUrls: string[];
  content?: string;
}

export interface JobSnapshot {
  spec: DeepSearchSpec;
  progress: JobProgress;
  findings: FindingRecord[];
  attempts: AttemptRecord[];
}

export type BrowserEvidenceStatus =
  | "ok"
  | "blocked"
  | "not-found"
  | "unsafe-url"
  | "timeout"
  | "unavailable";

export interface BrowserRequest {
  url: string;
  sourceId: string;
  allowedHosts: string[];
  maxChars: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface BrowserEvidence {
  status: BrowserEvidenceStatus;
  finalUrl?: string;
  title?: string;
  text?: string;
  format?: "dom" | "json-xhr" | "pdf";
  detail?: string;
  provenance: { adapter: string; route: string; capturedUrl?: string };
}

export interface BrowserSearchRequest {
  query: string;
  sourceId: string;
  venue: string;
  limit: number;
  timeoutMs: number;
}

export interface BrowserSearchEvidence {
  status: BrowserEvidenceStatus;
  results: RawResult[];
  detail?: string;
  provenance: { adapter: string; route: string; capturedUrl?: string };
}

export interface BrowserAdapter {
  readonly id: string;
  available(): Promise<{ available: boolean; reason?: string }>;
  retrieve(request: BrowserRequest): Promise<BrowserEvidence>;
  search?(request: BrowserSearchRequest): Promise<BrowserSearchEvidence>;
  close(): Promise<void>;
}

export interface JobStore {
  create(spec: DeepSearchSpec): Promise<JobProgress>;
  readSpec(id: string): Promise<DeepSearchSpec>;
  readProgress(id: string): Promise<JobProgress>;
  writeProgress(id: string, progress: JobProgress): Promise<void>;
  appendFinding(id: string, finding: FindingRecord): Promise<void>;
  appendAttempt(id: string, attempt: AttemptRecord): Promise<void>;
  readFindings(id: string): Promise<FindingRecord[]>;
  readAttempts(id: string): Promise<AttemptRecord[]>;
  listIncomplete(): Promise<string[]>;
}

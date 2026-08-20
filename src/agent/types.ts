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
  | "interaction-required"
  | "timeout"
  | "unsafe-url"
  | "browser-unavailable"
  | "chrome-browser-required";

export type BrowserEvidenceStatus =
  | "ok"
  | "blocked"
  | "interaction-required"
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
  /** Extra time for a user to complete a visible anti-bot challenge. */
  interactionTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface BrowserEvidence {
  status: BrowserEvidenceStatus;
  finalUrl?: string;
  title?: string;
  text?: string;
  /** Rendered content HTML captured from article/main/body in the browser. */
  html?: string;
  links?: string[];
  format?: "dom" | "json-xhr" | "pdf";
  detail?: string;
  provenance: { adapter: string; route: string; capturedUrl?: string };
}

export interface BrowserAdapter {
  readonly id: string;
  available(): Promise<{ available: boolean; reason?: string }>;
  retrieve(request: BrowserRequest): Promise<BrowserEvidence>;
  close(): Promise<void>;
}

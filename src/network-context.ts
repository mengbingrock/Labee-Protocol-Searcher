// Which kind of network are we calling from?
//
// This matters because entitlement is decided by IP. On a university network a
// publisher serves subscribed full text to an ordinary request; from a
// datacenter the same request gets an abstract stub — and vendor sites are
// *more* hostile to datacenter ranges, not less. Retrieval that silently
// depends on the answer should at least know it, and say so.
//
// Detected once per process, cached, and never fatal: an unreachable detector
// resolves to "unknown", which behaves exactly like "commercial" but reports
// itself honestly rather than asserting something it did not establish.
//
// Set PROTOCOLS_NETWORK_KIND to skip detection entirely (academic | commercial
// | unknown), or PROTOCOLS_NETWORK_DETECT=off to disable the outbound lookup.

import { reverse } from "node:dns/promises";

export type NetworkKind = "academic" | "commercial" | "unknown";

export interface NetworkContext {
  kind: NetworkKind;
  /** Public IP, when a lookup established one. */
  ip?: string;
  /** ASN / organisation string as reported by the lookup. */
  org?: string;
  /** Reverse-DNS name of `ip`, when it resolves. */
  rdns?: string;
  /** Which signal decided `kind` — surfaced so the verdict is auditable. */
  reason: string;
  detectedAt: string;
}

const DEFAULT_LOOKUP_URL = "https://ipinfo.io/json";
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Organisation-name signals. Deliberately includes non-English spellings
 * (universität/université/universidad all share the "universit" stem) and the
 * national research-and-education networks, whose ASNs front entire
 * university systems: Internet2 and ESnet (US), JISC/Janet (UK), GÉANT (EU),
 * RENATER (FR), SURF (NL), DFN (DE), CERNET (CN), SINET (JP), AARNet (AU).
 */
// `universi[td]\w*` rather than `universit` with a trailing \b. Two traps here: a
// word boundary straight after "universit" matches none of University /
// Universität / Université, and the Iberian spellings (Universidad, Universidade)
// use a d where the rest use a t.
const ACADEMIC_ORG_RE =
  /\b(?:universi[td]\w*|college|institute of technology|polytechnic\w*|academy of sciences|research (?:council|institute|network)|school of medicine|teaching hospital|internet2|esnet|geant|renater|surfnet|surf b\.?v|jisc|janet|dfn-verein|cernet|sinet|aarnet|nordunet|funet|cesnet|garr|rediris|max planck|helmholtz|fraunhofer|leibniz|cnrs|inserm|csic|riken|tubitak)\b/i;

/** Academic/education TLD shapes: .edu, .ac.uk, .edu.au, .ac.jp, .edu.cn … */
const ACADEMIC_HOST_RE = /(?:^|\.)(?:edu|ac)(?:\.[a-z]{2,3})?$/i;

let cached: NetworkContext | undefined;
let inFlight: Promise<NetworkContext> | undefined;

function fromEnvOverride(): NetworkContext | undefined {
  const forced = process.env.PROTOCOLS_NETWORK_KIND?.trim().toLowerCase();
  if (forced !== "academic" && forced !== "commercial" && forced !== "unknown") return undefined;
  return {
    kind: forced,
    reason: "PROTOCOLS_NETWORK_KIND override",
    detectedAt: new Date().toISOString(),
  };
}

interface IpInfo {
  ip?: unknown;
  org?: unknown;
  hostname?: unknown;
}

/** Classify from whatever signals we managed to gather. Pure, so it is testable. */
export function classify(signals: { org?: string; rdns?: string }): {
  kind: NetworkKind;
  reason: string;
} {
  const { org, rdns } = signals;
  if (rdns) {
    const host = rdns.replace(/\.$/, "").toLowerCase();
    if (ACADEMIC_HOST_RE.test(host)) return { kind: "academic", reason: `reverse DNS ${host}` };
  }
  if (org && ACADEMIC_ORG_RE.test(org)) {
    return { kind: "academic", reason: `network operator "${org}"` };
  }
  if (rdns && ACADEMIC_ORG_RE.test(rdns)) {
    return { kind: "academic", reason: `reverse DNS ${rdns}` };
  }
  if (org) return { kind: "commercial", reason: `network operator "${org}"` };
  if (rdns) return { kind: "commercial", reason: `reverse DNS ${rdns}` };
  return { kind: "unknown", reason: "no network signals available" };
}

async function lookupPublicIp(timeoutMs: number): Promise<IpInfo | null> {
  const url = process.env.PROTOCOLS_NETWORK_LOOKUP_URL || DEFAULT_LOOKUP_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "labee-protocol-searcher/network-context" },
    });
    if (!res.ok) return null;
    return (await res.json()) as IpInfo;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function reverseDns(ip: string): Promise<string | undefined> {
  try {
    const names = await reverse(ip);
    return names[0];
  } catch {
    return undefined;
  }
}

/**
 * Resolve the network context, at most once per process. Concurrent callers
 * share one in-flight detection rather than racing duplicate lookups.
 */
export async function detectNetworkContext(
  opts: { timeoutMs?: number } = {},
): Promise<NetworkContext> {
  if (cached) return cached;
  const override = fromEnvOverride();
  if (override) return (cached = override);
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<NetworkContext> => {
    const detectedAt = new Date().toISOString();
    if (process.env.PROTOCOLS_NETWORK_DETECT?.trim().toLowerCase() === "off") {
      return { kind: "unknown", reason: "detection disabled", detectedAt };
    }
    const timeoutMs = Number(process.env.PROTOCOLS_NETWORK_TIMEOUT_MS) || opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const info = await lookupPublicIp(timeoutMs);
    const ip = typeof info?.ip === "string" ? info.ip : undefined;
    const org = typeof info?.org === "string" ? info.org : undefined;
    // Prefer the lookup's own hostname; fall back to an actual rDNS query,
    // which costs nothing extra now that we have the address.
    const rdns =
      (typeof info?.hostname === "string" ? info.hostname : undefined) ??
      (ip ? await reverseDns(ip) : undefined);

    const { kind, reason } = classify({ ...(org ? { org } : {}), ...(rdns ? { rdns } : {}) });
    return {
      kind,
      reason,
      detectedAt,
      ...(ip ? { ip } : {}),
      ...(org ? { org } : {}),
      ...(rdns ? { rdns } : {}),
    };
  })();

  try {
    cached = await inFlight;
    return cached;
  } finally {
    inFlight = undefined;
  }
}

/** The cached context, or undefined when detection has not run yet. */
export function networkContext(): NetworkContext | undefined {
  return cached;
}

/**
 * True when this process is calling from a network that may carry institutional
 * subscriptions. Callers use it to decide whether attempting a publisher page
 * is worth a round trip — never to claim entitlement it has not observed.
 */
export function onAcademicNetwork(): boolean {
  return cached?.kind === "academic";
}

/** Test seam. */
export function resetNetworkContext(): void {
  cached = undefined;
  inFlight = undefined;
}

/**
 * The institution's own name, with the ASN prefix stripped — "AS26488 Santa Clara
 * University" becomes "Santa Clara University". Publishers print this name on the
 * page when they recognise the IP, both to grant ("full access via …") and to
 * refuse ("… does not provide access to this content"), so it is the key that
 * makes entitlement detection publisher-neutral.
 */
export function institutionName(): string | undefined {
  const org = cached?.org?.trim();
  if (!org) return undefined;
  const name = org.replace(/^AS\d+\s+/i, "").trim();
  return name.length > 2 ? name : undefined;
}

/** One-line summary for the startup banner. */
export function describeNetworkContext(ctx: NetworkContext): string {
  const where = ctx.ip ? ` ${ctx.ip}` : "";
  return `network: ${ctx.kind}${where} (${ctx.reason})`;
}

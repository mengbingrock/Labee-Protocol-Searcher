// Does this institution actually pay for this journal?
//
// Being on a university network is necessary but not sufficient. Wiley, for
// example, recognises the IP and prints "Santa Clara University" in its banner,
// then still refuses the article — the subscription simply does not cover that
// title. Springer Nature, from the same address, says "You have full access to
// this article via Santa Clara University" and serves the PDF.
//
// So entitlement is a second, finer question than network kind, and it is decided
// per journal rather than per publisher: an institution may hold Nature Protocols
// and not Nature Methods, both on nature.com.
//
// Publishers answer that question on the landing page, in prose, using the
// institution's own name. That makes the check publisher-neutral: take the name
// we already detected from the network, and look for it next to a grant or a
// refusal. Verdicts are cached per journal for the process, so the second article
// from a journal we know is unavailable costs nothing at all.

export type Entitlement = "entitled" | "not-entitled" | "unknown";

export interface EntitlementVerdict {
  status: Entitlement;
  /** The phrase that decided it, for reporting rather than guessing. */
  evidence: string;
}

/** Escape a detected institution name before splicing it into a pattern. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Refusals are checked first and win ties. A landing page routinely offers
// "Institutional login" as furniture even when access is already granted, so a
// login prompt alone proves nothing; only an explicit denial or a purchase price
// does. Getting this backwards would suppress content we are entitled to.
const DENY_RE = [
  /does not provide access to this content/i,
  /your institution does not have access/i,
  /no access to this content/i,
  /\bbuy (?:this )?(?:article|chapter|pdf)\b/i,
  /\bpurchase (?:this )?(?:article|pdf|access)\b/i,
  /\brent this article\b/i,
  /\bget access\b/i,
];

const GRANT_RE = [
  /you have full access to this (?:article|content|protocol)/i,
  /\bfull access\b[^.]{0,60}\bvia\b/i,
  /access provided by/i,
  /\byou have access\b/i,
];

/**
 * Read a publisher landing page for an entitlement statement.
 *
 * `institution` is the name detected from the network. When the page names it
 * directly the verdict is strong; the generic patterns are the fallback for
 * publishers that phrase it impersonally.
 */
export function classifyEntitlement(html: string, institution?: string): EntitlementVerdict {
  if (institution) {
    const name = escapeRe(institution);
    // The exact shape Wiley uses. Checked first because it is unambiguous.
    const namedDenial = new RegExp(`${name}[^.]{0,80}does not provide access`, "i");
    if (namedDenial.test(html)) {
      return { status: "not-entitled", evidence: `"${institution} does not provide access"` };
    }
    const namedGrant = new RegExp(`full access[^.]{0,80}${name}`, "i");
    if (namedGrant.test(html)) {
      return { status: "entitled", evidence: `"full access … ${institution}"` };
    }
  }
  for (const re of DENY_RE) {
    const m = re.exec(html);
    if (m) return { status: "not-entitled", evidence: `"${m[0]}"` };
  }
  for (const re of GRANT_RE) {
    const m = re.exec(html);
    if (m) return { status: "entitled", evidence: `"${m[0]}"` };
  }
  return { status: "unknown", evidence: "no entitlement statement on the page" };
}

// Cached per journal, not per publisher: one nature.com subscription does not
// imply another. Falls back to the host when no journal title is known, which is
// the coarse-but-safe key.
const cache = new Map<string, EntitlementVerdict>();

export function entitlementKey(url: string, journal?: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    host = url;
  }
  return `${host}::${(journal ?? "").toLowerCase()}`;
}

export function cachedEntitlement(key: string): EntitlementVerdict | undefined {
  return cache.get(key);
}

export function rememberEntitlement(key: string, verdict: EntitlementVerdict): void {
  // "unknown" is not worth remembering — the next article may say more, and
  // caching it would freeze the ambiguity for the whole process.
  if (verdict.status !== "unknown") cache.set(key, verdict);
}

/** Test seam. */
export function resetEntitlementCache(): void {
  cache.clear();
}

export function entitlementCacheSize(): number {
  return cache.size;
}

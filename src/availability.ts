// How available is a given DOI's full text, judged only from what we know right
// now?
//
// This used to be backed by a shared `fetchability-index.json` — a file of
// timestamped per-DOI observations, published in the repo and pulled from GitHub
// at runtime, that let a search label a result "verified-full-text (CI <date>)".
// That was dropped deliberately. Two reasons:
//
//   1. It asserted a global truth from one observer. An observation recorded by
//      CI describes what CI's network could reach on one day; "verified" told
//      every other caller something that was never measured for them. Once
//      retrieval became network-dependent (see network-context.ts) the claim
//      stopped being portable at all.
//   2. It was write-shared state. Anything that recorded observations back into
//      it — including a run with institutional entitlement — would publish an
//      availability claim that nobody else could reproduce.
//
// What remains is strictly per-request and shares nothing: the journal's prior,
// refined by open-access signals the scholarly backends returned for this exact
// query, in this process, moments ago. Weaker claims, but every one of them is
// true for the caller reading it.

export type Availability =
  | "likely-fetchable"
  | "unknown"
  | "unlikely-fetchable";

export interface DoiAvailabilityEvidence {
  availability: Availability;
  /** How the verdict was reached. No "verified" tier exists any more, by design. */
  confidence: "metadata" | "journal-prior";
  journalPrior: "full" | "partial" | "none";
  /** Which backends supplied the open-access signals, when confidence is "metadata". */
  signals?: string[];
}

/**
 * Journal prior first, refined by live provider signals. `oaSignals` are the
 * open-access indicators the scholarly backends attached to this result during
 * this search — Europe PMC's `isOpenAccess`, OpenAlex's `is_oa`, and so on.
 */
export function assessDoiAvailability(
  journalPrior: "full" | "partial" | "none",
  oaSignals: readonly string[] = [],
): DoiAvailabilityEvidence {
  if (oaSignals.length > 0) {
    return {
      availability: "likely-fetchable",
      confidence: "metadata",
      journalPrior,
      signals: [...new Set(oaSignals)],
    };
  }
  return {
    availability:
      journalPrior === "full"
        ? "likely-fetchable"
        : journalPrior === "none"
          ? "unlikely-fetchable"
          : "unknown",
    confidence: "journal-prior",
    journalPrior,
  };
}

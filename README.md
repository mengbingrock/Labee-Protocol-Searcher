# Labee Protocol Searcher

## Find lab protocols your AI assistant can actually use

Labee helps researchers move from a scientific question to useful protocol
content without searching journal sites, vendor catalogs, and enzyme databases
one by one.

Ask for a method in ordinary language. Labee searches across trusted protocol
publishers and suppliers, brings matching results together, and tells your AI
assistant what can be read now—full text, abstract, open-access link, or source
link only.

It works as a connector for ChatGPT, Claude, Codex, and other assistants that
support MCP.

## Install the Codex plugin

The public Labee marketplace packages the MCP server with a skill that prefers
Codex's integrated Browser for NEB search and retrieval.

```bash
codex plugin marketplace add mengbingrock/Labee-Protocol-Searcher --ref main
codex plugin add labee-protocol-searcher@labee_market
```

Start a new Codex conversation after installation so the plugin's tools and
skill are loaded. The plugin downloads the pinned public npm release
`@mengbingrock/labee-protocol-searcher@0.4.1` when its MCP server starts.

## The problems Labee solves

| What slows researchers down | How Labee helps |
| --- | --- |
| Protocols are scattered across journals, supplier sites, and databases. | One request searches all supported sources and presents the results together. |
| Publisher and supplier search pages often block automation or hide results behind interactive pages. | Labee uses several independent discovery routes and keeps a direct source link when a page cannot be read automatically. |
| A promising search result may lead to a paywall, an abstract, or a broken page. | Every result says what Labee expects to be readable, and every retrieval reports what it actually got — the two are never conflated. |
| One literature index can miss an important paper or be temporarily unavailable. | Labee checks multiple scholarly indexes and combines their findings instead of stopping after the first successful search. |
| Restriction-enzyme details are difficult to extract from commercial product pages. | Labee reads the open REBASE record for recognition sites, cut positions, isoschizomers, methylation sensitivity, and suppliers. |

## What you can ask

- “Find RNA extraction protocols for FFPE tissue that include
  deparaffinization, proteinase K, and DNase treatment.”
- “Compare open protocols for Gibson assembly.”
- “Find a spatial transcriptomics protocol for formalin-fixed samples.”
- “Show me the recognition site and cut position for BsaI.”
- “Search all supported sources and retrieve the methods sections I can read.”

You can narrow a request by organism, sample type, instrument, reagent, journal,
supplier, or protocol step.

## What you receive

### One clear result list

Results from protocol journals, community repositories, suppliers, and REBASE
appear in one response. Duplicate papers found by several indexes are combined.

### Honest access information

Labee separates discovery from access. Finding a paper does not automatically
mean its full text is available.

Search results carry a prediction; `fetch` reports what actually happened.

| Search label | What it means for you |
| --- | --- |
| **Likely fetchable** | An index reported an open-access copy for this paper during this search. |
| **May not fetch** | Only the journal’s usual behaviour is known; this paper has not been tried. |
| **Links only** | The site does not allow automated reading, so Labee gives you the direct page. |

Every search label is a prediction, and says so. Labee deliberately keeps no
shared record of past retrievals: whether a paper can be read depends on the
network asking — an institutional address may reach content a datacenter cannot
— so a claim like “verified full text” was only ever true for whoever measured
it. Predictions are computed fresh for each search and shared with nobody.

`fetch` then reports the outcome it actually got, as a machine-readable status:

| `fetch` status | What you received |
| --- | --- |
| `ok` | Readable protocol content from an open-access source. |
| `entitled-full-text` | The publisher’s own copy, read under your institution’s subscription. **Not open access** — that subscription’s terms govern what you may do with it. |
| `display-only-full-text` | Readable text from a public page without a detected redistribution licence (including PMC copies outside the Open Access Subset). Read it; don’t republish it. |
| `display-only-link` | A free-to-read PMC copy exists, but its publisher has not licensed machine-readable redistribution; open the supplied PMC link in a browser. |
| `oa-link` | No machine-readable text, but a legal open copy was found and linked. |
| `abstract-only` | Only the abstract was retrieved; no public open full text was found at retrieval time. |
| `not-found` / `not-fetchable` | Not indexed, or the site refused automated reading. |
| `interaction-required` | Labee opened its dedicated Chrome window, but a human verification page still needs your attention; complete it and retry. |
| `chrome-browser-required` | Native retrieval stopped short of full text and an explicitly authorized connected-Chrome capture task is ready for the Codex plugin. |

### Network context

Because entitlement is decided by IP, Labee checks once at startup whether it is
running on an academic network and prints what it found. On such a network
`fetch` will try the publisher’s own copy of a paywalled DOI before falling back
to the abstract. Set `PROTOCOLS_ENTITLED_FETCH=off` to never attempt it, or
`PROTOCOLS_NETWORK_DETECT=off` to skip the check altogether.

Labee still bypasses no access control. The entitled path uses only the access
your network already has, and it is labelled distinctly precisely so that
subscription content is never mistaken for open content.

### Useful content, not just citations

When permitted by the source, Labee returns readable protocol text and can focus
on a section such as Methods, Materials, Procedure, or Troubleshooting. If full
text is unavailable, it returns the best legal alternative it can find rather
than pretending the retrieval succeeded.

Labee does not bypass paywalls, authentication, CAPTCHAs, robots restrictions,
or other access controls.

### Optional default-profile browser for local Labee

Some public supplier pages, including NEB pages, reject server-style requests
but work in an ordinary visible browser. A locally run Labee instance can use
`browser: default` on `fetch` (CLI: `--browser default`). The
`browser_launch`, `browser_status`, and `browser_close` MCP tools provide an
explicit one-click lifecycle.

Default mode uses one dedicated window in the user's normal Google Chrome
profile, so it shares the cookies and verification state that already work in
Chrome. It does not enable CDP, enumerate or inspect existing tabs, or close any
window except the one it created. In Chrome, first enable **View > Developer >
Allow JavaScript from Apple Events**. If a verification page appears, Labee
waits briefly for you to complete it; it never solves or bypasses the check. For
NEB, Labee prefers an official protocols.io protocol linked from the supplier
page. Otherwise browser-readable publisher text is labelled
`display-only-full-text`.

This mode currently requires macOS, Google Chrome, macOS Automation permission,
and a trusted local MCP process; it is not intended for the hosted service.
Operator-managed CDP remains available as `browser: cdp` via
`PROTOCOLS_BROWSER_CDP_URL`.

For NEB, `search` also accepts `browser: default`. Labee opens each returned
NEB page in its dedicated window and retains the rendered content HTML. A following
`fetch` of the result ID automatically reuses the same profile and returns the
captured HTML as `display-only-full-text`; it does not request the NEB page a
second time. An explicit `browser: off` disables this handoff.

### Codex integrated Browser

For most browser tasks, prefer Codex's integrated Browser. It keeps browsing
inside Codex, uses a separate profile, and provides a shared view. It is
especially suitable for public websites, research, and localhost testing.

When Labee is installed as a Codex plugin, use `browser: host` for NEB.
The initial `search` returns a `hostBrowserTask` instead of using a server-side
web-search provider for NEB. The bundled skill opens NEB's rendered search page
in the integrated Browser, opens selected results in that same Browser
profile, and submits their exact main/article HTML (or rendered-text fallback)
through `neb_search_commit`. The commit returns normal result IDs and caches the
captures, so a subsequent `fetch` returns the captured content without another
NEB navigation.

This is an agent-orchestrated handoff: an MCP subprocess cannot invoke another
host tool by itself. The plugin skill coordinates the Labee MCP tools and the
host Browser. Labee does not silently switch to system Chrome. Use
`browser: default` or `cdp` only when the integrated Browser is unavailable and
the user explicitly authorizes that fallback; other clients can still use
native retrieval.

### Connected-Chrome journal fallback

When normal DOI/PMID retrieval returns only an abstract or link, the Codex
plugin can reuse the user's already connected Chrome session as an explicit
fallback. Call `fetch` with `browser: chrome`; if native retrieval is still
unresolved, Labee returns a short-lived `chromeBrowserTask`. The plugin reuses a
matching open article tab or opens the task's canonical URL, verifies the
DOI/title, and submits complete article HTML or text extracted from a PDF
downloaded through Chrome via `chrome_fetch_commit`.

Chrome applies its own signed-in session state; Labee never asks the plugin to
read, export, or print cookies. A committed publisher capture is labelled
`entitled-full-text`, never open access, and remains subject to the publisher or
subscription terms. The task uses the canonical DOI URL rather than an
incidental URL found in abstract metadata—specifically guarding the successful
`10.1038/nprot.2016.055` workflow. This fallback is used only after explicit
user authorization and only in a host that exposes a connected Chrome session.

## Sources covered

### Protocol journals and repositories

- STAR Protocols
- Nature Protocols
- JoVE (Journal of Visualized Experiments)
- Bio-protocol
- Current Protocols
- protocols.io

### Reagent and instrument suppliers

- Thermo Fisher Scientific
- QIAGEN
- New England Biolabs
- Bio-Rad
- Sigma-Aldrich / Merck
- EMD Millipore
- Takara Bio
- Promega
- Integrated DNA Technologies

### Restriction enzymes

- REBASE, the open Restriction Enzyme Database

## Start using Labee

### ChatGPT

If your organization provides access to the hosted Labee service:

1. Open **Settings → Plugins → MCPs → Add**.
2. Choose **Streamable HTTP**.
3. Enter `https://labee.online/mcp`.
4. Enter the bearer-token environment variable supplied by your administrator
   (normally `MCP_BEARER_TOKEN`).
5. Save the connection and add Labee from the tools menu in a new conversation.

Your access token should stay in an environment variable. Do not paste it into a
README, chat message, screenshot, or public configuration file.

### Claude, Codex, and other MCP clients

Use the same hosted MCP address and bearer token in any client that supports a
remote Streamable HTTP MCP connection. Teams that prefer to operate their own
instance can use the self-hosting notes below.

## What Labee is—and is not

Labee is a research-discovery and retrieval assistant. It helps you find source
material and understand what is accessible. It does not replace scientific
judgment, institutional safety review, validated laboratory procedures, or the
manufacturer’s current instructions for a regulated product.

Before using a protocol at the bench, confirm critical parameters against the
linked source and your laboratory’s approved practices.

## Current service transparency

Labee checks its supported search routes and a sample of paper-access results
every day. The customer-facing summary from the latest run is:

- all 16 supported sources returned search results;
- 47 individual papers were tested for access;
- 24 returned full text, 14 returned abstracts, 7 returned open-access links,
  and 2 were not found by the available retrieval routes;
- temporary trouble with one search provider does not stop the remaining
  providers from being checked.

<details>
<summary>View the detailed daily reliability record</summary>

<!-- HEALTH:BEGIN -->
_Measured automatically by [`scripts/health-check.mjs`](scripts/health-check.mjs), re-run daily by [the health workflow](.github/workflows/health.yml). Last run: **2026-08-20T05:49Z** · probe query `PCR purification` (`EcoRI` for REBASE)._

❌ **2 backends not answering:** `semanticscholar`, `duckduckgo`. The chains fall through, so search still works as long as one provider per chain is up.

**Backends**

| Backend | Chain | Today |
| --- | --- | --- |
| `crossref` | journal | ✅ 3 results |
| `europepmc` | journal | ✅ 3 results |
| `openalex` | journal | ✅ 3 results |
| `semanticscholar` | journal | ❌ semanticscholar: Semantic Scholar HTTP 429 |
| `pubmed` | journal | ✅ 3 results |
| `brave` | web | ✅ 2 results |
| `google` | web | — not configured |
| `duckduckgo` | web | ❌ duckduckgo: search returned HTTP 202 (via duckduckgo) |

**Sources**

| Source | Declared `fetch` | Search hits | Top result `fetch` |
| --- | --- | --- | --- |
| `star-protocols` | ✅ full | ✅ 12 | ✅ `ok` · Europe PMC |
| `nature-protocols` | ⚠️ partial | ✅ 12 | ⚠️ `abstract-only` · Europe PMC abstract |
| `jove` | ⚠️ partial | ✅ 5 | ✅ `ok` · NCBI author manuscript |
| `bio-protocol` | ✅ full | ✅ 8 | ✅ `ok` · Europe PMC |
| `current-protocols` | ✅ full | ✅ 10 | ⚠️ `abstract-only` · Europe PMC abstract |
| `protocols-io` | ⚠️ partial | ✅ 3 | ✅ `ok` · json extraction |
| `thermofisher` | ✅ full | ✅ 2 | ✅ `ok` · html extraction |
| `qiagen` | ✅ full | ✅ 3 | ✅ `ok` · html extraction |
| `neb` | ❌ none | ✅ 3 | ❌ `not-fetchable` |
| `bio-rad` | ⚠️ partial | ✅ 3 | ✅ `ok` · html extraction |
| `sigma-aldrich` | ❌ none | ✅ 3 | ❌ `not-fetchable` |
| `emd-millipore` | ❌ none | ✅ 3 | ❌ `not-fetchable` |
| `takarabio` | ✅ full | ✅ 3 | ✅ `ok` · html extraction |
| `promega` | ✅ full | ✅ 3 | ✅ `ok` · html extraction |
| `idt` | ✅ full | ✅ 3 | ✅ `ok` · html extraction |
| `rebase` | ✅ full | ✅ 2 | ✅ `ok` · REBASE flat file |

**Per-DOI retrieval:** 28/47 returned full text in this run. Not persisted: the result depends on the network the probe ran from, so it is reported, not published as a fact.

_A `partial` source showing `abstract-only`, `no-open-fulltext` or `may-not-fetch` is behaving as graded, not failing. Every ❌ above is a second failed attempt — probes retry once before being recorded as down._

**Daily history**

| Date | Backends up | Sources with hits | Top result `fetch` ok | Down | Drift |
| --- | --- | --- | --- | --- | --- |
| 2026-08-20 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-19 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-18 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-17 | ⚠️ 4/7 | ❌ sweep failed | — | `openalex`, `semanticscholar`, `duckduckgo` | — |
| 2026-08-16 | ⚠️ 6/7 | ✅ 16/16 | ⚠️ 11/16 | `duckduckgo` | — |
| 2026-08-15 | ⚠️ 6/7 | ✅ 16/16 | ⚠️ 11/16 | `duckduckgo` | — |
| 2026-08-14 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-13 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-12 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-11 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-10 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |
| 2026-08-09 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |
| 2026-08-08 | ⚠️ 6/7 | ✅ 16/16 | ⚠️ 12/16 | `duckduckgo` | `sigma-aldrich` |
| 2026-08-07 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |
| 2026-08-06 | ⚠️ 6/7 | ✅ 16/16 | ⚠️ 12/16 | `duckduckgo` | `sigma-aldrich` |
| 2026-08-05 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |
| 2026-07-30 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |

_One row per day, most recent first, last 30 days. Every run — including extra same-day ones — is kept in [`health-history.jsonl`](health-history.jsonl), which is where to look for a longer trend._
<!-- HEALTH:END -->

</details>

<details>
<summary>Self-hosting and contributor notes</summary>

### Install locally

Requires Node.js 20 or newer.

```sh
git clone https://github.com/mengbingrock/Labee-Protocol-Searcher.git
cd Labee-Protocol-Searcher
npm install
npm run build
```

The built server is `dist/index.mjs`. Run it as a local MCP process or as a
loopback HTTP service behind your own authenticated HTTPS proxy.

You can also use the published package:

```sh
npx -y @mengbingrock/labee-protocol-searcher
```

Optional provider keys improve search capacity, but the journal search and core
open-access retrieval work without them. Copy `.env.example` to `.env` for the
available settings. Never commit real credentials.

### Useful commands

```sh
npm run build
npm run typecheck
npm test
npm run health
```

### Main project areas

| Area | Location |
| --- | --- |
| Search and source coverage | `src/search.ts`, `src/journals.ts`, `src/providers/` |
| Content retrieval | `src/fetch.ts`, `src/fulltext.ts`, `src/extract.ts` |
| Browser-assisted retrieval | `src/agent/` |
| MCP and hosted transport | `src/mcp.ts`, `src/http.ts` |
| Daily reliability checks | `scripts/health-check.mjs`, `.github/workflows/health.yml` |
| Network context and entitlement | `src/network-context.ts` |
| Cookie jar (identity-provider handshakes) | `src/cookies.ts` |

</details>

## License

MIT

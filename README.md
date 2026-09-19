# Labee Protocol Searcher

[![CI](https://github.com/mengbingrock/Labee-Protocol-Searcher/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mengbingrock/Labee-Protocol-Searcher/actions/workflows/ci.yml)
[![Daily publisher health](https://github.com/mengbingrock/Labee-Protocol-Searcher/actions/workflows/health.yml/badge.svg?branch=main)](https://github.com/mengbingrock/Labee-Protocol-Searcher/actions/workflows/health.yml)

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
`@mengbingrock/labee-protocol-searcher@0.5.0` when its MCP server starts.

## The problems Labee solves

| What slows researchers down | How Labee helps |
| --- | --- |
| Protocols are scattered across journals, supplier sites, and databases. | One request searches all supported sources and presents the results together. |
| Publisher and supplier search pages often block automation or hide results behind interactive pages. | Labee renders each publisher's own search first through AWS Browserless, then uses scholarly or site-scoped search only when that first-party route returns no credible result. |
| A promising search result may lead to a paywall, an abstract, or a broken page. | Every result says what Labee expects to be readable, and every retrieval reports what it actually got — the two are never conflated. |
| One literature index can miss an important paper or be temporarily unavailable. | Labee checks multiple scholarly indexes and combines their findings instead of stopping after the first successful search. |
| A source can change or break without warning. | Daily CI searches every declared journal and vendor, fetches a result from each, and publishes the per-source outcome in this README. |
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

### Publisher-first search and fetch

For every protocol journal and supplier, Labee follows the same production
order:

1. Render the publisher's own search page through the self-hosted AWS
   Browserless service. Ordinary pages use `/content`; NEB uses `/scrape` with
   challenge solving and prefers an available local residential exit to read
   its live Coveo result anchors; `/function` is reserved for publishers that
   require form interaction and for IDT's Shadow DOM results.
2. Wait up to 30 seconds for client-rendered results, reject navigation links,
   challenge pages, and soft 404s, and keep only URLs matching that publisher's
   known result shape.
3. If publisher search fails, use scholarly indexes for journals or a
   site-scoped Brave/Google query for suppliers.
4. Fetch a selected publisher page through Browserless first. If that render
   fails and an explicitly enabled local residential exit is registered, retry
   through that exit; then fall through to the source's legal direct/API
   alternatives.

Each source in JSON output includes the route that actually supplied its
results. The daily matrix below publishes the same route, so a fallback is
visible instead of being reported as a successful publisher search.

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

`fetch` reports the payload it actually got as a machine-readable `_status`.
When full text is unavailable it also reports a separate `_reason`, so an
expected subscription boundary is not presented as a technical error:

- Access limitation: `_reason: subscription-required_` or `_reason: no-public-full-text_`.
- Technical failure: `_reason: technical-retrieval-failure_` or `_reason: technical-execution-failure_`.
- Input/index problem: `_reason: invalid-id_` or `_reason: not-indexed_`.

| `fetch` status | What you received |
| --- | --- |
| `ok` | Readable protocol content from an open-access source. |
| `entitled-full-text` | The publisher’s own copy, read under your institution’s subscription. **Not open access** — that subscription’s terms govern what you may do with it. |
| `display-only-full-text` | Readable text from a public page without a detected redistribution licence (including PMC copies outside the Open Access Subset). Read it; don’t republish it. |
| `display-only-link` | A free-to-read PMC copy exists, but its publisher has not licensed machine-readable redistribution; open the supplied PMC link in a browser. |
| `oa-link` | No machine-readable text, but a legal open copy was found and linked. |
| `abstract-only` | Only the abstract or publisher preview was retrieved. Check `_reason`: `subscription-required` is an expected access limitation (not an error); `no-public-full-text` means the open repositories checked had no downloadable body. |
| `not-found` | No matching indexed record was found (`_reason: not-indexed_`). |
| `not-fetchable` | Automated retrieval failed or the site refused it (`_reason: technical-retrieval-failure_`). This is a technical failure, not evidence of a subscription requirement. |
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

Labee does not bypass paywalls, authentication, robots restrictions, or other
access controls. The self-hosted Browserless operator may configure challenge
solving for public anti-bot pages; that does not authenticate, create an
entitlement, or change the content's licence.

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

### Optional remote browser for headless installs

Every mode above needs a browser on the machine running Labee, so none of them
help a headless server or CI. Setting `BROWSERLESS_TOKEN` enables the remote
browser used as the **primary publisher search and publisher-page fetch
route**. It renders each publisher's own search page first; scholarly or
site-scoped web databases run only when that publisher search fails. Publisher
result pages also use Browserless first, with ordinary HTTP as fallback.

The self-hosted AWS fork uses `/content` for normal pages, `/scrape` for NEB's
live Coveo anchors, and `/function` only when it must submit an interactive
search form or traverse open Shadow DOM. The `/content` and `/scrape` routes
allow a 30-second render settle window and request the server's configured
public-page challenge solver. Hosted browserless.io is a different codebase:
its `/unblock` route remains supported for page retrieval, but it is not used
for publisher search and cannot use the residential-exit extension.

Observed reach changes over time, so the daily record is authoritative. In the
2026-09-18 production run—before NEB moved to `/scrape`—first-party AWS
Browserless search supplied 9 of 15 publisher sources. STAR Protocols, JoVE,
Current Protocols, NEB, Sigma-Aldrich, and EMD Millipore used their configured
database/web fallbacks. Even though
Sigma-Aldrich and EMD search fell back, Browserless successfully fetched the
selected product pages; the report flags that as grade drift rather than
silently rewriting a long-term reliability claim from one observation.

NEB PDF manuals under `/-/media/` remain directly fetchable and are listed
ahead of equivalent HTML pages when a fallback web search finds both.

The post-change live verification on 2026-09-18 used AWS Browserless
`/scrape`, headless Chromium, challenge solving, and the local residential
exit. It returned three canonical NEB products in 36.2 seconds with route
`publisher-browserless-residential`; fetching the top product through
`/content` returned 16,378 characters as `display-only-full-text`.

Two limits are deliberate. Results are labelled `display-only-full-text` rather
than `ok`, because a page that needed a remote browser is not the same evidence
as one a plain request returned. And entitled retrieval never uses it: that path
depends on the calling network's own IP, so content fetched from a datacenter
could not honestly be labelled `entitled-full-text`.

Unset the token, or set `PROTOCOLS_BROWSERLESS=off`, to disable it. Without a
token nothing changes.

### Optional residential exit for the remote browser

The remote browser above calls from its own datacenter, which is exactly why it
is barred from entitled retrieval and why vendor sites are hostile to it. This
option removes that constraint by turning the relationship around: the MCP layer
running on **your** PC registers itself with a self-hosted browserless server as
a residential exit, and the server routes your browser traffic back out through
your connection. The remote browser then calls from the same network you are on.

```bash
PROTOCOLS_RESIDENTIAL_PROXY=on
RESIDENTIAL_PROXY_CONSENT=true
RESIDENTIAL_PROXY_AGENT_TOKEN=<the server's agent token>
BROWSERLESS_URL=https://browserless.example.com
RESIDENTIAL_PROXY_COUNTRY=US
```

The agent dials **out** over a WebSocket, so your PC never opens a listening
port. Tunnelled traffic is limited to ports 80 and 443 and to public addresses —
loopback, private, link-local and cloud-metadata ranges are refused after DNS
resolution — and `RESIDENTIAL_PROXY_ALLOW_HOSTS` narrows it further. The control
channel is encrypted end to end (X25519 + ChaCha20-Poly1305, keyed off the
shared token) independently of TLS, so a CDN or load balancer in front of the
server relays ciphertext it cannot read.

Four things to know before enabling it:

- It needs a **self-hosted** browserless with `RESIDENTIAL_PROXY_ENABLED=true`.
  The hosted browserless.io service has no such feature.
- Residential calls go to `/content`; `/unblock` is hosted-only and 404s on a
  self-hosted server.
- Stdio mode and one-shot `--query`/`--fetch` register. Under `--http` this process *is* the server, and a
  server offering itself as a residential exit would be a datacenter IP wearing
  the wrong label.
- Consent is a separate variable from enabling, deliberately. Other people's
  browser traffic will exit from your IP address.

Entitled retrieval still does not use the remote browser, even with a
residential exit registered. Making `entitled-full-text` depend on the exit
genuinely being the subscribing network is a provenance decision, not a
plumbing one, and it has not been taken here.

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

Labee's daily CI uses the production CLI to search every declared protocol
journal and vendor through its publisher page on AWS Browserless first, records
any scholarly or site-scoped fallback that was needed, and fetches a result from
each source. It also fetches every unique journal DOI returned by the sweep. The
badges above show the current build and daily-probe workflow results; the
generated per-source matrix below is written back into this README. The latest
completed run—including the route used for every source—is shown below.

Latest measured result (2026-09-18):

| Check | Result |
| --- | --- |
| Build/typecheck/test CI | ✅ Passed ([run](https://github.com/mengbingrock/Labee-Protocol-Searcher/actions/runs/35406749206)) |
| Publisher-health workflow | ✅ Passed in 9m19s ([run](https://github.com/mengbingrock/Labee-Protocol-Searcher/actions/runs/35406753346)) |
| First-party publisher search | ⚠️ 9/15 publishers; the other 6 used declared fallbacks |
| Search coverage | ⚠️ 15/16 sources returned hits; the REBASE probe failed in this run |
| Top-result full-text fetch | ⚠️ 13/16 sources |
| Journal DOI retrieval | ⚠️ 14/25 returned full text |
| Fallback backend health | ⚠️ 5/6 configured backends answered; Semantic Scholar returned HTTP 429 |
| Notable change | Sigma-Aldrich and EMD Millipore product pages fetched successfully through Browserless after fallback search; both remain flagged for re-grading until the result is repeatable |

<details>
<summary>View the detailed daily reliability record</summary>

<!-- HEALTH:BEGIN -->
_Measured automatically by [`scripts/health-check.mjs`](scripts/health-check.mjs), re-run daily by [the health workflow](.github/workflows/health.yml). Last run: **2026-09-18T23:52Z** · probe query `PCR purification` (`EcoRI` for REBASE)._

The scheduled run searches every declared protocol journal and vendor, then calls `fetch` for each source's top result. It additionally fetches every unique journal DOI returned by the sweep. Publisher search uses the AWS Browserless deployment first; this report shows when a scholarly or web database had to answer instead.

❌ **1 backend not answering:** `semanticscholar`. The chains fall through, so search still works as long as one provider per chain is up.

⚠️ **Grade drift — re-check `fetchability` in `src/vendors.ts`:** `sigma-aldrich` (graded `none` but the page extracted fine); `emd-millipore` (graded `none` but the page extracted fine).

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

**Sources**

| Source | Search route | Declared `fetch` | Search hits | Top result `fetch` |
| --- | --- | --- | --- | --- |
| `star-protocols` | ⚠️ fallback · `crossref+europepmc+openalex+pubmed` | ✅ full | ✅ 10 | ✅ `ok` · Europe PMC |
| `nature-protocols` | ✅ AWS Browserless | ⚠️ partial | ✅ 3 | ✅ `display-only-full-text` |
| `jove` | ⚠️ fallback · `crossref+openalex` | ⚠️ partial | ✅ 5 | ✅ `ok` · NCBI author manuscript |
| `bio-protocol` | ✅ AWS Browserless | ⚠️ partial | ✅ 3 | ❌ `not-fetchable` |
| `current-protocols` | ⚠️ fallback · `crossref+europepmc+openalex+pubmed` | ⚠️ partial | ✅ 10 | ⚠️ `abstract-only` · Europe PMC abstract |
| `protocols-io` | ✅ AWS Browserless | ✅ full | ✅ 3 | ✅ `display-only-full-text` |
| `thermofisher` | ✅ AWS Browserless | ✅ full | ✅ 3 | ✅ `display-only-full-text` |
| `qiagen` | ✅ AWS Browserless | ✅ full | ✅ 3 | ✅ `display-only-full-text` |
| `neb` | ⚠️ fallback · `brave` | ✅ full | ✅ 3 | ✅ `display-only-full-text` |
| `bio-rad` | ✅ AWS Browserless | ✅ full | ✅ 3 | ✅ `display-only-full-text` |
| `sigma-aldrich` | ⚠️ fallback · `brave` | ❌ none | ✅ 3 | ✅ `display-only-full-text` |
| `emd-millipore` | ⚠️ fallback · `brave` | ❌ none | ✅ 3 | ✅ `display-only-full-text` |
| `takarabio` | ✅ AWS Browserless | ✅ full | ✅ 3 | ✅ `display-only-full-text` |
| `promega` | ✅ AWS Browserless | ✅ full | ✅ 3 | ✅ `display-only-full-text` |
| `idt` | ✅ AWS Browserless | ✅ full | ✅ 3 | ✅ `display-only-full-text` |
| `rebase` | — REBASE flat file | ✅ full | ❌ fetch failed | — not probed |

**Per-DOI retrieval:** 14/25 returned full text in this run. Not persisted: the result depends on the network the probe ran from, so it is reported, not published as a fact.

_A `partial` source showing `abstract-only`, `no-open-fulltext` or `may-not-fetch` is behaving as graded, not failing. Every ❌ above is a second failed attempt — probes retry once before being recorded as down._

**Daily history**

| Date | Backends up | Publisher search | Sources with hits | Top result `fetch` ok | Down | Drift |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-18 | ⚠️ 5/6 | ⚠️ 9/15 | ⚠️ 15/16 | ⚠️ 13/16 | `semanticscholar` | `sigma-aldrich`, `emd-millipore` |
| 2026-09-17 | ⚠️ 4/6 | — | ⚠️ 15/16 | ⚠️ 8/16 | `europepmc`, `semanticscholar` | — |
| 2026-09-16 | ⚠️ 5/6 | — | ⚠️ 15/16 | ⚠️ 8/16 | `semanticscholar` | — |
| 2026-09-15 | ⚠️ 5/6 | — | ⚠️ 15/16 | ⚠️ 7/16 | `semanticscholar` | `idt` |
| 2026-09-14 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar` | — |
| 2026-09-13 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 9/16 | `semanticscholar` | — |
| 2026-09-12 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar` | — |
| 2026-09-11 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar` | — |
| 2026-09-10 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar` | — |
| 2026-09-09 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar` | — |
| 2026-09-08 | ⚠️ 5/6 | — | ❌ sweep failed | — | `semanticscholar` | — |
| 2026-09-07 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar` | — |
| 2026-09-06 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar` | — |
| 2026-09-05 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar` | — |
| 2026-09-04 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar` | — |
| 2026-09-03 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar` | — |
| 2026-09-02 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar` | `idt` |
| 2026-09-01 | ⚠️ 5/6 | — | ❌ sweep failed | — | `semanticscholar` | — |
| 2026-08-31 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar` | — |
| 2026-08-30 | ⚠️ 5/6 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar` | — |
| 2026-08-29 | ✅ 6/6 | — | ✅ 16/16 | ⚠️ 10/16 | — | — |
| 2026-08-28 | ⚠️ 5/7 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-27 | ⚠️ 5/7 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-26 | ⚠️ 5/7 | — | ✅ 16/16 | ⚠️ 10/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-25 | ⚠️ 5/7 | — | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-24 | ⚠️ 5/7 | — | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-23 | ⚠️ 5/7 | — | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-22 | ⚠️ 5/7 | — | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-21 | ⚠️ 4/7 | — | ✅ 16/16 | ⚠️ 11/16 | `europepmc`, `semanticscholar`, `duckduckgo` | — |
| 2026-08-20 | ⚠️ 5/7 | — | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |

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

Journal fallback search and open-access retrieval need no keys — Crossref,
Europe PMC, NCBI, OpenAlex and Unpaywall are all open. Publisher-first search
requires `BROWSERLESS_TOKEN`. Vendor fallback search requires `BRAVE_API_KEY`,
or `GOOGLE_API_KEY` together with `GOOGLE_CSE_CX`. Without those web-search
keys, a vendor can still return first-party Browserless results; only a failed
publisher search loses its web fallback, and the response says why.

(A keyless DuckDuckGo scraper used to fill that gap. It answered every request
with HTTP 202 and a CAPTCHA for months, so it was removed rather than left in
place to make an unkeyed install look like it was working.)

Copy `.env.example` to `.env` for the available settings. Never commit real
credentials.

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
| Publisher-first search and source coverage | `src/search.ts`, `src/publisher-search.ts`, `src/journals.ts`, `src/providers/` |
| Content retrieval | `src/fetch.ts`, `src/fulltext.ts`, `src/extract.ts` |
| AWS Browserless and residential retry | `src/browserless.ts`, `src/residential.ts`, `src/residential/` |
| Browser-assisted retrieval | `src/agent/` |
| MCP and hosted transport | `src/mcp.ts`, `src/http.ts` |
| Daily reliability checks | `scripts/health-check.mjs`, `.github/workflows/health.yml` |
| Network context and entitlement | `src/network-context.ts` |
| Cookie jar (identity-provider handshakes) | `src/cookies.ts` |

</details>

## License

MIT

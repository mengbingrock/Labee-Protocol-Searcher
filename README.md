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

## The problems Labee solves

| What slows researchers down | How Labee helps |
| --- | --- |
| Protocols are scattered across journals, supplier sites, and databases. | One request searches all supported sources and presents the results together. |
| Publisher and supplier search pages often block automation or hide results behind interactive pages. | Labee uses several independent discovery routes and keeps a direct source link when a page cannot be read automatically. |
| A promising search result may lead to a paywall, an abstract, or a broken page. | Every result says what Labee expects to be readable, and every retrieval reports what it actually got — the two are never conflated. |
| One literature index can miss an important paper or be temporarily unavailable. | Labee checks multiple scholarly indexes and combines their findings instead of stopping after the first successful search. |
| Deep searches can become repetitive, lose progress, or stop after a temporary failure. | Labee can run a durable search that records progress, tries every available route, removes duplicates, and resumes after a restart. |
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
| `display-only-full-text` | A PMC copy that is free to read but sits outside the Open Access Subset — the publisher granted display rights, not a redistribution licence. Read it; don’t republish it. |
| `oa-link` | No machine-readable text, but a legal open copy was found and linked. |
| `abstract-only` | Only the abstract is available; no open full text exists. |
| `not-found` / `not-fetchable` | Not indexed, or the site refused automated reading. |

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

### A thorough search when the question is difficult

For complex requests, Labee’s deep-search mode:

- searches every configured source and available search route;
- continues after one route succeeds so another source is not silently missed;
- retrieves every unique result once, then tries additional legal open-access
  routes when needed;
- records what worked, what failed, and why;
- keeps its progress so an interrupted search can continue later.

Labee does not bypass paywalls, authentication, CAPTCHAs, robots restrictions,
or other access controls.

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
_Measured automatically by [`scripts/health-check.mjs`](scripts/health-check.mjs), re-run daily by [the health workflow](.github/workflows/health.yml). Last run: **2026-08-11T18:48Z** · probe query `PCR purification` (`EcoRI` for REBASE)._

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
| `bio-protocol` | ✅ full | ✅ 9 | ✅ `ok` · Europe PMC |
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

**Per-DOI retrieval:** 24/47 returned full text in this run. Not persisted: the result depends on the network the probe ran from, so it is reported, not published as a fact.

_A `partial` source showing `abstract-only`, `no-open-fulltext` or `may-not-fetch` is behaving as graded, not failing. Every ❌ above is a second failed attempt — probes retry once before being recorded as down._

**Daily history**

| Date | Backends up | Sources with hits | Top result `fetch` ok | Down | Drift |
| --- | --- | --- | --- | --- | --- |
| 2026-08-11 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 11/16 | `semanticscholar`, `duckduckgo` | — |
| 2026-08-10 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |
| 2026-08-09 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |
| 2026-08-08 | ⚠️ 6/7 | ✅ 16/16 | ⚠️ 12/16 | `duckduckgo` | `sigma-aldrich` |
| 2026-08-07 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |
| 2026-08-06 | ⚠️ 6/7 | ✅ 16/16 | ⚠️ 12/16 | `duckduckgo` | `sigma-aldrich` |
| 2026-08-05 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |
| 2026-07-30 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |

_One row per day, most recent first, last 30 days. Every run—including extra same-day ones—is kept in [`health-history.jsonl`](health-history.jsonl)._
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
npm run test:agent:live -- --loops 1 --limit 1 --browser auto
```

### Main project areas

| Area | Location |
| --- | --- |
| Search and source coverage | `src/search.ts`, `src/journals.ts`, `src/providers/` |
| Content retrieval | `src/fetch.ts`, `src/fulltext.ts`, `src/extract.ts` |
| Durable deep search | `src/agent/` |
| MCP and hosted transport | `src/mcp.ts`, `src/http.ts` |
| Daily reliability checks | `scripts/health-check.mjs`, `.github/workflows/health.yml` |
| Network context and entitlement | `src/network-context.ts` |
| Cookie jar (identity-provider handshakes) | `src/cookies.ts` |

</details>

## License

MIT

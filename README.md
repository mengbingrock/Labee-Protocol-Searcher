# Labee Protocol Searcher

An **MCP (Model Context Protocol) stdio server** — and standalone CLI — that
searches laboratory-protocol journals and reagent vendors for a technique, kit,
reagent, or product, and returns ranked links per source. It also looks up
restriction enzymes and fetches open-access protocol full text.

- **Lean.** The server bundles to a single ESM file (`dist/index.mjs`) using only
  Node's built-in `fetch`; the one runtime dependency, `unpdf`, powers PDF
  extraction and is loaded lazily (only when a PDF is actually fetched).
- Works with any MCP client — the examples below cover **Claude Code** and
  **Codex CLI**.

## Why this exists

Direct/automated search of the target sites is **not reliably usable**. Fetching
their *search pages* from a non-browser client returns, depending on the site and
the moment, 403/503/login walls, or JavaScript-only shells with no results in
the HTML:

| Source | Direct fetch of its search page |
| --- | --- |
| cell.com/star-protocols | 403 Forbidden |
| nature.com/nprot | 303 → login/paywall |
| thermofisher.com | 200 but results are JS-rendered |
| qiagen.com | 200 but results are JS-rendered |
| neb.com | 403 / intermittent 200 |
| bio-rad.com | 403 / 503 |
| sigmaaldrich.com / emdmillipore.com | 503 / intermittent 200 |
| takarabio.com | 403 |
| promega.com | JS-only shell |
| idtdna.com | connection blocked |

So this server routes each source to the backend that *actually* works for it.

## Sources

Every source is **searchable**. Whether `fetch` can then retrieve a result's
*content* is a separate question, and it does not follow from the source's kind —
several vendor product pages extract cleanly while one of the journals is mostly
paywalled. Each source therefore carries a measured grade, which `search` stamps
onto every result it returns:

| Grade | In results | Meaning |
| --- | --- | --- |
| ✅ `full` | `fetchable` | Retrieval essentially always works. |
| ⚠️ `partial` | `may-not-fetch` | Works for some results, not others, and which is which isn't knowable at search time. Worth trying; be ready for a link back. |
| ❌ `none` | `links-only` | The site refuses automated requests. `fetch` can only hand back the link, so spending a call buys nothing. |

| Source | `id` | Kind | Searched via | `fetch` |
| --- | --- | --- | --- | --- |
| STAR Protocols (Cell Press) | `star-protocols` | journal | scholarly chain | ✅ open-access full text |
| Nature Protocols | `nature-protocols` | journal | scholarly chain | ⚠️ paywalled, but ~26% is deposited in PMC and readable; else the abstract |
| JoVE | `jove` | journal | scholarly chain | ⚠️ many DOIs aren't indexed by Europe PMC |
| Bio-protocol | `bio-protocol` | journal | scholarly chain | ✅ open-access full text |
| Current Protocols (Wiley) | `current-protocols` | journal | scholarly chain | ✅ open-access full text |
| protocols.io | `protocols-io` | vendor | web search `site:` | ⚠️ public `/view/` protocols only |
| Thermo Fisher Scientific | `thermofisher` | vendor | web search `site:` | ✅ product pages extract |
| QIAGEN | `qiagen` | vendor | web search `site:` | ✅ product pages extract |
| New England Biolabs | `neb` | vendor | web search `site:` | ❌ 403 — use `rebase` for enzyme facts |
| Bio-Rad | `bio-rad` | vendor | web search `site:` | ⚠️ product pages extract, some category URLs 403 |
| Sigma-Aldrich (Merck) | `sigma-aldrich` | vendor | web search `site:` | ❌ 403 |
| EMD Millipore | `emd-millipore` | vendor | web search `site:` | ❌ 403 |
| Takara Bio | `takarabio` | vendor | web search `site:` | ✅ product pages extract |
| Promega | `promega` | vendor | web search `site:` | ✅ product pages extract |
| Integrated DNA Technologies | `idt` | vendor | web search `site:` | ✅ once the country-cookie gate is followed |
| REBASE (restriction enzymes) | `rebase` | database | in-memory index of the REBASE release file | ✅ structured record |

The grades live on each source in [`src/vendors.ts`](src/vendors.ts) as a
`fetchability` field, with a note on each recording why. `search`, the result
renderer and `list_sources` all read that one field, so they can't drift apart
from what `fetch` actually does. Re-check them if a site changes behaviour —
the [daily health check](#backend-health) tells you when to.

**REBASE is why `neb.com` being blocked costs you little.** NEB publishes the
canonical restriction-enzyme database as a keyless flat file, so recognition
sites, cut positions, isoschizomers, methylation sensitivity and supplier lists
come from the structured source rather than from scraping product pages. It's
auto-included for enzyme-shaped queries (`EcoRI`, `GAATTC`).

## Backend health

Every backend this server talks to is third-party, and several of them change
behaviour without notice: a search API starts rate-limiting, a vendor turns on a
bot check. So the table below is measured rather than written — CI re-runs the
probes daily and commits the result, which means a stale claim here is visible
instead of silent. Run it yourself with `npm run health`.

The declared grades are **not** rewritten automatically: one probe can't tell
"always works" from "worked today". The check only flags a hard contradiction —
a source graded `full` that refused the request, or one graded `none` that
extracted cleanly — which is the signal to go re-grade it by hand.

Nothing here is overwritten, either. Today's numbers go on top, but every run is
also appended to [`health-history.jsonl`](health-history.jsonl) and the last 30
days stay in the table below — a snapshot alone can't distinguish a backend that
broke overnight from one that has been down for a fortnight, and only the second
is a reason to re-route a chain.

<!-- HEALTH:BEGIN -->
_Measured automatically by [`scripts/health-check.mjs`](scripts/health-check.mjs), re-run daily by [the health workflow](.github/workflows/health.yml). Last run: **2026-08-10T06:43Z** · probe query `PCR purification` (`EcoRI` for REBASE)._

❌ **2 backends not answering:** `semanticscholar`, `duckduckgo`. The chains fall through, so search still works as long as one provider per chain is up.

⚠️ **Grade drift — re-check `fetchability` in `src/vendors.ts`:** `sigma-aldrich` (graded `none` but the page extracted fine).

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
| `duckduckgo` | web | ❌ search returned HTTP 202 (via duckduckgo) |

**Sources**

| Source | Declared `fetch` | Search hits | Top result `fetch` |
| --- | --- | --- | --- |
| `star-protocols` | ✅ full | ✅ 3 | ✅ `ok` · Europe PMC |
| `nature-protocols` | ⚠️ partial | ✅ 3 | ⚠️ `abstract-only` · Europe PMC abstract |
| `jove` | ⚠️ partial | ✅ 2 | ✅ `ok` · NCBI author manuscript |
| `bio-protocol` | ✅ full | ✅ 3 | ✅ `ok` · Europe PMC |
| `current-protocols` | ✅ full | ✅ 3 | ⚠️ `abstract-only` · Europe PMC abstract |
| `protocols-io` | ⚠️ partial | ✅ 3 | ✅ `ok` · json extraction |
| `thermofisher` | ✅ full | ✅ 2 | ✅ `ok` · html extraction |
| `qiagen` | ✅ full | ✅ 3 | ✅ `ok` · html extraction |
| `neb` | ❌ none | ✅ 3 | ❌ `not-fetchable` |
| `bio-rad` | ⚠️ partial | ✅ 3 | ✅ `ok` · html extraction |
| `sigma-aldrich` | ❌ none | ✅ 3 | ✅ `ok` · html extraction |
| `emd-millipore` | ❌ none | ✅ 3 | ❌ `not-fetchable` |
| `takarabio` | ✅ full | ✅ 3 | ✅ `ok` · html extraction |
| `promega` | ✅ full | ✅ 3 | ✅ `ok` · html extraction |
| `idt` | ✅ full | ✅ 3 | ✅ `ok` · html extraction |
| `rebase` | ✅ full | ✅ 2 | ✅ `ok` · REBASE flat file |

_A `partial` source showing `abstract-only`, `no-open-fulltext` or `may-not-fetch` is behaving as graded, not failing. Every ❌ above is a second failed attempt — probes retry once before being recorded as down._

**Daily history**

| Date | Backends up | Sources with hits | Top result `fetch` ok | Down | Drift |
| --- | --- | --- | --- | --- | --- |
| 2026-08-10 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |
| 2026-08-09 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |
| 2026-08-08 | ⚠️ 6/7 | ✅ 16/16 | ⚠️ 12/16 | `duckduckgo` | `sigma-aldrich` |
| 2026-08-07 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |
| 2026-08-06 | ⚠️ 6/7 | ✅ 16/16 | ⚠️ 12/16 | `duckduckgo` | `sigma-aldrich` |
| 2026-08-05 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |
| 2026-07-30 | ⚠️ 5/7 | ✅ 16/16 | ⚠️ 12/16 | `semanticscholar`, `duckduckgo` | `sigma-aldrich` |

_One row per day, most recent first, last 30 days. Every run — including extra same-day ones — is kept in [`health-history.jsonl`](health-history.jsonl), which is where to look for a longer trend._
<!-- HEALTH:END -->

## How it works

Two routes, picked per source:

- **Protocol journals (STAR Protocols, Nature Protocols, JoVE, Bio-protocol,
  Current Protocols)** → a chain of five free, keyless scholarly APIs, tried in
  order until one answers: **Crossref → Europe PMC → OpenAlex → Semantic Scholar
  → PubMed (NCBI E-utilities)**. Reliable out of the box; reorder with
  `PROTOCOLS_JOURNAL_PROVIDERS`. Optional `SEMANTIC_SCHOLAR_API_KEY` /
  `NCBI_API_KEY` raise rate limits (both work without a key).

- **Reagent vendors + protocols.io** → a **web-search provider chain**, scoped
  per source with a `site:` filter:

  1. **Brave Search API** — if `BRAVE_API_KEY` is set (free tier).
  2. **Google Programmable Search** — if `GOOGLE_API_KEY` + `GOOGLE_CSE_CX` are set
     (free 100/day).
  3. **DuckDuckGo** — keyless default; works for occasional queries but can be
     rate-limited.

  The chain returns the first non-empty result, so an unconfigured or
  rate-limited provider transparently falls through.

**Set a free Brave or Google key for reliable vendor search.** Without one, vendor
results are best-effort via DuckDuckGo. Either way, every source is always paired
with its deterministic on-site search URL, so the tool stays useful even when
extraction is unavailable.

## Tools

Three tools, in a `search` → `fetch` shape.

- `search({ query, sources?, limit? })` — search journals, reagent vendors, and
  the REBASE enzyme database in one call. Returns a flat, ranked list where each
  result carries a stable `id`, its `source`, and a `fetchable` grade
  (`fetchable` / `may-not-fetch` / `links-only` — see [Sources](#sources)). `sources`
  is an optional subset of source ids (REBASE is auto-included for enzyme-shaped
  queries like `EcoRI` / `GAATTC`); `limit` is per-source (1–10, default 5). Each
  source also echoes the effective scoped query it ran, so an empty result is
  explainable.
- `fetch({ id | ids, section? })` — retrieve a result's content by id:
  - `rebase:<enzyme>` → the structured REBASE record (cut position,
    isoschizomers, methylation sensitivity, source organism, suppliers).
  - `doi:` / `pmid:` / `pmcid:` (or a bare identifier) → open-access full text via
    **Europe PMC → NCBI → Unpaywall → abstract**, rendered section-by-section.
    Pass `section` (a title substring, e.g. `Methods`) to read just one section.
    Europe PMC serves only its open-access subset, so a PMCID it 404s on is
    retried at NCBI, which also serves PMC *author manuscripts* — that one tier
    is what makes a paywalled-journal protocol readable when its authors
    deposited it. When Unpaywall only has a landing page or PDF (no PMC copy),
    `fetch` extracts the text itself — HTML, XML, and PDF (via `unpdf`). If the
    article is closed everywhere, the last tier returns its abstract and MeSH
    terms rather than a bare link. The Unpaywall tier needs
    `PROTOCOLS_CONTACT_EMAIL` set.
  - `url:` → the page is fetched and its readable text extracted (HTML, XML, PDF;
    protocols.io via its `.json`). Most vendors work; the few that refuse
    automated requests return their link instead, graded `links-only` up front so
    you needn't spend the call.
  - Pass `ids` to fetch a batch in one call. Every result ends with a
    `_status: …_` line (`ok`, `abstract-only`, `no-open-fulltext`, `oa-link`,
    `not-fetchable`, `not-found`, `bad-id`).
- `list_sources()` — the source catalog and which providers are configured.

## Worked example

A real run against four sources — one journal, two vendors that behave
differently, and the enzyme database. Output is verbatim, trimmed only where
marked.

```sh
node dist/index.mjs --query "Gibson assembly" \
  --sources star-protocols,neb,promega,rebase --limit 2
```

```markdown
# Search: "Gibson assembly"

## STAR Protocols (Cell Press) _(journal)_
Query: `Gibson assembly in STAR Protocols (Cell Press)`
Search page: https://www.cell.com/action/doSearch?journalCode=star-protocols&field1=AllField&text1=Gibson%20assembly
- [In situ probe and inhibitory RNA synthesis using streamlined gene cloning with Gibson assembly](https://doi.org/10.1016/j.xpro.2022.101458)
  `doi:10.1016/j.xpro.2022.101458` · fetchable

## New England Biolabs (NEB) _(vendor)_
Query: `site:neb.com Gibson assembly`
Search page: https://www.neb.com/en-us/search?searchValue=Gibson%20assembly
- [Gibson Assembly | NEB](https://www.neb.com/en-us/applications/cloning-and-synthetic-biology/dna-assembly-and-cloning/gibson-assembly)
  `url:https://www.neb.com/…/gibson-assembly` · links-only — Daniel G. Gibson, of the
  J. Craig Venter Institute, described a robust exonuclease-based method to assemble
  DNA seamlessly and in the correct order, eponymously known as Gibson Assembly.

## Promega _(vendor)_
Query: `site:promega.com Gibson assembly`
Search page: https://www.promega.com/search/?q=Gibson%20assembly
- [Biomath Calculators | DNA Calculator | Vector Insert Ratio](https://www.promega.com/resources/tools/biomath/)
  `url:https://www.promega.com/resources/tools/biomath/` · fetchable — DNA calculations
  to convert µg to pmol for double-stranded and single-stranded DNA…

## REBASE (restriction enzymes) _(database)_
Query: `Gibson assembly (by name)`
_No extractable results._

_6 results across 4 sources. Call `fetch` with a result's id to read it. `links-only`
results can't be retrieved — open their url instead; `may-not-fetch` ones are worth
trying but can come back as a link._
```

Four things worth reading off that output:

- **Every source reports the query it actually ran** (`site:neb.com Gibson
  assembly`), so an empty result is explainable rather than mysterious. REBASE
  correctly finds nothing — "Gibson assembly" is not an enzyme name.
- **The two vendors are graded differently.** NEB is `links-only`; Promega is
  `fetchable`. Inferring from "vendor" would have been wrong for one of them.
- **The search page is always present**, even for the source that returned
  nothing, because it's a constructed URL rather than a fetch.
- **Snippets are the source's own text**, passed through — `search` never
  summarises, and never calls a model.

Then retrieve content by id. The grades hold:

```sh
node dist/index.mjs --fetch "doi:10.1016/j.xpro.2022.101458"
```

```markdown
# In situ probe and inhibitory RNA synthesis using streamlined gene cloning with Gibson assembly.

_Source: Europe PMC open-access full text (PMC9207569)._

_Sections: Before you begin · Design primers with Gibson overhangs · Prepare Gibson
Reaction Buffer and master mix · Key resources table · Materials and equipment ·
Step-by-step method details · Total RNA extraction · cDNA synthesis · … _
[full text follows, procedure sections first]
```

Pass `section` (`--fetch <id>` in the CLI reads the whole article; the MCP tool
takes `{ id, section: "Troubleshooting" }`) to read one section instead.

```sh
node dist/index.mjs --fetch "url:https://www.neb.com/en-us/applications/…/gibson-assembly"
```

```markdown
This page can't be retrieved automatically — the site refused the request.

Open it directly: https://www.neb.com/en-us/applications/…/gibson-assembly

_status: not-fetchable_
```

That's the `links-only` grade being honest rather than the tool failing — and it's
why you'd go to REBASE for enzyme facts instead:

```sh
node dist/index.mjs --fetch "rebase:BsaI"
```

```markdown
# BsaI

- **Recognition site / cut:** `GGTCTC(1/5)`
- **Isoschizomers:** Eco31I,Bli49I,Bli161I,Bso31I,BspTNI,Eco51I,PpaI,…
- **Methylation sensitivity:** -4(6)
- **Source organism:** Bacillus stearothermophilus 6-55
- **Supplied by NEB.** Commercial suppliers: New England Biolabs, Sigma Chemical
  Corporation, Vivantis Technologies.

_Source: REBASE (rebase.neb.com), NEB's open Restriction Enzyme Database._

_status: ok_
```

Every `fetch` result ends with a machine-readable `_status: …_` line, so a client
can branch on the outcome without parsing prose.

## Where things live

| Concern | File |
| --- | --- |
| Source catalog, `site:` scoping, on-site search URLs, `fetchability` grades | [`src/vendors.ts`](src/vendors.ts) |
| Search orchestration, per-vendor bucketing, id minting, result rendering | [`src/search.ts`](src/search.ts) |
| Journal chain (Crossref → Europe PMC → OpenAlex → Semantic Scholar → PubMed) | [`src/journals.ts`](src/journals.ts) |
| Web-search providers and their priority order | [`src/providers/`](src/providers/) |
| Open-access full text: Europe PMC → NCBI → Unpaywall → abstract, JATS → markdown | [`src/fulltext.ts`](src/fulltext.ts) |
| Page text extraction (HTML/XML/PDF, protocols.io JSON, cookie gates) | [`src/extract.ts`](src/extract.ts) |
| REBASE flat-file parser and enzyme lookup | [`src/rebase.ts`](src/rebase.ts) |
| `fetch` id dispatch (`rebase:` / `doi:` / `pmid:` / `pmcid:` / `url:`) | [`src/fetch.ts`](src/fetch.ts) |
| MCP tool definitions, JSON-RPC dispatch (stdio) | [`src/mcp.ts`](src/mcp.ts) |
| Streamable HTTP transport | [`src/http.ts`](src/http.ts) |
| Live backend probes that rewrite the health block above | [`scripts/health-check.mjs`](scripts/health-check.mjs) |
| One summary line per health run, appended forever (JSONL) | [`health-history.jsonl`](health-history.jsonl) |

## Install

### Option A — npx (no clone)

Once published to npm, any MCP client can spawn it with `npx`. No local checkout,
no build step.

**Claude Code:**

```sh
claude mcp add protocols -- npx -y @mengbingrock/labee-protocol-searcher
```

Or add it by hand to your MCP config (`~/.claude.json` or a project
`.mcp.json`):

```jsonc
{
  "mcpServers": {
    "protocols": {
      "command": "npx",
      "args": ["-y", "@mengbingrock/labee-protocol-searcher"],
      "env": { "BRAVE_API_KEY": "..." }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.protocols]
command = "npx"
args = ["-y", "@mengbingrock/labee-protocol-searcher"]
env = { BRAVE_API_KEY = "..." }
```

### Option B — git clone + build (no npm account needed)

```sh
git clone https://github.com/mengbingrock/Labee-Protocol-Searcher.git
cd Labee-Protocol-Searcher
npm install
npm run build        # → dist/index.mjs (bundled; unpdf stays in node_modules)
```

Then point your client at the built file's absolute path.

**Claude Code:**

```sh
claude mcp add protocols -- node /abs/path/to/Labee-Protocol-Searcher/dist/index.mjs
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.protocols]
command = "node"
args = ["/abs/path/to/Labee-Protocol-Searcher/dist/index.mjs"]
env = { BRAVE_API_KEY = "..." }
```

## Configuration (env)

| Var | Purpose |
| --- | --- |
| `BRAVE_API_KEY` | Enable the Brave Search provider (recommended). |
| `GOOGLE_API_KEY` + `GOOGLE_CSE_CX` | Enable the Google Programmable Search provider. |
| `PROTOCOLS_SEARCH_PROVIDER` | Force a single vendor provider: `brave` \| `google` \| `duckduckgo`. |
| `PROTOCOLS_JOURNAL_PROVIDERS` | Reorder/limit the journal chain (comma-separated): `crossref,europepmc,openalex,semanticscholar,pubmed`. |
| `SEMANTIC_SCHOLAR_API_KEY` / `NCBI_API_KEY` | Optional; raise rate limits for those journal providers. |
| `PROTOCOLS_CONTACT_EMAIL` | Sent to the Crossref/OpenAlex/NCBI "polite pools" for reliability, and required to enable the Unpaywall open-access full-text fallback in `fetch`. |
| `PROTOCOLS_MCP_TOKEN` | HTTP mode only: shared secret required as `Authorization: Bearer <token>`. |
| `PROTOCOLS_MCP_PORT` / `PROTOCOLS_MCP_HOST` | HTTP mode only: listen address. Default `3001` on `127.0.0.1`. |

Set these in your MCP client's `env` block, or — for a local clone — copy
`.env.example` to `.env` (gitignored) beside the package. The server loads that
file at startup and never overrides a variable already set in the real
environment, so the client's `env` block always wins.

**PDF extraction:** when an open-access copy is only a PDF, `fetch` extracts its
text with [`unpdf`](https://github.com/unjs/unpdf) (pdf.js under the hood). It's
a normal dependency, loaded lazily so the PDF engine is only pulled in when a PDF
is actually fetched; a malformed or encrypted PDF falls back to returning the link.

## Run as a remote (HTTP) server

Besides stdio, the server speaks MCP's Streamable HTTP transport, so one hosted
instance can serve many clients instead of each one spawning its own child
process:

```sh
PROTOCOLS_MCP_TOKEN=$(openssl rand -hex 32) node dist/index.mjs --http --port 3001
```

It binds `127.0.0.1` by default — put a TLS-terminating proxy in front rather
than exposing the port. Binding a non-loopback address without
`PROTOCOLS_MCP_TOKEN` set is refused outright, since the tools spend
third-party API quota and an open endpoint spends someone else's budget.

The endpoint is `POST /mcp`; `GET /healthz` is an unauthenticated liveness
probe. The server is sessionless (no `Mcp-Session-Id`), so clients never need to
resume, and it doesn't offer a server-initiated SSE stream — `GET /mcp` returns
405, as the spec requires of servers that don't.

Point a client at it with a bearer token:

```jsonc
// claude --mcp-config '<this>'
{ "mcpServers": { "protocols": {
    "type": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer YOUR_TOKEN" } } } }
```

```toml
# ~/.codex/config.toml — codex reads the token from the named env var
[mcp_servers.protocols]
url = "https://example.com/mcp"
bearer_token_env_var = "LABEE_MCP_TOKEN"
```

## Use as a CLI

```sh
# after `npm run build`:
node dist/index.mjs --query "CRISPR knockout" --sources star-protocols,nature-protocols
node dist/index.mjs --query "Gibson assembly" --sources neb --limit 3
node dist/index.mjs --query "Q5 polymerase" --json
node dist/index.mjs --fetch "rebase:EcoRI"
node dist/index.mjs --fetch "doi:10.1016/j.xpro.2022.101458"
node dist/index.mjs --list-sources

# or via the bin, when installed globally / with npx:
npx @mengbingrock/labee-protocol-searcher --query "RNA extraction FFPE"
```

In dev, skip the build with `npm run dev -- --query "..."`
(`node --experimental-strip-types src/index.ts`).

## Develop

```sh
npm run build      # bundle to dist/index.mjs
npm run test       # vitest (parsers, providers, journals, search routing, MCP handshake)
npm run typecheck
npm run health     # probe every live backend, rewrite the health block in this README
```

`npm run health` also appends a summary line for the run to
`health-history.jsonl`. Add `--no-history` (`node scripts/health-check.mjs
--write --no-history`) when you're re-running probes to debug one source and
don't want that noise in the record; without `--write` nothing is recorded at
all and the block is only printed.

Two workflows run in CI: [`ci.yml`](.github/workflows/ci.yml) typechecks, tests
and builds on every push and pull request, and
[`health.yml`](.github/workflows/health.yml) runs the live probes daily at 05:17
UTC, then commits both the refreshed health block and the day's history line, so
the record accumulates instead of being replaced. The health job is offline-safe
in the sense that matters: absent API keys are reported as *not configured*
rather than as outages, so a fork without secrets still publishes a truthful
table. Set
`BRAVE_API_KEY` (repository secret) and `PROTOCOLS_CONTACT_EMAIL` (repository
variable) to exercise the vendor chain and the Unpaywall tier; `GOOGLE_API_KEY` +
`GOOGLE_CSE_CX`, `SEMANTIC_SCHOLAR_API_KEY` and `NCBI_API_KEY` are optional.

`npm run health` hits live third-party APIs — roughly 25 requests — so run it
when you want a fresh reading, not in a loop.

## License

MIT

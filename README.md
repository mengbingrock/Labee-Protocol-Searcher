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
their search pages from a non-browser client returns, depending on the site and
the moment, 403/503/login walls, or JavaScript-only shells with no results in
the HTML:

| Source | Direct fetch result |
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
  result carries a stable `id`, its `source`, and a `fetchable` flag. `sources`
  is an optional subset of source ids (REBASE is auto-included for enzyme-shaped
  queries like `EcoRI` / `GAATTC`); `limit` is per-source (1–10, default 5). Each
  source also echoes the effective scoped query it ran, so an empty result is
  explainable.
- `fetch({ id | ids, section? })` — retrieve a result's content by id:
  - `rebase:<enzyme>` → the structured REBASE record (cut position,
    isoschizomers, methylation sensitivity, source organism, suppliers).
  - `doi:` / `pmid:` / `pmcid:` (or a bare identifier) → open-access full text via
    **Europe PMC → Unpaywall**, rendered section-by-section. Pass `section` (a
    title substring, e.g. `Methods`) to read just one section. When Unpaywall
    only has a landing page or PDF (no PMC copy), `fetch` extracts the text
    itself — HTML, XML, and PDF (via `unpdf`). The Unpaywall tier needs
    `PROTOCOLS_CONTACT_EMAIL` set.
  - `url:` vendor pages are bot-blocked and returned as a link, not scraped.
  - Pass `ids` to fetch a batch in one call. Every result ends with a
    `_status: …_` line (`ok`, `no-open-fulltext`, `oa-link`, `not-fetchable`,
    `not-found`, `bad-id`).
- `list_sources()` — the source catalog and which providers are configured.

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
node dist/index.mjs --query "CRISPR knockout" --vendors star-protocols,nature-protocols
node dist/index.mjs --query "Gibson assembly" --vendors neb --limit 3
node dist/index.mjs --query "Q5 polymerase" --json
node dist/index.mjs --list-vendors

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
```

## License

MIT

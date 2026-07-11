# mcp-protocols

An **MCP (Model Context Protocol) stdio server** — and standalone CLI — that
searches laboratory-protocol journals and reagent vendors for a technique, kit,
reagent, or product, and returns ranked links per source. It also looks up
restriction enzymes and fetches open-access protocol full text.

- **Zero runtime dependencies.** The published package is a single self-contained
  ESM file (`dist/index.mjs`); it uses only Node's built-in `fetch`.
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

- `search_protocols({ query, vendors?, limit? })` — search across sources.
  `vendors` is an optional subset of source ids; `limit` is per-source (1–10,
  default 5).
- `find_restriction_enzyme({ query, by? })` — look up a restriction enzyme in
  REBASE by name (e.g. `EcoRI`) or recognition sequence (e.g. `GAATTC`): cut
  position, isoschizomers, methylation sensitivity, source organism, suppliers.
- `get_protocol_fulltext({ id })` — retrieve open-access full text from Europe
  PMC by DOI, PMID, or PMCID.
- `list_protocol_vendors()` — the source catalog and which web-search providers
  are currently configured.

## Install

### Option A — npx (no clone)

Once published to npm, any MCP client can spawn it with `npx`. No local checkout,
no build step.

**Claude Code:**

```sh
claude mcp add protocols -- npx -y @mengbingrock/mcp-protocols
```

Or add it by hand to your MCP config (`~/.claude.json` or a project
`.mcp.json`):

```jsonc
{
  "mcpServers": {
    "protocols": {
      "command": "npx",
      "args": ["-y", "@mengbingrock/mcp-protocols"],
      "env": { "BRAVE_API_KEY": "..." }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.protocols]
command = "npx"
args = ["-y", "@mengbingrock/mcp-protocols"]
env = { BRAVE_API_KEY = "..." }
```

### Option B — git clone + build (no npm account needed)

```sh
git clone https://github.com/mengbingrock/mcp-protocols.git
cd mcp-protocols
npm install
npm run build        # → dist/index.mjs (self-contained, no runtime deps)
```

Then point your client at the built file's absolute path.

**Claude Code:**

```sh
claude mcp add protocols -- node /abs/path/to/mcp-protocols/dist/index.mjs
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.protocols]
command = "node"
args = ["/abs/path/to/mcp-protocols/dist/index.mjs"]
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
| `PROTOCOLS_CONTACT_EMAIL` | Sent to the Crossref/OpenAlex/NCBI "polite pools" for reliability. |

## Use as a CLI

```sh
# after `npm run build`:
node dist/index.mjs --query "CRISPR knockout" --vendors star-protocols,nature-protocols
node dist/index.mjs --query "Gibson assembly" --vendors neb --limit 3
node dist/index.mjs --query "Q5 polymerase" --json
node dist/index.mjs --list-vendors

# or via the bin, when installed globally / with npx:
npx @mengbingrock/mcp-protocols --query "RNA extraction FFPE"
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

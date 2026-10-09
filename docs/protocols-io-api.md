# protocols.io search API investigation

Verified with direct HTTP requests and the website's actual network requests on
2026-10-08. Counts below describe those probes, not permanent index sizes.

## Two different search APIs

| Interface | Endpoint | Authentication | Search controls |
| --- | --- | --- | --- |
| Documented public REST API | `/api/v3/protocols` | Bearer client/OAuth token | Keyword, public/user filters, sorting, pagination, peer review |
| Website's native JSON search | `/api/v1/search` | Public probes worked both anonymously and with the client token | Native sorts, scientific facets, access categories, advanced field queries, publisher counts |
| Website HTML | `/search` | Public | URL specifies criteria; JavaScript retrieves results from the native API |

The [official documentation](https://apidoc.protocols.io/#get-list) describes
`filter=public`, `key`, `order_field`, `order_dir`, `page_id`, `page_size`,
`fields`, and `peer_reviewed`. `fields` selects response properties; it is not
the website's advanced field-search interface. Antibody/technique facets are
not documented on this endpoint.

With the saved client token, REST searches ordered by `date`, `name`, and
`activity` worked. `relevance` returned HTTP 400 with an upstream SQL error.
Its pagination also differed from the docs: requesting `page_id=0` returned
`current_page=1`; requesting `page_id=1` returned `current_page=2`.
Its search corpus/semantics differ from the website: `pcr` returned 3,498 REST
matches versus 2,028 website Open Access matches. Neither API should be
substituted silently for the other when preserving search criteria.

Labee therefore uses the native website API for its existing website controls.
The configured client token is sent only to protocols.io in the Authorization
header. Public discovery does not require that token in the observed native
endpoint; the configured token enables this route in Labee. Browserless remains
the fallback because this native endpoint has no documented compatibility
contract.

## Verified native capabilities

| Capability | Observed result |
| --- | --- |
| Relevance, date, title, Impact (`mentions`), Works for me (`wfm`) | All five returned HTTP 200, 2,028 Open Access matches, and different leading protocols |
| One-indexed pagination | Page 2 returned different protocols; page size is independent of Labee's result limit |
| Technique facet | `pcr` + technique `PCR` + Open Access returned 238 matches |
| Combined facets | Adding organism `Homo sapiens` returned 28 matches |
| Multiple values within a scientific facet | `PCR\|Real-time PCR` returned 66 matches, consistent with intersection; do not assume OR |
| Antibody facet | `Anti-rabbit` + `pcr` returned 200 matches with access unrestricted, and zero with Open Access selected |
| Exact zero matches | A nonexistent technique returned zero, not a backend error |
| Advanced title | `pcr AND title:(PCR) AND is_open_access:(true)` returned 621 matches; a nonexistent title returned zero |
| Advanced keywords | `keywords:(PCR)` + `pcr` + Open Access returned 1,300 matches |
| Advanced technique | `all_entities.techniques:("PCR")` + `pcr` + Open Access returned 236 matches; this differs from the sidebar facet's 238 |
| Advanced author | `authors_string:(Anna Behle)` + `pcr` + Open Access returned 33 matches |
| Publication range | `published:[2026-01-01 TO 2026-10-08]` + `pcr` + Open Access returned 196 matches |
| Peer review | `pcr AND peer_reviewed:(true)` returned 31 matches |
| Research category | `pcr AND is_research:(true)` returned 59 matches |

Peer review and research category were explored directly; dedicated Labee
options for them have not been added. The website serializer also exposes
advanced journal, article DOI, equipment/reagent identifiers, ORCID, affiliation,
funders, and abstract fields. Their request syntax was inspected; individual
positive/negative probes for every such field were not performed.

The response contains `items`, `pagination.total_results`, `access_facets`,
and, in simple mode, `entity_facets`. Facet counts come from the publisher,
not from the returned sample. Entity lists reached 100 choices, so Labee
marks them `complete: false`. Advanced mode does not request sidebar facets.
Simple mode defaults to Open Access, matching the website; explicitly clearing
`access` searches across both access categories.

## Curl examples

Use a token stored in `PROTOCOLS_IO_ACCESS_TOKEN`; never put its literal value in
source code or in a URL. These requests perform discovery only.

```bash
curl --get 'https://www.protocols.io/api/v1/search' \
  -H "Authorization: Bearer $PROTOCOLS_IO_ACCESS_TOKEN" \
  -H 'Accept: application/json' \
  --data-urlencode 'q=pcr' \
  --data-urlencode 'types=1' \
  --data-urlencode 'antibodies=Anti-rabbit' \
  --data-urlencode 'sort_by=mentions' \
  --data-urlencode 'sort_dir=desc' \
  --data-urlencode 'page_id=1' \
  --data-urlencode 'page_size=30' \
  --data-urlencode 'use_fields_boosters=true' \
  --data-urlencode 'is_advanced=false' \
  --data-urlencode 'entity_facets=true'
```

That searches unrestricted access categories. Add
`--data-urlencode 'access=open_access'` to match the website's default access
filter. The example antibody currently has only Springer matches, so adding
Open Access correctly returns zero. Access lists are comma-separated;
scientific facet selections are pipe-separated.

```bash
curl --get 'https://www.protocols.io/api/v1/search' \
  -H "Authorization: Bearer $PROTOCOLS_IO_ACCESS_TOKEN" \
  -H 'Accept: application/json' \
  --data-urlencode 'q=pcr AND title:(PCR) AND is_open_access:(true) AND published:[2026-01-01 TO 2026-10-08]' \
  --data-urlencode 'types=1' \
  --data-urlencode 'sort_by=date' \
  --data-urlencode 'sort_dir=desc' \
  --data-urlencode 'page_id=1' \
  --data-urlencode 'page_size=30' \
  --data-urlencode 'use_fields_boosters=true' \
  --data-urlencode 'is_advanced=true'
```

The public advanced-search URL contains a JSON settings object. The native API
requires the serialized field query instead; sending that JSON directly as
`q` returned misleading zero matches in the initial probes.

## Labee integration and validation

`src/protocols-io-api.ts` uses a fixed HTTPS endpoint, sends the token only in a
header, rejects redirects and non-public/invalid results, preserves versioned
URLs and publisher order, and verifies pagination. Errors report safe summaries
instead of upstream response bodies or exception text. Failed API searches
retry the exact criteria through Browserless; confirmed empty searches do not.
Refinement re-runs the publisher query and can switch from API to Browserless
without substituting an unfiltered web search.

The token is stored in the ignored local `.env` file with owner-only permissions.
The hosted backend must separately receive `PROTOCOLS_IO_ACCESS_TOKEN` and this
code for remote MCP users to use the new route. Local stdio remains a forwarding
bridge; it does not send this publisher token to the remote MCP service.

Run fixture tests normally with `npm test`. Run the opt-in integration smoke
test with:

```bash
LABEE_LIVE_PROTOCOLS_IO_API=1 npm test -- test/protocols-io-api-live.test.ts
```

It verifies all five sorts, paging, refinement with multiple facets, clearing
access filters, advanced search, and confirmed zero matches through MCP.

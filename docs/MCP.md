# Oracle MCP server

Thirteen read-only tools over one run's `query/index.duckdb`, three resources and the two README
prompts. The same tool registry (`src/tools/registry.ts`) backs the agent chat.

## Connect

| Where | How |
|---|---|
| Local run, stdio | `claude mcp add oracle-broward -- ./bin/oracle.mjs mcp` (latest run; `--run <id>`, `--index <path>`, `--fixture`) |
| Local server, HTTP | `./bin/oracle.mjs serve`, then `claude mcp add --transport http oracle-broward http://127.0.0.1:4317/mcp` |
| Published run (M3) | `./bin/oracle.mjs mcp --manifest <cid>` |
| Hosted (M5) | `https://<host>/mcp` |

HTTP is Streamable HTTP in stateless mode: POST only, JSON responses, no session id, 120 requests per
minute per IP (`/mcp` on `serve`).

## Tools

| Tool | Input | Returns |
|---|---|---|
| `dataset_info` | — | run id, as-of, manifest CID (null when unpublished), view counts, permit coverage, limitations |
| `resolve_place` | `name` | Census point for a Broward place, or `found: false` (never invented) |
| `find_aged_roofs` | `lat, lon, radiusMiles, minRoofAgeYears=15, limit=25` | `total_matching` + properties, oldest roofs first, with roof-age basis |
| `find_open_roof_permits` | `lat, lon, radiusMiles, minOpenYears=0, limit=25` | `total_matching` + open roofing permits, longest open first, contractor, license, BBB fields |
| `find_long_held_properties` | `lat?, lon?, radiusMiles?, minYearsSinceTransfer=10` | properties by years since last transfer |
| `find_out_of_area_owners` | `lat?, lon?, radiusMiles?, scope=out_of_county\|out_of_state` | properties with owners mailing from outside Broward / Florida |
| `find_by_occupancy` | `occupancy[], lat?, lon?, radiusMiles?, minRoofAgeYears?` | owner & occupancy (tenant) view with `occupancy_basis` |
| `get_property` | `parcelId` | property, owner (company names only), roof age, sales, tax, permits, Lexicon entity CIDs |
| `get_permit` | `permitKey` | permit, linked property (and how it was linked), contractor |
| `get_business` | `companyId` (business key or company CID) | owner or contractor business with properties / license |
| `get_contractor` | `companyId` (DBPR license id or company CID) | license, BBB fields, roofing permits, open-permit count |
| `search_records` | `text, mode=hybrid\|text\|semantic, lat?, lon?, radiusMiles?` | BM25 / embedding / fused hits over permits, properties, businesses, contractors |
| `run_read_only_sql` | `sql, maxRows=100` | one SELECT; DDL/DML, COPY, ATTACH, INSTALL, PRAGMA, file functions, multiple statements rejected |

Every row carries `provenance[].source_url`, `property_cid` and `manifest_cid`; every result carries
`notes` (missing permit coverage in the radius, no BBB rating, frozen Fort Lauderdale layer,
unpublished run).

## Resources and prompts

- `oracle://manifest/current`: manifest CID and group roots (local roots while unpublished)
- `oracle://run-history`: runs with manifest CIDs and deltas
- `oracle://views-guide`: columns and meaning of `roofing-views.v1`, for SQL
- Prompts: `aged_roofs_near_city {city, radiusMiles?, minRoofAgeYears?}` and
  `long_open_roof_permits_near_city {city, radiusMiles?, minOpenYears?}`

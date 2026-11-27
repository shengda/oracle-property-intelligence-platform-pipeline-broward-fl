# Runbook — Broward Oracle pipeline (M1 ingest → build → index; M2 inspect: serve, MCP, agent)

Everything in M1 is local and unpublished. Outputs land in gitignored folders: `cache/raw/`
(downloads, with SHA-256 per source), `work/oracle.duckdb` (staging work store), `runs/<run_id>/`
(Lexicon groups, CARs, exported tables, derived index, QA).

## Setup (once)

```bash
git clone --recurse-submodules https://github.com/shengda/oracle-property-intelligence-platform-pipeline-broward-fl.git
cd oracle-property-intelligence-platform-pipeline-broward-fl
nvm install 22 && nvm use 22          # Node >= 22.18 (.nvmrc)
npm ci
bash scripts/install-elephant-cli.sh  # pinned Elephant CLI 2 build (elephant-cli.version) → bin/elephant-cli
./bin/oracle.mjs readiness            # PASS on CLI, Lexicon manifest, kit submodule
```

`git submodule update --init` if the clone was made without `--recurse-submodules`.
Disk: ~20 GB free for a county-wide build (peak during `hash`).

## The M1 run (one command)

```bash
./bin/oracle.mjs run --no-publish
```

= `ingest` (all sources) → `build` (both Lexicon groups) → `index` (index, derived files, QA).
It prints the QA summary and the run directory. Step by step:

```bash
./bin/oracle.mjs ingest                                  # every source, in order (bulk first)
./bin/oracle.mjs ingest --source ftl-permits,weston-permits   # re-pull selected sources only
./bin/oracle.mjs ingest --source ftl-accela-contractors --accela-max-requests 4000
./bin/oracle.mjs build                                   # new run id, both groups
./bin/oracle.mjs build --group property_improvement --run <id>
./bin/oracle.mjs index --run <id>                        # writes meta/qa.json last; exits 0 on failed checks
./bin/oracle.mjs query "select city, count(*) from v_property where roof_age_years >= 15 group by 1 order by 2 desc"
```

Smoke a handful of parcels without touching the county run:
`./bin/oracle.mjs build --parcels 504201080220,494307140030`.

## What a run directory holds

```
runs/<run_id>/
├── build/<group>.car                 CountyIndex archive (packed), + -errors.csv, -hash.csv, -car-errors.csv, -tables-export.json
├── tables/<group>/<table>/part-*.parquet + tables.car     export-tables output (the Lexicon tables)
├── supplement/*.parquet              derived inputs with no Lexicon home (classifier outputs, permit text, licenses)
├── query/index.duckdb                roofing-views.v1 + FTS + vector index
├── query/v_*.parquet                 one Parquet per roofing view
├── samples/*.csv                     ≤ 100-row extracts, no owner names
└── meta/{state,coverage,sources,deltas,qa}.json
```

## Sources and change modes

| Key | Change mode | Notes |
|---|---|---|
| `bcpa-taxroll`, `bcpa-taxroll-full` | `file_digest` | ~3.5 + ~8 min; SHA-256 of the NDJSON decides `changed` |
| `ftl-permits` | `file_digest` | frozen layer (2018–2021) |
| `weston-permits` | `window` | rolling issued/closed reports — re-pull each run |
| `hced-permits` | `window` | blocked this run (403 / query failure); the loader stops and records it |
| `dbpr-licenses` | `file_digest` | 47 MB CSV, refreshed daily by DBPR |
| `ftl-accela-contractors` | `bounded_crawl` | open FTL roofing permits only, 1.5 s/request, resumable |
| `bbb`, `sunbiz` | probe | blocked (403 / login + disk); recorded, never bypassed |
| `census-*` | `file_digest` | reference files |

## M2 — inspect a run in the browser

```bash
npm run ui:build                 # once, and after UI changes (builds ui/dist)
./bin/oracle.mjs serve           # latest local run → http://127.0.0.1:4317/
./bin/oracle.mjs serve --run <id> --port 4317
./bin/oracle.mjs serve --fixture # the synthetic fixture (CRM development, tests)
```

The site is labelled **UNPUBLISHED** until M3. Pages:

| Page | What to check |
|---|---|
| Runs | group roots, Lexicon table row counts, coverage, limitations, build timings |
| Sources | every source: status, records, bytes, SHA-256, limitation; permit coverage by jurisdiction |
| Quality | every `meta/qa.json` check with value, threshold, status; 20 spot-check parcels linked to bcpa.net |
| Manifest | local artifacts with size + SHA-256 and group CIDs; "Verify now" is disabled until publish |
| Explorer | radius search (city picker, address, lat/lon or map click): aged roofs + long-open roof permits |
| Occupancy | owner & occupancy (tenant) view with owner-location filter |
| Property / Permit / Contractor / Business | one record with its relationships, Lexicon entity CIDs and source requests |
| Search | BM25, semantic (local MiniLM) or hybrid search |
| SQL | read-only DuckDB console over the views and `lx_*` tables (one SELECT, 500 rows) |
| Agent | chat over the 13 tools (needs `ANTHROPIC_API_KEY` in `.env`; restart `serve`) |
| MCP | endpoint, connect commands, live console with the raw JSON-RPC |
| WASM proof | DuckDB-WASM in the browser reads `v_property.parquet` and must return the API's rows |

HTTP API v1 (contract-validated JSON; the CRM consumes it in M4): `/api/health`, `/api/runs`,
`/api/sources`, `/api/qa/:runId`, `/api/manifest/:runId`, `/api/verify/:runId`,
`/api/query/{aged-roofs,open-permits,occupancy,long-held,out-of-area}`, `/api/property/:parcelId`,
`/api/permit/:permitKey`, `/api/business/:companyId`, `/api/contractor/:companyId`,
`/api/contractors`, `/api/place?name=`, `/api/search`, `POST /api/sql`, `POST /api/agent`, `/mcp`.

MCP (see `docs/MCP.md`):

```bash
claude mcp add oracle-broward -- ./bin/oracle.mjs mcp            # stdio, latest local run
claude mcp add --transport http oracle-broward http://127.0.0.1:4317/mcp   # while `serve` runs
```

Tests: `npm test` (unit + integration), `npm run test:e2e` (Playwright: builds the UI, serves the
fixture with a scripted mock agent, runs a normal and a WebGL-disabled browser). On macOS 12
Playwright uses the installed Google Chrome; elsewhere `npx playwright install chromium`.

UI development with hot reload: `./bin/oracle.mjs serve` in one terminal, `npm run ui:dev` in another
(http://127.0.0.1:5317, proxies `/api`, `/mcp`, `/files`).

## M2 sign-off

Review the Quality page and the data, fix defects by re-running only the affected `--source` or
`--group`, then `oracle index --run <id>`, and record the decision in `docs/DATA-QA.md`. Nothing is
published (M3) before that sign-off.

## Commands that arrive later

`publish`, `verify`, `sync` and `serve --manifest <cid>` arrive with M3 and exit with code 2 and a
message until then.

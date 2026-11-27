# Runbook — Broward Oracle pipeline (Milestone 1: ingest → build → index, local)

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

## Commands that arrive later

`publish`, `verify`, `sync` (M3) and `mcp`, `serve` (M2) are registered and exit with code 2 and
a message until their milestone.

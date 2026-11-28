# Decisions — Broward Oracle (M1)

Recorded during Task 0 (readiness) and Milestone 1 (ingest), 2026-11-27. Architecture:
[`roofing-oracle-architecture-and-roadmap.md`](./roofing-oracle-architecture-and-roadmap.md).

## Repositories and toolchain

- **Forks confirmed:** `shengda/oracle-property-intelligence-platform-pipeline-broward-fl` is a fork
  of `prismteam-ai/oracle-property-intelligence-platform-pipeline-broward-fl`; `shengda/roofing-crm`
  is a fork of `prismteam-ai/roofing-crm` (`gh repo view --json parent`). `upstream` remotes point
  at the `prismteam-ai` repos. Work happens on `feat/broward-oracle-pipeline`.
- **Team kit:** consumed read-only as the git submodule `vendor/soofi-xyz-team-kit`, pinned at
  `0ef57e9e` (kit 0.203.0). Nothing in the kit is modified; Broward-specific code lives in `src/`.
  Used from the kit: the roof-age resolver (`src/roof-age/integration.ts`), the Broward permit
  profile (32 jurisdictions, for permit coverage), the skill rules (`use-oracle`,
  `car-publication.md`, `county-seed-data`, `build-county-transform`, `dbpr-license-ingest`,
  `bbb-harvest`, `sunbiz-corporate-ingest`, `migrate-elephant-cli-v2`).
- **Elephant CLI 2**, build `94db3af645d575a43462f3249978415585a271f0` (`elephant-cli 2.0.0-alpha.0`,
  `x86_64-apple-darwin`), pinned in `elephant-cli.version` and installed into `bin/` by
  `scripts/install-elephant-cli.sh`. One build for validate, hash, export-tables (and upload in M3).
  Layout: **packed** (`hash` without `--linked`); `export-tables --part-size 64m`.
- **Node 22.23.5** (nvm), TypeScript run through `tsx`; DuckDB 1.5.6 (`@duckdb/node-api`) with the
  `spatial`, `fts` and `vss` extensions; local embeddings `Xenova/all-MiniLM-L6-v2` (q8) via
  transformers.js.

## Data and provenance

- **Property source: the Broward County Property Appraiser roll as published by Broward County
  GIS**, not FL DOR NAL. The kit's `county-seed-data` order prefers the appraiser roll, and this
  one carries owner and mailing fields, homestead exemption amounts, the DOR land-use code, year
  built, values, five sales per parcel and a parcel centroid — everything DOR NAL + SDF + PIN would
  provide, in one official source. DOR files sit behind a SharePoint file browser and are recorded
  as `skipped` (`optional_cut`).
  - Primary layer `PARCEL_POLY_BCPA_TAXROLL/0` (554,358 polygon rows; latest recorded sale
    2024-09-27).
  - Second layer `QAlertBCPA_Parcel_TaxRoll/3` (781,388 rows incl. 253,849 condominium units;
    older snapshot, latest recorded sale 2020-03-26). Used **only for folios absent from the
    primary layer**; those parcels carry this layer's provenance and `roll_source =
    bcpa-taxroll-full`, so their sale-based signals (years since transfer) are flagged as older.
- **Provenance spike (Task 0 Step 7): PASS.** Every roll entity's `source_http_request` is the
  exact per-folio query of the official layer: `GET …/FeatureServer/<n>/query` with
  `multiValueQueryString {where:["FOLIO='<folio>'"], outFields:["*"], f:["json"]}`. One parcel
  validated, hashed (packed, `not_packed` 0), CAR-validated (0 errors on all six checks) and
  exported before any product code was written.
- **Homestead** = `HE1_AMOUNT > 0` (328,560 parcels on the primary layer). The layer's
  `HOMESTEAD_FLAG` marks something else (only 21,044 `Y`) and is not used.
- **Sale price** = documentary stamp amount ÷ 0.007 (Florida deed stamps, $0.70 per $100); stamps
  at the $0.70 minimum are nominal and get no price. Qualification codes `01`–`05` → `sale_type:
  TypicallyMotivated`.
- **Tax year 2025** for the roll values (inferred from the roll vintage: latest recorded sale
  2024-09-27; the layer also carries last-year and two-years-ago values). Recorded as an assumption.
- **Roof age:** the kit resolver's precedence (completed primary replacement > new construction >
  built year; repairs never reset; built-year default at year precision) with a Broward profile
  that maps our tested classifier outputs one-to-one onto the kit's classes
  (`src/transforms/roof-age.ts`). For completed Fort Lauderdale permits without a CO date the
  layer's `LASTUPDATEDATE` is used as the completion date (documented assumption).
- **Contractors:** the Fort Lauderdale permit layer has `CONTRACTOR`/`CONTRACTID` empty in every
  row, so the plan's bounded exception applies: the public Accela permit detail page
  (`aca-prod.accela.com/FTL/Cap/CapDetail.aspx`, no login; `robots.txt` absent) is read for **open
  roofing permits only**, one request at a time, 1.5 s apart, capped. The licensed professional's
  license number is the search key; company, qualifier person and license data come **from the DBPR
  record** (kit `dbpr-license-ingest` rule). No DBPR match → no contractor.
  - **Deviation:** the DBPR record is read from DBPR's official construction licensee extract
    (`CONSTRUCTIONLICENSE_1.csv`, refreshed 2026-11-26) instead of one license-detail page per
    license; `source_http_request` on contractor entities is the GET of that extract. Same official
    record, no per-license session SID, hundreds fewer requests.
- **Owner-name policy (Open Q3, default):** individual owner names and mailing street lines are
  never published. Company owners (business names) are published as `company` entities linked from
  the latest sale; owner type, owner-location class and occupancy are derived (published in the
  query tables only). The QA report's PII check enforces this.
- **BBB (Open Q7):** the bounded probe got HTTP 403 on the first category request; the source is
  stopped and recorded `blocked`. No BBB scores in this run; `bbb_rating`/`bbb_accredited` stay null
  and every answer says "no BBB rating".

## Permits and the §3.7 skip rule

**Rule:** a source is skipped when a full fetch would take more than ~2 hours unattended, or when
it depends on a third party's turnaround. Blocked sources (captcha, login, HTTP 403) are skipped
regardless and never bypassed.

| Permit source | Decision |
|---|---|
| Fort Lauderdale ArcGIS `gisdata/MapServer/27` | **Loaded** (91,027 permits). Layer is frozen: submitted 2018-01-08 → 2021-01-05. Demo city. |
| Fort Lauderdale Accela detail (contractors) | **Loaded, bounded** — open roofing permits only |
| Weston Accela issued/closed reports (ArcGIS) | **Loaded** (rolling window: 311 issued, 580 closed); `window` change mode — the incremental source for M3 run 2 |
| Broward HCED POSSE ArcGIS (unincorporated) | **Blocked** this run: HTTP 403 on the service root, then `Failed to execute query` (400). Recorded, not retried around. |
| Fort Lauderdale `BuildingPermits/FeatureServer` (2024) | Answers HTTP 500; not used |
| Other 28 municipal portals (kit Broward profile) | **Skipped** `too_slow` (parcel-by-parcel search, ~20–80 h per large city) or **blocked** per the kit profile (captcha/login/custodian-only) |
| Public-records requests | **Skipped** `turnaround` (days to weeks) |
| Miramar FY19–21 ArcGIS permit tables | Not used: historical snapshots with no status/close dates |

**Demo city:** Fort Lauderdale (largest covered permit set, long-open roofing permits 5–8 years old).

## Business records

- **Sunbiz:** `cordata.zip` is served from the Division of Corporations SFTP portal (HTTP 401 without
  a login; the web host is Cloudflare-challenged per the kit) and needs ~20 GB of free disk; the
  operator machine had ~21 GB free. Recorded `blocked`. Business records come from BCPA company
  owners and DBPR contractor companies (`v_business`).
- **Overture places:** first scope cut (architecture §6.1), recorded `skipped` (`optional_cut`).

## Storage and build

- **Per-property outputs are ZIPs** (Deflate, compact JSON, deterministic bytes), one per property.
  ~780k properties as directories of ~8 files would take ~18 GB on APFS; ZIPs take ~5 GB and are
  deleted after the CAR validates (they are regenerated deterministically from the work store).
  Hashed ZIPs are deleted after `hash`.
- **Measured CLI throughput** (2,000 synthetic properties, this machine): write 2.0 s, `validate`
  0.5 s, `hash` 1.1 s, `validate` CAR 0.3 s, `export-tables` 0.8 s. At county scale (766,044 properties,
  3.8 M blocks) `validate` takes 4 min, `hash` 15 min, `validate` CAR 7 min and `export-tables`
  20 min; full timings are in `docs/SOURCES.md`.
- **Real-data validation fixes.** The first county build failed Lexicon validation on 98 of 766,044
  properties: 56 roofs replaced this year (computed roof age 0; Lexicon requires ≥ 1) and 42
  single-digit lot areas (Lexicon area strings need ≥ 2 digits). Age 0 now publishes `roof_date`
  with `roof_age_years` null (the derived 0 stays in the supplement and views); areas below
  10 sq ft are omitted as roll errors. Both groups now validate with zero errors.
- **Permits without a folio link by unique street address** (see `docs/SOURCES.md`): 39 % → 89 %
  of permits linked. Conservative by design — an address naming more than one parcel stays
  unmatched rather than guessed.
- **Supplementary derived tables** (`runs/<id>/supplement/*.parquet`, `kind: derived` in M3) hold
  classifier outputs and source fields with no Lexicon home (see `LEXICON-MAP.md`, "Lexicon gaps").
  They are keyed by `parcel_identifier`, permit key and DBPR license id, and never contain owner
  names.

## M2 — query layer, MCP, Explorer, agent

- **Materialized roofing views.** `oracle index` stores each `roofing-views.v1` view as a table
  (`mv_<view>`, ordered by location, ART-indexed on its keys) and redefines `v_<view>` as
  `select * from mv_<view>`. Names and columns are unchanged; a 5-mile aged-roof query dropped from
  ~1 s to 20–140 ms on the 766k-parcel run. Index size 2.6 → 2.9 GB.
- **Radius = bbox prefilter + haversine in plain SQL** (no spatial extension at query time, no
  axis-order ambiguity); the same formula runs in DuckDB-WASM on the proof page, which must return
  the API's rows exactly.
- **Place names** resolve from `src/data/broward-places.json`: Census Gazetteer internal points
  filtered by the cb_2024 county polygon (37 places). The ingest-time `ref_places` used the county
  bbox and kept 5 Miami-Dade places (Aventura, Golden Beach, Ives Estates, Ojus, Watergate); they
  are not used for resolution.
- **One tool registry** (`src/tools/registry.ts`) feeds the MCP server and the agent. Tools take a
  flat `lat`/`lon`, default to 25 rows (max 500) so answers fit a model's context, return
  `total_matching` for the two README questions, and always carry `notes` naming what is missing
  (uncovered permit jurisdictions, BBB blocked, the frozen Fort Lauderdale layer, unpublished run).
- **MCP over HTTP is stateless** (new server + transport per request, JSON responses, POST only,
  60–120 requests/min per IP) so any Lambda instance can answer in M5.
- **Agent:** Vercel AI SDK `generateText` + `@ai-sdk/anthropic`, default model `claude-opus-5-5`
  (`ORACLE_AGENT_MODEL` overrides), `stepCountIs(8)`, 90 s timeout. Only the answer text comes from
  the model; steps, map results, citations (only tool-returned identifiers), assumptions, missing
  data and the follow-up context are derived from the AI SDK step results.
- **API responses are validated against the `contract` schemas** before they are sent (500 with the
  issues if not), so the CRM can rely on the published shapes.
- **Browser tests** run on the fixture with a scripted mock model (`ui/e2e/server.ts`, test-only).
  Playwright 1.65 ships no Chromium for macOS 12, so local runs use the installed Google Chrome
  (`channel: "chrome"`); CI on Linux uses the bundled Chromium.
- **Map tiles** are OpenStreetMap raster tiles with attribution (light, interactive inspection
  use); M5 may switch to a hosted tile style.
- **Fort Lauderdale "open" permits** come from a layer frozen in January 2021: open durations are
  counted to today and every open-permit answer says so.

## M3 — what we publish, and where (decided 2026-11-27)

- **Broward is already registered in Atlas** (`counties/FL/broward.json`, `county` group only,
  archive `baguqeerahfw4wnjiumsos6e2i3r2lcmaadfuvi54o7qx75xqx2vei42wpmvq`, 754,269 properties,
  built from the Florida Statewide Cadastral layer; registered 2026-11-12, refreshed 2026-11-23).
  This is the "started" pipeline the README describes. Elephant hosts it after the Atlas merge.
- **We register a `property_improvement` group next to it**, the pattern of Cobb, GA (atlas#191):
  `groups.county` stays byte for byte; our group adds Fort Lauderdale and Weston permits,
  contractors and licenses.
- **Same property identity as the published archive.** A property CID is the CID of its Seed
  (parcel + address + the request that produced them). Our M1 Seeds came from the BCPA roll
  request, so 0 of 749,012 shared parcels had the published CID. The new `atlas-county` source
  downloads the published Seed tables (`parcel`, `address`, `address_has_parcel`; the
  `CountyTables` block is checked against its CID, each part against its recorded size) and the
  permit transform reuses each parcel's published Seed. Rebuilding an entity from its
  export-tables row with null columns dropped reproduces it exactly: all 26,663 property CIDs of the
  group are properties of the published archive, and the build fails if any is not
  (`checkPublishedPropertyCids`, QA check `permit_group_extends_published_county`).
- **Left out:** 530 permitted parcels (3,345 permits) the published archive does not hold. They
  stay in our query views; they need a county superset to be registered.
- **Our own county archive is not published.** It stays the local source of the query database
  (more parcels, full sales history, structures and roof age than the published one). Replacing the
  published `county` group would have to be a proven superset of it (Atlas convention, e.g.
  atlas#180, #197: no published record dropped), including its 573,130 individual owner records,
  which conflicts with our no-owner-PII default (Open Q3). Deferred as a follow-up.
- **The DuckDB index is not published** (2.9 GB). `oracle sync` rebuilds it from the published
  Parquet. Published per run: the `property_improvement` archive + tables (~0.15 GB), query views,
  samples, `meta/*.json` and the run manifest (~0.1 GB), so two free pinning tiers suffice.
- **Permit dedup made deterministic (found while rebuilding).** 519 permit keys have duplicate
  source rows (32 with differing statuses); the old ordering left ties, so a re-derive could keep a
  different row (3 statuses flipped between two derives of the same input). The choice is now
  total: closed record, source, latest update, then a content hash (`createDrvPermits`). The run's
  permit group, supplement and index were rebuilt with it; its local (unpublished) county archive
  keeps the earlier derive until the next full run.
- **Gateways (observed 2026-11-27):** `ipfs.io` answers path requests with a "service worker
  gateway only" notice and `dweb.link` redirects or rate-limits; `ipfs.filebase.io` serves. M3
  verification must handle this or use other independent gateways (README names these two only
  as examples).

## M3 — how publishing works (implemented 2026-11-27)

- **Providers.** Filebase (Kubo RPC `rpc.filebase.io`) holds the Lexicon DAGs and every file;
  Pinata holds every file again. Pinata's free plan refuses pin-by-CID (`PAID_FEATURE_ONLY`) and
  CAR imports (403), so its copy of each DAG is the group's `.car` file, which anyone can
  re-import. Both providers compute the CID of every file independently (CIDv1, raw leaves,
  256 KiB chunks); a mismatch fails the publish (tested on a 1.1 MB chunked file: identical).
- **Tables DAG import.** `elephant-cli upload <tables dir>` (build `94db3af`, the one Atlas's gate
  pins) sends `tables.car`, which holds only the `CountyTables` block; Filebase's `dag/import`
  refuses it ("the CAR is missing blocks its DAG requires (12 missing)": 11 parts + the archive
  root). Publish then writes the complete tables DAG as one CAR (that block, every archive block,
  every part's blocks, each checked against its CID) and imports it. The manifest records which
  path each DAG took (`groups[].uploads`).
- **Gateways.** Verification uses `ipfs.filebase.io` and `gw.ipfs-lens.dev` (independent of both
  providers); `ipfs.io`, `dweb.link` and `trustless-gateway.link` answered 429/52x to every request
  on 2026-11-27. Both serve CORS and range requests, so the WASM page reads the published Parquet
  by CID. Override with `ORACLE_GATEWAYS`. Local gateways are refused.
- **Verification.** Files: size + SHA-256 from the manifest, byte for byte on both gateways.
  Lexicon archive (133k blocks): public gateways cut off a full DAG export (`ipfs.filebase.io`
  appended "CAR stream truncated" after 3,526 blocks), so the archive is checked as Atlas does: every
  byte through its `.car` file (rooted at the archive CID, every block hashed at publish), plus a
  spaced sample of 16 blocks from the gateway (root, shards, properties; dag-json links followed,
  each block hashed). Tables root: its block, which must link exactly the archive root and the
  manifest's parts (each checked byte for byte). The manifest: one raw block. Retries: timeouts and
  5xx back off 2/4/8 s; 429 waits `Retry-After` or 15 s × attempt.
- **Path-keyed CDN caches.** `gw.ipfs-lens.dev` sits behind Cloudflare, which caches by path: after
  one `?format=car` or plain GET of a CID, a `?format=raw` request for it returns the cached CAR or
  file. Block reads accept a CAR (read to the requested block) and fall back to the full byte check
  when they get file bytes. Both answers are still checked against the CID.
- **Run history next to a synced run.** A manifest cannot name its history (the history lists the
  manifest's CID). `sync` takes it from the local run that published the manifest, or from
  `--history <cid>` (it must list the manifest). `publish --resume` re-verifies an interrupted
  publish from its pinned manifest instead of uploading again.
- **Published identity.** The views hand out the property CIDs of the published Atlas county
  archive (`supplement/atlas_seed.parquet`): 749,012 of 766,044 parcels; the 17,032 parcels that
  archive lacks get `property_cid` null (contract: nullable). Entity lists show only published
  CIDs (the property and its `property_improvement` entities); sale and tax rows no longer carry
  CIDs of the unpublished county archive. QA check `property_cids_published`.
- **The index is rebuilt, not downloaded.** The manifest lists the inputs (`query/v_*.parquet`,
  `query/qd_*.parquet` county detail, `supplement/*.parquet`, the `property_improvement` Lexicon
  parts, `meta/coverage.json`) and the view row counts; `oracle sync` rebuilds the index from them
  and fails on any count mismatch. `--rebuild` also recomputes `v_roof_permit` and `v_contractor`
  from the published Lexicon tables and compares them row for row. `v_property` cannot be
  recomputed from published Lexicon data, because the run's own county archive is not published.
- **Incremental runs reuse the county group** (hardlinked, no disk) when none of its inputs
  (roll, DOR, Census, Sunbiz) changed since the previous run; permit refreshes do not count,
  because the one permit-derived county field (structure roof date) is served from the run's
  supplement (`qd_structure`, `v_property`). Otherwise the county group is rebuilt.

## M5 — hosting (decided 2026-11-28)

- **One container Lambda on a public Function URL, no CloudFront.** The Function URL is HTTPS by
  default. CloudFront would add a cache in front of `/mcp` and `/api/agent` (which must never be
  cached) for no gain: a 5-minute EventBridge ping keeps an instance warm and no custom domain is
  needed. CloudFront can be put in front later without other changes.
- **The image serves the published run only.** `cache/published/<manifest cid>/` is synced first
  (`oracle sync` checks every file's sha256 against the manifest) and copied in; the server opens
  `index.duckdb` read-only. DuckDB extensions (`fts`, `vss`) and the embedding model are installed
  at build time, so the read-only Lambda filesystem never downloads anything.
- **Server bundle, not tsx.** `src/hosted.ts` is bundled with esbuild (dependencies external) to
  `/app/src/hosted.mjs`, so `REPO_ROOT` resolves to `/app` as in a clone.
- **Agent key and budget.** The Claude key is read from the SSM SecureString
  `/roofing/anthropic-key` at cold start (never an env value). The daily token budget is counted in
  a DynamoDB table (pk `AGENT#<day>`, TTL) shared by every instance; the per-IP limit stays per
  instance. Client IPs come from the address the Function URL appends to `X-Forwarded-For`
  (exactly one trusted hop), so they cannot be spoofed to dodge the limit.
- **Agent model `claude-sonnet-5-5`, 500k tokens a day, 50 s agent timeout** (the Lambda stops at
  60 s). Settings live in `deploy/hosted.json`; the alarm email is passed at deploy time only.
- **Index prefetch.** Lambda loads image files lazily, so a fresh instance's first queries waited
  on `index.duckdb` blocks (a new CRM workspace took ~21 s instead of ~1 s). The server reads the
  file once in the background right after start.
- **Agent tool output is compacted for the model** (`compactForModel`): no provenance, URLs, ids or
  nulls per row, at most 40 rows, totals kept. Citations and map pins still use the full result.
- **Public SQL is sandboxed in the engine.** The served index runs with
  `enable_external_access = false` and `lock_configuration = true`, so no query can read files or
  the network (a regex guard alone let `SELECT * FROM 'package.json'` through). The guard also
  rejects quoted table sources, `/api/sql` is rate-limited per IP, and the Lambda has a reserved
  concurrency of 20.
- **Measured** (first deploy, 3008 MB): cold start ~10 s init (13 s first request), warm requests
  ~0.3 s, memory ~265 MB, image 1.76 GB.

## Kit deviations (architecture §0.1, kept current)

| Kit rule (source) | Our choice | Why |
|---|---|---|
| AWS + CDK only (`apply-engineering-guidelines`) | Followed (M5): CDK, `us-east-2`, `project_name` tags, Powertools Logger + Metrics, X-Ray active tracing | — |
| Vercel AI SDK for every LLM call | Followed (M2); ESLint bans `@anthropic-ai/sdk` | — |
| Vitest + GitHub Actions; Prettier/ESLint; `tsc` | Followed | — |
| PagerDuty for critical failures | CloudWatch alarms (errors, 5xx, agent budget) and AWS Budgets → SNS email (M5) | No on-call rotation |
| Queued boundaries for external dependencies | Bounded, resumable source jobs on the operator machine (Accela lookup checkpoints per permit) | Batch, not a service |
| Atlas only; no county pointer (`use-oracle`) | No county IPNS; per-run manifests by CID (M3) | README acceptance criteria |
| Do not publish coverage objects | `meta/coverage.json` published (M3) | README requires coverage |
| Postgres query DB for reconciliation | DuckDB work store | No standing infrastructure |
| Public MCP = Elephant MCP 2.0 over Atlas | Own read-only MCP over the run (M2) | README asks for this run's MCP |
| DBPR license-detail URL per contractor (`dbpr-license-ingest`) | DBPR official licensee extract as the record and request | Same official record; avoids per-license session lookups |
| Roof-age lineage in `structure.source_payload` (kit integration) | Lineage in the derived `property_signals` table | Live `structure` schema has `additionalProperties: false` |

## Open questions (architecture §9) — status

Q1 (Atlas access): the repository is public; a registration is a pull request from a fork that
needs a code-owner approval (`.github/CODEOWNERS`) and a green `validate`.
Not yet sent to the assigner (the operator sends them): deadline (Q4),
owner-name policy (Q3 — default applied meanwhile), BBB score handling (Q7 — source blocked).
Q8 (designated Oracle repo) is answered by the fork parent:
`prismteam-ai/oracle-property-intelligence-platform-pipeline-broward-fl`.

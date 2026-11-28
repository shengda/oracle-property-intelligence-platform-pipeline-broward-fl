# Roofing Lead Platform — Architecture & Execution Roadmap

**Revisions:** single Elephant publication format; grading requirements; after plan review: repo
layout and PR gate, AWS CDK hosting, Vercel AI SDK, documented kit deviations, Atlas requested
early, published query index and samples, owner & occupancy (tenant) view, permit sourcing, scope
cuts; five milestones — ingest, inspect, upload, query, deploy.
**Specs (the two assigned user stories):**
- Oracle: [`../README.md`](../README.md)
- CRM: [`../../roofing-crm/README.md`](../../roofing-crm/README.md)

**Grading:** team-kit `slowking` agent (`agents/slowking.md`) with skills
`evaluate-candidate-intent`, `evaluate-candidate-product` (+ `reference/assignment-evidence-catalogs.md`)
and `evaluate-candidate-implementation`, plus `apply-engineering-guidelines` as its baseline.
Summary and consequences in §0. **Prerequisite:** Slowking drives the hosted URLs with the
`user-playwright` MCP tools, which the team kit's `mcp.json` does not ship; add a Playwright MCP
server to Claude Code before any self-check.

**Implementation plans:**
- Oracle: [`oracle-broward-pipeline-plan.md`](./oracle-broward-pipeline-plan.md) (this repo)
- CRM: [`../../roofing-crm/docs/roofing-crm-plan.md`](../../roofing-crm/docs/roofing-crm-plan.md) (CRM repo)

This document lives in the Oracle repo because the Oracle owns the data contract
the CRM consumes. Relative links assume the sibling-clone layout in Decision 1.

**Decisions recorded:**
1. **Repo layout and PR gate.** Two sibling clones; the team kit is a separate, unchanged checkout:
   ```
   ~/git/
   ├── soofi-xyz-team-kit/                                          (read-only reference; never commit to it)
   ├── oracle-property-intelligence-platform-pipeline-broward-fl/   origin = github.com/shengda/<repo>, upstream = designated assignment repo (Open Q8)
   └── roofing-crm/                                                 origin = github.com/shengda/roofing-crm, upstream = github.com/prismteam-ai/roofing-crm
   ```
   Each PR goes **from the `shengda` fork to the designated assignment repo**. That is Slowking's
   PR gate: a PR inside the fork does not count. Before writing code, confirm each `shengda/*`
   repo is a GitHub fork of its designated repo (`gh repo view shengda/<repo> --json parent`) and
   confirm the Oracle's designated repo URL. The `*-main` download folders inside the team-kit
   checkout are stale copies of these plans; do not build in them.
2. The Oracle repo **consumes the team-kit runtime read-only** (`skills/use-oracle/runtime`)
   through a pinned git submodule at `vendor/soofi-xyz-team-kit`. Anything Broward-specific
   that the kit lacks (county Lexicon transform, BBB/Sunbiz enrichment profile, owner and
   occupancy extraction, sales, coordinates) is implemented **inside the Oracle repo**, calling
   kit library functions with explicit options.
3. The team-kit plugin is not required; skills are read from the submodule.
4. **Published formats: Elephant Lexicon is canonical; README-required derived artifacts ride
   alongside.** Each run publishes, per data group, the elephant-cli CAR and exported Parquet
   tables (the Lexicon record). The README lists "query table, coverage, indexes, sample
   extracts" as eligible objects, so each run also publishes derived **file** artifacts built
   only from those exported tables: `query/index.duckdb` (roofing views, full-text and vector
   indexes), `query/<view>.parquet` (the roofing query tables), `samples/*.csv` (sample extracts)
   and `meta/*.json` (coverage, sources, state, deltas, and the `qa.json` data-quality report). The manifest labels every artifact
   `kind: lexicon | derived | meta`. Derived artifacts are never registered in Atlas. BBB score
   detail lives in the derived tables if the Lexicon has no rating fields (Open Q7).
5. **Both products ship as hosted runtimes on AWS via CDK** (`us-east-2`, every resource tagged
   `project_name`), as the kit's `apply-engineering-guidelines` (AWS + CDK mandatory) and
   `build-frontend-backends` require. Slowking scores **0/100** without a candidate-deployed,
   hosted URL it can use in a browser. Everything scales to zero: nothing costs money while idle,
   and the grader can never land on a "sleeping" page.
   - Oracle: one Lambda container image (the Fastify app via the AWS Lambda Web Adapter, with
     `index.duckdb` and the DuckDB extensions baked into the image) on a public Lambda Function
     URL (HTTPS by default; no CloudFront, see `docs/DECISIONS.md` § M5).
   - CRM: `apps/web` on Amplify, `apps/api` tRPC on Lambda behind API Gateway, the agent on a
     Lambda Function URL (avoids the 29 s API Gateway limit), leads in DynamoDB (on-demand).
   - Secrets in SSM Parameter Store (SecureString); an AWS Budgets alarm caps surprise spend;
     Powertools Logger/Tracer/Metrics on every Lambda.
   - Fallback only if no AWS account is available in T0: one Hugging Face Spaces Docker container
     per product, recorded as a kit deviation; the PR then links the direct `*.hf.space` URL,
     not the iframe page.
6. **Agents are part of both products, built with the Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`,
   zod tool schemas). Kit rule `stack-ai-sdk-for-llm` forbids direct provider SDKs. Each hosted
   UI has an agent chat panel; the Oracle also exposes a public, read-only MCP server over HTTP.
   One Oracle tool registry feeds both the MCP server and the agent's AI SDK tools. An MCP
   endpoint alone does not satisfy the graded agent demo.
7. **Local first: ingest → inspect → upload → query → deploy (§6.1).** The whole Broward
   dataset is ingested and built locally (M1), inspected in the local Oracle UI (M2), and only
   then published (M3), because published CIDs are immutable. The CRM is built against the
   published data served locally (M4); both apps are deployed last (M5). The hosting risk this
   defers is covered by the AWS/CDK hello-world in T0 and a time-boxed M5 with buffer.
8. **Kit conventions vs. the README: the README wins on graded behaviour, and deviations are
   written down.** No county-specific IPNS name: the kit forbids county pointers and the README
   makes IPNS optional. Atlas access is requested in M1 (T0) because registration has lead time; if it
   is granted, Atlas plus the kit's Elephant MCP become the public registry evidence. Every
   remaining deviation is listed in §0.1 and `docs/DECISIONS.md` and summarised in each PR.
9. **The CRM consumes the Oracle over HTTP.** Map, list and detail use the hosted Oracle `/api`,
   pinned to one manifest CID; the agent uses the hosted Oracle `/mcp`. The CRM ships no DuckDB,
   index build or data cache; it imports only the Oracle's zod contract (`<pkg>/contract`).

---

## 0. Grading requirements (Slowking)

**Gates — any failure ⇒ 0/100, Fail (no partial credit):**

| Gate | Requirement | Our answer |
|---|---|---|
| PR | PR to the **designated assignment repo**; the PR is the system of record | One PR per repo, from the `shengda` fork to the designated repo; description links everything below (Open Q8) |
| Runtime (absolute) | **Candidate-deployed hosted URL**, exercised in a Playwright browser without building or running anything. `localhost`, "clone and run", local Docker, tunnels ⇒ 0 | Hosted Oracle (Function URL → Lambda) + hosted CRM (Amplify + Lambda), HTTPS, public |
| Credentials | Working credentials in the PR, or public runtime | Public read-only Oracle; public CRM with a per-browser demo workspace (no login) |
| Demo | Demo artifact reachable from the PR | One demo video per product following its README demo transcript |

**Weighted score (anchored bands 0/25/50/75/100% per dimension):**

| Dimension | Weight | What drives it for us |
|---|---|---|
| Functional outcome (3–8 points derived from the story) | 40 | Every README demo step works in the hosted UI on real county-scale Broward data |
| Runtime & demo quality | 20 | Fast, stable hosted UI (index baked into the Lambda image, warm ping), good error states, video shows the real outcome |
| Evidence quality | 12 | Observed counts, provenance links, manifest CIDs that fetch on public gateways |
| Access-boundary compliance | 8 | Data served only from IPFS-published artifacts, no internal store exposed, sources respected and blocked portals never bypassed |
| Implementation quality | 7 | Clean architecture and tests; `apply-engineering-guidelines` (TypeScript, AI SDK, CDK, Powertools, Vitest + GitHub Actions CI, Prettier/ESLint) |
| Kit-usage conformance | 5 | Expected toolchain from `arceus`: `oracle` agent + `use-oracle` stage skills for ingestion, Atlas if granted; `build-frontend-backends` for the CRM; CRM routing to `vivillon`/Console is Open Q9 |
| Reproducibility | 4 | Everything reachable from the PR alone |
| Speed | 4 | Assignment-sent time → **latest commit** time. The Oracle assignment repo's first commit is 2026-10-24; confirm the sent time (Open Q4) |

**Oracle evidence catalog** (`assignment-evidence-catalogs.md`): real records at realistic
scale ("sparse data scores extremely low"), canonical entities and relationships, source
provenance, **RAG-backed retrieval**, an **exploration UI**, inquiry workflows on real data.
The example breakdown in `evaluate-candidate-intent` names **Tenant, Business and Contractor
views**, **semantic RAG Q&A**, **source-backed natural-language answers** and **data
scale/coverage**. We cover "Tenant" with an owner & occupancy view: the homestead exemption in
the bulk roll separates owner-occupied homes from likely tenant-occupied ones.

**Projected functional breakdowns** (the grader derives its own; we build so each point is
observable in the hosted UI):

| Oracle point (projected) | Where it is shown |
|---|---|
| Data coverage & scale across sources | Runs + Sources pages (counts, timestamps, limitations); Quality page (published `qa.json`: coverage, duplicates reconciled, geometry, permit, roof-age and link-rate checks) |
| Roofing lead queries (radius, roof age, long-open permits, contractor + BBB) | Explorer page |
| Agent / semantic RAG source-backed answers | Agent chat panel with a "Retrieved evidence" list (tool, args, rows) and the "near that area" follow-up |
| IPFS publication (manifest, CIDs on 2 gateways, CARs, new CID per run) | Manifest page "Verify now" (live two-gateway fetch + SHA-256 match in the browser) and "Check previous run"; Runs page |
| Entities, relationships, provenance; owner & occupancy (tenant), business, contractor views | Property / Occupancy / Business / Contractor pages |
| MCP-ready, no-ongoing-cost design | MCP page with a live console (`initialize`, `tools/list`, `tools/call` against `/mcp`), Cost page, DuckDB-WASM proof page |

| CRM point (projected) | Where it is shown |
|---|---|
| Map search: county default, GPS/pin, radius | Map |
| Lead discovery: aged roofs, long-open permits, filters | Map layers + list |
| Detail: permit, contractor, BBB | Detail drawer |
| Lead records management | Leads page (status, notes, filters by roof age / open duration / radius) |
| RAG agent over real data | Agent panel with retrieved evidence and follow-ups |
| Future sections (disabled) | Sidebar |

**Rules we adopt from the grader:**
- Nothing counts unless it is observable on the hosted URL or linked from the PR.
- The demo uses real Broward records.
- The final submission commit is the last commit; later commits extend elapsed time.
  Post-submission evidence (e.g. Atlas) goes in PR comments.
- Slowking's browser is headless Playwright: it may have no WebGL and no geolocation permission.
  Every proof runs live in the page (gateway digest check, MCP calls, agent retrieval), and pages
  work without the map (list fallback, center by city/address/lat-lon).
- Run a Slowking gate check against draft PRs as soon as both hosted URLs are live in M5, and a
  full self-check before submitting.

### 0.1 Kit conformance and documented deviations

| Kit rule (source) | Our choice | Why |
|---|---|---|
| AWS + CDK only (`apply-engineering-guidelines`) | Followed (Decision 5); HF Spaces only as a recorded fallback | — |
| Vercel AI SDK for every LLM call (`stack-ai-sdk-for-llm`) | Followed (Decision 6) | — |
| Powertools on every Lambda; Vitest + GitHub Actions; Prettier/ESLint; `tsc` | Followed | — |
| PagerDuty for critical failures (`observability-pagerduty-alerting`) | CloudWatch alarm → email | A candidate exercise has no on-call rotation |
| Queued boundaries for external dependencies (`external-dependency-boundaries`) | Source fetches (BBB, the optional Accela lookup) run as bounded, resumable batch jobs (checkpoints, per-host delays) on the operator machine; agent → Claude is synchronous with a timeout and a friendly failure message | Chat needs an immediate response; timeout and recovery are documented |
| Atlas is the only public registry; no county-specific pointer (`use-oracle`, `car-publication.md`) | No county IPNS. Per-run manifests and derived artifacts are published by CID because the README requires them; Atlas registration if access is granted (Open Q1) | README acceptance criteria |
| Do not publish coverage objects (`use-oracle`) | `meta/coverage.json` is published | The README requires coverage in the manifest |
| Query DB (Postgres) for internal reconciliation (`query-db-loading-matching`) | DuckDB work store with the same matching rules; kit Postgres stages run in Docker for one run only if required | No standing infrastructure |
| Public MCP = Elephant MCP 2.0 over Atlas (`use-elephant-mcp`) | Own read-only MCP over the published run; Elephant MCP evidence added if Atlas is granted | The README asks for an MCP-ready interface over this run |

## 1. System context

```
                    PUBLIC SOURCES (read-only, polite, robots-respecting)
  DOR NAL/SDF or appraiser roll · parcel geometry · ArcGIS permit layers (Fort Lauderdale, HCED) · Sunbiz · DBPR · BBB
                                         │
                                         ▼
┌──────────────────────── ORACLE PIPELINE (operator machine, per run) ─────────────────────┐
│  oracle ingest → oracle build (elephant-cli) → oracle index → oracle publish → verify   │
└──────────────┬──────────────────────────────────────────────────────────────────────────┘
               │ CARs + exported Parquet + derived index/query tables/samples + manifest (CIDv1)
               ▼
   Filebase + 2nd provider ──► public IPFS ◄── ipfs.io / dweb.link (grader can fetch)
               │ manifest CID (+ Atlas county page if granted)
               ▼
┌──────── HOSTED ORACLE (AWS CDK: Function URL → Lambda container image; public, read-only) ─┐
│ index.duckdb = published query/index.duckdb (sha256-verified, baked into the image)      │
│  ├── Explorer UI: Runs · Sources · Manifest · Explorer · Property · Occupancy ·          │
│  │   Business · Contractor · Agent chat · MCP · Cost · WASM proof                        │
│  ├── /api/*  (UI, CRM and agent endpoint; Claude key in SSM Parameter Store)             │
│  └── /mcp    (stateless Streamable HTTP MCP server; rate-limited)                        │
└───────────────┬──────────────────────────────────────────────────────────────────────────┘
                │ /api (HTTP) + /mcp
┌───────────────▼──────── HOSTED CRM (AWS CDK) ────────────────────────────────────────────┐
│ apps/web on Amplify (map, list, detail, leads, agent panel, disabled sections)           │
│ apps/api tRPC on Lambda (API Gateway) → Oracle /api        leads → DynamoDB              │
│ agent Lambda (Function URL) → Oracle /mcp                                                 │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Cost model.**
- The pipeline runs on the operator's machine, once per run.
- Data lives on public IPFS on free pin tiers.
- Every hosted piece scales to zero (Lambda, Amplify, DynamoDB on-demand, within the
  AWS free tiers), so no server runs while idle. That is "no ongoing infrastructure cost by
  default". ECR image storage (cents per month) is the only fixed line; `docs/COST.md` measures it.
- Anyone can rebuild the hosted Oracle from the manifest CID, or query `query/*.parquet`
  directly from a gateway, as the WASM proof page shows.
- Metered items: Claude usage for the agents, capped by rate limits and a daily budget, and an
  AWS Budgets alarm at $5/month.

## 2. Roles and repo boundaries

| Concern | Repo | Role |
|---|---|---|
| Source ingestion, Lexicon transforms, dedupe, provenance, roof age, occupancy | Oracle | Oracle |
| elephant-cli build, derived artifacts, IPFS publication, manifest, CARs, gateway verification, run history | Oracle | Oracle |
| Pipeline code, index + views, MCP server, explorer UI, agent, AWS hosting | Oracle | Builder |
| Map CRM, lead records, RAG agent, disabled future sections, AWS hosting | CRM | (product app) |

The CRM never ingests. It consumes one immutable run, identified by a manifest CID, through the
Oracle HTTP API and MCP, plus its own read-write leads table.

## 3. Oracle architecture

### 3.1 Pipeline stages

| # | Stage | Input → output | Kit reuse |
|---|---|---|---|
| 0 | Readiness | sources + Lexicon + CLI + hosting checks; permit open-data feed search; skip decisions recorded (§3.7); Atlas access requested → `docs/SOURCES.md`, `docs/DECISIONS.md` | `onboard-county`, `county-discovery`, `county-readiness-preflight`, `permits:probe-broward`, `migrate-elephant-cli-v2` |
| 1 | Seed + `county` group | appraiser roll or DOR NAL (CO_NO 16) + DOR SDF → seed root + `county` data-group root (property, parcel, address, structure, tax, sales; homestead flag staged) | `county-seed-data` source order; `build-county-transform` loop; Duval seed pattern |
| 2 | Geometry | parcel geometry → `geometry` entities linked to addresses | Duval NAL/parcel-geometry centroid pattern |
| 3 | Owners + occupancy | owner columns → owner entities + mailing address in `county` group (PII policy, Open Q3); homestead + use code → occupancy class (derived) | new (kit seed deliberately excludes owner PII) |
| 4 | Permits | Fort Lauderdale + HCED ArcGIS layers + open-data feeds (if found) → `property_improvement` data group; other jurisdictions recorded `skipped`/`blocked` (§3.7) | Broward permit profile, kit `arcgis-feature-service` adapter, `county-permit-adapter`, `county-ingest-run`; new loader for feeds |
| 5 | Roof age | permits + year built → `structure` roof fields | `src/roof-age/integration.ts` (`applyRoofAgeToTransformedData`) |
| 6 | Identity + business | DBPR → company/person/license; Sunbiz → corporate group; Overture → places group (optional, cut first) | `dbpr-license-ingest`, `sunbiz-corporate-ingest`, `overture-places-ingest` |
| 7 | Reputation | BBB (bounded; stop on 403) → BBB flag per Lexicon; score detail per Open Q7 | `bbb-harvest`, `bbb-link`; kit `harvestBbbCategory`, `validateEnrichmentProfile` |
| 8 | Build | per group: `validate` → `hash` (packed) → `validate` CAR → `export-tables` | `use-oracle/reference/car-publication.md` |
| 8b | Derive | exported tables → `query/index.duckdb`, `query/<view>.parquet`, `samples/*.csv` | new (`oracle index`) |
| 9 | Publish | `upload` to Filebase; pin every CID on a 2nd provider; manifest (no county IPNS) | `car-publication.md` (upload), new (manifest, 2nd provider) |
| 10 | Verify | manifest → 2 public gateways: files by bytes, DAG roots by trustless CAR | new |
| 11 | Serve (hosted) | manifest CID → published `query/index.duckdb` (sha256-verified) → explorer UI, agent, MCP on Lambda | new; modeled on the kit's Elephant MCP (local snapshot) |
| 12 | Atlas (if granted) | `export-tables --atlas-page` → Atlas PR → global IPNS → Elephant MCP sync | `car-publication.md` "Register in Atlas", `use-elephant-mcp` |

Working stores during a run (internal, never published or hosted): `work/oracle.duckdb` and
`runs/<run_id>/groups/<group>/outputs/`. If a reused kit stage requires Postgres/Restate, run
it in Docker for that run only and record it in run history.

### 3.2 Published data: Elephant Lexicon data groups

| Data group | Built from | Main Lexicon classes / relationships (exact names verified in T0) |
|---|---|---|
| `county` | NAL/SDF (or appraiser roll), parcel geometry, owner columns, roof age | `property`, `parcel`, `address`, `geometry`, `structure` (incl. `roof_date`, `roof_age_years`), `tax`, sales, owner person/company + mailing address; `property_has_address`, `address_has_geometry`, `property_has_tax`, … |
| `property_improvement` | Fort Lauderdale + HCED ArcGIS permit layers, open-data feeds (if found), DBPR | `property_improvement` (permit), `company`, `person`, `license`; `property_improvement_has_contractor`, `contractor_has_license`, `contractor_has_person`; BBB flag |
| corporate (group key from the Lexicon) | Sunbiz | `company` (+ addresses, officers) |
| places (group key from the Lexicon; optional) | Overture Maps | places classes per `overture-places-ingest` |

The seed group rides inside every archive and gives each property the same `property_cid`
in every group. Fields without a Lexicon home stay in `source_payload` and are listed as
Lexicon gaps. Derived values (occupancy class, owner location class, permit open days, BBB score
detail if the Lexicon has no rating fields) live in the derived query tables, never in the
Lexicon groups.

**Stable identifiers:** `parcel_identifier` (CRM lead key), `property_cid`, permit key
`<source_system>:<permit_number>`, company `sunbiz:<documentNumber>` where linked, license number.

### 3.3 Run artifacts, manifest, history

```
Run N (all CIDv1 base32)
├── <group>.car            file CID; group DAG rooted at a CountyIndex block (dag-json, packed)       kind: lexicon
├── <group>-tables/        export-tables Parquet parts (file CIDs) + tables.car (CountyTables root)   kind: lexicon
├── query/index.duckdb     roofing views + FTS + vector index, built only from the exported tables     kind: derived
├── query/<view>.parquet   v_property, v_roof_permit, v_contractor, v_business, v_owner                kind: derived
├── samples/*.csv          sample extracts (e.g. 100 aged roofs, 100 long-open permits)                kind: derived
├── meta/coverage.json  meta/sources.json  meta/state.json  meta/deltas.json  meta/qa.json            kind: meta
├── manifest-N.json        own file CID; lists every CID above; previous_manifest_cid → run N-1
└── run-history.json       own file CID; previous runs kept
```

The latest run is found from the PR and `demo-packet/`, the hosted Runs page, and Atlas if
registration is granted. There is no county IPNS name.

`oracle.manifest.v1`: `schema`, `run_id`, `created_at`, `county {state:"FL", name:"Broward", fips:"12011"}`,
`lexicon {manifest_url, manifest_cid?}`, `encoding {elephant_cli_version, elephant_cli_build, layout:"packed", part_size}`,
`groups[] { key, schema_cid, archive {cid, codec:"directory", ipld_codec:"dag-json", car {name, cid, size, sha256}}, tables {cid, codec:"directory", ipld_codec:"dag-json", car {…}, parts[] {name, cid, size, sha256, rows}}, properties, not_packed }`,
`artifacts[] {name, cid, size, codec:"file", sha256, media_type, kind:"derived"|"meta"}`, `previous_manifest_cid`,
`pins[] {provider, pinned_at}`, optional `origins[]`. DAG roots are recorded as
`codec:"directory"` + `ipld_codec:"dag-json"` with a CAR; byte artifacts are `codec:"file"` with
size + sha256. Verification results go into run history.

### 3.4 Incremental model

- Source descriptors with change modes (`file_digest`, `window` with 14-day overlap,
  `bounded_crawl`) and watermarks in `meta/state.json`.
- Each run rebuilds outputs touched by changed sources, reuses the rest, re-hashes each
  group; unchanged groups keep identical archive and tables roots.
- Deltas per group from the exported `properties` table (property CID → data-group root CID).
- Previous CIDs stay pinned; ≥3 runs demonstrate "ongoing" (simulated updates allowed if
  no source changes, labelled as such).
- **On-demand refreshes** (the README allows "scheduled or on-demand"): each later run is a
  manual `oracle run --mode incremental` (ingest → build → index → publish → verify), then a
  redeploy of the hosted Oracle on the new manifest CID. No scheduled job.

### 3.5 Index, derived artifacts, sync, query layer

`oracle index` runs inside the pipeline, after `export-tables`. It builds `index.duckdb` once per
run, only from that run's exported tables, and contains:
- views over every group's class and relationship tables;
- derived tables from tested TypeScript classifiers;
- **`roofing-views.v1`** (`v_property` incl. `occupancy_class` and `owner_location_class`,
  `v_roof_permit`, `v_contractor`, `v_business`, `v_owner`);
- a **full-text index**;
- a **vector index** (local sentence embeddings, DuckDB `vss`) over permit descriptions and
  business/contractor summaries only, which keeps the file small. Its size is measured in T0
  against the free pin quotas.

The same command writes `query/<view>.parquet` and `samples/*.csv`. All three kinds of output
are published with the run.

`oracle sync --manifest <cid>` downloads the published `query/index.duckdb`, sha256-verified and
cached by CID. With `--rebuild` it downloads the Lexicon Parquet parts instead and rebuilds the
index, which proves the derived index is reproducible from the Lexicon record (a test compares
row counts). Every consumer opens the index read-only.

One typed query module (`src/query/queries.ts`, exported as `<pkg>/client`; DTO zod schemas
exported as `<pkg>/contract`) is shared by the UI, the agent and the MCP server. It provides
`findAgedRoofs`, `findOpenRoofPermits`, `findLongHeldProperties`, `findOutOfAreaOwners`,
`findByOccupancy`, `getProperty`, `getPermit`, `getBusiness`, `getContractor`, `listContractors`,
`searchRecords` (hybrid text + semantic), `datasetInfo`, `resolvePlace` and `runReadOnlySql`.
Every row carries provenance, `property_cid` and the manifest CID.

### 3.6 Hosted Oracle: explorer UI, agent, MCP

One Lambda container image, deployed by CDK (`DockerImageFunction`, `us-east-2`):
- the image runs the Fastify app (`oracle serve`) through the AWS Lambda Web Adapter;
- `index.duckdb` (the published `query/index.duckdb` for the pinned manifest CID) and the DuckDB
  extensions are baked in at image build;
- it is served straight from a Lambda Function URL (HTTPS by default). CloudFront was dropped:
  the warm ping already avoids cold starts, nothing needs a custom domain, and it would only add
  cache rules that must never cover `/mcp` or `/api/agent`;
- a scheduled EventBridge ping keeps it warm.

It serves:

- **Explorer UI** (React/Vite/MapLibre):
  - `Runs`: summary, sources, coverage, limitations, history with per-group CIDs.
  - `Sources`: counts by source and Lexicon class, timestamps, provenance.
  - `Manifest`: every artifact with clickable `ipfs.io` / `dweb.link` links and the latest
    verification report.
  - `Explorer`: radius map; aged roofs; long-open permits with contractor + BBB.
  - `Property` / `Occupancy` / `Business` / `Contractor` views: entities, relationships,
    provenance. `Occupancy` is the owner & occupancy (tenant) view: owner type and location,
    owner-occupied vs likely tenant-occupied, years since transfer.
  - `Agent` chat, `MCP` (live endpoint + connect instructions), `Cost`/architecture.
  - **DuckDB-WASM proof page (required):** runs a roofing query in the browser straight against
    `query/<view>.parquet` on a public gateway.
- **Agent endpoint** `/api/agent`: Vercel AI SDK `generateText` with tools from the shared
  registry (max 8 steps). Answers cite parcel/permit identifiers and source URLs and list
  assumptions and missing data. The Claude key comes from SSM; per-IP rate limit and daily
  budget cap.
- **MCP server** `/mcp` (stateless Streamable HTTP with JSON responses, so it runs on Lambda;
  stdio for local use). Read-only, zod-validated, rate-limited.
  - Tools: `dataset_info`, `resolve_place`, `find_aged_roofs`, `find_open_roof_permits`,
    `find_long_held_properties`, `find_out_of_area_owners`, `find_by_occupancy`,
    `get_property`, `get_permit`, `get_business`, `get_contractor`, `search_records`,
    `run_read_only_sql`.
  - Resources: current manifest, run history, views guide.
  - Prompts: the two README agent questions.

### 3.7 Data sources and skill coverage

| # | README data category | Public source | Provided skill | Coverage | Gap and owning task |
|---|---|---|---|---|---|
| 1 | Property records | Broward County Property Appraiser bulk roll if published; otherwise **FL DOR NAL**, county 16 | `county-seed-data` (order: appraiser bulk → DOR NAL → county GIS) | ✅ Covered | Pick the source in T0; seed + `county` transform in T3 |
| 2 | Property detail pages | Broward County Property Appraiser website | `county-appraisal-onboarding`, `build-county-transform` | ⚠️ Skill exists, no Broward flow | **Fallback** for the `county` group if T0 shows provenance needs per-parcel page requests |
| 3 | Ownership + occupancy | Owner columns and homestead exemption of the same roll (#1) | `county-seed-data` drops owner columns | ⚠️ Partial | Owner entities, owner-location and occupancy classifiers in T5; publication per Open Q3 |
| 4 | Sales / years since transfer | **FL DOR SDF**, or roll sale columns | none | ❌ Not covered | Sales entities in T3 |
| 5 | Location / coordinates | Broward County GIS or DOR parcel layer | `county-seed-data` names county GIS; no centroid step | ⚠️ Partial | `geometry` entities in T4 |
| 6 | Roofing permits | Fort Lauderdale and HCED ArcGIS layers; city/county open-data permit feeds (ArcGIS REST, Socrata) if they exist. Portals and records requests skipped (§3.7) | `county-permit-adapter`, `county-ingest-run` + kit Broward profile | ⚠️ Covered within source access | T6. Kit profile: 9 adapter-implemented, 5 certified pilots, 4 listing-only, 5 identity-unproven, 9 blocked (documented, never bypassed); enumeration is bounded-only. Feeds searched in T0; skips documented per §3.7 |
| 7 | Contractor records | **FL DBPR** | `dbpr-license-ingest` | ✅ Covered | T8 |
| 8 | Business records (legal entities) | **Sunbiz** | `sunbiz-corporate-ingest` | ✅ Covered | T8 |
| 9 | Business records (businesses/POI) | **Overture Maps places** | `overture-places-ingest` | ✅ Covered | T8 — optional, first scope cut |
| 10 | BBB ratings | **BBB** `roofing-contractors` | `bbb-harvest`, `bbb-link` | ⚠️ Needs Broward profile; 403 risk; Lexicon flag only | Local profile + bounded harvest in T9; scores per Open Q7 |
| 11 | Reference: county boundary | **Census TIGER/Line** | inside `overture-places-ingest` | ✅ Covered | T4 |
| 12 | Reference: municipality centers, ZIPs | **Census** places/ZCTA | none | ❌ Not covered | T5, T13 |

#### Source sizes and download times

What each README data need comes from, how big it is and how long it takes to fetch. **Kit**
values come from team-kit files (`skills/sunbiz-corporate-ingest`, `skills/dbpr-license-ingest`,
`skills/bbb-harvest`, `skills/use-oracle/runtime/src/counties/{broward,duval}/`); **Est.** values
are estimates that T0 replaces with measured numbers in `docs/SOURCES.md`.

| Data (README need) | Source | Size | Download time | Updates | Basis / notes |
|---|---|---|---|---|---|
| Property, owners, mailing address, homestead, land use, year built, **last sale date** | FL DOR **NAL**, county 16 (`floridarevenue.com/property/dataportal`); Broward appraiser bulk roll if one exists | ~80–150 MB zipped, ~0.5–0.8 GB CSV | 1–5 min | Yearly | Source: Kit (Duval seed uses DOR NAL/SDF/PIN). Size: Est. Duval ≈ 404k parcels (Kit); Broward ≈ 0.8–1.0 M parcels (Est.). The NAL's own sale fields give years since last transfer |
| Sales history | FL DOR **SDF** | ~10–30 MB | < 1 min | Yearly | Est. Adds sale history beyond the NAL's last-sale fields |
| Coordinates / parcel geometry | FL DOR **PIN** parcel layer, or the Broward GIS parcel layer | ~150–400 MB | 2–10 min | Yearly | Source: Kit. Size: Est. Same portal as NAL/SDF, so the three stay consistent |
| Roofing permits — Fort Lauderdale | City ArcGIS layer `gis.fortlauderdale.gov/.../gisdata/MapServer/27` | **91,027 records** (Kit); ~50–150 MB JSON (Est.) | **~1–3 min** (pages of 1,000, 2 concurrent, 0.5 s apart; Kit config) | Ongoing | Kit marks it `certified`: parcel ID, status, applied/approved/CO dates, contractor name and licence. The kit also labels its contractor field `not-exposed` — check in T0. Load first |
| Roofing permits — unincorporated Broward | County HCED ArcGIS layer `bcgishub.broward.org/.../HCEDPossePermitsRef/MapServer/4` | **7,369 records** (Kit); ~5 MB | Seconds | Ongoing | Kit: `bounded-only`, no parcel field, so permits are matched by address |
| Roofing permits — other jurisdictions | Municipal portals (Accela, Tyler, Click2Gov, …) via the kit Broward profile; parcel-by-parcel search, ≥ 1.5 s per request (some hosts 0.5 s) | ~1–3 GB of captures per large city (Est.) | **~20–80 h per large city** at concurrency 1 (Est.) | Ongoing | **Skipped** (skip rule below). Kit profile: 32 jurisdictions, 9 blocked (captcha, login, custodian-only; never bypassed); the fetchable rest add up to tens of hours to days. One bounded exception: if the Fort Lauderdale layer has no contractor names, look up only its open roofing permits in Fort Lauderdale Accela (a few thousand requests, ~1–3 h, Est.) |
| Roofing permits — records requests | Custodian public-records responses | Varies | **Days to weeks** turnaround | One-off | **Skipped** (skip rule below): turnaround exceeds the delivery window |
| Contractors + licences | FL **DBPR** Construction licensee download (`myfloridalicense.com/construction-industry/public-records/`) | ~50–100 MB (Est.) | Minutes | Weekly (Kit) | The kit's per-licence lookup (one request at a time, conservative rate) is the fallback; the bulk file avoids hours of lookups |
| Business records (legal entities) | **Sunbiz** quarterly `cordata.zip` (`dos.fl.gov/sunbiz/other-services/data-downloads/`) | **~1.7 GB zipped, ~18 GB expanded** (Kit) | 5–30 min, **via a real browser** (Cloudflare-challenged; Kit) | Quarterly (Kit) | Kit: expand with system `unzip` (Deflate64); filter by the Broward ZIP prefixes. Lee scale: 12.6 M records scanned, ~379k matched (Kit) |
| BBB ratings | BBB `roofing-contractors` category for the Broward market; bounded harvest (2 s per page, 1.5 s per profile; Kit) | < 100 MB (Est.) | < 1 h (Est.) | Ad hoc | Kit: 403 risk is high — stop, record it, point to the official BBB API |
| Business records (places/POI), optional | **Overture Maps** places, Broward bbox via STAC/Parquet | ~20–60 MB (Est.) | 5–15 min (Est.) | Monthly | First scope cut |
| County boundary | Census **TIGER/Line** county polygon | < 100 MB (Est.) | < 1 min | Yearly | — |
| Place centres for "near [city]" | Census **Gazetteer** places + ZCTA | ~1–5 MB (Est.) | Seconds | Yearly | Feeds `resolvePlace` |
| Roof age | **Derived**: last roofing permit, else year built | — | — | Each run | From NAL + permits |

**Totals (Est.):** the sources we load ≈ **2.5–3.5 GB** downloaded in **under an hour** (Sunbiz
dominates; ~18 GB once expanded, streamed through the Broward ZIP filter so the expanded file is
not kept). The skipped portal crawls would have added **tens of hours** and **2–10 GB**.

#### Skip rule and how skips are documented

The binding constraint is **source access and fetch time, not skill coverage**.

**Rule:** a source is skipped when a full fetch would take more than ~2 hours unattended, or when
it depends on a third party's turnaround (records requests). Size alone is not a reason: Sunbiz is
~18 GB expanded but downloads in minutes and is the README's business-records source, so it stays.
Blocked sources (captcha, login, HTTP 403) are skipped regardless and never bypassed.

- **Skipped:** municipal permit portals (tens of hours to days; 9 of them also blocked) and
  public-records requests (days to weeks).
- **Kept for permits:** Fort Lauderdale ArcGIS (91,027) and HCED ArcGIS (7,369), any fast
  open-data feed T0 finds, and the bounded Fort Lauderdale Accela contractor lookup if T0 finds
  the layer's contractor field empty.
- **Consequence:** permits cover Fort Lauderdale and unincorporated Broward. Property, owners,
  coordinates, businesses, contractors and roof age (year built where no permit exists) stay
  county-wide. The demo centers on Fort Lauderdale. Elsewhere, open-permit queries return
  nothing and roof age falls back to year built, and the UI and agent say so.

**Where each skip is recorded.** The README asks for run history with "any source limitations"
(L41), "document pipeline speed limitations and source constraints" (L47), a demo showing
"documented source limitations" (L92), and an agent that "clearly identifies any assumptions or
missing data" (L111):

| Place | What it shows | README |
|---|---|---|
| `docs/SOURCES.md` | One row per skipped source: status `skipped` or `blocked`, reason (`too_slow`, `turnaround`, `optional_cut`, or the blocker), size and time estimate (measured in T0), coverage lost | L47 |
| `docs/DECISIONS.md` | The skip rule, the skipped list, the demo-city choice and why | L47 |
| `meta/sources.json`, `meta/coverage.json` (published) | `status`, `skipReason`, `estimate`, `limitation` per source; permit coverage by jurisdiction (`covered` / `skipped` / `blocked`) | L41 |
| Run history, `Runs` and `Sources` pages | The limitations of each run; a per-jurisdiction permit coverage table with reasons and estimates | L41, L92 |
| `Quality` page (`qa.json`) | Permit coverage check (share of parcels in covered jurisdictions), status `warn` with the documented limitation, not `fail` | L92 |
| Agent, MCP `dataset_info`, `AgentAnswer.missingData` | When a radius crosses uncovered jurisdictions, the answer names them, e.g. "no permit data for Oakland Park, Wilton Manors; roof age from year built" | L111 |
| CRM search results and lead detail | A permit-coverage note from the Oracle response | CRM L21 |
| `README.md` "Speed limitations and source constraints", `SUBMISSION.md` | The rule, each skipped source with its size and time, and the command that would add it later (`oracle ingest --source permits --jurisdictions <key>`) | L47 |

## 4. CRM architecture

```
roofing-crm/ (Turborepo, pnpm, TypeScript)
  apps/web               React + Vite + MapLibre GL (OpenFreeMap tiles) + tRPC client → Amplify
  apps/api               tRPC router → Lambda behind API Gateway; agent handler → Lambda Function URL
  packages/oracle-data   typed HTTP client of the hosted Oracle /api (pinned manifest CID) → CRM DTOs
  packages/leads-db      DynamoDB single table (on-demand); DynamoDB Local in tests
  packages/agent         Vercel AI SDK tool loop; tools = MCP client (@ai-sdk/mcp) to the Oracle /mcp
  packages/shared        DTOs, zod schemas, constants (Broward center, defaults)
  infra/                 CDK app: Amplify app, HTTP API + Lambdas, Function URL, DynamoDB, SSM params, budget alarm
```

- Hosted over HTTPS (GPS requires a secure context). Public, no login: each browser gets its own
  demo workspace (httpOnly cookie, seeded with demo leads, 7-day TTL), so graders' lead writes are
  isolated. Leads persist in DynamoDB, keyed by workspace. Map search also works without WebGL
  or GPS (list fallback; center by city/address via the Oracle's `/api/place` or lat/lon).
- Map, list and detail call the Oracle `/api`; responses are validated against the Oracle zod
  contract. The CRM checks that Oracle `/api/health` reports the pinned `ORACLE_MANIFEST_CID`
  and shows a degraded banner otherwise.
- The agent is an MCP client of the hosted Oracle `/mcp` (in development, the `/mcp` of a local
  `oracle serve --fixture`). Answers cite identifiers + provenance and state assumptions; rate-limited,
  budget-capped.
- Leads are keyed on `parcel_identifier`: one active lead per property, flagged `stale` when a
  newer run changes or drops the property.
- Disabled sections: Campaigns, Estimates, Jobs & Scheduling, Invoicing, Storm Tracking,
  Team. They are visible and `aria-disabled`, with no routes.

## 5. Contract between the repos

1. **Pointer:** the CRM config has `ORACLE_API_URL`, `ORACLE_MCP_URL` and the expected
   `ORACLE_MANIFEST_CID`. To upgrade, redeploy the Oracle on the new manifest, then change the
   CRM value and redeploy.
2. **Data:** Oracle HTTP API v1 (`/api/health`, `/api/query/*`, `/api/property/:id`,
   `/api/permit/:key`, `/api/contractor/:id`, `/api/place?name=`) returning `roofing-views.v1` rows with the stable
   identifiers. Breaking changes bump the version.
3. **Code:** the CRM depends on the Oracle repo's `contract` export only (zod schemas and types;
   no DuckDB). Use `link:` during development and pin `github:<designated oracle repo>#<sha>`
   before the CRM PR; the Oracle's `prepare` builds `dist/`.
4. **Agent tools:** the CRM agent uses the hosted Oracle MCP URL. That is the README's "agents
   and the roofing CRM can use [it]" in practice.
5. **Fixture:** the Oracle ships `fixtures/elephant-mini/` (≈50 synthetic Lexicon-valid
   properties through the real validate → hash → export-tables path). `oracle serve --fixture`
   gives the CRM a local Oracle API + MCP for development. CRM unit tests use a fake Oracle
   server built from the contract. Demos use real Broward records only, and the CRM is
   built and submitted only on a published county-scale manifest, never on the fixture.

## 6. Execution plan

### 6.1 Milestones

Five milestones, in order: **ingest → inspect → upload → query → deploy**. Everything runs locally
until M5. Data is inspected before it is published because CIDs are immutable: a bad row or
leaked PII cannot be withdrawn once pinned.

| M | Name | Contents (plan tasks) | Exit criteria | Est. |
|---|---|---|---|---|
| **M1** | **Ingest** — download all required data and build it into the target format, locally | Oracle T0–T10, T13 index build (`buildIndex`, `writeDerived`); `oracle run --no-publish` | **Readiness (T0):** sources confirmed, Lexicon map, provenance spike, CLI pinned, hash throughput and sizes measured, Atlas access requested, skip list recorded, open questions sent, forks confirmed, AWS/CDK hello-world measured (so M5 has no unknowns). **Data:** every bulk source ingested — DOR NAL + SDF + PIN (property, owners, homestead, last sale, coordinates), Sunbiz, DBPR, Fort Lauderdale and HCED ArcGIS permits, BBB (bounded), Census places/ZCTA/TIGER (+ Overture if not cut). **Build:** every Lexicon group `validate`-clean, hashed, CAR-validated and exported; `runs/<run_id>/query/index.duckdb`, `query/*.parquet`, `samples/*.csv` and `meta/qa.json` built from the exported tables. Slow sources skipped and recorded per the §3.7 skip rule | 12–15 d |
| **M2** | **Inspect** — Oracle UI, MCP and agent on the local run | Oracle T13 query layer, T14, T15 (incl. the Quality page), T16; `oracle serve --index runs/<run_id>/query/index.duckdb` | Every README query works in the local UI on real county-scale data; the Quality page (`meta/qa.json`, written by `oracle index`) reviewed (counts vs the NAL row count, geometry coverage, permit status and open-duration distributions, roof-age basis mix, contractor/BBB link rates, occupancy and owner-location mix, PII scan of published columns, 20-parcel spot check against the appraiser site); defects fixed by re-running M1 steps; written sign-off in `docs/DATA-QA.md` | 5–6 d |
| **M3** | **Upload** — publish to the Elephant network | Oracle T11, T12, T20 (if Atlas access is granted) | Run 1 published (Lexicon groups + derived + meta incl. `qa.json`, Filebase + second pinner; `publish` refuses a failed QA check unless `--force`, which is recorded); manifest CIDs fetch and match on ipfs.io and dweb.link; `oracle sync --manifest <cid>` + `--rebuild` reproduce the inspected index; **run 2** (incremental: windowed re-pull of the ArcGIS permit layers and DBPR) publishes a new manifest CID while run 1 still resolves; demo-packet manifests and run history recorded | 2–3 d |
| **M4** | **Query** — CRM UI on local data | CRM T1–T10 | The CRM runs locally against `oracle serve --manifest <run 2 CID>` (published data, synced and verified) with DynamoDB Local; the full CRM demo transcript passes `e2e/demo.spec.ts` locally, including the grader-like project (no WebGL, no geolocation) | 7–9 d |
| **M5** | **Deploy** — both UIs to production | Oracle T17, T18, T19; CRM T11, T12 | Oracle (Function URL → Lambda) and CRM (Amplify + Lambda + DynamoDB) hosted on the latest manifest; **run 3** (on-demand incremental, or a labelled simulated update) published and the hosted apps redeployed on it; Slowking gate check, then full self-check against draft PRs; demo videos; ready PRs; final commits | 4–5 d |

Atlas registration (T20) runs inside M3 if access has arrived, otherwise whenever it arrives
(post-submission evidence goes in a PR comment).

**Scope cuts if the deadline (Open Q4) is tight, in this order:**
1. Overture places group.
2. Business page depth (Sunbiz officers).
3. BBB beyond a bounded flag.
4. The third real run (keep 2 real runs + 1 labelled simulated run).

**Never cut:** the hosted URLs, county-scale property data, permits and roof age for the demo
area, the manifest and live two-gateway verification, run history with a new CID, both agents, the
vector index ("semantic RAG Q&A" is a named Slowking point), the live MCP console, the demo
videos, and both PRs.

### 6.2 Sequencing

```
M1 Ingest ─► M2 Inspect ─► M3 Upload ─► M4 Query ─► M5 Deploy
   └ CRM T1–T4 on the Oracle fixture can be built while M1 downloads and hashing run unattended
```

- Sequential critical path ≈ 30–38 working days solo. Building CRM T1–T4 on the fixture while M1
  downloads and hashing run unattended brings it to ≈ 26–32. About a month has already elapsed since
  2026-10-24: confirm the sent time and deadline (Open Q4) and apply the scope cuts above.
- **Hosting risk moves to the end.** Slowking scores 0 without a hosted runtime, so M1 keeps the
  T0 AWS/CDK hello-world (memory quota, image size, cold start), M5 is time-boxed with buffer, and
  the HF Spaces fallback stays documented.
- Every task is scope-parameterized (`--parcels`, `--jurisdictions`, `--source`), so a defect
  found in M2 re-runs only the affected source or group.
- Speed: the final submission commit is the last commit; post-submission fixes only for a
  grading blocker.

### 6.3 Agents and skills per phase

| Phase | Use |
|---|---|
| M1 readiness (T0) | `onboard-county`, `county-discovery`, `county-readiness-preflight`, `migrate-elephant-cli-v2` |
| M1 ingest | `build-county-transform`, `county-seed-data`, `county-permit-adapter`, `county-ingest-run`, `dbpr-license-ingest`, `sunbiz-corporate-ingest`, `overture-places-ingest`, `bbb-harvest`, `query-db-loading-matching` (from `vendor/soofi-xyz-team-kit`; optionally via the `oracle` agent); `county-appraisal-onboarding` only for the provenance fallback |
| M1 build, M3 publish | `use-oracle/reference/car-publication.md` + our manifest, derived artifacts, 2nd provider |
| M2 query/MCP | `use-elephant-mcp` as the reference pattern |
| M5 hosting (both) | `apply-engineering-guidelines` (CDK, `us-east-2`, `project_name` tags, Powertools, CI), `build-frontend-backends` (Amplify, tRPC on Lambda, CDK) |
| Agents (both) | `apply-engineering-guidelines` rule `stack-ai-sdk-for-llm` (Vercel AI SDK); `claude-api` only for model choice |
| M4 CRM | `build-frontend-backends`, `apply-engineering-guidelines`, `build-local-rag-pocs` |
| M5 | `slowking` with `evaluate-candidate-intent` / `-product` / `-implementation` (Playwright MCP required) |
| M3 (T20) | `use-oracle/reference/car-publication.md` "Register in Atlas", `use-elephant-mcp` |
| All | Prism product builder/configurer agents are not used (no Prism deployment) unless Open Q9 says the CRM must be a Console app |

## 7. Demo mapping (hosted URLs)

| Oracle demo step | Evidence |
|---|---|
| Run summary | Runs page |
| Records by source | Sources page (counts per source and Lexicon class, timestamps, provenance) + Quality page (published `qa.json` checks with pass/warn/fail) |
| DuckDB layer | Cost/architecture page + WASM proof page (DuckDB-WASM queries `query/<view>.parquet` straight from a public gateway): no hosted database required |
| Manifest | Manifest page + `demo-packet/manifests/<run_id>.json` |
| Two gateways | Manifest page "Verify now": the browser fetches from ipfs.io and dweb.link and matches size + SHA-256 against the manifest; latest `oracle verify` report also shown |
| Incremental new CID | Runs page: per-group and manifest CIDs for run N vs N+1, both in run history; Manifest page "Check previous run" shows the old CID still fetches |
| UI radius / roof age / permits | Explorer page |
| Owner & occupancy (tenant) | Occupancy page, Property view |
| Agent | Agent chat page with the two README prompts (the second is a follow-up reusing the first's area) and retrieved evidence |
| MCP-ready | MCP page: live console calling `/mcp` from the browser, connect instructions; CRM uses it |
| No infra cost | Cost page + `docs/COST.md` |

| CRM demo step | Evidence |
|---|---|
| Opens on county | Broward center, zoom 10 |
| Pin/GPS + radius | map controls (HTTPS) |
| Aged roofs / open permits | map layers + list, long-open emphasized |
| Detail with contractor + BBB | detail drawer |
| Convert to leads | single + bulk convert, Leads page (persists in DynamoDB, per-browser workspace) |
| Agent query | chat panel; results pushed onto map |
| Filters | roof age, permit status/open years, radius, on the candidate list and the Leads page |
| Disabled sections | sidebar |

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| No usable hosted runtime at grading time ⇒ 0/100 | Medium, fatal | Hosting is last (M5), so T0's AWS/CDK hello-world measures quotas, image size and cold start in M1; M5 time-boxed with buffer; HF Spaces fallback; scale-to-zero Lambda (no sleep page); warm ping + uptime check; health page; Slowking gate check at M2 |
| PR does not satisfy the gate (fork not linked to the designated repo, wrong target) | Low–Med, fatal | Confirm fork parents and designated repos in M1 / T0 (Open Q8) |
| Lambda limits: 10 GB image, memory quota on new accounts, API Gateway 29 s timeout | Medium | Keep the index small (embeddings only for permits/businesses); measure in T0 (M1); agents on Function URLs; request quota increase early; HF Spaces fallback |
| Cold start with a large baked index | Medium | Lazy image loading, read-only DuckDB, warm ping; measure and record in `deploy/README.md` |
| Agent key abuse or cost | Medium | Key in SSM, per-IP rate limit, daily budget cap, AWS Budgets alarm, friendly "limit reached" message |
| Agent budget exhausted during grading ⇒ agent point scores 0 | Low–Med | Budget sized for several grading runs; budget-use alarm at 80%; raise the cap during the grading window |
| Grader's headless browser has no WebGL / geolocation ⇒ map flows fail | Medium | List fallback without the map; center by city/address/lat-lon; e2e project with WebGL and geolocation off |
| Public CRM writes collide or get spammed | Medium | Per-browser demo workspaces with TTL; daily lead-create cap per workspace |
| Post-submission commits (e.g. Atlas evidence) lower Speed | Medium | Later evidence in PR comments, never new commits |
| Lexicon/kit provenance rules reject bulk-file `source_http_request` for the `county` group | Medium, high impact | Decide in T0 with a 10-parcel spike; fallback = appraiser page capture with throughput gates |
| Thin Broward permit coverage (blocked portals, bounded-only enumeration) ⇒ weak long-open-permit demo | High | Load both ArcGIS layers (≈ 98k permits) and any fast feed T0 finds; demo in Fort Lauderdale; skipped and blocked jurisdictions shown as documented limitations in `SOURCES.md`, the Sources and Quality pages and agent answers (§3.7); ask Open Q5; never bypass |
| BBB 403 / robots | High | Stop, record evidence, point to the official API |
| Elephant CLI 2 is a pre-release | Medium | Pin one build (≥ `94db3af`) per run, recorded in the manifest |
| Full re-hash per run too slow | Medium | Measure in T0; reuse unchanged outputs; hash only changed groups |
| Second provider cannot pin the same CIDs | Low–Med | Pin-by-CID provider, or `ipfs dag export` + CAR upload |
| Fresh CIDs slow on public gateways | Medium | Pin early; retries; small parts; pre-warm; 2 providers |
| Owner PII published immutably | Medium | No individual owner names/street lines by default (Open Q3) |
| Kit-usage and implementation points lost on deviations | Medium (≤ 12 pts) | Follow AWS/CDK/AI SDK/Powertools; record the remaining deviations (§0.1) in `DECISIONS.md` and the PRs; ask Open Q9 |
| Free-tier pin quota exceeded (Lexicon + derived index × runs) | Medium | Measure in T0; unchanged artifacts keep their CIDs across runs; second provider or paid tier |
| Deadline / speed: about a month already elapsed | High | Confirm Open Q4; apply the scope cuts in §6.1 |

## 9. Open questions for the assigner

1. Data is published in Elephant format either way. May we also **register in Atlas** (private
   repo; needs access)? Asked in M1 (T0) because registration has lead time.
2. Are **Filebase credentials** provided, or do we use our own free-tier account(s)?
3. May **individual owner names / mailing addresses** be published to public, immutable IPFS?
4. Deadline and the **assignment-sent datetime** (speed is measured from it). The Oracle
   assignment repo's first commit is 2026-10-24.
5. Is skipping slow permit portals (tens of hours each) and records requests, documented as
   source limitations with size and time estimates, acceptable for "all available county data"?
6. Any constraints on **hosting**? Plan: our own AWS account, `us-east-2`, public URLs.
7. Is the Lexicon **BBB flag** enough, or must BBB **scores** be published?
8. Which **designated assignment repositories** should the two PRs target (the Oracle URL is
   unconfirmed)? We open them from the `shengda/*` forks.
9. Is the CRM expected to be built as a **Prism Console app** (`vivillon`), which `arceus` routes "new business app" requests to? If so, we need Prism environment access.

## 10. Acceptance-criteria and grading traceability (summary)

| Requirement | Covered by |
|---|---|
| Oracle: geography & coverage | Oracle T0, T1 config, T3 |
| Oracle: data loading (property/permit/owner/contractor/BBB/business/coords/roof age) | Oracle T3–T9 |
| Oracle: dedupe + provenance | Oracle T8, `source_http_request` on every entity (T2 writer, all source tasks) |
| Oracle: continuous/incremental + run history | Oracle T10, T12, T18 (on-demand incremental runs) |
| Oracle: performance + slow sources documented | Oracle T0, T18 |
| Oracle: Elephant IPFS conventions | Oracle T2, T10, T11 (+ T20 Atlas if granted) |
| Oracle: IPFS publication rules (CIDv1, manifest, CARs, 2 gateways, immutable CIDs) | Oracle T11, T12 |
| Oracle: published query table, indexes, sample extracts, coverage | Oracle T13 (`oracle index`), T11 |
| Oracle: DuckDB, MCP, agent, UI, no ongoing cost | Oracle T13–T17, `docs/COST.md` |
| Oracle: roofing queries incl. long-held + out-of-area owners | Oracle T13 |
| Oracle: owner & occupancy (tenant) view | Oracle T3, T5, T13, T15 |
| Oracle: demonstration (incl. "both Oracle and builder" Roles section) | Oracle T18, T19 |
| CRM: county default, GPS/pin, radius | CRM T5 |
| CRM: aged roofs, open permits, details, contractor/BBB | CRM T2, T4, T6 |
| CRM: lead list + lead records, lead filters by roof age / open duration / radius | CRM T3, T4, T6, T7 |
| CRM: RAG agent | CRM T8 (+ Oracle T13–T14) |
| CRM: disabled future sections | CRM T9 |
| CRM: demo transcript | CRM T10, T12 |
| Grading: PR, hosted runtime, credentials, demo gates | Oracle T0 (fork check), T17, T19; CRM T3–T4 (public workspaces), T11, T12 |
| Grading: observable in a headless browser (live gateway verify, MCP console, retrieved evidence, follow-ups, no-WebGL/no-GPS fallback) | Oracle T15, T16; CRM T5, T8, T10 |
| Grading: Speed (no commits after submission) | Oracle T19, T20; CRM T12 |
| Grading: kit conformance and documented deviations | §0.1; Oracle T0, T16, T17, T19; CRM T8, T11, T12 |
| Grading: reproducibility and speed | PR descriptions (Oracle T19, CRM T12); five-milestone sequencing (§6.1); scope cuts; final-commit rule |

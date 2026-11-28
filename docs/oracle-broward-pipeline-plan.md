# Oracle Broward Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use 10x-engineer:subagent-driven-development (recommended) or 10x-engineer:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete a continuous, incremental Broward County, FL property-intelligence pipeline that publishes each run to Elephant IPFS in Elephant Lexicon format (elephant-cli CARs + exported Parquet tables), together with the README-required derived artifacts (query tables, a DuckDB index, sample extracts, coverage) and one manifest per run. Ship a **hosted, public, read-only Oracle runtime on AWS** (CDK, scale-to-zero) — explorer UI, agent chat and MCP server over the published data — that a grader can exercise in a browser, with no standing Oracle-paid infrastructure.

**Architecture:** A Node/TypeScript CLI (`oracle`) collects Broward sources into a local work store and writes per-property Lexicon outputs per data group (`county`, `property_improvement`, corporate, optional places), reusing the team-kit Oracle runtime. Each run:
1. builds every group with elephant-cli (`validate → hash → validate CAR → export-tables`);
2. builds the derived `query/index.duckdb`, `query/<view>.parquet` and `samples/*.csv` from the exported tables (`oracle index`);
3. uploads to Filebase and pins every CID on a second provider;
4. writes a manifest (chained by `previous_manifest_cid`; no county IPNS) and run history;
5. verifies retrieval on two public gateways.

One Lambda container image (CDK, AWS Lambda Web Adapter, published index baked in) serves the explorer UI, an agent endpoint (Vercel AI SDK + the same query tools) and a stateless MCP server over HTTP, on a public Lambda Function URL (HTTPS).

**Tech Stack:**
- Runtime and data: Node ≥ 22.18, TypeScript, Elephant CLI 2 (pinned build ≥ `94db3af`), kubo (`ipfs` CLI), `@duckdb/node-api` (+ `spatial`, `fts`, `vss`, `httpfs`), transformers.js (`@huggingface/transformers`, local sentence embeddings), `@ipld/car` + `multiformats`.
- Interfaces: `@modelcontextprotocol/sdk` (stdio + stateless Streamable HTTP), Vercel AI SDK (`ai`, `@ai-sdk/anthropic`), `zod`, `commander`, Fastify + React/Vite/MapLibre, `@duckdb/duckdb-wasm` (proof page).
- Quality: `vitest`, Playwright, Prettier + ESLint, GitHub Actions CI.
- AWS (`us-east-2`, tagged `project_name`): CDK (`aws-cdk-lib`); Lambda container image + AWS Lambda Web Adapter; Function URL; SSM Parameter Store; EventBridge; AWS Budgets; Powertools for AWS Lambda (TypeScript); Docker for the image build only.
- Kit: team-kit runtime `@soofi-xyz-team-kit/oracle-runtime` (read-only git submodule).

**Spec:** [`../README.md`](../README.md) · Architecture: [`roofing-oracle-architecture-and-roadmap.md`](./roofing-oracle-architecture-and-roadmap.md) (decisions, §0 grading, §0.1 kit deviations)

**Repo:** `~/git/oracle-property-intelligence-platform-pipeline-broward-fl/` — `origin` = `github.com/shengda/oracle-property-intelligence-platform-pipeline-broward-fl`, `upstream` = the designated assignment repo (confirm in Task 0, Open Q8). The PR goes from the fork to the designated repo. All paths below are relative to this folder. Test command: `npx vitest run <file>` (integration tests needing `elephant-cli`/`ipfs` on PATH are skipped otherwise).

## Global Constraints

- County: **Broward County, FL** — FIPS `12011`, FL DOR county number `16`; default for ingestion, queries and demos.
- Roof-age threshold default **15 years**, long-held ownership default **10 years** — always query parameters, never baked into data.
- **Elephant Lexicon is the canonical published format.** `validate` must be clean before `hash`; `hash` in the packed layout (no `--linked`); `export-tables` is the **only** producer of published Lexicon tables; one pinned CLI build per run, recorded in the manifest.
- **Derived artifacts** are built only from that run's exported tables by `oracle index`: `query/index.duckdb`, `query/<view>.parquet` (`roofing-views.v1`) and `samples/*.csv`. They are published as `codec:"file"` artifacts with `kind:"derived"`, because the README lists query tables, indexes and sample extracts. They are never registered in Atlas, and never contain fields absent from the exported tables except classifier outputs.
- Validate against the live Lexicon manifest `https://lexicon.elephant.xyz/api/manifest`.
- Every Lexicon entity carries an exact `source_http_request` for the request that produced it; never auth headers, cookies or tokens.
- Internal stores (`work/`, per-property outputs, hashed ZIPs) are never published.
- Every published object: **CIDv1 base32**; never mutate a published CID; new data ⇒ new CID; run history retains previous CIDs. Every DAG root (archive, tables) is accompanied by its CAR.
- Manifest per run lists every eligible object with `cid`, `name`, `size`, `codec` (`file`|`directory`), `sha256`, `kind` (`lexicon`|`derived`|`meta`); optional `origins`; `previous_manifest_cid` chains runs. **No county-specific IPNS name** (the kit forbids county pointers; the README makes IPNS optional).
- Retrieval proven on **two independent public gateways** this environment does not operate: `https://ipfs.io` and `https://dweb.link`; bytes must match manifest size/digest. Private/local/authenticated gateway only = fail.
- Pin on Filebase **and** a second provider (no single-vendor dependency).
- Manifests, run history and verification reports committed under `demo-packet/`; CAR files attached to GitHub releases and pinned by CID.
- No standing Oracle-paid service; DuckDB runs on the consumer side.
- Sources: respect robots and access boundaries; on HTTP 403 / captcha / login, stop that source and record the limitation. Never bypass.
- Do not commit secrets, `.env*` (except `.env.example`), raw captures, Parquet, ZIP or CAR files — except the small synthetic `fixtures/elephant-mini/`.
- Default: no individual owner names or street lines in published groups until Open Question 3 is answered.
- **Do not modify the team kit.** Consume it read-only via the pinned `vendor/soofi-xyz-team-kit` submodule; put every Broward-specific addition in this repo. Do not run `npx skills add elephant-xyz/skills`.
- Demo uses **real** Broward records only (fixtures are for tests and the CRM's early development).
- **Grading (Slowking, architecture §0):** a **hosted, public HTTPS runtime** is mandatory — `localhost`, "clone and run", local Docker or tunnels score 0/100. Every README demo step must be observable on the hosted URL or linked from the PR. The PR from the `shengda` fork to the designated assignment repo is the system of record; it links the hosted URL, the MCP URL, the demo video, the latest manifest CID, setup docs and the kit-deviation summary. The final submission commit is the last commit: Slowking's Speed score runs to the PR head's latest commit, so nothing (e.g. Atlas evidence) is committed to the PR branch afterwards.
- **Observable in a headless browser:** Slowking credits only what it sees happen in its Playwright browser on the hosted URL. Every proof step (gateway fetch + digest match, MCP calls, agent retrieval) runs live in the UI, not only in the CLI or a stored report. Pages must work without WebGL: results render as lists when the map cannot initialise, and the search center can be set without clicking the map.
- **Kit engineering baseline (`apply-engineering-guidelines`, which Slowking also loads):**
  - TypeScript only.
  - Every LLM call goes through the Vercel AI SDK (`ai` + `@ai-sdk/anthropic`, zod tool schemas). Direct provider SDKs are forbidden.
  - AWS `us-east-2` with CDK only; every resource tagged `project_name`.
  - Powertools Logger/Tracer/Metrics on every Lambda.
  - Vitest + GitHub Actions CI, Prettier + ESLint, `tsc`.
  - Deviations are allowed only as recorded in architecture §0.1 and `docs/DECISIONS.md`.
- Hosted endpoints are read-only. The Claude API key lives only in SSM Parameter Store (SecureString), read at cold start. The agent and `/mcp` are rate-limited per IP, the agent has a daily budget cap, and an AWS Budgets alarm guards the account.
- The hosted image holds only published data (`query/index.duckdb` from a manifest CID, sha256-verified); never internal working stores.

## Review Focus

1. **Freshly published CID not yet resolvable on a public gateway** — verify retries with backoff, reports per-gateway/per-artifact results, and exits non-zero with a readable report rather than hanging or passing partially. (Task 12)
2. **Permit with missing/ambiguous dates or unmapped status** — normalized status `needs_review`, `open_days` null; never appears in "long-open" results. (Task 6, Task 13)
3. **Property without usable geometry** — no `geometry` entity, `geo_status` recorded; excluded from radius results but counted in coverage. (Task 4, Task 13)
4. **Incremental run where nothing changed** — every group's archive root and tables root identical to the previous run, deltas all zero, run still recorded with a new manifest/history CID. (Task 10)
5. **Agent sends write/DDL or unbounded SQL** — `run_read_only_sql` rejects non-SELECT statements (`COPY`, `ATTACH`, `INSTALL`, `PRAGMA`, `CREATE`, multiple statements) and caps rows. (Task 13, Task 14, Task 16)
6. **Derived index drifts from the Lexicon record** — `oracle sync --rebuild` from the published Lexicon Parquet parts reproduces the published `query/index.duckdb` view row counts exactly; a mismatch fails the run. (Task 13)

## Execution Order (five milestones, architecture §6.1)

Tasks are numbered by dependency; they are executed in five milestones. Everything is local until M5.

1. **M1 Ingest** — T0 → T1 → T2 → T3–T9 (county-wide) → T10 → T13 `buildIndex` + `writeDerived` + `qaReport` (all run by `oracle index`). `oracle run --no-publish` produces a complete local run under `runs/<run_id>/`. Bulk sources first (DOR NAL/SDF/PIN, Sunbiz, DBPR, Fort Lauderdale and HCED ArcGIS permits, Census); slow sources (municipal permit portals, records requests) are skipped by the architecture §3.7 skip rule and recorded as limitations. Fall back to `--parcels` for one municipality only if T0 shows county-wide hashing does not fit M1.
2. **M2 Inspect** — T13 query layer → T14 → T15 → T16, all on `oracle serve --index runs/<run_id>/query/index.duckdb` (labelled UNPUBLISHED). Review the Data quality page (`meta/qa.json`) and the data itself, fix defects by re-running only the affected `--source`/group, and record sign-off in `docs/DATA-QA.md`. Nothing is published before sign-off.
3. **M3 Upload** — T11 → T12: publish run 1, verify on both gateways, `oracle sync --manifest <cid>` and `--rebuild` reproduce the inspected index; then run 2 (incremental: windowed re-pull of the ArcGIS permit layers and DBPR) publishes a new manifest CID. T20 if Atlas access has arrived.
4. **M4 Query** — the CRM plan (T1–T10) runs locally against `oracle serve --manifest <run 2 CID>`.
5. **M5 Deploy** — T17 (hosted Oracle) → T18 (run 3 on demand, redeploy) → T19, together with CRM T11–T12. Open draft PRs as soon as both hosted URLs are live, run a Slowking gate check, then the full self-check.
6. Scope cuts if the deadline is tight follow architecture §6.1, in order: Overture places (T8), business page depth, BBB beyond a bounded flag, the third real run. Portal permit crawls are already skipped (§3.7). The vector index (T13) is **not** a scope cut: "semantic RAG Q&A" is a named point in Slowking's example breakdown.

---

### Task 0: Readiness spike, sources, Lexicon and CLI

Investigation task (no product code). Produces the facts later tasks depend on.

**Files:**
- Create: `docs/SOURCES.md`, `docs/DECISIONS.md`, `docs/LEXICON-MAP.md`

- [ ] **Step 0: Repo targets and grading prerequisites.**
  - Confirm `shengda/oracle-property-intelligence-platform-pipeline-broward-fl` and `shengda/roofing-crm` are GitHub forks of their designated assignment repos: `gh repo view shengda/<repo> --json parent`. If either is not a fork, re-fork from the designated repo before any commits (Slowking's PR gate).
  - Send the open questions (architecture §9), with priority on Atlas access (Q1), the deadline and sent time (Q4) and the designated repos (Q8).
  - Add a Playwright MCP server to Claude Code so the `slowking` self-checks can drive the hosted URLs.
- [ ] **Step 1:** In the submodule, run `(cd skills/use-oracle/runtime && npm ci && npm test)`; record pass/fail.
- [ ] **Step 2:** Run the `onboard-county` intake, `county-discovery`, and `county-readiness-preflight` procedures for Broward. Record each gate result.
- [ ] **Step 3:** Run `npm run permits:probe-broward` (bounded). For each of the 32 jurisdictions in `src/counties/broward/permit-profile.mjs`, record: adapter, implementation status, blocker type, sample latency, whether contractor/license fields appear. The latency, extrapolated to the jurisdiction's parcel count, is the evidence for each `too_slow` skip.
- [ ] **Step 3b: Permit sourcing beyond portals** (permits carry the long-open-permit demo; the kit profile enumerates bounded-only and blocks many jurisdictions).
  - Search for official bulk or open-data permit feeds: Broward County and city ArcGIS REST / Hub services, Socrata portals, published permit extracts. Record URL, licence, fields (status, issue/final dates, description, contractor/license, folio), update cadence and row counts.
  - Records requests are not filed (skip rule: turnaround). Record that in `SOURCES.md`.
  - Confirm Fort Lauderdale as the demo city: check that `CONTRACTOR` / `CONTRACTID` are populated on its ArcGIS roofing permits. If they are empty, enable the bounded Accela contractor lookup in T6 and record its measured time.
- [ ] **Step 3c: Record skip decisions.** Apply the architecture §3.7 skip rule to every source and jurisdiction. Write the rule, the skipped list with size and time estimates, and the demo-city choice to `docs/DECISIONS.md`; mark each skipped source in `SOURCES.md` and in `SOURCES` (`status: "skipped"`, `skipReason`, `estimate`).
- [ ] **Step 4:** For every source in architecture §3.7 (#1–#12), confirm availability, access terms, format, size and last-modified: Broward Property Appraiser bulk roll (if any) and FL DOR NAL + SDF for county 16; a Broward parcel geometry layer; Sunbiz quarterly bulk; DBPR licensee downloads (construction categories); Overture Maps places release; Census TIGER county polygon and Census places/ZCTA files; BBB `roofing-contractors` for the Broward market (bounded probe; stop on 403). Download each bulk source once and record its **actual size, row count and download time** next to the estimate in architecture §3.7 ("Source sizes and download times"); for portal sources, time 50 parcel searches per adapter and extrapolate. Update the §3.7 table with the measured values.
- [ ] **Step 5:** Install Elephant CLI 2 per `migrate-elephant-cli-v2` (pinned build ≥ `94db3af`); record `elephant-cli --version` and build commit. Confirm `export-tables --part-size` accepts a small cap (target 64 MiB).
- [ ] **Step 6:** Fetch the live Lexicon manifest and write `docs/LEXICON-MAP.md`: for each README data need, the exact data group, class and field names (property, parcel, address, geometry, structure roof fields, tax, sales, owner person/company + mailing address, property_improvement status/dates/description, contractor relationships, license, company, places, BBB flag); list Lexicon gaps (fields that would go to `source_payload`) and whether any BBB rating fields exist. Also record the bulk-roll homestead-exemption and land-use fields used for occupancy, and whether the Lexicon has a home for them.
- [ ] **Step 7:** **Provenance spike** — build Lexicon outputs for 10 Broward parcels from the bulk source with `source_http_request` = the official bulk-file request; run `elephant-cli validate` and `hash`. Record PASS/FAIL. If it fails or contradicts kit rules, record the fallback: per-parcel appraiser page capture via `county-appraisal-onboarding` (estimate throughput and scope).
- [ ] **Step 8:** Measure for 1,000 synthetic properties, then extrapolate to the Broward parcel count:
  - `hash` + `export-tables` time and output size;
  - `index.duckdb` size, split into views + FTS and embeddings for permits/businesses only.

  Decide whether the county-wide `county` group fits M1's time box. Compare the total published size per run, and across 3 runs given CID reuse, with the free pin quotas of both providers.
- [ ] **Step 8b: AWS hosting check.**
  - Choose the AWS account; run `cdk bootstrap` in `us-east-2`.
  - Deploy a hello-world Lambda container image (Fastify + AWS Lambda Web Adapter) with a Function URL, through CDK, tagged `project_name`. Include a dummy 2 GB file baked into the image.
  - Record cold-start time, the account's Lambda memory quota (request an increase to 10 GB if needed), the image size, and the cost of an idle month.
  - Create the AWS Budgets alarm.
  - If no AWS account is available, fall back to Hugging Face Spaces Docker: record its limits and sleep behaviour, and log the deviation in `DECISIONS.md`.
- [ ] **Step 9:** Decide and record in `DECISIONS.md`:
  - **Hosting and agent:** AWS account and region (default `us-east-2`), or the recorded fallback; the Claude model (via `@ai-sdk/anthropic`) and the agent's daily budget; the local embedding model.
  - **Data and provenance:** bulk source (appraiser roll vs DOR), provenance approach, permit sources (ArcGIS layers, feeds) and the §3.7 skip rule (portals, records requests).
  - **Publication:** second pinning provider (must support pin-by-CID or CAR upload); "no county IPNS"; Atlas status (requested on `<date>`).
  - **Pending answers:** owner-name policy (Open Q3), BBB score handling (Open Q7).
  - **Kit stages and quotas:** whether any kit stage needs Postgres/Restate; size vs free-tier quotas.
  - **Kit deviations:** copy the table from architecture §0.1 and keep it current.
- [ ] **Step 10:** Write `SOURCES.md` (one row per source: key, URL, access, change mode `file_digest`/`window`/`bounded_crawl`, status, blocker, size, row count, download time, throughput, notes; include permit feeds and records requests with their dates). Commit `docs/`.

### Task 1: Repo scaffold, kit submodule, Elephant CLI pin, config, CLI skeleton

**Files:**
- Create:
  - `package.json`: `"type":"module"`, `engines.node ">=22.18.0"`, `bin.oracle`, `exports {"./client": "./dist/client/index.js", "./contract": "./dist/contract/index.js"}`, `"prepare": "tsc -p tsconfig.build.json"`.
  - `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`.
  - `.github/workflows/ci.yml`: `tsc`, ESLint, Prettier check, `vitest run`.
  - `.gitignore`: `work/`, `runs/`, `cache/`, `cdk.out/`, `*.car`, `*.parquet`, `*.zip`, `*.duckdb`, `.env*`, `!.env.example`, `!fixtures/elephant-mini/**`.
  - `.env.example`: `FILEBASE_ACCESS_KEY=`, `FILEBASE_SECRET_KEY=`, `FILEBASE_BUCKET=`, `SECOND_PINNER=`, `SECOND_PINNER_TOKEN=`, `ELEPHANT_CLI=./bin/elephant-cli`, `ANTHROPIC_API_KEY=` (local development only; hosted reads SSM), `ORACLE_AGENT_MODEL=`.
- Create: `vendor/soofi-xyz-team-kit` (`git submodule add https://github.com/soofi-xyz/soofi-xyz-team-kit.git vendor/soofi-xyz-team-kit`, pinned; read-only; dependency `"@soofi-xyz-team-kit/oracle-runtime": "file:vendor/soofi-xyz-team-kit/skills/use-oracle/runtime"`)
- Create: `scripts/install-elephant-cli.sh` (downloads the build recorded in `elephant-cli.version` into `bin/`), `elephant-cli.version`
- Create: `src/config.ts`, `src/cli.ts`, `src/work-db.ts`
- Test: `tests/config.test.ts`, `tests/work-db.test.ts`

**Interfaces:**
- Produces:
  - `COUNTY = { state: "FL", name: "Broward", fips: "12011", dorCountyNo: 16, center: { lat: 26.15, lon: -80.30 }, bbox: { minLat, maxLat, minLon, maxLon } } as const` (bbox finalized in Task 4).
  - `DEFAULT_ROOF_AGE_YEARS = 15`, `DEFAULT_LONG_HELD_YEARS = 10`, `PUBLIC_GATEWAYS = ["https://ipfs.io", "https://dweb.link"]`, `LEXICON_MANIFEST_URL = "https://lexicon.elephant.xyz/api/manifest"`.
  - `openWorkDb(path: string): Promise<WorkDb>`; `WorkDb { run(sql, params?): Promise<void>; all<T>(sql, params?): Promise<T[]>; appendRows(table: string, rows: Record<string, unknown>[]): Promise<number>; close(): Promise<void> }`.
  - CLI commands registered (bodies filled later): `readiness`, `ingest`, `build`, `index`, `publish`, `verify`, `sync`, `query`, `mcp`, `serve`, `run` (`--mode full|incremental`, `--no-publish`).
  - What each data command reads and writes (all local and gitignored until `publish`):

    | Command | Reads | Writes |
    |---|---|---|
    | `ingest [--source <key>...] [--window <from>..<to>]` | Sources (§3.7) | Raw downloads in `cache/raw/<source>/<retrieved_at>/` (sha256 recorded); staging tables `stg_*` in the work store `work/oracle.duckdb`; `work/sources.json` (per source: status, counts, timings, limitation). Stops at the work store. |
    | `build [--run <id>] [--group <key>...]` | Work store | Per-property Lexicon outputs in `runs/<run_id>/groups/<group>/`; then elephant-cli → `runs/<run_id>/build/<group>.car`, exported tables in `runs/<run_id>/tables/<group>/`, `runs/<run_id>/meta/` (coverage, sources, state, deltas) |
    | `index --run <id>` | `runs/<run_id>/tables/` only (+ `meta/` for the QA checks) | `runs/<run_id>/query/index.duckdb`, `query/<view>.parquet`, `samples/*.csv`; last step: the QA checks → `runs/<run_id>/meta/qa.json` and a printed summary (Task 13). It exits 0 even with failed checks; `publish` is the gate |
    | `publish --run <id> [--force]` | `runs/<run_id>/` | CIDs, manifest, run history (Tasks 11–12). Refuses when `meta/qa.json` has any `fail` check unless `--force`, which is recorded in run history |
    | `run --no-publish` | — | `ingest` → `build` → `index` (M1/M2); without `--no-publish` it continues to `publish` → `verify` |

  - Data sources for `serve`/`mcp`/`query`, exactly one of: `--manifest <cid>` (synced from IPFS, sha256-verified), `--index <path>` (a local unpublished run; every page and tool result is labelled UNPUBLISHED and has `manifest_cid: null`; refused when `ORACLE_HOSTED=1`), `--fixture <dir>`.

- [ ] **Step 0: Work in the existing clone of the fork** (`~/git/oracle-property-intelligence-platform-pipeline-broward-fl`, `origin` = `shengda` fork). Do not use the `*-main` download folder inside the team kit.
```bash
cd ~/git/oracle-property-intelligence-platform-pipeline-broward-fl
git remote add upstream <designated assignment repo URL>   # from Task 0 Step 0
git fetch upstream && git status                           # main tracks the fork; README matches upstream
git checkout -b feat/broward-oracle-pipeline
git add docs/ && git commit -m "docs: architecture roadmap and execution plan"   # the plans already live in docs/
```

- [ ] **Step 1: Write failing tests**
```ts
test("county constants", () => {
  expect(COUNTY.fips).toBe("12011");
  expect(COUNTY.dorCountyNo).toBe(16);
  expect(DEFAULT_ROOF_AGE_YEARS).toBe(15);
});
test("work db round-trips rows", async () => {
  const db = await openWorkDb(":memory:");
  await db.run("create table t(id varchar, n integer)");
  expect(await db.appendRows("t", [{ id: "a", n: 1 }])).toBe(1);
  expect(await db.all("select * from t")).toEqual([{ id: "a", n: 1 }]);
});
test("kit runtime resolves", async () => {
  const mod = await import("@soofi-xyz-team-kit/oracle-runtime/src/roof-age/integration.ts");
  expect(typeof mod.applyRoofAgeToTransformedData).toBe("function");
});
```
- [ ] **Step 2:** `npx vitest run tests/config.test.ts tests/work-db.test.ts` → FAIL (modules missing).
- [ ] **Step 3:** Implement config, `openWorkDb` (DuckDB node-api appender), CLI with `commander`, CLI install script.
- [ ] **Step 4:** Re-run → PASS; `npx tsx src/cli.ts --help` lists all eleven commands; `bin/elephant-cli --version` matches `elephant-cli.version`; `npx eslint . && npx prettier --check .` pass.
- [ ] **Step 5:** `git add -A . && git commit -m "chore: scaffold oracle CLI with kit submodule, pinned elephant-cli and CI"`; confirm `git -C ../soofi-xyz-team-kit status` shows no changes.

### Task 2: Lexicon output writer, elephant-cli wrapper, roofing views contract, fixture

**Files:**
- Create: `src/lexicon/manifest.ts`, `src/lexicon/output-writer.ts`, `src/elephant/cli.ts`, `src/views/roofing-views.ts`, `src/types.ts`
- Create: `scripts/make-fixture.ts` → `fixtures/elephant-mini/` (≈50 synthetic Broward-shaped properties across `county` + `property_improvement`, run through the real validate → hash → export-tables path, plus `fixture-manifest.json`; `source_http_request` URLs point at `https://example.invalid/fixture/...`)
- Test: `tests/lexicon/output-writer.test.ts`, `tests/elephant/cli.test.ts` (fake binary), `tests/elephant/cli.integration.test.ts`, `tests/views/roofing-views.test.ts`

**Interfaces:**
- Produces:
  - `loadLexiconManifest(url?: string): Promise<LexiconManifest>`; `classFields(m: LexiconManifest, className: string): string[]`.
  - `type SourceHttpRequest = { method: "GET" | "POST"; url: string; multiValueQueryString?: Record<string, string[]> }`.
  - `type LexiconEntity = { id: string; className: string; data: Record<string, unknown>; sourceHttpRequest: SourceHttpRequest }`; `type LexiconRelationship = { type: string; from: string; to: string }`.
  - `type PropertyOutput = { parcelId: string; seed: Record<string, unknown>; group: GroupKey; entities: LexiconEntity[]; relationships: LexiconRelationship[] }`; `type GroupKey = "county" | "property_improvement" | string` (corporate/places keys from `LEXICON-MAP.md`).
  - `writePropertyOutput(groupDir: string, p: PropertyOutput): Promise<string>` — writes one per-property output (seed root + group root + entity/relationship files) in the layout `build-county-transform` defines; rejects entities without `sourceHttpRequest` or with auth headers.
  - `ElephantCli { version(): Promise<string>; validate(input: string, errorsCsv: string): Promise<{ errors: number }>; hash(input: string, out: { zip: string; csv: string; car: string }): Promise<{ root: string; blocks: number; notPacked: number }>; exportTables(car: string, outDir: string, opts: { partSize: string }): Promise<{ tablesRoot: string; tables: number; parts: number }>; upload(path: string, opts: { api: string }): Promise<{ root: string; parts?: number; gatewayUrl: string }> }` (wraps the pinned binary, parses `--json`/`--output-json`).
  - `ROOFING_VIEWS_VERSION = "roofing-views.v1"`; `createRoofingViews(db: DuckDbConn, opts: { asOf: string }): Promise<void>` creating `v_property`, `v_roof_permit`, `v_contractor`, `v_business`, `v_owner` with columns per architecture §3.5.
  - Enums in `types.ts`: `PermitStatus = "open"|"completed"|"other"|"needs_review"`, `RoofWorkClass = "primary_roof_replacement"|"primary_roof_new_construction"|"repair_or_coating"|"accessory_roof"|"other"`, `OwnerLocationClass = "in_county"|"in_state_out_of_county"|"out_of_state"|"foreign"|"unknown"`, `OccupancyClass = "owner_occupied"|"likely_tenant_occupied"|"commercial"|"vacant_land"|"government_or_exempt"|"unknown"`, `GeoStatus = "parcel_centroid"|"missing_geometry"|"outside_county"`.
  - `src/contract/index.ts` (exported as `<pkg>/contract`): zod schemas + inferred types for every HTTP API DTO (Task 15) and the query inputs/outputs (Task 13). It has no runtime dependency on DuckDB; the CRM imports only this.

- [ ] **Step 1: Write failing tests**
```ts
test("writer rejects an entity without source_http_request", async () => {
  await expect(writePropertyOutput(dir, { ...p, entities: [{ ...e, sourceHttpRequest: undefined as any }] })).rejects.toThrow(/source_http_request/);
});
test("writer rejects auth headers in provenance", …);
test("writer output contains seed root and group root", …);
test("cli wrapper parses hash summary", async () => {        // fake binary prints the hash JSON
  expect(await cli.hash(dir, outs)).toEqual({ root: "bagu…", blocks: 12, notPacked: 0 });
});
test("integration: fixture outputs validate with zero errors and hash to a CountyIndex root", …);
test("roofing views expose the contract columns over fixture tables", async () => {
  await createRoofingViews(db, { asOf: FIXTURE_AS_OF });
  expect(await columns(db, "v_property")).toEqual(expect.arrayContaining(["parcel_identifier", "property_cid", "lat", "lon", "roof_age_years", "owner_location_class", "occupancy_class"]));
});
test("contract export imports without loading DuckDB", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; class/field names come from `docs/LEXICON-MAP.md`; generate `fixtures/elephant-mini/` with the real CLI.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `src/lexicon src/elephant src/views src/contract src/types.ts scripts/make-fixture.ts fixtures/elephant-mini tests` with message `feat: Lexicon writer, elephant-cli wrapper, roofing views, contract and fixture`. **Milestone M1:** share the contract + fixture with the CRM track.

### Task 3: Seed and `county` data group from the bulk roll (property, structure, tax, sales)

Sources #1, #4 in architecture §3.7 (and raw owner staging for Task 5). Follow the `county-seed-data` source order and the `build-county-transform` loop; provenance per the Task 0 decision.

**Files:**
- Create: `src/sources/registry.ts`, `src/sources/dor-parcels.ts`, `src/transforms/county/index.ts`, `src/transforms/county/map-parcel.ts`
- Test: `tests/sources/dor-parcels.test.ts`, `tests/transforms/county.test.ts`, fixtures `tests/fixtures/nal-sample.csv`, `sdf-sample.csv` (hand-made rows, include one `CO_NO=15` row)

**Interfaces:**
- Consumes: `WorkDb`, `writePropertyOutput`, kit `isValidDorParcelId`, `NAL_SOURCE_FIELDS` (Duval seed) as the field reference, `docs/LEXICON-MAP.md`.
- Produces:
  - `SourceDescriptor { key; kind; url; changeMode: "file_digest"|"window"|"bounded_crawl"; status; limitation?; blockerType? }`, `SourceRunResult { key; status: "loaded"|"partial"|"blocked"|"skipped"; records; startedAt; finishedAt; window?; limitation?; skipReason?: "too_slow"|"turnaround"|"optional_cut"; estimate?: { size: string; time: string }; requests?; avgLatencyMs? }` (skipped sources are never fetched but still appear in `sources.json` with their reason and estimate), `SOURCES: SourceDescriptor[]`.
  - `loadDorParcels(db: WorkDb, opts: { nalPath: string; sdfPath: string; retrievedAt: string; request: SourceHttpRequest }): Promise<SourceRunResult>` → `stg_parcels` (incl. homestead-exemption indicator and DOR land-use code, field names from `LEXICON-MAP.md`), `stg_sales`, `stg_owner_raw`.
  - `toCountyOutput(row: StagedParcel, ctx: { sales: StagedSale[]; geometry?: StagedGeometry; owner?: OwnerEntities; asOf: string }): PropertyOutput` (group `county`).
  - `buildCountyGroup(db: WorkDb, groupDir: string, opts: { asOf: string; parcels?: string[] }): Promise<{ properties: number; skipped: { reason: string; count: number }[] }>`.

- [ ] **Step 1: Write failing tests**
```ts
test("loads only county 16 rows", async () => { expect(res.records).toBe(nalRowsForCounty16); });
test("year built maps to the structure entity; land use and values to property/tax", …);
test("sales: most recent qualified SDF sale is the last transfer; all sales become sales entities", …);
test("every entity carries the decided source_http_request", …);
test("invalid DOR parcel id is skipped with reason 'invalid_parcel_id'", …);
test("homestead indicator and land-use code are staged for occupancy classification", …);
test("integration: 10 real-shaped parcels validate with zero errors", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement streaming CSV load via DuckDB `read_csv`; mapping in `map-parcel.ts`; unmapped DOR codes kept per kit rule (Lexicon gaps in `source_payload`, listed in `SOURCES.md`).
- [ ] **Step 4:** Run → PASS. Run on the real Broward roll; record counts, skips, duration in `SOURCES.md`.
- [ ] **Step 5:** Commit `feat: Broward seed and county Lexicon group from bulk roll`.

### Task 4: Geometry for every parcel

Sources #5, #11. Skill gap: `county-seed-data` names the GIS layer but has no centroid step.

**Files:**
- Create: `src/sources/parcel-geometry.ts`
- Modify: `src/transforms/county/map-parcel.ts` (emit `geometry` + `address_has_geometry`), `src/config.ts` (final `COUNTY.bbox`)
- Test: `tests/sources/parcel-geometry.test.ts`

**Interfaces:**
- Consumes: `stg_parcels`.
- Produces: `loadParcelGeometry(db: WorkDb, opts: { geometryPath: string; format: "shapefile"|"geojson"|"csv"; retrievedAt: string; request: SourceHttpRequest }): Promise<SourceRunResult>` → `stg_geometry(parcel_id, lat, lon, geo_status)`.

- [ ] **Step 1: Write failing tests**
```ts
test("centroid inside the TIGER county polygon → parcel_centroid and a geometry entity", …);
test("parcel with no geometry → missing_geometry and no geometry entity", …);   // Review Focus 3
test("centroid outside the county → outside_county, no geometry entity", …);
test("coverage counts parcels by geo_status", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with DuckDB `spatial` (`ST_Read`, `ST_Centroid`, `ST_Transform` to EPSG:4326 when needed), joined on normalized parcel id.
- [ ] **Step 4:** Run → PASS; real run; record % with coordinates in `SOURCES.md`.
- [ ] **Step 5:** Commit `feat: parcel geometry in county group`.

### Task 5: Owners, out-of-area and occupancy classification

Sources #3, #12 (Census ZCTA → `broward-zips.json`). Skill gap: `county-seed-data` deliberately drops owner columns. Occupancy backs the owner & occupancy (tenant) view that Slowking's Oracle breakdown expects.

**Files:**
- Create: `src/classify/owners.ts`, `src/transforms/county/owners.ts`, `src/data/broward-zips.json`, `src/data/fl-zip-prefixes.json`
- Test: `tests/classify/owners.test.ts`, `tests/transforms/owners.test.ts`

**Interfaces:**
- Consumes: `stg_owner_raw`.
- Produces: `classifyOwnerLocation(m: { state?: string|null; zip?: string|null; country?: string|null }): OwnerLocationClass`; `classifyOwnerType(name: string): "person"|"company"|"trust"|"government"|"unknown"`; `classifyOccupancy(p: { landUseCode: string|null; homestead: boolean|null; ownerType: string }): OccupancyClass` (residential + homestead → `owner_occupied`; residential without homestead → `likely_tenant_occupied`; derived only, published in the query tables, not the Lexicon groups); `toOwnerEntities(raw: StagedOwner, policy: { publishIndividualNames: boolean }): OwnerEntities` (owner person/company + mailing address entities and relationships per `LEXICON-MAP.md`).

- [ ] **Step 1: Write failing tests**
```ts
expect(classifyOwnerLocation({ state: "FL", zip: "33314" })).toBe("in_county");
expect(classifyOwnerLocation({ state: "FL", zip: "32801" })).toBe("in_state_out_of_county");
expect(classifyOwnerLocation({ state: "NY", zip: "10001" })).toBe("out_of_state");
expect(classifyOwnerLocation({ country: "CANADA" })).toBe("foreign");
expect(classifyOwnerLocation({})).toBe("unknown");
expect(classifyOwnerType("ACME HOLDINGS LLC")).toBe("company");
expect(classifyOwnerType("SMITH JOHN & MARY")).toBe("person");
expect(classifyOwnerType("SMITH FAMILY TRUST")).toBe("trust");
expect(classifyOwnerType("BROWARD COUNTY")).toBe("government");
test("publishIndividualNames=false omits person names and mailing street lines but keeps city/state/zip", …);
test("company owners keep the business name", …);
expect(classifyOccupancy({ landUseCode: "01", homestead: true, ownerType: "person" })).toBe("owner_occupied");
expect(classifyOccupancy({ landUseCode: "01", homestead: false, ownerType: "company" })).toBe("likely_tenant_occupied");
expect(classifyOccupancy({ landUseCode: "00", homestead: false, ownerType: "person" })).toBe("vacant_land");
expect(classifyOccupancy({ landUseCode: null, homestead: null, ownerType: "unknown" })).toBe("unknown");
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; classifiers are reused by the index build (Task 13). Land-use code groups come from the DOR code table recorded in `LEXICON-MAP.md`.
- [ ] **Step 4:** Run → PASS; real run; record owner-location and occupancy class distributions in `SOURCES.md`.
- [ ] **Step 5:** Commit `feat: owner entities, out-of-area and occupancy classification`.

### Task 6: `property_improvement` group from Broward permits

Source #6. Skills: `county-permit-adapter`, `county-ingest-run`. Loaded: Fort Lauderdale ArcGIS and HCED ArcGIS (kit `arcgis-feature-service` adapter and profile routes), plus any fast open-data feed found in Task 0 Step 3b. Every other jurisdiction is recorded `skipped` (architecture §3.7 skip rule, with the T0 estimate) or `blocked` (kit profile) and is never fetched. If T0 found the Fort Lauderdale contractor field empty, a bounded Accela lookup fills contractors for open roofing permits only.

**Files:**
- Create: `src/sources/permits.ts`, `src/sources/permit-feeds.ts` (official open-data feeds), `src/sources/permit-coverage.ts`, `src/classify/permits.ts`, `src/transforms/property-improvement/index.ts`
- Test: `tests/classify/permits.test.ts`, `tests/sources/permits.test.ts` (adapter calls mocked), `tests/sources/permit-feeds.test.ts`, `tests/transforms/property-improvement.test.ts`

**Interfaces:**
- Consumes: kit `browardPermitProfile`, kit permit adapters + `src/permits/normalization.mjs`, kit `roofWorkClassificationSchema`, `writePropertyOutput`.
- Produces:
  - `classifyRoofWork(p: { type?: string; description?: string }): { isRoofing: boolean; roofWorkClass: RoofWorkClass }`.
  - `normalizePermitStatus(raw: string|null): PermitStatus`; `computeOpenDays(p: { status: PermitStatus; issuedDate: string|null }, asOf: string): number|null`.
  - `loadPermits(db: WorkDb, opts: { jurisdictions?: string[]; window?: { from: string; to: string } }): Promise<SourceRunResult[]>` → `stg_permits`; jurisdictions outside the load list return `status: "skipped"` with `skipReason` and `estimate`; blocked ones return `status: "blocked"` with `blockerType`; neither is fetched.
  - `permitCoverage(db: WorkDb): PermitCoverage[]`; `PermitCoverage { jurisdiction; cities: string[]; status: "covered"|"skipped"|"blocked"; permits: number; reason?: string; estimate?: { size: string; time: string } }` → written to `meta/coverage.json`, served by `datasetInfo`.
  - `enrichFtlContractors(db: WorkDb, opts: { maxRequests: number }): Promise<SourceRunResult>` (only when T0 enabled it): Accela detail lookups for open Fort Lauderdale roofing permits without a contractor, profile delay enforced, stops at `maxRequests`.
  - `loadPermitFeed(db: WorkDb, opts: { key: string; kind: "arcgis"|"socrata"; url: string; fieldMap: PermitFieldMap; retrievedAt: string }): Promise<SourceRunResult>` → `stg_permits` (`file_digest` or `window` change mode; `source_http_request` is the feed query).
  - `buildPropertyImprovementGroup(db: WorkDb, groupDir: string): Promise<{ properties: number; permits: number; unmatched: number }>` (each permit's `source_http_request` is its detail/search request).

- [ ] **Step 1: Write failing tests**
```ts
expect(classifyRoofWork({ description: "RE-ROOF SHINGLE 30 SQ" })).toEqual({ isRoofing: true, roofWorkClass: "primary_roof_replacement" });
expect(classifyRoofWork({ description: "ROOF REPAIR 2 SQ" }).roofWorkClass).toBe("repair_or_coating");
expect(classifyRoofWork({ description: "SCREEN ENCLOSURE ROOF" }).roofWorkClass).toBe("accessory_roof");
expect(classifyRoofWork({ description: "INTERIOR REMODEL" }).isRoofing).toBe(false);
expect(normalizePermitStatus("Issued")).toBe("open");
expect(normalizePermitStatus("Finaled")).toBe("completed");
expect(normalizePermitStatus("Inspections in progress")).toBe("open");
expect(normalizePermitStatus("Gibberish-Status")).toBe("needs_review");
expect(computeOpenDays({ status: "open", issuedDate: "2016-03-01" }, FIXTURE_AS_OF)).toBe(3921);
expect(computeOpenDays({ status: "open", issuedDate: null }, FIXTURE_AS_OF)).toBeNull();   // Review Focus 2
expect(computeOpenDays({ status: "completed", issuedDate: "2016-03-01" }, FIXTURE_AS_OF)).toBeNull();
test("blocked jurisdiction is reported, never fetched", …);
test("permit links to its property by folio; unmatched permits counted, not published", …);
test("same permit in predecessor and current system becomes one property_improvement", …);
test("feed rows map through the field map; the same permit from a feed and a portal becomes one property_improvement", …);
test("skipped jurisdiction is reported with skipReason and estimate, never fetched", …);
test("permitCoverage marks Fort Lauderdale covered, Coral Springs blocked, a portal-only city skipped", …);
test("Accela contractor lookup touches only open roofing permits without a contractor and stops at maxRequests", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; reuse kit normalization before adding mappings; enforce per-host `minimumDelayMs` from the profile.
- [ ] **Step 4:** Run → PASS. Load both ArcGIS layers (minutes) and, if enabled, the bounded Accela lookup; record per-jurisdiction status (`covered`/`skipped`/`blocked`), counts, reasons and estimates in `SOURCES.md`.
- [ ] **Step 5:** Commit `feat: property_improvement group from Broward permits`.

### Task 7: Roof age on structures

**Files:**
- Create: `src/transforms/roof-age.ts`
- Test: `tests/transforms/roof-age.test.ts`

**Interfaces:**
- Consumes: kit `applyRoofAgeToTransformedData`, `permitRowToRoofAgeEvidence`, `resolveCanonicalRoofAge` (`src/roof-age/integration.ts`); `stg_permits`; `county` group outputs.
- Produces: `applyRoofAge(countyGroupDir: string, db: WorkDb, asOf: string): Promise<{ bySource: Record<string, number> }>` → sets `roof_date`, `roof_age_years` and lineage on each `structure` entity.

- [ ] **Step 1: Write failing tests**
```ts
test("completed primary replacement sets roof_date from the final date", …);   // finaled 2009-05-10 → roof_age_years 17 as of FIXTURE_AS_OF
test("repair/coating never resets roof age", …);                               // repair 2020 on 1990 house → 36 from built year
test("built-year default writes a year-precision roof_date, never Jan 1", …);  // kit rule
test("no evidence → roof fields absent", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement as a thin adapter over the kit; do not re-implement its precedence rules.
- [ ] **Step 4:** Run → PASS; real run; record distribution by source in `SOURCES.md`.
- [ ] **Step 5:** Commit `feat: roof age on county structures via kit resolver`.

### Task 8: Contractors, corporate and places groups, entity resolution

Sources #7, #8, #9. Skills: `dbpr-license-ingest`, `sunbiz-corporate-ingest`, `overture-places-ingest`; dedupe rules from `query-db-loading-matching`. The Overture places group is optional and is the first scope cut (architecture §6.1); Sunbiz already covers business records.

**Files:**
- Create: `src/sources/dbpr.ts`, `src/sources/sunbiz.ts`, `src/sources/overture-places.ts`, `src/resolve/entities.ts`
- Test: `tests/sources/dbpr.test.ts`, `tests/sources/overture-places.test.ts`, `tests/resolve/entities.test.ts`

**Interfaces:**
- Consumes: kit Sunbiz library functions (e.g. `filterSunbizDirectory` with `zipPrefixes` from `browardEnrichmentProfile`, Task 9), kit `normalizePermitContractorIdentity`, `matchContractorToCompany`, `jaroWinkler`; `writePropertyOutput`.
- Produces: `loadDbpr(db, opts: { licenseFiles: string[]; retrievedAt: string }): Promise<SourceRunResult>` (adds company/person/license + `property_improvement_has_contractor`, `contractor_has_license`, `contractor_has_person` to the `property_improvement` outputs); `buildCorporateGroup(db, groupDir, opts: { bulkPath: string }): Promise<{ companies: number }>`; `buildPlacesGroup(db, groupDir, opts: { release: string }): Promise<{ places: number }>`; `resolveEntities(db: WorkDb): Promise<{ contractorsLinked: number; ownersLinked: number }>`.

- [ ] **Step 1: Write failing tests**
```ts
test("permit license number → DBPR record → company/person/license entities", …);
test("no DBPR match writes no contractor (kit rule)", …);
test("Sunbiz company source_http_request is the per-company detail URL, not the bulk page (kit rule)", …);
test("name variants resolve to one company; below-threshold matches are not linked", …);
test("Overture places outside the Broward boundary are dropped; release + licence recorded", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; Sunbiz first (identity baseline), then DBPR, then linking.
- [ ] **Step 4:** Run → PASS; real run; record link rates in `SOURCES.md`.
- [ ] **Step 5:** Commit `feat: contractors, corporate and places groups`.

### Task 9: BBB (bounded) — Lexicon flag and score handling

Source #10. Skill: `bbb-harvest` (+ `bbb-link`). Access limit: 403 ⇒ stop and document.

**Files:**
- Create: `src/sources/broward-enrichment-profile.ts` (exports `browardEnrichmentProfile`: BBB market + reviewed `roofing-contractors` category URLs, Sunbiz `zipPrefixes`; validated with kit `validateEnrichmentProfile`), `src/sources/bbb.ts`, optional `src/publish/bbb-ratings.ts` (only if Open Q7 requires scores and the Lexicon has no rating fields)
- Test: `tests/sources/bbb.test.ts`

**Interfaces:**
- Consumes: kit `harvestBbbCategory`, kit BBB linker, resolved contractors.
- Produces: `loadBbb(db, opts: { maxRequests: number; maxDurationMinutes: number; retrievedAt: string }): Promise<SourceRunResult>`; BBB flag applied per kit linker to Lexicon outputs; optional `writeBbbRatings(db, outPath): Promise<{ rows: number }>` (a supplementary Parquet listed in the manifest as a non-Lexicon artifact).

- [ ] **Step 1: Write failing tests**
```ts
test("browardEnrichmentProfile passes kit validateEnrichmentProfile", …);
test("HTTP 403 stops the source and records limitation", …);   // status "blocked", no further requests
test("only exact license/phone/name matches set the BBB flag; Jaro-Winkler matches stay review candidates (kit rule)", …);
test("missing grade stays null, never 'F'", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with hard bounds; no proxy/fingerprint changes.
- [ ] **Step 4:** Run → PASS; bounded real run; record coverage/limitations in `SOURCES.md`.
- [ ] **Step 5:** Commit `feat: bounded BBB enrichment`.

### Task 10: Build every data group with elephant-cli; deltas, state, coverage

**Files:**
- Create: `src/build/build-group.ts`, `src/build/deltas.ts`, `src/build/meta.ts`
- Test: `tests/build/build-group.test.ts` (fake CLI), `tests/build/build-group.integration.test.ts` (fixture outputs), `tests/build/deltas.test.ts`

**Interfaces:**
- Consumes: `ElephantCli`, group output dirs, `SourceRunResult[]`, previous run's exported `properties` tables (from cache).
- Produces:
  - `buildGroup(group: GroupKey, groupDir: string, outDir: string, cli: ElephantCli, opts: { partSize: string }): Promise<GroupBuildResult>`; `GroupBuildResult { group; archiveRoot: string; carPath: string; tablesRoot: string; tablesDir: string; properties: number; notPacked: number }`. Order: `validate dir` → (errors ⇒ throw with CSV path, no hash) → `hash` (packed) → `validate CAR` → `export-tables`.
  - `computeDeltas(prevTablesDir: string|null, curTablesDir: string): Promise<{ added: number; changed: number; removed: number }>` (compares `properties` table: property CID → data-group root CID).
  - `writeMeta(runDir: string, m: { coverage; sources; state; deltas }): Promise<string[]>` → `meta/coverage.json`, `meta/sources.json`, `meta/state.json`, `meta/deltas.json`.

- [ ] **Step 1: Write failing tests**
```ts
test("validation errors stop the group before hash and surface the CSV", …);
test("integration: same outputs → identical archive root and tables root", …);   // Review Focus 4
test("deltas: changed property data-group root counted as changed; new as added; missing as removed", …);
test("no-change incremental → all deltas zero", …);                              // Review Focus 4
test("not_packed count is reported, not treated as failure (kit rule)", …);
test("coverage.json lists every source with status and limitation, including skipped sources with skipReason and estimate", …);
test("coverage.json lists permit coverage by jurisdiction", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; reuse unchanged per-property outputs from the previous run.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: elephant-cli group build with deltas and run metadata`.

### Task 11: Publish to Elephant IPFS — upload, second provider, manifest

No county IPNS name (architecture Decision 8). Runs are chained by `previous_manifest_cid`; the latest manifest CID is recorded in `demo-packet/`, the PR and the hosted Runs page.

**Files:**
- Create: `src/publish/upload.ts`, `src/publish/second-pinner.ts`, `src/publish/files.ts` (kubo add of CAR, meta and derived files as unixfs files), `src/publish/manifest.ts`, `src/publish/publish-run.ts`
- Test: `tests/publish/manifest.test.ts`, `tests/publish/publish-run.test.ts` (fakes), `tests/publish/kubo.integration.test.ts`

**Interfaces:**
- Consumes: `GroupBuildResult[]`, meta file paths, `ElephantCli.upload`.
- Produces:
  - `uploadGroup(r: GroupBuildResult, cli: ElephantCli): Promise<{ archive: UploadSummary; tables: UploadSummary }>` (`--api https://rpc.filebase.io`).
  - `addFiles(paths: string[]): Promise<{ path: string; cid: string; size: number; sha256: string }[]>` (CIDv1, raw leaves; pinned on Filebase; CID must equal Filebase's reported CID).
  - `SecondPinner { provider: string; pinCids(cids: string[]): Promise<{ cid: string; pinnedAt: string }[]> }` (pin-by-CID, or `ipfs dag export` + CAR upload, per `DECISIONS.md`).
  - `ManifestSchema` (zod, `schema: "oracle.manifest.v1"`, fields per architecture §3.3) and `type Manifest`.
  - `publishRun(input: { runId: string; groups: GroupBuildResult[]; metaFiles: string[]; derivedFiles: string[]; previousManifestCid: string|null }, deps): Promise<{ manifest: Manifest; manifestCid: string }>`. `derivedFiles` are the Task 13 outputs (`query/index.duckdb`, `query/*.parquet`, `samples/*.csv`); `metaFiles` include `meta/qa.json`. It refuses to publish when `qa.json` has a `fail` check unless `force: true`, which is recorded in the manifest and run history.

- [ ] **Step 1: Write failing tests**
```ts
test("manifest lists each group's archive root, tables root, both CAR files, every Parquet part, every meta and derived file", …);
test("every byte artifact has codec 'file', size, sha256 and kind ('derived'|'meta'); DAG roots have codec 'directory', ipld_codec 'dag-json' and a car", …);
test("all CIDs are CIDv1 base32", …);                 // every cid matches /^b[a-z2-7]+$/
test("encoding records the elephant-cli version and build", …);
test("previous_manifest_cid chains runs", …);
test("manifest has no ipns field", …);
test("a failed second-provider pin fails the publish", …);
test("publish refuses a run whose qa.json has a fail check; force:true publishes and records qa.overridden", …);
test("meta/qa.json is listed in the manifest with kind 'meta'", …);
test("kubo integration: importing a group CAR in a fresh repo reproduces the archive root", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; the manifest is added as its own file after every other CID is known.
- [ ] **Step 4:** Run → PASS. Publish the first real run.
- [ ] **Step 5:** Commit `feat: Elephant IPFS publication with manifest and dual pinning`.

### Task 12: Public gateway verification and run history

**Files:**
- Create: `src/publish/verify.ts`, `src/publish/history.ts`
- Test: `tests/publish/verify.test.ts`, `tests/publish/history.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `PUBLIC_GATEWAYS`.
- Produces:
  - `verifyManifest(m: Manifest, opts?: { gateways?: string[]; retries?: number /*4*/; timeoutMs?: number /*120000*/; fetchImpl?: typeof fetch }): Promise<VerificationReport>`; `VerificationReport { ok: boolean; checkedAt: string; results: { name: string; cid: string; gateway: string; ok: boolean; size?: number; sha256?: string; attempts: number; error?: string }[] }`. Files: `/ipfs/<cid>` bytes vs size + sha256. DAG roots: `/ipfs/<cid>?format=car` parsed with `@ipld/car`; root matches and every block hashes to its CID.
  - `RunHistorySchema` (`schema: "oracle.run-history.v1"`, `runs[] { run_id, mode, simulated: boolean, started_at, finished_at, sources, deltas_by_group, groups: { key, archive_root, tables_root }[], derived: { name, cid }[], qa: { status: "pass"|"warn"|"fail", overridden: boolean, cid }, manifest_cid, previous_manifest_cid, verification: { ok, checkedAt, gateways } }`); `appendRun(h, entry): RunHistory` (pure; never drops prior runs).

- [ ] **Step 1: Write failing tests**
```ts
test("passes when both gateways return matching bytes", …);
test("digest mismatch on one gateway → ok false with that result flagged", …);
test("timeouts retry with backoff then report attempts", …);   // Review Focus 1: attempts === 4, error "timeout"
test("DAG root with a tampered block fails CAR verification", …);
test("only-local gateway configured is rejected", …);          // localhost/127.0.0.1 → throws
test("appendRun keeps previous CIDs, chains previous_manifest_cid and labels simulated runs", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; `oracle publish` = Task 11 + history append + history file publish; `oracle verify` prints a table and exits non-zero on failure.
- [ ] **Step 4:** Run → PASS. Verify run 1 live; publish run 2 (incremental) and verify both.
- [ ] **Step 5:** Commit `feat: public gateway verification and run history`.

### Task 13: `oracle index` (derived artifacts), sync, typed queries, FTS, read-only SQL

**Files:**
- Create: `src/query/sync.ts`, `src/query/index-build.ts`, `src/query/derived.ts` (view Parquet + sample CSV export), `src/query/extensions.ts` (pins DuckDB extensions to a local `extension_directory`; installed at build time, never at request time), `src/query/db.ts`, `src/query/queries.ts`, `src/query/places.ts`, `src/data/broward-places.json` (source #12), `src/client/index.ts` (re-exports sync/index/db/queries/places/types)
- Test: `tests/query/queries.test.ts` (on `fixtures/elephant-mini`), `tests/query/sync.test.ts`, `tests/query/index-build.test.ts`, `tests/query/derived.test.ts`

**Interfaces:**
- Consumes: `Manifest`, verify digest logic, classifiers (Tasks 5, 6), `createRoofingViews`.
- Produces (all rows include `provenance: { source_url: string; retrieved_at?: string }[]`, `property_cid` and `manifest_cid`):
  - `buildIndex(src: { tablesDirs: Record<GroupKey, string>; runId: string } | { fixtureDir: string }, outPath: string): Promise<string>`. It builds `index.duckdb` once:
    - a view per group class/relationship table;
    - derived tables from classifiers (owner location, occupancy, permit status/open days, roof work class);
    - `roofing-views.v1`;
    - FTS over permit descriptions and addresses;
    - a vector index over permit descriptions and business/contractor summaries only.

    `oracle index` runs it on the run's local exported tables before publish.
  - `writeDerived(indexPath: string, outDir: string): Promise<{ files: string[] }>` → `query/<view>.parquet` for every roofing view and `samples/aged-roofs.csv`, `samples/long-open-permits.csv`, `samples/contractors.csv` (≤ 100 rows each, no owner PII per Open Q3). The `oracle run` pipeline passes `index.duckdb` + these files to `publishRun({ derivedFiles })`.
  - `syncRun(opts: { manifestCid: string; cacheDir: string; gateways?: string[]; rebuild?: boolean }): Promise<LocalRun>`. By default it downloads the published `query/index.duckdb` (sha256-verified, cached by CID, offline if cached). With `rebuild` it downloads every Lexicon Parquet part listed in the manifest (sha256-verified, cached by part CID) and runs `buildIndex`.
  - `openIndex(path: string): Promise<SnapshotDb>` (read-only; `access_mode=READ_ONLY`, temp directory `/tmp`).
  - `findAgedRoofs(db, q: { center: LatLon; radiusMiles: number; minRoofAgeYears?: number; limit?: number }): Promise<PropertyLead[]>`
  - `findOpenRoofPermits(db, q: { center: LatLon; radiusMiles: number; minOpenYears?: number; limit?: number }): Promise<PermitLead[]>` (sorted by `open_days` desc; contractor name, license, BBB flag/score)
  - `findLongHeldProperties(db, q: { center?: LatLon; radiusMiles?: number; minYearsSinceTransfer?: number; limit?: number })`
  - `findOutOfAreaOwners(db, q: { center?: LatLon; radiusMiles?: number; scope?: "out_of_county"|"out_of_state"; limit?: number })`
  - `findByOccupancy(db, q: { center?: LatLon; radiusMiles?: number; occupancy: OccupancyClass[]; minRoofAgeYears?: number; limit?: number })` (owner & occupancy / tenant view)
  - `getProperty(db, parcelId): Promise<PropertyDetail|null>`; `getPermit(db, permitKey): Promise<PermitDetail|null>`
  - `getBusiness(db, companyId): Promise<BusinessDetail|null>` (Sunbiz entity, places, owned properties); `getContractor(db, companyId): Promise<ContractorDetail|null>` (licenses, BBB flag/score, permits, open-permit count); `listContractors(db, q: { center?: LatLon; radiusMiles?: number; minOpenPermits?: number; limit?: number })`
  - `searchRecords(db, q: { text: string; center?: LatLon; radiusMiles?: number; limit?: number; mode?: "hybrid"|"text"|"semantic" })` — hybrid = FTS + vector similarity (DuckDB `vss` over local sentence embeddings of permit descriptions and entity summaries, computed at index build)
  - `datasetInfo(db): Promise<{ manifestCid: string|null; published: boolean; runId; viewsVersion; counts: Record<string, number>; coverage; permitCoverage: PermitCoverage[]; limitations: string[] }>`
  - `qaReport(db, meta): Promise<QaReport>`, run as the last step of `oracle index` and written to `meta/qa.json` (the M2 review input, the `publish` gate, and a published `kind: meta` artifact shown on the Data quality page): property count vs the NAL row count; share with geometry and inside the county bbox; permit status and `open_days` distributions (incl. `needs_review` share); permit coverage (share of parcels in covered jurisdictions; `warn` citing the documented limitation, not `fail`); roof-age basis mix (permit vs year built vs unknown); contractor-license and BBB link rates; occupancy and owner-location mix; duplicate parcel/permit keys; a PII scan of published columns against the Open Q3 policy; 20 random parcels with appraiser-site links for a manual spot check. Each check has a threshold and a `pass|warn|fail` status. The PII check reports counts and status only, never the values found.
  - `resolvePlace(name: string): LatLon | null`; `runReadOnlySql(db, sql: string, maxRows?: number /*500*/)`
  - Defaults: `limit` 200, `minRoofAgeYears` 15, `minYearsSinceTransfer` 10, `minOpenYears` 0.

- [ ] **Step 1: Write failing tests**
```ts
test("index is built once per run and reused", …);
test("writeDerived emits one Parquet per roofing view and capped sample CSVs without owner names", …);
test("sync downloads the published index and rejects a sha256 mismatch", …);
test("sync --rebuild skips parts already cached by CID and rejects a part whose sha256 differs", …);
test("rebuilt index view row counts equal the published index", …);              // Review Focus 6
test("findByOccupancy filters likely_tenant_occupied within the radius", …);
test("radius boundary: 4.9 mi in, 5.1 mi out", …);
test("minRoofAgeYears filters on roof_age_years and reports the roof-age source", …);
test("properties without geometry never returned by radius queries", …);      // Review Focus 3
test("needs_review permits excluded from long-open results", …);              // Review Focus 2
test("open permits sorted by open_days desc with contractor and BBB fields", …);
test("long-held uses last transfer ≥ 10y", …);
test("out_of_state scope excludes in_state_out_of_county", …);
test("resolvePlace('Fort Lauderdale') ≈ {26.12,-80.14}; unknown → null", …);
test.each(["COPY t TO 'x'", "ATTACH 'x'", "INSTALL httpfs", "PRAGMA x", "CREATE TABLE x(a int)", "SELECT 1; SELECT 2"])
  ("runReadOnlySql rejects %s", …);                                           // Review Focus 5
test("runReadOnlySql caps rows at maxRows", …);
test("semantic search finds 'reroof' permits for the query 'replace roof shingles'", …);
test("getContractor returns licenses, BBB fields and open-permit count", …);
test("qaReport flags a property count more than 2% off the NAL row count and any owner name in published columns", …);
test("oracle index writes meta/qa.json as its last step and exits 0 even when a check fails", …);
test("qa.json PII check contains counts and status but no matched values", …);
test("an index opened with --index reports published:false and manifestCid null", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; SQL lives in `queries.ts` and `roofing-views.ts` only; radius = bbox prefilter then `ST_Distance_Sphere(ST_Point(lon,lat), ST_Point($lon,$lat)) <= miles*1609.344`.
- [ ] **Step 4:** Run → PASS. Build `dist/` and confirm `import { syncRun, buildIndex, findAgedRoofs } from "<pkg>/client"` and `import { AgedRoofsQuery } from "<pkg>/contract"` work from a scratch project. Wire `oracle index` (including the QA step) into `oracle run --no-publish` (M1); the derived artifacts are published with the run in M3 (Task 11 `derivedFiles`).
- [ ] **Step 5:** Commit `feat: oracle index, derived artifacts, sync and roofing query layer`.

### Task 14: MCP server (stdio + Streamable HTTP)

**Files:**
- Create: `src/tools/registry.ts` (one tool registry: name, description, zod input schema, handler over `SnapshotDb`; consumed by the MCP server here and by the agent's AI SDK tools in Task 16), `src/mcp/server.ts`, `src/mcp/http.ts` (stateless Streamable HTTP mount at `/mcp`, JSON responses, so it runs on Lambda), `src/mcp/rate-limit.ts`, `.mcp.json` (local: `oracle mcp --manifest $ORACLE_MANIFEST_CID`), `docs/MCP.md`
- Test: `tests/tools/registry.test.ts`, `tests/mcp/server.test.ts` (MCP SDK in-memory client), `tests/mcp/http.test.ts`

**Interfaces:**
- Consumes: `SnapshotDb`, all Task 13 functions.
- Produces:
  - `ORACLE_TOOLS: OracleTool[]`: `dataset_info`, `resolve_place`, `find_aged_roofs`, `find_open_roof_permits`, `find_long_held_properties`, `find_out_of_area_owners`, `find_by_occupancy`, `get_property`, `get_permit`, `get_business`, `get_contractor`, `search_records`, `run_read_only_sql`. Each has a zod input schema from the `contract`; outputs are JSON with rows, provenance, `property_cid`, `manifest_cid` and `notes`.
  - `createOracleMcpServer(db: SnapshotDb, opts: { manifest: Manifest; history: RunHistory }): McpServer` registering every `ORACLE_TOOLS` entry.
    - Resources: `oracle://manifest/current`, `oracle://run-history`, `oracle://views-guide`.
    - Prompts: `aged_roofs_near_city`, `long_open_roof_permits_near_city` (the two README agent questions).
  - `mountMcpHttp(app: FastifyInstance, server: McpServer, opts: { path?: "/mcp"; rateLimitPerMinute?: number /*60*/ }): void` (stateless: no session store, so any Lambda instance can answer).

- [ ] **Step 1: Write failing tests**
```ts
test("lists exactly the thirteen tools, three resources and two prompts", …);
test("MCP tool list and registry are identical (names and input schemas)", …);
test("find_aged_roofs returns rows with provenance, property_cid and manifest_cid", …);
test("invalid radius (negative) returns a tool error, not a crash", …);
test("run_read_only_sql rejects DDL through MCP too", …);
test("HTTP: a Streamable HTTP client lists tools at /mcp without a session (stateless)", …);
test("HTTP: requests over the per-IP limit get 429", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; `oracle mcp --manifest <cid>` (stdio) syncs, builds/reuses the index, then serves; `oracle mcp --index <path>` serves a local unpublished run (M2); `oracle mcp --fixture <dir>` serves the fixture; `oracle serve` mounts `/mcp`.
- [ ] **Step 4:** Run → PASS. Smoke: connect Claude Code to the local stdio server and ask the two README prompts.
- [ ] **Step 5:** Commit `feat: MCP server over index.duckdb (stdio + HTTP)`.

### Task 15: Explorer UI

**Files:**
- Create: `src/ui/server.ts` (Fastify JSON API + static), `ui/` (Vite + React + MapLibre): pages `Runs`, `Sources`, `Quality`, `Manifest`, `Explorer`, `Property`, `Occupancy`, `Business`, `Contractor`, `Mcp`, `Cost`, `WasmProof` (required)
- Test: `tests/ui/api.test.ts`, `ui/e2e/explorer.spec.ts` (Playwright)

**Interfaces:**
- Consumes: `SnapshotDb`, Task 13 queries, `RunHistory`, `VerificationReport`, `Manifest`.
- Produces: `startUiServer(opts: { db: SnapshotDb; history: RunHistory; manifest: Manifest; verification?: VerificationReport; host?: string; port?: number /*4317*/ }): Promise<{ app: FastifyInstance; close(): Promise<void> }>`; endpoints `GET /api/health`, `/api/runs`, `/api/sources`, `/api/qa/:runId`, `/api/manifest/:runId`, `/api/verify/:runId`, `/api/query/aged-roofs`, `/api/query/open-permits`, `/api/query/occupancy`, `/api/property/:parcelId`, `/api/permit/:permitKey`, `/api/business/:companyId`, `/api/contractor/:companyId`, `/api/contractors`, `/api/place?name=` (`resolvePlace`; used by the Explorer's city picker and the CRM's center control). All responses are validated against the `contract` schemas; this is the HTTP API v1 the CRM consumes (architecture §5).
- Page content:
  - `Runs`: summary, source list, coverage, limitations, history with per-group and manifest CIDs and deltas.
  - `Sources`: counts by source and Lexicon class with timestamps; skipped and blocked sources with reason and size/time estimate; permit coverage by jurisdiction (`covered`/`skipped`/`blocked`).
  - `Quality` (all modes): the run's `meta/qa.json` — each check with its value, threshold and pass/warn/fail status, grouped as coverage & scale, duplicates & reconciliation, coordinates, permits, roof age, contractor/BBB links, occupancy/owner location, PII; the 20 spot-check parcels linked to the appraiser site and to their Property pages; the `qa.json` CID with gateway links when published. Runs links here for each run.
  - `Manifest`: every artifact (Lexicon, derived, meta) with `https://ipfs.io/ipfs/<cid>` and `https://dweb.link/ipfs/<cid>` links, CAR links for every directory root, plus the latest verification report. A **"Verify now"** button runs the check live in the browser (`ui/src/lib/verify-in-browser.ts`): fetch the selected artifact from both gateways, compute SHA-256 with WebCrypto, and compare size + digest with the manifest, showing per-gateway status, bytes, digest and time. It defaults to small artifacts (the manifest, `samples/*.csv`, one Parquet view) and warns above 50 MB. A **"Check previous run"** button fetches the previous run's manifest CID from both gateways to show it still resolves and differs from the current CID.
  - `Explorer`: radius map with pin/address search; aged-roof and long-open-permit layers; result list. A center control that does not need the map (address search, a city picker backed by `resolve_place`, and lat/lon inputs). If MapLibre cannot get a WebGL context, the page shows a notice and still renders the result list and filters. When the radius crosses jurisdictions without permit data, a note names them.
  - Entity pages with relationships and provenance links.
  - `Occupancy`: the owner & occupancy (tenant) view, with occupancy and owner-location filters on the map and per-property owner type/location, occupancy basis and years since transfer.
  - `Mcp`: endpoint URL and connect commands, plus a **live MCP console** (`ui/src/pages/Mcp.tsx` with the MCP TypeScript SDK client over Streamable HTTP, same origin): buttons for `initialize`, `tools/list` and `tools/call` with prefilled examples (`dataset_info`, `resolve_place{name:"Fort Lauderdale"}`, `find_aged_roofs{lat,lon,radiusMiles:5,minRoofAgeYears:15}`), editable JSON arguments and the raw JSON-RPC request/response.
  - `Cost`: what runs where, and why Oracle carries no ongoing cost.
  - `WasmProof` (required): DuckDB-WASM runs an aged-roofs-in-radius query in the browser straight against `query/v_property.parquet` on `ipfs.io` and shows the same rows as the API.

- [ ] **Step 1: Write failing tests**
```ts
test("GET /api/runs returns runs with per-group CIDs and deltas", …);
test("GET /api/query/aged-roofs honors lat,lon,radiusMiles,minRoofAgeYears", …);
test("GET /api/contractor/:id returns licenses, BBB and permits", …);
test("manifest page renders gateway links built from CIDs (Playwright)", …);
test("explorer: dropping a pin and setting 5 miles lists aged roofs and long-open permits (Playwright)", …);
test("GET /api/health reports manifest CID and index status", …);
test("GET /api/query/occupancy returns likely_tenant_occupied properties with occupancy basis", …);
test("every API response parses with its contract schema", …);
test("serve --index shows the UNPUBLISHED banner and the Quality page; Verify now is disabled (Playwright)", …);
test("Quality page renders every qa.json check with status and links the published qa.json CID (Playwright)", …);
test("WASM proof page returns rows from a gateway-hosted Parquet (Playwright, gateway mocked in CI)", …);
test("manifest 'Verify now' shows both gateways ok with matching size and sha256; a tampered body shows a mismatch (Playwright, gateways mocked)", …);
test("manifest 'Check previous run' shows the previous manifest CID resolving (Playwright, gateways mocked)", …);
test("MCP console lists 13 tools and a find_aged_roofs call returns rows (Playwright)", …);
test("explorer with WebGL disabled shows the notice and lists aged roofs for a lat/lon center (Playwright, --disable-gpu --disable-webgl)", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; gateway links always derived from CIDs; empty and error states explain what happened (e.g. "outside Broward coverage"). `oracle serve --fixture fixtures/elephant-mini` serves the same API + `/mcp` on the fixture for CRM development. `oracle serve --index runs/<run_id>/query/index.duckdb` serves a local unpublished run for M2: a persistent UNPUBLISHED banner, the Manifest page lists local group roots and file digests with "Verify now" disabled, and the `Quality` page shows the local `meta/qa.json`.
- [ ] **Step 4:** Run → PASS (`npx vitest run tests/ui` and `npx playwright test ui/e2e`, including a headless Chromium project launched with `--disable-gpu --disable-webgl`).
- [ ] **Step 5:** Commit `feat: explorer UI with entity, occupancy, quality, manifest (live verify), MCP console, cost and WASM proof pages`.

### Task 16: Agent chat (endpoint + panel)

Load `apply-engineering-guidelines` (rule `stack-ai-sdk-for-llm`) before writing this task's code: every LLM call goes through the Vercel AI SDK, and direct provider SDKs are forbidden. Use the `claude-api` skill only to choose the model ID.

**Files:**
- Create: `src/agent/agent.ts`, `src/agent/ai-tools.ts` (maps `ORACLE_TOOLS` to AI SDK `tool({ description, inputSchema, execute })` entries over the same `SnapshotDb`), `src/agent/prompt.ts`, `src/agent/budget.ts`, `ui/src/pages/Agent.tsx`
- Test: `tests/agent/agent.test.ts` (AI SDK mock language model from `ai/test` + fixture `SnapshotDb`), `ui/e2e/agent.spec.ts`

**Interfaces:**
- Consumes: `ORACLE_TOOLS` (Task 14), `ai` (`generateText`, `tool`, `stepCountIs`), `@ai-sdk/anthropic`.
- Produces:
  - `createOracleAgent(deps: { db: SnapshotDb; model: LanguageModel }): OracleAgent`; `OracleAgent.ask(i: { message: string; history: ChatTurn[] }): Promise<AgentAnswer>`; `AgentAnswer { text: string; results: { parcelId: string; lat: number; lon: number; label: string }[]; citations: { parcelId?: string; permitKey?: string; sourceUrl: string }[]; assumptions: string[]; missingData: string[]; steps: { tool: string; args: Record<string, unknown>; rowCount: number; sample: string[] }[]; context: { center?: LatLon; placeName?: string; radiusMiles?: number }; manifestCid: string }` (zod schema in `contract`; structured output via the AI SDK). `steps` is built from the AI SDK step results, not from model text, so the panel shows what was actually retrieved. `context` is returned to the client and sent back in the next turn's history so follow-ups ("near that area") reuse the previous center.
  - `POST /api/agent` (mounted by `oracle serve`); `BudgetGuard { allow(ip: string): boolean; record(tokens: number): void }` (per-IP rate limit + daily token budget from env); model call wrapped in a timeout with a friendly failure message (documented sync boundary, architecture §0.1).
  - Prompt rules: answer only from tool results; resolve places with `resolve_place` and state the assumption; for a follow-up that refers to "that area" / "near there", reuse the previous turn's `context` and say so; cite parcel/permit identifiers and source URLs; list missing data (e.g. no BBB rating; jurisdictions inside the radius without permit data, from `dataset_info` permit coverage); `stopWhen: stepCountIs(8)`.
  - Budget sizing: the daily token budget and per-IP limit are set for the grading window (several full demo runs from one IP); a CloudWatch metric on budget use alarms at 80%. The README's two demo prompts are in `docs/DEMO.md` with their expected tool calls.

- [ ] **Step 1: Write failing tests**
```ts
test("aged-roofs prompt calls resolve_place then find_aged_roofs{radiusMiles:5,minRoofAgeYears:15}", …);
test("long-open prompt returns open duration, contractor and BBB or 'no BBB rating' in missingData", …);
test("unknown city → assumption recorded, no invented coordinates", …);
test("radius crossing uncovered jurisdictions → missingData names them and says roof age comes from year built there", …);
test("citations reference only identifiers returned by tools", …);
test("follow-up 'which properties near that area have open roofing permits…' reuses the previous turn's center and radius and records that assumption", …);
test("answer.steps lists each tool call with args and row counts from the step results", …);
test("over budget → 429 with a friendly message", …);
test("model timeout → friendly failure, no partial answer", …);
test("no direct provider SDK is imported (lint rule bans @anthropic-ai/sdk)", …);
test("agent page shows answer, citations, assumptions, a collapsible 'Retrieved evidence' list (tool, args, rows) and a 'show on map' action (Playwright)", …);
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `generateText` + AI SDK tools; model from `ORACLE_AGENT_MODEL` via `@ai-sdk/anthropic`; key from SSM Parameter Store when hosted (`ANTHROPIC_API_KEY` env only for local development). Add an ESLint `no-restricted-imports` rule for `@anthropic-ai/sdk`.
- [ ] **Step 4:** Run → PASS; manual check with a real key against the fixture.
- [ ] **Step 5:** Commit `feat: hosted agent chat (Vercel AI SDK) over the Oracle tool registry`.

### Task 17: Hosted deployment (AWS, CDK)

Load `apply-engineering-guidelines` (`cloud-aws-primary`, `observability-logging-tracing`) and `build-frontend-backends` (`rules/cdk-api-infrastructure.md`) before writing this task's code.

**Files:**
- Create:
  - `Dockerfile`: Lambda base image + AWS Lambda Web Adapter extension; `index.duckdb` and DuckDB extensions baked in.
  - `.dockerignore`, `scripts/fetch-index-for-image.ts` (`oracle sync --manifest $ORACLE_MANIFEST_CID` → verified `index.duckdb`).
  - `infra/bin/oracle.ts`, `infra/lib/oracle-stack.ts`, `infra/cdk.json`.
  - `deploy/README.md`: AWS setup, SSM parameters, redeploy on a new manifest, HF Spaces fallback.
  - `.github/workflows/uptime.yml`: scheduled ping of `/api/health`.
  - `src/observability.ts`: Powertools Logger/Tracer/Metrics. Metrics: requests, agent calls, agent failures, budget rejections.
- Modify: `src/cli.ts` `serve` (read `PORT` from the Web Adapter, open the index read-only), `README.md` (hosted URLs)
- Test: `tests/deploy/image.test.ts` (container from the fixture answers `/api/health`, `/mcp`, `/api/query/aged-roofs`), `infra/test/oracle-stack.test.ts` (CDK assertions)

**Interfaces:**
- Consumes: `syncRun`, `startUiServer`, `mountMcpHttp`, agent endpoint.
- Produces `OracleStack` (CDK, `env: { region: "us-east-2" }`, `tags: { project_name: "oracle-broward" }`):
  - `DockerImageFunction`: memory per the Task 0 measurement (target 3–10 GB), timeout 60 s, env `ORACLE_MANIFEST_CID`, `ORACLE_AGENT_MODEL`, `AGENT_DAILY_TOKEN_BUDGET`, `RATE_LIMIT_PER_MINUTE`, `ANTHROPIC_KEY_PARAM`.
  - Function URL (`authType: NONE`, HTTPS). No CloudFront: the warm ping covers cold starts and there is nothing to cache safely in front of `/mcp` or `/api/agent`.
  - DynamoDB table (on-demand, TTL) for the agent's daily token count, shared by every Lambda instance.
  - SSM SecureString parameter read at cold start.
  - EventBridge rule pinging `/api/health` every 5 minutes (warm).
  - CloudWatch alarm on 5xx/errors → SNS email (documented replacement for PagerDuty).
  - AWS Budgets alarm at $5/month.
  - Agent budget-use metric alarm at 80% of `AGENT_DAILY_TOKEN_BUDGET` → SNS email.
  - Outputs: hosted URL, MCP URL.

- [ ] **Step 1: Write failing tests**
```ts
test("image built with ORACLE_FIXTURE=1 answers /api/health, /mcp and /api/query/aged-roofs", …);
test("stack: one DockerImageFunction in us-east-2 tagged project_name, Function URL auth NONE", …);
test("stack: the agent's daily budget lives in a DynamoDB table with TTL", …);
test("stack: Anthropic key comes from an SSM parameter, never a plain env value", …);
test("stack: budget alarm, error alarm and agent budget-use alarm exist", …);
```
- [ ] **Step 2:** Run `npx vitest run tests/deploy infra/test` → FAIL.
- [ ] **Step 3:** Implement the Dockerfile, fetch script and CDK stack; put the key in SSM (`aws ssm put-parameter --type SecureString`, never committed); `cdk deploy`; enable the uptime workflow.
- [ ] **Step 4:** Run → PASS. Open the Function URL in a clean browser: the health page shows the manifest CID, and the explorer, agent and `/mcp` work. Record cold-start time, memory and idle monthly cost in `deploy/README.md`.
- [ ] **Step 5:** Commit `feat: hosted Oracle on AWS Lambda via CDK`. **Milestone M5** when this runs on the latest published manifest. Then open the **draft PR** (fork → designated repo; outward-facing, confirm with the user first) and run a Slowking gate check against it and the hosted URL.

### Task 18: Full runs, demo packet, documentation

**Files:**
- Create: `demo-packet/manifests/<run_id>.json`, `demo-packet/run-history.json`, `demo-packet/verification/<run_id>.json`, `demo-packet/README.md` (fetch by CID, `ipfs dag import` CARs, regenerate tables with `elephant-cli export-tables`), `docs/COST.md`, `docs/DEMO.md`, `docs/ARCHITECTURE.md`
- Modify: `docs/SOURCES.md` (final timings, limitations, coverage, Lexicon gaps), `README.md`

- [ ] **Step 1:** Confirm the run chain: run 1 (`oracle run --mode full`, published in M3 after the M2 sign-off), run 2 (`--mode incremental`, windowed re-pull of the ArcGIS permit layers, DBPR and any permit feed; M3), run 3 on demand in M5 (`oracle run --mode incremental` on the windowed sources, or a recorded simulated update if no source changed, `simulated: true` in history), then redeploy the hosted Oracle on its manifest CID.
- [ ] **Step 2:** `oracle verify` each manifest from a clean machine/network; save reports. Run `oracle sync --rebuild` on the latest manifest and confirm it matches the published index (Review Focus 6).
- [ ] **Step 3:** Redeploy the hosted Oracle (T17) on the latest manifest; confirm Runs shows all runs, both manifest CIDs and that old CIDs still fetch.
- [ ] **Step 4:** Attach each run's group CARs and `tables.car` files to a GitHub release; record CAR CIDs + links in `demo-packet/README.md`.
- [ ] **Step 5:** Write `COST.md` (pin usage vs quotas on both providers; AWS idle cost from the bill/Cost Explorer: Lambda, ECR storage, DynamoDB; agent budget; zero standing Oracle service) and `DEMO.md` mirroring the README demo transcript on the **hosted URL**. Update `DECISIONS.md` kit-deviation table.
- [ ] **Step 6:** Check `git status` shows no Parquet/CAR/secrets outside `fixtures/elephant-mini/`; commit `docs/ demo-packet/ README.md` with message `docs: demo packet, sources, cost and demo script`.

### Task 19: Submission — demo video, PR, Slowking self-check

**Files:**
- Create: `docs/SUBMISSION.md` (PR description source), `demo-packet/video.md` (video link + chapter timestamps)

- [ ] **Step 1:** Record the demo video on the hosted URL following the README demo transcript step by step: run summary → sources → data quality → DuckDB/cost (incl. the WASM proof page) → manifest → two-gateway fetch ("Verify now") → incremental new CID ("Check previous run") → explorer radius queries → occupancy view → agent prompts incl. the "near that area" follow-up, with retrieved evidence expanded → MCP console calls. Upload it to a link reachable without sign-in.
- [ ] **Step 2:** Write `docs/SUBMISSION.md` with:
  - Access: hosted URL (Function URL), MCP URL + connect command, credentials ("public, read-only"), demo video link.
  - Data: latest manifest CID and previous manifest CIDs, run history, Atlas PR / Elephant MCP evidence if registered.
  - Reproduction: setup/reproduction steps (`oracle sync --manifest <cid>`, `oracle sync --rebuild`, `cdk deploy`), source limitations and permit coverage by jurisdiction; the skip rule and each skipped source with its size and time estimate (mirrored in a README "Speed limitations and source constraints" section).
  - Roles (README demo step "both Oracle and builder"): **as Oracle**, ran the pipeline, publishes from my own pinning accounts (Filebase + second pinner), owns run history and the on-demand incremental runs, and opened the Atlas PR if granted; **as builder**, wrote the pipeline, query layer, MCP server, UI, agent and infrastructure. The Runs page footer shows the same.
  - Kit: agents/skills used (`oracle`, `use-oracle` stage skills, `build-county-transform`, `apply-engineering-guidelines`, `build-frontend-backends`, …), the **kit-deviation table** (architecture §0.1), open-question answers.
- [ ] **Step 3:** Push the branch to the `shengda` fork and turn the draft PR (fork → designated assignment repo) into a ready PR with `SUBMISSION.md` as the description (outward-facing — confirm with the user first).
- [ ] **Step 4:** Self-check: run the team-kit `slowking` agent (Playwright MCP connected) against the PR and hosted URL; fix any `Failed` gate or low-scoring point, then re-check.
- [ ] **Step 5:** Make the final commit; afterwards commit only to fix a grading blocker. Speed is measured to the PR head's latest commit, so post-submission evidence (e.g. Atlas) goes in PR comments, never in new commits on the PR branch.

### Task 20: Register in Atlas (when access is granted)

Access was requested in Task 0 (Open Question 1); run this as soon as access to `elephant-xyz/atlas` is granted, after the first publish (M3). Registration is the kit's public publication path and the strongest kit-usage evidence. If access never arrives, record that in `SUBMISSION.md`.

- [ ] **Step 1:** Confirm the Atlas gate's pinned CLI (`VERSION` in atlas `.github/workflows/validate.yml`) is build `94db3af` or newer; rebuild with that build if ours differs.
- [ ] **Step 2:** For each Lexicon group (never derived artifacts), `elephant-cli export-tables <group>.car --atlas-page ./atlas/counties/FL/broward.json --county broward --state FL --fips 12011`.
- [ ] **Step 3:** Open the Atlas PR (touching only `counties/FL/broward.json`) with archive and tables roots retrievable from public gateways; after merge, resolve the global Atlas IPNS, run Elephant MCP 2.0 `sync`, and record `listAtlasCounties` / `getAtlasDatasetInfo` output and the PR link in `demo-packet/README.md` if this happens before the T19 final commit; afterwards, post them as a comment on the submission PR instead (Speed).

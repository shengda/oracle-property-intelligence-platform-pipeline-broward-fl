# Explorer UI guide and demo script

How to use the Oracle Explorer, and how to walk through the README **Demo Transcript** with it.

## Start it

```bash
export PATH=$HOME/.nvm/versions/node/v22.23.5/bin:$PATH   # this machine only
./bin/oracle.mjs serve            # latest local run → http://127.0.0.1:4317/
# Other sources: --run runs/<id> | --index <path>.duckdb | --fixture (tiny test data) | --manifest <cid> (a published run)
```

- The agent tab needs `ANTHROPIC_API_KEY` in `.env` (and optionally `ORACLE_AGENT_MODEL`); restart
  `serve` after adding it. Every other tab works without a key.
- The yellow **UNPUBLISHED** banner means the run is local and not yet on IPFS. It disappears when the
  server is started from a published manifest (`serve --manifest <cid>`).
- Published runs (2026-11-27): run 1 `bafkreigdrq3tmzv6wk4ymglnlncrxflgsdkcw6g4z6hmzbbtdtp4lxvdqi`
  (full), run 2 `bafkreiaw4jf6xzwtgpcfadnu7vbwpwpshbv7qz2hflapksf5m4rzl4dsby` (incremental, chained
  to run 1). Run history `bafkreidao3zlxua5l2k7qrime4n3so3brz5styzmb4jnjweuwl4bwg64uu`.
- Every view is a URL (`#/page?…`): bookmark or paste one to come back to the exact same state.

## The tabs

| Tab | What it is for | How to use it |
|---|---|---|
| **Runs** | Run summary: status, mode, as-of date, Elephant CLI version, start → finish, record counts per view, each Lexicon data group with its root CIDs and per-stage timings, deltas vs the previous run, Lexicon tables. | Read top to bottom. **Data quality →** jumps to Quality. On a published run, the manifest CID and the run history (run 1 → run 2, each verified) appear here. |
| **Sources** | Every source pulled: status (loaded / blocked / skipped), records, bytes, requests, retrieval time, SHA-256 of the raw capture, and the limitation for each. Then permit coverage per jurisdiction and row counts per Lexicon class. | Use it to answer "what did we load, from where, when, and what's missing". Blocked sources (HCED, BBB 403, portal-only cities) are listed with the reason, never hidden. |
| **Quality** | The QA report (`meta/qa.json`): 20 checks grouped by theme with value, threshold and pass / warn / fail, plus **Spot check — 20 random parcels** with links to bcpa.net. | Scan for warn/fail; open a few spot-check links and compare address, year built and last sale with the appraiser site. |
| **Manifest** | Every artifact of the run: name, kind, codec, size, SHA-256, CID, gateway links. | Unpublished: locally computed roots; **Verify now** / **Check previous run** are disabled. Published: **Verify now** re-checks every CID on ipfs.filebase.io and gw.ipfs-lens.dev (root blocks, files ≤ 5 MB byte for byte); the stored report from publish (every byte) shows below; **Check previous run** fetches the previous manifest by CID and lists what changed. |
| **Explorer** | The lead map: aged roofs (brown) and long-open roof permits (blue) inside a radius. | Set the center (city dropdown, address + **Find**, lat/lon + **Set center**, or click the map). Set **Radius**, **Roof age ≥**, **Permit open ≥**; toggle the two layers. Click a dot or a row for detail. The yellow note names jurisdictions inside the radius with no permit data. |
| **Property** (opened from any row) | One parcel: address, coordinates, owner type/location, structure, roof age **and its basis** (permit / year built), sales, tax values, permits, Lexicon entity CIDs, link to bcpa.net. | Use it to show source backing for a single answer. |
| **Permit** (opened from any permit) | One permit: status, issue date, open duration, work class, contractor, license (DBPR), BBB, parcel and how it was linked (folio / address / address + unit). | Show "how do we know" for an open permit. |
| **Occupancy** | Owner & occupancy filter around a center: owner location (any / outside Broward / outside Florida or abroad), occupancy class (likely tenant-occupied, owner-occupied, commercial, vacant land, government/exempt, unknown) and roof age. | Pick a center and radius, choose an owner location, tick occupancy classes, set roof age. Covers the README's regional / out-of-area owner questions. |
| **Contractors** | The 233 contractors on roofing permits with license, class, status, permit and open-permit counts, BBB. | Click a contractor for its DBPR license detail and its roofing permits. BBB shows "no rating" (BBB returned 403; recorded, not bypassed). |
| **Search** | Keyword (BM25), meaning-based (embeddings) or hybrid search across permits, properties, businesses and contractors. | Type e.g. `reroof shingle` or `tile roof replacement`; pick the mode. The first semantic search loads the model (a few seconds). |
| **SQL** | Read-only DuckDB console over the views (one SELECT, 500 rows max; DDL, COPY, ATTACH and file functions are rejected). The **Views guide** below documents every view and column. | Click a canned query (aged roofs by city, roof-age basis mix, longest-open permits, owner location × occupancy, Lexicon tables), edit, **Run** (⌘/Ctrl + Enter). |
| **Agent** | Chat over the same tools: answer, reasoning steps, tool calls, cited records, assumptions and missing data; results can be pinned on the Explorer map. | Click a suggested prompt or type one. Follow-ups reuse the previous turn's area. Needs the API key. |
| **MCP** | The MCP endpoint (`/mcp`, Streamable HTTP) with connect commands, and a live console that sends real JSON-RPC from your browser. | **initialize** → **tools/list** → pick a tool, edit its arguments → **tools/call**. Every request and response is shown raw below. |
| **WASM proof** | DuckDB compiled to WebAssembly runs the aged-roofs query **in your browser** against the Parquet file, then compares with the server's answer. | Press **Run in browser**. Unpublished, the Parquet comes from this server; published, it is read by CID from ipfs.filebase.io (range requests). |
| **Cost** | What runs where and what costs money: local ingest, IPFS for storage, query on the consumer side, Lambda (M5), the agent as the only metered part. | Read it during the "no infrastructure cost" step. |

## Demo script (README Demo Transcript)

Before you start:

1. `./bin/oracle.mjs serve` and open http://127.0.0.1:4317/ (after M5, use the hosted URL).
2. Put `ANTHROPIC_API_KEY` in `.env` and restart, so the agent step works; send one test question.
3. Open the Explorer once at Fort Lauderdale so the map tiles are cached.
4. Demo city: **Fort Lauderdale**. It is the only large city with permit data, so both questions
   return real permits there.

| # | Presenter says | Do this | Point at | Ready now? |
|---|---|---|---|---|
| 0 | Opening statement | — | — | ✓ |
| 1 | "Opening the pipeline run summary." | **Runs** | Completed run, start → finish, 766,044 properties, both Lexicon groups with timings; then **Sources** for limitations | ✓ |
| 2 | "Total uploaded records by source." | **Sources**, then **Quality** | Records, bytes, retrieval time and SHA-256 per source; rows per Lexicon class; QA 16 pass / 4 warn / 0 fail; contractors + BBB status | ✓ |
| 3 | "Opening the DuckDB-backed query layer." | **SQL** → *Roof-age basis mix* → Run; then **WASM proof** → Run in browser; then **Cost** | Same DuckDB answer computed in the browser with no Oracle database | ✓ (gateway-backed on a published run) |
| 4 | "Published artifact manifest for this run." | **Manifest** | CID, size, codec, SHA-256 per artifact; manifest CID | ✓ (run 2) |
| 5 | "Retrieve one artifact by CID from two public gateways." | **Manifest** → **Verify now** (or `oracle verify`) | Both gateways ✓, size + digest match | ✓ |
| 6 | "A later incremental publish produced a new CID." | **Runs** (run history) → **Manifest** → **Check previous run** | Run 1 and run 2 manifest CIDs differ; run 1 still resolves (14 artifacts unchanged, 10 changed) | ✓ |
| 7 | "Properties within a sample radius with roofs older than 15 years." | **Explorer**: city *Fort Lauderdale*, radius 5, roof age ≥ 15 | 129,671 properties; **Basis** column; open a row → Property page with coordinates, source and bcpa.net link | ✓ |
| 8 | "Open roofing permits there, longest open first, with contractor and BBB." | Same Explorer view, **Permit open ≥ 5** | 1,497 permits open ≥ 5 years; open duration, contractor, license, BBB column; the January 2021 note; open a permit → Permit page | ✓ |
| 9 | Agent prompt 1: "Which properties in Broward County within five miles of Fort Lauderdale have roofs older than 15 years?" | **Agent** | Answer, steps, cited records, basis assumption; pin on map | needs API key |
| 10 | Agent prompt 2: "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?" | **Agent** (same chat) | Reuses the area; permit ages, contractors, "BBB unavailable" and frozen-status notes as missing data | needs API key |
| 11 | "The system is MCP-ready." | **MCP** → initialize → tools/list → `find_aged_roofs` → tools/call; mention `docs/MCP.md` | The 13 tools, raw JSON-RPC, the same data the CRM will use | ✓ |

**What to say about the caveats** (both are signed off in `docs/DATA-QA.md`):

- *Roof age:* "Outside Fort Lauderdale and Weston, cities don't publish permits in bulk, so roof age
  falls back to building age. It's an upper bound, and every result says which basis it used."
- *Fort Lauderdale permits:* "The city's permit layer stopped updating in January 2021, so 'open'
  means open at that snapshot. Every open-permit answer says so."
- *BBB:* "BBB blocks automated access (HTTP 403). We recorded that and didn't work around it, so the
  BBB column shows 'no rating'."

**If something goes wrong live:**

- Blank page: hard refresh (⌘⇧R). If it stays blank, restart `serve`.
- Map shows a grey box: the browser has no WebGL. The lists below still show every result.
- Agent says "not configured": the key is missing or `serve` wasn't restarted. Fall back to the
  Explorer (steps 7–8) and the MCP console, which answer the same questions with the same tools.

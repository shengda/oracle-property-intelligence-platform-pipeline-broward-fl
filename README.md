# Oracle Property Intelligence Platform Pipeline - Broward County, FL

> **Reviewers:** start at [Implementation (this repository)](#implementation-this-repository): demo
> video, hosted runtime, how to run it and verify the CIDs.
>
> **Hosted:** https://jbahdp5wn5czd3bj2trxjjz6ha0tfyzg.lambda-url.us-east-2.on.aws/ (public, read-only) ·
> MCP: `…/mcp` · health: `…/api/health` · deployment: [`deploy/README.md`](deploy/README.md) ·
> published runs (manifest CIDs, run history, verification): [`runs/`](runs/) and
> [`docs/DEMO.md`](docs/DEMO.md)

## Context

This repository is the **data gathering and ingestion pipeline** that supplies the [Roofing CRM & Lead Identification UI](https://github.com/prismteam-ai/roofing-crm). The CRM helps roofing companies explore properties in their service area, identify aging roofs and open roofing permits, and turn those signals into leads. This pipeline story covers collecting, loading, reconciling, and exposing the underlying property and permit datasets; the CRM UI/workflow itself is out of scope here.

The Oracle ingestion pipeline has been started, but the full **Broward County, FL** dataset has not been completely uploaded, reconciled, or demonstrated. The infrastructure must be designed so Oracle does not carry ongoing infrastructure cost by default. For this candidate exercise, the candidate acts as both Oracle and builder: they are responsible for completing the pipeline and proving the low-cost infrastructure approach.

The pipeline must be continuous and incremental (ongoing ingestion of new and changed records over time) and must publish eligible data artifacts to Elephant IPFS (the Elephant protocol’s decentralized storage layer, following Lexicon / elephant-cli / Filebase+IPNS conventions used by the Elephant oracle skills).

Published artifacts must remain independently retrievable from the public IPFS network after the candidate’s local environment, demo session, and any single pinning vendor are gone. **Content identifiers (CIDs) are the durable identity of each artifact.** A vendor HTTP gateway URL is a convenience locator, not the artifact.

In addition to standard property intelligence, the pipeline must surface signals relevant to **roofing lead generation**, including roof age, open roofing permits (especially long-open permits), contractor identity, BBB rating scores where available, ownership/contact fields where available, and accurate property coordinates for radius-based search.

## Description

Complete the Oracle pipeline by loading all available Broward County, FL property, permit, ownership, business, contractor, location, and public-source data into an MCP-ready database. Use IPFS and DuckDB to minimize Oracle-hosted infrastructure costs while enabling UI and agent access to answer property intelligence questions that support the roofing CRM—especially aged-roof and open-permit lead discovery within a map radius.

The pipeline must demonstrate that data is ingested on an ongoing basis (not a one-shot bulk load): support incremental / windowed refreshes, preserve run history with record deltas and timestamps, and re-publish updated artifacts to Elephant IPFS as **new immutable CIDs** (do not mutate a previously published CID).

## Acceptance Criteria

### Geography & coverage
- Target **Broward County, FL** as the default and primary county for ingestion and demos.

### Data loading
- Run the Oracle pipeline until all available county data is uploaded.
- Load available property records into the database.
- Load available permit records into the database, with emphasis on **roofing-related permits**.
- Preserve permit status, open/close dates (or equivalent), and duration-open signals so long-open permits can be identified.
- Load available ownership records into the database.
- Load available contractor records into the database.
- Load available BBB / contractor rating scores where publicly available.
- Load available business records into the database.
- Load available location and coordinate data into the database (required for GPS/pin-drop radius queries in the CRM).
- Capture roof age or best-available proxies (e.g., year built, last roofing permit/completion date) so properties with roofs older than a configurable threshold (default suggestion: **15 years**) can be queried.
- Reconcile duplicate entities across all uploaded datasets.
- Preserve source provenance for uploaded records.
- Design and implement the pipeline as continuous / incremental:
  - Support ongoing ingestion of new and changed records (scheduled or on-demand refreshes, change detection or bounded windows, idempotent steps).
  - Maintain a visible history of pipeline runs (timestamps, source list, record counts, deltas, any source limitations).
  - Demonstrate that data continues to be ingested and published over time (multiple runs or simulated ongoing updates).

### Infrastructure & access
- Optimize pipeline performance where feasible.
- Identify slow source sites or constrained data sources.
- Document pipeline speed limitations and source constraints.
- Design the infrastructure so Oracle does not carry ongoing infrastructure cost by default.
- Use IPFS for decentralized storage of eligible dataset artifacts.
- Use DuckDB for local or portable analytical querying.
- Structure the database to support MCP access.
- Enable agent access to query the database.
- Provide a UI for exploring the uploaded data.

### IPFS publication
- Treat IPFS **CIDs** as the durable identity of published artifacts. Do not treat a vendor-specific HTTP URL as the source of truth.
- Prefer **CIDv1** (base32) for every published object.
- Keep published bytes **retrievable from the public IPFS network**, not only from a private node, authenticated gateway, vendor dashboard, or laptop that is running during the demo.
- Publish a machine-readable **artifact manifest** (JSON) for each pipeline run. Include every eligible object (query table, coverage, indexes, sample extracts, and any directory roots) with at least:
  - `cid`
  - logical `name` / path
  - `size` in bytes
  - IPFS codec (`file` vs `directory`)
  - content digest (e.g. SHA-256 of the raw bytes, or equivalent)
  - optional provider `origins` (multiaddrs) if a candidate-operated node is still serving the blocks
- If IPNS is used, record both the IPNS name and the **resolved CID** for that run. IPNS is a pointer; the CID is the snapshot.
- On incremental republish, keep prior CIDs immutable. New data produces a new CID. Run history must retain previous CIDs.
- For directory artifacts, also publish a **CAR** of the DAG rooted at that CID so the snapshot can be imported by any IPFS node without re-encoding.
- Demonstrate that each listed CID can be fetched from **at least two independent public gateways** that this environment does not operate (for example `https://ipfs.io/ipfs/<cid>` and `https://dweb.link/ipfs/<cid>`), and that the retrieved bytes match the manifest size/digest.
- Include the artifact manifest (and CARs, if any) in the repository or demo packet so a third party can fetch the dataset by CID after the candidate environment is gone.

### Roofing CRM–supporting queries
- Support radius-based property identification using coordinates (around a GPS point or map pin).
- Support questions about properties with roofs older than 15 years (or a configurable age threshold).
- Support questions about properties with **open roofing permits**, including those that have remained open for many years.
- Support returning permit details with contractor name and BBB rating score where available.
- Support questions about properties that have not exchanged ownership in more than 10 years.
- Support questions about properties with regional (or out-of-area) owners.
- Return source-backed answers where source data is available.

### Demonstration
- Demonstrate the uploaded dataset through the UI.
- Demonstrate the uploaded dataset through an agent query aligned to roofing lead discovery.
- Demonstrate that Oracle can operate without carrying the infrastructure cost.
- Demonstrate public, CID-addressed IPFS publication using the artifact manifest and independent gateway retrieval (not a private-only locator).
- Confirm the candidate fulfilled both Oracle and builder responsibilities for this milestone.
- Pass the demo using real uploaded Broward County records.

## Demo Transcript
- Presenter: “I will demonstrate that the Oracle pipeline has loaded the available dataset for Broward County, Florida, that the data is queryable through DuckDB, that eligible artifacts are stored on IPFS as content-addressed snapshots, and that both the UI and agent can answer property intelligence questions that support roofing lead generation.”
- Presenter: “First, I am opening the pipeline run summary.”
  - Expected Result: The system displays the completed pipeline run, source list, county coverage, record counts, timestamps, and any documented source limitations.
- Presenter: “Show the total uploaded records by source.”
  - Expected Result: The system shows uploaded property, permit, ownership, contractor (with BBB rating where available), business, and coordinate records with collection timestamps and provenance.
- Presenter: “Now I am opening the DuckDB-backed query layer.”
  - Expected Result: The system confirms that the loaded data is available for structured querying without requiring Oracle-hosted database infrastructure.
- Presenter: “Show the published artifact manifest for this run.”
  - Expected Result: A JSON (or equivalent) listing every eligible artifact with CID, size, logical name, codec, and digest. Gateway URLs, if shown, are derived from those CIDs. An IPNS name, if used, is shown together with the resolved CID.
- Presenter: “Retrieve one published artifact by CID from a public gateway that this environment does not operate, then again from a second independent public gateway.”
  - Expected Result: Both fetches succeed and the bytes match the manifest size/digest. Serving the object only from a private, local, or authenticated gateway is a fail.
- Presenter: “Show that a later incremental publish produced a new CID without mutating the previous one.”
  - Expected Result: The prior CID still resolves; the new run has a distinct CID; IPNS (if used) now points at the new CID; both CIDs appear in run history. A CAR is available for any directory root.
- Presenter: “Using the UI, show properties within a sample radius that have roofs older than 15 years.”
  - Expected Result: Matching properties are returned with roof-age basis, coordinates, and source provenance.
- Presenter: “Show properties in that area with open roofing permits, prioritizing permits that have remained open for many years, including contractor and BBB rating where available.”
  - Expected Result: Results include permit status/open duration, contractor identity, BBB score when present, and clear source backing.
- Presenter: “Now I am asking the same type of questions through the agent.”
  - Agent Prompt: “Which properties in Broward County within five miles of [city xyz] have roofs older than 15 years?”
    - Expected Result: The agent returns matching properties, explains the reasoning, and includes source-backed evidence.
  - Agent Prompt: “Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?”
    - Expected Result: The agent returns a filtered list with permit age/open duration, contractor details, BBB rating when available, and clearly identifies any assumptions or missing data.
- Presenter: “Finally, I will show that the system is MCP-ready.”
  - Expected Result: The system demonstrates an MCP-ready interface or documented MCP-compatible query structure that agents and the roofing CRM can use without changing the data model.

## Out of Scope
- Roofing CRM UI, map pin/GPS interaction design, and lead outreach workflows (covered in [roofing-crm](https://github.com/prismteam-ai/roofing-crm)).
- Live outbound messaging to property owners.

## Reference
- [Roofing CRM & Lead Identification UI](https://github.com/prismteam-ai/roofing-crm)
- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit)
- [Elephant Oracle Skills](https://github.com/elephant-xyz/skills)

## Implementation (this repository)

### Review it in five minutes

1. **Watch the demo video:**
   [oracle_demo.mov](https://drive.google.com/file/d/18Lre0lRzqjFXB2anyambVhYeIAFaxr2L/view?usp=drive_link).
2. **Open the hosted Explorer:** https://jbahdp5wn5czd3bj2trxjjz6ha0tfyzg.lambda-url.us-east-2.on.aws/
   - It is public and read-only, with no sign-in. It serves published run 2.
   - **Runs**, **Sources** and **Quality** show the run summary, the sources and the QA report.
   - **Manifest** → **Verify now** checks every CID on two public gateways.
   - **WASM proof** → **Run in browser** runs the query in your browser, reading the Parquet from IPFS.
   - **Explorer** at Fort Lauderdale, radius 5, shows aged roofs and long-open permits.
   - **Agent** answers questions in plain language. **MCP** is a live JSON-RPC console.
3. **Follow the demo script:** [`docs/DEMO.md`](docs/DEMO.md) maps every README demo step to a
   page, with what to point at. [`docs/DEMO-VIDEO.md`](docs/DEMO-VIDEO.md) is the script the
   video follows.

### Published runs

| Run | Manifest CID | In this repo |
|---|---|---|
| 1, full | `bafkreigdrq3tmzv6wk4ymglnlncrxflgsdkcw6g4z6hmzbbtdtp4lxvdqi` | `runs/20261127T132618Z-full/` |
| 2, incremental (chained to run 1) | `bafkreiaw4jf6xzwtgpcfadnu7vbwpwpshbv7qz2hflapksf5m4rzl4dsby` | `runs/20261127T223244Z-incremental/` |

- **What each run folder holds:** `publish/` (manifest, run history, gateway verification) and
  `meta/` (QA, coverage, deltas).
- **Fetch by CID yourself:**

  ```bash
  CID=bafkreiaw4jf6xzwtgpcfadnu7vbwpwpshbv7qz2hflapksf5m4rzl4dsby
  curl -s https://ipfs.filebase.io/ipfs/$CID | shasum -a 256
  curl -s https://gateway.pinata.cloud/ipfs/$CID | shasum -a 256
  ```

  Both hashes match each other and the committed `publish/manifest.json`.
- **Atlas:** the permit group is registered for review in
  [elephant-xyz/atlas#211](https://github.com/elephant-xyz/atlas/pull/211).

### Hosted endpoints

| What | Where |
|---|---|
| Explorer UI | `/` |
| Health (run, manifest, agent) | `GET /api/health` |
| Lead queries (aged roofs, open permits, occupancy, out-of-area and long-held owners) | `GET /api/query/<name>` |
| Detail by id | `GET /api/property/<folio>`, `/api/permit/<key>`, `/api/contractor/<id>` |
| Read-only SQL (sandboxed, rate-limited) | `POST /api/sql` `{"sql": "select …"}` |
| Agent | `POST /api/agent` `{"message": "…"}` |
| MCP (Streamable HTTP, 13 tools; see [`docs/MCP.md`](docs/MCP.md)) | `POST /mcp` |

Hosting runs on AWS: one container Lambda, deployed with CDK, which scales to zero. The data is
read from the published run. The setup, measured costs and redeploy steps are in
[`deploy/README.md`](deploy/README.md).

### Run it locally

You need Node 22.18 or later.

```bash
git clone --recurse-submodules https://github.com/shengda/oracle-property-intelligence-platform-pipeline-broward-fl.git
cd oracle-property-intelligence-platform-pipeline-broward-fl
npm ci

# A published run, downloaded by CID and checked against its manifest. It is a large download.
./bin/oracle.mjs serve --manifest bafkreiaw4jf6xzwtgpcfadnu7vbwpwpshbv7qz2hflapksf5m4rzl4dsby

# Or the tiny synthetic fixture: no downloads, ready in seconds.
./bin/oracle.mjs serve --fixture
```

Then open http://127.0.0.1:4317/.

- **The agent tab** needs `ANTHROPIC_API_KEY` in `.env` (see `.env.example`).
- **Every other tab** works without a key.
- **Check a run's CIDs** on two public gateways:
  `./bin/oracle.mjs verify --manifest <cid> --quick`.

### Run the pipeline

[`docs/RUNBOOK.md`](docs/RUNBOOK.md) has the full guide. In short:

```bash
bash scripts/install-elephant-cli.sh   # pinned Elephant CLI 2 build
./bin/oracle.mjs readiness             # toolchain, Lexicon manifest, kit submodule
./bin/oracle.mjs run --no-publish      # ingest → build (Lexicon groups) → index + QA, local only
./bin/oracle.mjs run --mode incremental  # … → publish → verify → run history (needs .env pinning keys)
```

- **Disk:** a county-wide build needs about 20 GB free.
- **Source list and limits:** what each source is and what it can't provide are in
  [`docs/SOURCES.md`](docs/SOURCES.md).
- **Mapping:** how source fields map to the Lexicon is in
  [`docs/LEXICON-MAP.md`](docs/LEXICON-MAP.md).

### Checks

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

CI runs the same checks on every push. A scheduled uptime check calls the hosted health endpoint.

### Design and decisions

- [`docs/DECISIONS.md`](docs/DECISIONS.md) explains each choice, including where this departs
  from the team kit and why.
- [`docs/DATA-QA.md`](docs/DATA-QA.md) has the data-quality findings and sign-off.
- [`docs/roofing-oracle-architecture-and-roadmap.md`](docs/roofing-oracle-architecture-and-roadmap.md)
  covers the architecture.

### Known limits

These are also shown in the UI and in the agent's answers.

- **Permits cover Fort Lauderdale and Weston only.**
  - Unincorporated Broward's service returned HTTP 403.
  - The other cities only offer one-parcel-at-a-time portals, or need a login.
- **Fort Lauderdale's permit layer stopped updating in January 2021.** "Open" means open as of
  then.
- **No BBB ratings.** BBB returned HTTP 403, and we did not bypass it.
- **Contractor names** are on about 30% of open permits.
- **Run 2 is a real incremental publish with new CIDs.** Its source data didn't change, so its
  record deltas are zero.

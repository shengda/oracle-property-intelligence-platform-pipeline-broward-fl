# Oracle pipeline: demo video script (about 8 minutes)

Follows the README **Demo Transcript** in order. Spoken lines are in quotes; actions are in bold.
Site: https://jbahdp5wn5czd3bj2trxjjz6ha0tfyzg.lambda-url.us-east-2.on.aws/

## Before you record

- Open the site once, click through Explorer and the Agent tab, and send one test question, so the
  Lambda is warm and the map tiles are cached.
- Have a terminal ready, with a large font, in the Oracle repository folder (for step 5).
- Have the GitHub repository open in a second tab, on `runs/`, for steps 4 and 6.
- Window at about 1400×900, browser zoom 100%, notifications off.
- Note: ipfs.io and dweb.link sometimes return 429 (rate limit) to scripts. Use the in-app
  **Verify now** (Filebase and ipfs-lens) as the main proof, and try ipfs.io in the terminal as a
  bonus. Pinata's gateway also worked in the last review.

## 0. Opening (20 s)

"I'll show that the Oracle pipeline loaded the available Broward County data, that it's queryable
with DuckDB, that each run is published to IPFS as content-addressed snapshots, and that both the
UI and an agent answer roofing-lead questions. I acted as both the Oracle and the builder."

## 1. Pipeline run summary (45 s)

**Open the Runs tab.**

"This is the run summary: a completed incremental run, its start and finish, 766,044 properties,
the Lexicon data groups with their root CIDs and how long each stage took, and the deltas against
the previous run."

## 2. Records by source (60 s)

**Open Sources.**

"Every source we pulled, with status, record count, bytes, retrieval time and the SHA-256 of the
raw capture. Sources that were blocked are listed with the reason. For example, BBB returned 403,
and we recorded that rather than working around it. Permit data covers Fort Lauderdale and Weston;
the other cities are listed as not covered."

**Open Contractors briefly.** "233 contractors from roofing permits, with state licenses."

**Open Quality.** "And a QA report: 20 checks, plus a spot check of random parcels against the
appraiser site."

## 3. DuckDB query layer, no Oracle database (75 s)

**Open SQL → click *Roof-age basis mix* → Run.**

"The query layer is DuckDB over the published files. This is a read-only console over the views."

**Open WASM proof → Run in browser. Wait for the green tick.**

"This is the key point for cost. DuckDB compiled to WebAssembly runs the same aged-roofs query in
my browser, reading the Parquet file straight from IPFS by its CID. It gets the same 129,671 rows as
the API. No Oracle-hosted database is involved."

**Open Cost.** "The hosted demo is one Lambda that scales to zero, under a $5 monthly budget. The
data itself lives on IPFS, so the Oracle doesn't need to run anything for it to stay available."

## 4. The artifact manifest (45 s)

**Open Manifest.**

"The manifest for this run lists every artifact with its CID, size, codec and SHA-256. Gateway
links are derived from the CIDs. The manifest itself has a CID, starting bafkreiaw4j. It's also
committed in the repository." **Switch to the GitHub tab, show `runs/…/publish/manifest.json`.**

## 5. Retrieve by CID from two public gateways (75 s)

**Back in Manifest → Verify now. Wait for the results.**

"Verify now fetches every CID from two public gateways I don't operate and checks the bytes
against the manifest. All pass."

**In the terminal, run:**

```bash
CID=bafkreiaw4jf6xzwtgpcfadnu7vbwpwpshbv7qz2hflapksf5m4rzl4dsby
curl -s https://ipfs.filebase.io/ipfs/$CID | shasum -a 256
curl -s https://gateway.pinata.cloud/ipfs/$CID | shasum -a 256
```

"Two independent gateways return identical bytes for the manifest." If ipfs.io answers, add it:
`curl -s https://ipfs.io/ipfs/$CID | shasum -a 256`.

## 6. Incremental publish, new CID (45 s)

**Back on Runs: point at the run history. Then Manifest → Check previous run.**

"Run 2 is an incremental publish chained to run 1. It has a new manifest CID, and run 1's CID still
resolves: this fetches it and lists what changed between them. Both appear in the run history."

Say this plainly: "In this second run the source data didn't change, so the deltas are zero and
only derived artifacts changed. The point it shows is that a new run gets new immutable CIDs."

## 7. Aged roofs in the UI (45 s)

**Open Explorer: city Fort Lauderdale, radius 5, Roof age ≥ 15.**

"129,671 properties within 5 miles have roofs at least 15 years old. The Basis column says where
each roof age comes from: a roofing permit, or the year built when there's no permit."

**Click a row.** "The property page has coordinates, owner, structure, sales, tax values, permits,
the Lexicon CIDs and a link to the appraiser's record."

## 8. Long-open permits (45 s)

**Back to Explorer, set Permit open ≥ 5.**

"Open roofing permits, longest open first, with the contractor, license and BBB column. Note the
banner: Fort Lauderdale's permit layer stopped updating in January 2021, so 'open' means open at
that snapshot." **Click a permit.** "The permit page shows how it was linked to the parcel and the
contractor's DBPR license."

## 9. Agent (90 s)

**Open Agent. Send:**
`Which properties in Broward County within five miles of Fort Lauderdale have roofs older than 15 years?`

"The agent uses the same tools and cites records. It reports the count, lists examples, and states
its assumption about roof-age basis."

**Then send:**
`Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?`

"It reuses the area, gives permit ages and contractors, and lists what's missing: no BBB rating and
the frozen Fort Lauderdale statuses."

## 10. MCP (30 s)

**Open MCP → initialize → tools/list → find_aged_roofs → tools/call.**

"The same data is available over MCP, with 13 tools. This is what the Roofing CRM's agent uses."

## 11. Close (20 s)

"To recap: real Broward records, loaded and QA-checked; queryable with DuckDB, even in the browser
straight from IPFS; published as immutable CIDs that two independent gateways serve; and answered
by the UI, an agent and MCP. Thanks for watching."

## If something goes wrong

- Verify now shows a gateway failure: that's gateway rate limiting. Say so, rerun it, or use the
  terminal commands.
- The agent is slow or refuses: fall back to Explorer and MCP, which answer the same questions with
  the same tools.
- The WASM proof is slow on first click: it downloads a 36 MB engine. Wait; don't click twice.

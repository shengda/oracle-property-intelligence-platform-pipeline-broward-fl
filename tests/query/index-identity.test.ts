import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { openIndex } from "../../src/query/db.ts";
import { buildIndex } from "../../src/query/index-build.ts";
import * as Q from "../../src/query/queries.ts";
import { openWorkDb } from "../../src/work-db.ts";
import { FIXTURE_DIR, fakeEmbedder } from "../helpers/fixture-index.ts";

test("with the published Seed loaded, views hand out published property CIDs (null where the archive lacks the parcel)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-identity-"));
  const runDir = path.join(dir, "run");
  await cp(FIXTURE_DIR, runDir, { recursive: true });

  // Publish a Seed for every parcel but one.
  const tmp = await openWorkDb(":memory:");
  const parcels = await tmp.all<{ parcel_identifier: string }>(
    `select parcel_identifier from read_parquet('${runDir}/tables/county/property/*.parquet') order by 1`,
  );
  const missing = parcels[0].parcel_identifier;
  await tmp.run(
    `copy (select parcel_identifier, 'bpublished' || parcel_identifier as property_cid
       from read_parquet('${runDir}/tables/county/property/*.parquet') where parcel_identifier <> '${missing}')
     to '${runDir}/supplement/atlas_seed.parquet' (format parquet)`,
  );
  await tmp.close();

  const indexPath = path.join(dir, "index.duckdb");
  const r = await buildIndex({ runDir, asOf: "2026-11-25", runId: "identity" }, indexPath, {
    embedder: fakeEmbedder,
  });
  expect(r.property_identity).toBe("atlas");
  const db = await openIndex(indexPath, { runDir });
  try {
    const rows = await db.all<{ parcel_identifier: string; property_cid: string | null }>(
      "select parcel_identifier, property_cid from v_property order by 1",
    );
    expect(rows.length).toBe(parcels.length);
    for (const row of rows) {
      expect(row.property_cid).toBe(
        row.parcel_identifier === missing ? null : `bpublished${row.parcel_identifier}`,
      );
    }
    // Permit and owner views follow v_property, and so does the detail page.
    const leaks = await db.one<{ n: number }>(
      `select count(*)::INTEGER n from (
         select property_cid from v_roof_permit union all select property_cid from v_owner
       ) where property_cid is not null and property_cid not like 'bpublished%'`,
    );
    expect(leaks!.n).toBe(0);
    const d = await Q.getProperty(db, missing);
    expect(d!.property.property_cid).toBeNull();
    expect(d!.entities).toEqual([]);
    const other = await Q.getProperty(db, parcels[1].parcel_identifier);
    expect(other!.entities[0]).toMatchObject({
      class: "property",
      cid: `bpublished${parcels[1].parcel_identifier}`,
    });
  } finally {
    await db.close();
  }
});

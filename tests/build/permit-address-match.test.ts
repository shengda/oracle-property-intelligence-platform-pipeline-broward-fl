import { expect, test } from "vitest";
import { matchPermitsByAddress } from "../../src/build/derive.ts";
import { openWorkDb } from "../../src/work-db.ts";

test("permits without a folio link to a parcel only on an unambiguous address in their jurisdiction", async () => {
  const db = await openWorkDb(":memory:");
  await db.run(`create table stg_parcels as select * from (values
    ('A00000000001', '1215', 'NW', '15', 'AVE', null, null, 'FORT LAUDERDALE'),
    ('A00000000002', '835', 'NE', '19', 'AVE', null, '4', 'FORT LAUDERDALE'),
    ('A00000000003', '835', 'NE', '19', 'AVE', null, '6', 'FORT LAUDERDALE'),
    ('A00000000004', '405', null, 'CORAL', 'WAY', null, null, 'FORT LAUDERDALE'),
    ('A00000000005', '405', null, 'CORAL', 'WAY', null, null, 'WESTON')
  ) t(parcel_id, situs_number, situs_dir, situs_street, situs_type, situs_post_dir, situs_unit, situs_city)`);
  await db.run(`create table drv_permits as select * from (values
    ('p1', 'broward_ftl_arcgis_permits', null, '1215 NW 15 AV'),
    ('p2', 'broward_ftl_arcgis_permits', null, '835 NE 19 AVE # 0006'),
    ('p3', 'broward_ftl_arcgis_permits', null, '835 NE 19 AVE'),
    ('p4', 'broward_ftl_arcgis_permits', null, '405 CORAL WY'),
    ('p5', 'broward_ftl_arcgis_permits', 'B00000000009', '1215 NW 15 AVE'),
    ('p6', 'broward_ftl_arcgis_permits', null, '1 ALARM LABEL')
  ) t(permit_key, source_system, parcel_id, address)`);
  await matchPermitsByAddress(db);
  const rows = await db.all<{
    permit_key: string;
    parcel_id: string | null;
    parcel_match_method: string | null;
  }>("select permit_key, parcel_id, parcel_match_method from drv_permits order by permit_key");
  expect(rows).toEqual([
    { permit_key: "p1", parcel_id: "A00000000001", parcel_match_method: "address" }, // AV → AVE
    { permit_key: "p2", parcel_id: "A00000000003", parcel_match_method: "address_unit" }, // unit 0006 → 6
    { permit_key: "p3", parcel_id: null, parcel_match_method: null }, // two condo units: ambiguous
    { permit_key: "p4", parcel_id: "A00000000004", parcel_match_method: "address" }, // Weston twin ignored
    { permit_key: "p5", parcel_id: "B00000000009", parcel_match_method: "folio" }, // folio kept as given
    { permit_key: "p6", parcel_id: null, parcel_match_method: null },
  ]);
  await db.close();
});

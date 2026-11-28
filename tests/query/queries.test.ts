import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as C from "../../src/contract/index.ts";
import type { SnapshotDb } from "../../src/query/db.ts";
import { resolvePlace } from "../../src/query/places.ts";
import * as Q from "../../src/query/queries.ts";
import { openWorkDb } from "../../src/work-db.ts";
import { fakeEmbedder, fixtureIndex } from "../helpers/fixture-index.ts";

let db: SnapshotDb;
const FTL = { lat: 26.122, lon: -80.137 };

beforeAll(async () => {
  ({ db } = await fixtureIndex());
}, 120_000);
afterAll(async () => {
  await db?.close();
});

describe("radius predicate", () => {
  test("radius boundary: 4.9 mi in, 5.1 mi out; rows without geometry never match", async () => {
    const w = await openWorkDb(":memory:");
    // 1° of latitude = 69.09 mi on the haversine sphere used by distanceSql.
    const deg = (mi: number) => mi / 69.0934;
    await w.run(`create table p as select * from (values
      ('in', ${FTL.lat + deg(4.9)}, ${FTL.lon}), ('out', ${FTL.lat + deg(5.1)}, ${FTL.lon}),
      ('nogeo', null, null), ('nolon', ${FTL.lat}, null)) t(id, lat, lon)`);
    const rows = await w.all<{ id: string }>(
      `select id from p where ${Q.radiusSql(FTL, 5, "p")} order by id`,
    );
    expect(rows.map((r) => r.id)).toEqual(["in"]);
    await w.close();
  });
});

describe("lead queries (fixture)", () => {
  test("minRoofAgeYears filters on roof_age_years and reports the roof-age source", async () => {
    const rows = await Q.findAgedRoofs(db, { center: FTL, radiusMiles: 5, minRoofAgeYears: 15 });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      C.PropertyLead.parse(r);
      expect(r.roof_age_years).toBeGreaterThanOrEqual(15);
      expect(["permit", "year_built"]).toContain(r.roof_age_basis);
      expect(r.distance_miles).toBeLessThanOrEqual(5);
      expect(r.provenance[0].source_url).toMatch(/^https?:\/\//);
      expect(r.manifest_cid).toBeNull();
    }
    const younger = await Q.findAgedRoofs(db, { center: FTL, radiusMiles: 5, minRoofAgeYears: 0 });
    expect(younger.length).toBeGreaterThan(rows.length);
  });

  test("order=nearest sorts aged roofs by distance; the default sorts oldest first", async () => {
    const base = { center: FTL, radiusMiles: 10, minRoofAgeYears: 0 };
    const near = await Q.findAgedRoofs(db, { ...base, order: "nearest" });
    const d = near.map((r) => r.distance_miles!);
    expect(d).toEqual([...d].sort((a, b) => a - b));
    const old = (await Q.findAgedRoofs(db, base)).map((r) => r.roof_age_years!);
    expect(old).toEqual([...old].sort((a, b) => b - a));
  });

  test("order=spread covers the radius: a capped list reaches as far as the full one", async () => {
    const base = { center: FTL, radiusMiles: 10, minRoofAgeYears: 0 };
    const all = await Q.findAgedRoofs(db, { ...base, limit: 5000 });
    const cap = Math.max(2, Math.floor(all.length / 4));
    const spread = await Q.findAgedRoofs(db, { ...base, order: "spread", limit: cap });
    const nearest = await Q.findAgedRoofs(db, { ...base, order: "nearest", limit: cap });
    expect(spread).toHaveLength(cap);
    const far = (rows: typeof all) => Math.max(...rows.map((r) => r.distance_miles!));
    expect(far(spread)).toBeGreaterThan(far(nearest));
    for (const r of spread) expect(C.PropertyLead.parse(r)).toBeTruthy();
  });

  test("open permits filter on roof age; the count covers every match", async () => {
    const base = { center: FTL, radiusMiles: 10 };
    const all = await Q.findOpenRoofPermits(db, base);
    const ages = all.map((r) => r.roof_age_years).filter((a): a is number => a != null);
    expect(ages.length).toBeGreaterThan(0);
    const min = Math.max(...ages);
    const rows = await Q.findOpenRoofPermits(db, { ...base, minRoofAgeYears: min });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.roof_age_years).toBeGreaterThanOrEqual(min);
    expect(await Q.countOpenRoofPermits(db, { ...base, minRoofAgeYears: min })).toBe(rows.length);
    expect(await Q.countOpenRoofPermits(db, base)).toBe(all.length);
  });

  test("open permits carry their property's roof age", async () => {
    const rows = await Q.findOpenRoofPermits(db, { center: FTL, radiusMiles: 10 });
    const linked = rows.filter((r) => r.parcel_identifier);
    expect(linked.length).toBeGreaterThan(0);
    for (const r of linked) {
      const p = await Q.getProperty(db, r.parcel_identifier!);
      expect(r.roof_age_years ?? null).toBe(p?.property.roof_age_years ?? null);
    }
  });

  test("open permits sorted by open_days desc with contractor and BBB fields; needs_review excluded", async () => {
    const rows = await Q.findOpenRoofPermits(db, { center: FTL, radiusMiles: 10 });
    expect(rows.length).toBeGreaterThan(0);
    const days = rows.map((r) => r.open_days!);
    expect(days).toEqual([...days].sort((a, b) => b - a));
    for (const r of rows) {
      C.PermitLead.parse(r);
      expect(r.status).toBe("open");
      expect(r).toHaveProperty("contractor_name");
      expect(r).toHaveProperty("bbb_rating");
    }
    const review = await db.all<{ n: number }>(
      "select count(*)::INTEGER n from v_roof_permit where status = 'needs_review'",
    );
    expect(review[0].n).toBeGreaterThan(0); // the fixture has one, and it never appears above
  });

  test("long-held uses last transfer ≥ 10y", async () => {
    const rows = await Q.findLongHeldProperties(db, {});
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.years_since_transfer).toBeGreaterThanOrEqual(10);
  });

  test("out_of_state scope excludes in_state_out_of_county", async () => {
    const st = await Q.findOutOfAreaOwners(db, { scope: "out_of_state" });
    const co = await Q.findOutOfAreaOwners(db, { scope: "out_of_county" });
    for (const r of st) expect(["out_of_state", "foreign"]).toContain(r.owner_location_class);
    expect(co.length).toBeGreaterThanOrEqual(st.length);
    expect(co.some((r) => r.owner_location_class === "in_state_out_of_county")).toBe(true);
  });

  test("findByOccupancy filters likely_tenant_occupied within the radius", async () => {
    const rows = await Q.findByOccupancy(db, {
      center: FTL,
      radiusMiles: 5,
      occupancy: ["likely_tenant_occupied"],
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.occupancy_class).toBe("likely_tenant_occupied");
      expect(r.distance_miles).toBeLessThanOrEqual(5);
      expect(r.occupancy_basis).toBeTruthy();
    }
  });

  test("invalid input (negative radius) is rejected by the contract schema", async () => {
    await expect(Q.findAgedRoofs(db, { center: FTL, radiusMiles: -1 })).rejects.toThrow();
  });
});

describe("entities, search and dataset info (fixture)", () => {
  test("getProperty returns owner, sales, tax, permits and Lexicon entity CIDs", async () => {
    const [p] = await Q.findAgedRoofs(db, { center: FTL, radiusMiles: 10, minRoofAgeYears: 0, limit: 1 });
    const d = await Q.getProperty(db, p.parcel_identifier);
    expect(d).not.toBeNull();
    C.PropertyDetail.parse(d);
    expect(d!.entities.map((e) => e.class)).toContain("property");
    expect(d!.appraiser_url).toContain(p.parcel_identifier);
    expect(await Q.getProperty(db, "000000000000")).toBeNull();
  });

  test("getContractor returns licenses, BBB fields and open-permit count", async () => {
    const [c] = await Q.listContractors(db, {});
    expect(c).toBeTruthy();
    const d = await Q.getContractor(db, c.dbpr_license_id);
    C.ContractorDetail.parse(d);
    expect(d!.contractor.license_class).toBeTruthy();
    expect(d!.open_permit_count).toBe(d!.permits.filter((p) => p.status === "open").length);
    expect(d!.bbb.note).toMatch(/BBB/);
  });

  test("semantic search finds 'reroof' permits for the query 'replace roof shingles'", async () => {
    const hits = await Q.searchRecords(
      db,
      { text: "replace roof shingles", mode: "semantic", limit: 5 },
      { embedder: fakeEmbedder },
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].kind).toBe("permit");
    expect(hits[0].text.toLowerCase()).toMatch(/roof/);
    for (const h of hits) C.SearchHit.parse(h);
  });

  test("text search uses the BM25 index; hybrid merges both lists", async () => {
    const t = await Q.searchRecords(db, { text: "roof", mode: "text", limit: 5 });
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((h) => h.match.includes("text"))).toBe(true);
    const h = await Q.searchRecords(db, { text: "roof", limit: 5 }, { embedder: fakeEmbedder });
    expect(h.some((x) => x.match.length === 2)).toBe(true);
  });

  test("an index opened with --index reports published:false and manifestCid null", async () => {
    const info = await Q.datasetInfo(db);
    C.DatasetInfo.parse(info);
    expect(info.published).toBe(false);
    expect(info.manifestCid).toBeNull();
    expect(info.limitations[0]).toMatch(/UNPUBLISHED/);
    expect(info.counts.v_property).toBe(50);
  });

  test("read-only SQL through the snapshot caps rows and rejects DDL", async () => {
    const r = await Q.readOnlySql(db, "select * from v_property", 3);
    expect(r.rows).toHaveLength(3);
    expect(r.truncated).toBe(true);
    await expect(Q.readOnlySql(db, "drop table mv_property")).rejects.toThrow();
  });
});

describe("resolvePlace", () => {
  test("resolvePlace('Fort Lauderdale') ≈ {26.12,-80.14}; unknown → null", () => {
    const p = resolvePlace("Fort Lauderdale")!;
    expect(p.lat).toBeCloseTo(26.14, 1);
    expect(p.lon).toBeCloseTo(-80.15, 1);
    expect(resolvePlace("Ft. Lauderdale, FL")?.name).toBe("FORT LAUDERDALE");
    expect(resolvePlace("Aventura")).toBeNull(); // Miami-Dade
    expect(resolvePlace("Springfield")).toBeNull();
    expect(resolvePlace("Broward County")?.basis).toBe("county");
  });
});

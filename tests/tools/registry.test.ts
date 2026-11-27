import { afterAll, beforeAll, expect, test } from "vitest";
import type { SnapshotDb } from "../../src/query/db.ts";
import { callTool, ORACLE_TOOLS } from "../../src/tools/registry.ts";
import { fixtureIndex } from "../helpers/fixture-index.ts";

let db: SnapshotDb;
beforeAll(async () => {
  ({ db } = await fixtureIndex());
}, 120_000);
afterAll(async () => db?.close());

test("registry holds the thirteen plan tools with unique names", () => {
  expect(ORACLE_TOOLS.map((t) => t.name).sort()).toEqual(
    [
      "dataset_info",
      "find_aged_roofs",
      "find_by_occupancy",
      "find_long_held_properties",
      "find_open_roof_permits",
      "find_out_of_area_owners",
      "get_business",
      "get_contractor",
      "get_permit",
      "get_property",
      "resolve_place",
      "run_read_only_sql",
      "search_records",
    ].sort(),
  );
});

test("find_aged_roofs returns rows with provenance, property_cid and manifest_cid plus a total", async () => {
  const out: any = await callTool(db, "find_aged_roofs", { lat: 26.122, lon: -80.137, radiusMiles: 5 });
  expect(out.total_matching).toBeGreaterThanOrEqual(out.count);
  expect(out.rows.length).toBeGreaterThan(0);
  for (const r of out.rows) {
    expect(r.property_cid).toBeTruthy();
    expect(r).toHaveProperty("manifest_cid", null);
    expect(r.provenance.length).toBeGreaterThan(0);
  }
  expect(out.notes.join(" ")).toMatch(/UNPUBLISHED/);
});

test("resolve_place says found:false instead of inventing coordinates", async () => {
  const out: any = await callTool(db, "resolve_place", { name: "Orlando" });
  expect(out.found).toBe(false);
  expect(out.place).toBeNull();
});

test("bad input is rejected by the tool schema", async () => {
  await expect(callTool(db, "find_aged_roofs", { lat: 26, lon: -80, radiusMiles: -1 })).rejects.toThrow();
  await expect(callTool(db, "run_read_only_sql", { sql: "drop table mv_property" })).rejects.toThrow(
    /SELECT/,
  );
});

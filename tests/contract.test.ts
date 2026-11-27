import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { AgedRoofsQuery, ContractorRow, PropertyRow, RoofPermitRow } from "../src/contract/index.ts";
import { ROOFING_VIEW_COLUMNS } from "../src/views/roofing-views.ts";

test("contract schemas cover exactly the roofing view columns", () => {
  expect(Object.keys(PropertyRow.shape).sort()).toEqual([...ROOFING_VIEW_COLUMNS.v_property].sort());
  expect(Object.keys(RoofPermitRow.shape).sort()).toEqual([...ROOFING_VIEW_COLUMNS.v_roof_permit].sort());
  expect(Object.keys(ContractorRow.shape).sort()).toEqual([...ROOFING_VIEW_COLUMNS.v_contractor].sort());
});

test("query defaults: roof age 15, radius validated", () => {
  expect(AgedRoofsQuery.parse({ center: { lat: 26.12, lon: -80.14 }, radiusMiles: 5 }).minRoofAgeYears).toBe(
    15,
  );
  expect(AgedRoofsQuery.safeParse({ center: { lat: 26.12, lon: -80.14 }, radiusMiles: -1 }).success).toBe(
    false,
  );
});

test("contract export imports without loading DuckDB", async () => {
  const src = await readFile(new URL("../src/contract/index.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  expect(code).not.toMatch(/duckdb/i);
  expect(src.match(/^import .* from "(.*)";$/gm)).toEqual(['import { z } from "zod";']);
});

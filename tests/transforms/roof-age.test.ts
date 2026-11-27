import { expect, test } from "vitest";
import { computeRoofAge, type RoofPermitInput } from "../../src/transforms/roof-age.ts";

const base: Omit<RoofPermitInput, "permitKey" | "status" | "roofWorkClass" | "completionDate"> = {
  sourceSystem: "broward_ftl_arcgis_permits",
  isRoofing: true,
  closeDate: null,
  issueDate: null,
  applicationDate: null,
};

test("completed primary replacement sets roof_date from the final date", () => {
  const r = computeRoofAge({
    parcelId: "p",
    builtYear: 1990,
    asOf: "2026-11-25",
    historicalCoverage: "partial",
    permits: [
      {
        ...base,
        permitKey: "a",
        status: "completed",
        roofWorkClass: "primary_roof_replacement",
        completionDate: "2009-05-10",
      },
    ],
  });
  expect([r.roofDate, r.roofAgeYears, r.basis]).toEqual(["2009-05-10", 17, "permit"]);
});

test("repair/coating never resets roof age", () => {
  const r = computeRoofAge({
    parcelId: "p",
    builtYear: 1990,
    asOf: "2026-11-25",
    historicalCoverage: "partial",
    permits: [
      {
        ...base,
        permitKey: "a",
        status: "completed",
        roofWorkClass: "repair_or_coating",
        completionDate: "2020-05-10",
      },
    ],
  });
  expect([r.roofAgeYears, r.basis]).toEqual([36, "year_built"]);
});

test("built-year default writes a year-precision roof_date, never Jan 1", () => {
  const r = computeRoofAge({
    parcelId: "p",
    builtYear: 2001,
    asOf: "2026-11-25",
    historicalCoverage: "unavailable",
    permits: [],
  });
  expect(r.roofDate).toBe("2001");
  expect(r.lineage.roofDatePrecision).toBe("year");
});

test("open replacement permit does not reset roof age", () => {
  const r = computeRoofAge({
    parcelId: "p",
    builtYear: 1980,
    asOf: "2026-11-25",
    historicalCoverage: "partial",
    permits: [
      {
        ...base,
        permitKey: "a",
        status: "open",
        roofWorkClass: "primary_roof_replacement",
        completionDate: null,
        issueDate: "2019-01-01",
      },
    ],
  });
  expect(r.basis).toBe("year_built");
});

test("no evidence → roof fields absent", () => {
  const r = computeRoofAge({
    parcelId: "p",
    builtYear: null,
    asOf: "2026-11-25",
    historicalCoverage: "unavailable",
    permits: [],
  });
  expect([r.roofDate, r.roofAgeYears, r.basis]).toEqual([null, null, "unknown"]);
});

import { expect, test } from "vitest";
import { compactForModel, MODEL_ROW_LIMIT } from "../../src/agent/ai-tools.ts";

const row = (i: number) => ({
  permit_number: `R-${i}`,
  open_years: 6.1,
  contractor_name: null,
  source_url: "https://gis.example/permit",
  provenance: [{ source_url: "https://gis.example/permit" }],
  property_cid: "baguqeeraexample",
  manifest_cid: "bafkreiexample",
});

test("compact: rows lose provenance, URLs, ids and nulls; the run's manifest stays once", () => {
  expect(compactForModel({ manifest_cid: "bafkreiexample", total_matching: 1, rows: [row(1)] })).toEqual({
    manifest_cid: "bafkreiexample",
    total_matching: 1,
    rows: [{ permit_number: "R-1", open_years: 6.1 }],
  });
});

test("compact: caps the rows the model reads, keeps the totals, says so", () => {
  const out = compactForModel({
    total_matching: 174,
    rows: Array.from({ length: 174 }, (_, i) => row(i)),
  }) as any;
  expect(out.rows).toHaveLength(MODEL_ROW_LIMIT);
  expect(out.total_matching).toBe(174);
  expect(out.rows_note).toMatch(/Showing 40 of the 174 rows/);
});

import { expect, test } from "vitest";
import {
  areaString,
  situsAddress,
  toCountyOutput,
  type StagedParcel,
} from "../../src/transforms/county/map-parcel.ts";
import { splitPersonName } from "../../src/transforms/property-improvement/index.ts";

const parcel: StagedParcel = {
  parcel_id: "504201080220",
  land_use_code: "01",
  homestead: false,
  situs_number: "23",
  situs_dir: null,
  situs_street: "PELICAN",
  situs_type: "DR",
  situs_post_dir: null,
  situs_unit: null,
  situs_city: "FORT LAUDERDALE",
  situs_zip: "33301",
  legal_description: "PELICAN ISLE 21-19 B LOT 23",
  year_built: 1951,
  effective_year_built: 2000,
  building_sqft: 4069,
  units: 1,
  buildings: 1,
  lot_sqft: 13012,
  land_value: 1171080,
  building_value: 1597480,
  other_value: 0,
  assessed_value: 1034870,
  exemption_amount: 0,
  county_taxable: 984870,
  school_taxable: 1009870,
  city_taxable: 984870,
  lat: 26.1237,
  lon: -80.1129,
  geo_status: "parcel_centroid",
};
const ctx = { taxYear: 2025, roof: { roofDate: "1951", roofAgeYears: 75 }, publishCompanyOwners: true };

test("year built maps to property; roof age to the structure entity; values to tax", () => {
  const out = toCountyOutput(parcel, { ...ctx, sales: [] });
  const by = Object.fromEntries(out.entities.map((x) => [x.file, x]));
  expect(by["property.json"].data).toMatchObject({
    parcel_identifier: "504201080220",
    property_type: "SingleFamily",
    property_structure_built_year: 1951,
  });
  expect(by["structure.json"].data).toMatchObject({ roof_date: "1951", roof_age_years: 75 });
  expect(by["tax_2025.json"].data).toMatchObject({ tax_year: 2025, property_market_value_amount: 2768560 });
  expect(by["geometry.json"].data).toEqual({ latitude: 26.1237, longitude: -80.1129 });
});

test("real-data edge cases: roof replaced this year (age 0) and single-digit lot areas are not published", () => {
  const out = toCountyOutput(
    { ...parcel, lot_sqft: 5, building_sqft: 9 },
    { ...ctx, roof: { roofDate: "2026-03-01", roofAgeYears: 0 }, sales: [] },
  );
  const by = Object.fromEntries(out.entities.map((x) => [x.file, x]));
  expect(by["structure.json"].data).toMatchObject({ roof_date: "2026-03-01", roof_age_years: null });
  expect(by["property.json"].data).not.toHaveProperty("total_area");
  expect(by["property.json"].data).not.toHaveProperty("livable_floor_area");
  expect(areaString(13012)).toBe("13012");
  expect(areaString(10)).toBe("10");
  expect(areaString(0)).toBeNull();
});

test("every entity carries the decided source_http_request (per-folio BCPA roll query)", () => {
  const out = toCountyOutput(parcel, { ...ctx, sales: [] });
  for (const x of out.entities) {
    expect(x.sourceHttpRequest.url).toMatch(/PARCEL_POLY_BCPA_TAXROLL\/FeatureServer\/0\/query$/);
    expect(x.sourceHttpRequest.multiValueQueryString?.where).toEqual(["FOLIO='504201080220'"]);
  }
});

test("sales become sales_history entities; a company owner links to the latest sale", () => {
  const out = toCountyOutput(parcel, {
    ...ctx,
    sales: [
      { sale_date: "2020-01-02", deed_type: "WD", price: 500000, qual_code: "01" },
      { sale_date: "1999-05-05", deed_type: "WD", price: null, qual_code: "11" },
    ],
    owner: {
      name_1: "PELICAN HOLDINGS LLC",
      name_2: null,
      mail_line_1: "1 MAIN ST",
      mail_line_2: null,
      mail_city: "MIAMI",
      mail_state: "FL",
      mail_zip: "33131",
    },
  });
  const files = out.entities.map((x) => x.file);
  expect(files).toEqual(
    expect.arrayContaining([
      "sales_history_1.json",
      "sales_history_2.json",
      "company_owner.json",
      "address_owner_mailing.json",
    ]),
  );
  expect(out.relationships.find((r) => r.key === "sales_history_has_company")?.from).toBe(
    "sales_history_2.json",
  );
  expect(out.entities.find((x) => x.file === "sales_history_2.json")?.data).toMatchObject({
    ownership_transfer_date: "2020-01-02",
    purchase_price_amount: 500000,
    sale_type: "TypicallyMotivated",
  });
});

test("individual owners are never published", () => {
  const out = toCountyOutput(parcel, {
    ...ctx,
    sales: [{ sale_date: "2020-01-02", deed_type: "WD", price: null, qual_code: null }],
    owner: {
      name_1: "SMITH JOHN & MARY",
      name_2: null,
      mail_line_1: "1 MAIN ST",
      mail_line_2: null,
      mail_city: "X",
      mail_state: "FL",
      mail_zip: "33301",
    },
  });
  expect(out.entities.some((x) => x.className === "person" || x.file === "company_owner.json")).toBe(false);
  expect(JSON.stringify(out)).not.toContain("SMITH");
});

test("parcel without usable geometry has no geometry entity", () => {
  const out = toCountyOutput(
    { ...parcel, geo_status: "missing_geometry", lat: null, lon: null },
    { ...ctx, sales: [] },
  );
  expect(out.entities.some((x) => x.file === "geometry.json")).toBe(false);
});

test("situs address and DBPR name parsing", () => {
  expect(situsAddress(parcel)).toBe("23 PELICAN DR, FORT LAUDERDALE, FL 33301");
  expect(splitPersonName("ADDERLY, TODD R")).toEqual({ last: "ADDERLY", first: "TODD", middle: "R" });
  expect(splitPersonName("ACME ROOFING")).toBeNull();
});

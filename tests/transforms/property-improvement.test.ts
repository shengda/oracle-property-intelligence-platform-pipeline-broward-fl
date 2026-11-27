import { expect, test } from "vitest";
import { propertyOutputFiles } from "../../src/lexicon/output-writer.ts";
import type { StagedParcel } from "../../src/transforms/county/map-parcel.ts";
import {
  toPropertyImprovementOutput,
  type DrvPermit,
} from "../../src/transforms/property-improvement/index.ts";

const parcel = {
  parcel_id: "473725000010",
  situs_number: "3400",
  situs_dir: "W",
  situs_street: "COMMERCIAL",
  situs_type: "BLVD",
  situs_post_dir: null,
  situs_unit: null,
  situs_city: "FORT LAUDERDALE",
  situs_zip: "33309",
  land_use_code: "11",
  year_built: 1980,
} as unknown as StagedParcel;

const permit: DrvPermit = {
  permit_key: "ftl:R1",
  source_system: "ftl",
  parcel_id: "473725000010",
  permit_number: "R1",
  permit_type: "ROOF",
  permit_subtype: null,
  description: "REROOF",
  raw_status: "ISSUED",
  lexicon_status: "Permitted",
  is_roofing: true,
  roof_work_class: "replacement" as never,
  application_date: null,
  issue_date: "2018-01-02",
  completion_date_resolved: null,
  close_date: null,
  final_date: null,
  est_value: null,
  request_json: JSON.stringify({ method: "GET", url: "https://gis.example/query" }),
  license_id: null,
  class_code: null,
  licensee_name: null,
  dba_name: null,
};

const REQ = JSON.stringify({
  method: "GET",
  multiValueQueryString: { where: ["OBJECTID>=1161838 AND OBJECTID<1163838"] },
  url: "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query",
});

const seed = {
  property_cid: "baguqeera3yomr7tbozeupk2ongl4kjdhb2vn3rtbmsak3tqy6gkcm2ynveia",
  parcel_row: {
    parcel_identifier: "473725000010",
    request_identifier: "473725000010",
    source_http_request: REQ,
    cid: "x",
    property_cid: "y",
    data_group_cid: "z",
  },
  address_row: {
    unnormalized_address: "EVERGLADES, UNINCORPORATED, FL 33327",
    city_name: "UNINCORPORATED",
    county_name: "Broward",
    street_name: null,
    request_identifier: "473725000010",
    source_http_request: REQ,
    cid: "x",
  },
};

const ctx = {
  seedCid: "bafkreibhurphpjdq33ysit57jtzmdldgngepsdbsw4vm7esawth2ezgaxu",
  groupCid: "bafkreicyzywzwhmguojpi2otgrwsyi37le3u4lnavljbxu76cnrudxaxfu",
  cardinality: {
    property_has_property_improvement: "many",
    property_improvement_has_contractor: "many",
    contractor_has_person: "many",
  } as Record<string, "one" | "many">,
};

test("with a published Seed, parcel.json and address.json are the published entities (no nulls, same request)", () => {
  const files = Object.fromEntries(
    propertyOutputFiles(toPropertyImprovementOutput(parcel, [permit], seed), ctx).map((f) => [
      f.name,
      JSON.parse(f.data),
    ]),
  );
  expect(files["parcel.json"]).toEqual({
    parcel_identifier: "473725000010",
    request_identifier: "473725000010",
    source_http_request: JSON.parse(REQ),
  });
  expect(files["address.json"]).toEqual({
    unnormalized_address: "EVERGLADES, UNINCORPORATED, FL 33327",
    city_name: "UNINCORPORATED",
    county_name: "Broward",
    request_identifier: "473725000010",
    source_http_request: JSON.parse(REQ),
  });
  // The permits and the property entity are unchanged by the Seed choice.
  expect(files["property_improvement_1.json"].permit_number).toBe("R1");
  expect(files["property.json"].request_identifier).toBe("473725000010");
});

test("without a published Seed the property gets our own roll Seed; a Seed for another parcel is refused", () => {
  const own = toPropertyImprovementOutput(parcel, [permit]);
  expect(own.entities.find((e) => e.file === "address.json")!.data.unnormalized_address).toContain(
    "COMMERCIAL",
  );
  expect(() =>
    toPropertyImprovementOutput(parcel, [permit], {
      ...seed,
      parcel_row: { ...seed.parcel_row, parcel_identifier: "999999999999" },
    }),
  ).toThrow(/published Seed for 473725000010 is parcel 999999999999/);
});

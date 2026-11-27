import path from "node:path";
import type { SourceRunResult } from "../types.ts";
import { newStats } from "../util/http.ts";
import type { WorkDb } from "../work-db.ts";
import { downloadArcgisLayer } from "./arcgis.ts";
import { BCPA_TAXROLL_FULL_LAYER, BCPA_TAXROLL_LAYER } from "./registry.ts";
import { fetchJson } from "../util/http.ts";

/** Columns requested from the BCPA tax roll layer (owner columns are staged, never published raw). */
export const BCPA_FIELDS = [
  "OBJECTID_12",
  "FOLIO",
  "PARCEL_TYP",
  "NAME_LINE_1",
  "NAME_LINE_2",
  "ADDRESS_LINE_1",
  "ADDRESS_LINE_2",
  "CITY",
  "STATE",
  "ZIP",
  "LEGAL_LINE_1",
  "LEGAL_LINE_2",
  "LEGAL_LINE_3",
  "USE_CODE",
  "USE_TYPE",
  "MILLAGE_CODE",
  "JUST_LAND_VALUE",
  "JUST_BUILDING_VALUE",
  "JUST_OTHER_VALUE",
  "NEW_SOH_VALUE",
  "EXEMPTION_AMOUNT",
  "COUNTY_TAXABLE",
  "SCHOOL_TAXABLE",
  "CITY_TAXABLE",
  "HOMESTEAD_FLAG",
  "HE1_AMOUNT",
  "HE2_AMOUNT",
  "EXEMPTION_TYPE",
  "OWNERS_DOMICILE",
  "LAST_PHYSICAL_INSPECTION",
  ...[1, 2, 3, 4, 5].flatMap((i) => [
    `SALE_DATE_${i}`,
    `DEED_TYPE_${i}`,
    `STAMP_AMOUNT_${i}`,
    `SALE${i}_QUAL_CODE`,
  ]),
  "SITUS_STREET_NUMBER",
  "SITUS_STREET_DIRECTION",
  "SITUS_STREET_NAME",
  "SITUS_STREET_TYPE",
  "SITUS_STREET_POST_DIR",
  "SITUS_UNIT_NUMBER",
  "SITUS_CITY",
  "SITUS_ZIP_CODE",
  "BLDG_ADJ_SQ_FOOTAGE",
  "BLDG_TOT_SQ_FOOTAGE",
  "BLDG_UNITS",
  "BLDG_YEAR_BUILT",
  "ACTUAL_YEAR_BUILT",
  "BLDG_NUM_OF",
  "GIS_SQUARE_FOOT",
  "BEDS",
  "BATHS",
  "MUNICIPALITY",
];

/** BCPA two-letter situs city codes → municipality names (verified against Cities_Multipart). */
export const BCPA_CITY_CODES: Record<string, string> = {
  FL: "FORT LAUDERDALE",
  HW: "HOLLYWOOD",
  PI: "PEMBROKE PINES",
  MM: "MIRAMAR",
  CS: "CORAL SPRINGS",
  DV: "DAVIE",
  PB: "POMPANO BEACH",
  PL: "PLANTATION",
  SU: "SUNRISE",
  DB: "DEERFIELD BEACH",
  TM: "TAMARAC",
  WS: "WESTON",
  MG: "MARGATE",
  OP: "OAKLAND PARK",
  LH: "LAUDERHILL",
  PA: "PARKLAND",
  CY: "COOPER CITY",
  CK: "COCONUT CREEK",
  DN: "DANIA BEACH",
  NL: "NORTH LAUDERDALE",
  HA: "HALLANDALE BEACH",
  LL: "LAUDERDALE LAKES",
  BC: "UNINCORPORATED",
  WP: "WEST PARK",
  LP: "LIGHTHOUSE POINT",
  WM: "WILTON MANORS",
  SW: "SOUTHWEST RANCHES",
  LS: "LAUDERDALE BY THE SEA",
  PK: "PEMBROKE PARK",
  HB: "HILLSBORO BEACH",
  SL: "SEA RANCH LAKES",
  LZ: "LAZY LAKE",
};

export const ROLL_LAYERS = {
  "bcpa-taxroll": { url: BCPA_TAXROLL_LAYER, oid: "OBJECTID_12", priority: 1 },
  "bcpa-taxroll-full": { url: BCPA_TAXROLL_FULL_LAYER, oid: "OBJECTID_1", priority: 2 },
} as const;
export type RollKey = keyof typeof ROLL_LAYERS;

export async function downloadBcpaTaxroll(opts: {
  rawDir: string;
  retrievedAt: string;
  key?: RollKey;
  log?: (msg: string) => void;
}): Promise<SourceRunResult & { rawPath: string; fields: string[] }> {
  const key = opts.key ?? "bcpa-taxroll";
  const layer = ROLL_LAYERS[key];
  const startedAt = new Date().toISOString();
  const stats = newStats();
  const meta = await fetchJson<{ fields: { name: string }[] }>(`${layer.url}?f=json`, { stats });
  const available = new Set(meta.fields.map((f) => f.name));
  const fields = BCPA_FIELDS.filter((f) => available.has(f) && f !== "OBJECTID_12");
  const rawPath = path.join(opts.rawDir, key, opts.retrievedAt.replace(/[:.]/g, "-"), "features.ndjson.gz");
  const res = await downloadArcgisLayer({
    layerUrl: layer.url,
    oidField: layer.oid,
    outFields: fields,
    pageSize: 2000,
    returnCentroid: true,
    outPath: rawPath,
    minDelayMs: 250,
    stats,
    onPage: (n) => {
      if (n % 50_000 < 2000) opts.log?.(`${key}: ${n} records`);
    },
  });
  return {
    key,
    status: "loaded",
    records: res.records,
    startedAt,
    finishedAt: new Date().toISOString(),
    requests: stats.requests,
    avgLatencyMs: stats.requests ? Math.round(stats.totalMs / stats.requests) : undefined,
    bytes: stats.bytes,
    sha256: res.sha256,
    rawPath,
    fields,
  };
}

/**
 * Stage one roll layer's NDJSON into `stg_bcpa_raw_<key>` (attributes flattened, every field as
 * VARCHAR; fields the layer lacks are NULL), then rebuild `stg_bcpa_raw` as the union of the
 * staged layers tagged with `roll_source`.
 */
export async function stageBcpaTaxroll(
  db: WorkDb,
  rawPath: string,
  retrievedAt: string,
  key: RollKey = "bcpa-taxroll",
): Promise<number> {
  const layer = ROLL_LAYERS[key];
  const cols = BCPA_FIELDS.filter((f) => f !== "OBJECTID_12")
    .map((f) => `json_extract_string(attributes, '$.${f}') as "${f}"`)
    .join(",\n  ");
  const table = `stg_bcpa_raw_${key.replace(/-/g, "_")}`;
  await db.run(`create or replace table ${table} as
select json_extract_string(attributes, '$.${layer.oid}') as "OBJECTID_12", ${cols},
  centroid.y::DOUBLE as centroid_lat, centroid.x::DOUBLE as centroid_lon,
  '${retrievedAt}' as retrieved_at, '${key}' as roll_source, ${layer.priority} as roll_priority
from read_json('${rawPath}', format='newline_delimited', maximum_object_size=10000000,
  columns={attributes: 'JSON', centroid: 'STRUCT(x DOUBLE, y DOUBLE)'})`);
  const staged = await db.all<{ table_name: string }>(
    "select table_name from information_schema.tables where table_name like 'stg_bcpa_raw_%' order by table_name",
  );
  await db.run(
    `create or replace table stg_bcpa_raw as ${staged.map((t) => `select * from ${t.table_name}`).join(" union all by name ")}`,
  );
  const row = await db.one<{ n: number }>(`select count(*)::INTEGER as n from ${table}`);
  return row?.n ?? 0;
}

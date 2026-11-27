import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { COUNTY } from "../config.ts";
import type { SourceRunResult } from "../types.ts";
import { newStats, politeFetch } from "../util/http.ts";
import type { WorkDb } from "../work-db.ts";
import {
  CENSUS_COUNTY_BOUNDARY_URL,
  CENSUS_PLACES_GAZETTEER_URL,
  CENSUS_ZCTA_COUNTY_URL,
} from "./registry.ts";

async function download(url: string, dir: string, name: string) {
  const stats = newStats();
  const started = new Date().toISOString();
  const res = await politeFetch(url, { stats, timeoutMs: 600_000, minDelayMs: 0 });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} at ${url}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, res.body);
  return { file, started, stats, sha256: createHash("sha256").update(res.body).digest("hex") };
}

function result(key: string, d: Awaited<ReturnType<typeof download>>, records: number): SourceRunResult {
  return {
    key,
    status: "loaded",
    records,
    startedAt: d.started,
    finishedAt: new Date().toISOString(),
    requests: d.stats.requests,
    avgLatencyMs: d.stats.requests ? Math.round(d.stats.totalMs / d.stats.requests) : undefined,
    bytes: d.stats.bytes,
    sha256: d.sha256,
    rawPath: d.file,
  };
}

/** Census Gazetteer places (FL) → `ref_places` (name, lat, lon) inside the Broward bbox. */
export async function loadCensusPlaces(
  db: WorkDb,
  opts: { rawDir: string; retrievedAt: string },
): Promise<SourceRunResult> {
  const d = await download(
    CENSUS_PLACES_GAZETTEER_URL,
    path.join(opts.rawDir, "census-places", opts.retrievedAt.replace(/[:.]/g, "-")),
    "gaz_place_12.txt",
  );
  const b = COUNTY.bbox;
  await db.run(`create or replace table ref_places as
select upper(regexp_replace(trim(NAME), ' (city|town|village|CDP)$', '')) as name, trim(NAME) as census_name,
  GEOID::VARCHAR as geoid, INTPTLAT::DOUBLE as lat, trim(INTPTLONG::VARCHAR)::DOUBLE as lon
from read_csv('${d.file}', delim='\t', header=true, all_varchar=true)
where INTPTLAT::DOUBLE between ${b.minLat} and ${b.maxLat} and trim(INTPTLONG::VARCHAR)::DOUBLE between ${b.minLon} and ${b.maxLon}`);
  const n = await db.one<{ n: number }>("select count(*)::INTEGER n from ref_places");
  return result("census-places", d, n?.n ?? 0);
}

/** Census 2020 ZCTA–county relationship → `ref_broward_zips`. */
export async function loadCensusZcta(
  db: WorkDb,
  opts: { rawDir: string; retrievedAt: string },
): Promise<SourceRunResult> {
  const d = await download(
    CENSUS_ZCTA_COUNTY_URL,
    path.join(opts.rawDir, "census-zcta-county", opts.retrievedAt.replace(/[:.]/g, "-")),
    "tab20_zcta520_county20_natl.txt",
  );
  await db.run(`create or replace table ref_broward_zips as
select distinct GEOID_ZCTA5_20 as zip from read_csv('${d.file}', delim='|', header=true, all_varchar=true)
where GEOID_COUNTY_20 = '${COUNTY.fips}' and GEOID_ZCTA5_20 is not null and GEOID_ZCTA5_20 <> ''`);
  const n = await db.one<{ n: number }>("select count(*)::INTEGER n from ref_broward_zips");
  return result("census-zcta-county", d, n?.n ?? 0);
}

/** Census cartographic county boundary → `ref_county_boundary` (WKT polygon of Broward). */
export async function loadCountyBoundary(
  db: WorkDb,
  opts: { rawDir: string; retrievedAt: string },
): Promise<SourceRunResult> {
  const d = await download(
    CENSUS_COUNTY_BOUNDARY_URL,
    path.join(opts.rawDir, "census-county-boundary", opts.retrievedAt.replace(/[:.]/g, "-")),
    "cb_2024_us_county_500k.zip",
  );
  await db.run("install spatial; load spatial;");
  await db.run(`create or replace table ref_county_boundary as
select GEOID as geoid, NAME as name, ST_AsText(geom) as wkt
from ST_Read('/vsizip/${d.file}/cb_2024_us_county_500k.shp') where GEOID = '${COUNTY.fips}'`);
  const n = await db.one<{ n: number }>("select count(*)::INTEGER n from ref_county_boundary");
  if ((n?.n ?? 0) !== 1) throw new Error("Broward boundary not found in the Census county file");
  return result("census-county-boundary", d, 1);
}

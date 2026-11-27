import { COUNTY } from "../config.ts";
import {
  classifyOccupancy,
  classifyOwnerLocation,
  classifyOwnerType,
  setBrowardZips,
} from "../classify/owners.ts";
import { computeOpenDays, lexiconImprovementStatus } from "../classify/permits.ts";
import { computeRoofAge, type RoofPermitInput } from "../transforms/roof-age.ts";
import type { PermitStatus, RoofWorkClass } from "../types.ts";
import type { WorkDb } from "../work-db.ts";

/** Jurisdictions whose permits are loaded (covered) — everything else is reported skipped/blocked. */
export const PERMIT_JURISDICTIONS: Record<string, { cities: string[]; sourceSystem: string }> = {
  "fort-lauderdale": { cities: ["FORT LAUDERDALE"], sourceSystem: "broward_ftl_arcgis_permits" },
  weston: { cities: ["WESTON"], sourceSystem: "broward_weston_accela_permits" },
  "unincorporated-broward": { cities: ["UNINCORPORATED"], sourceSystem: "broward_hced_posse_permits" },
};

/**
 * Derive the work-store tables the groups and the index are built from. Everything here is
 * internal; only Lexicon fields reach the groups, and derived classifier outputs reach the
 * supplementary query tables.
 */
export async function deriveAll(
  db: WorkDb,
  opts: { asOf: string; log?: (m: string) => void },
): Promise<void> {
  const log = opts.log ?? (() => {});
  await db.run("install spatial; load spatial;");

  // 1. Geometry status: centroid inside the TIGER county polygon.
  const hasBoundary = await db.one<{ n: number }>(
    "select count(*)::INTEGER n from information_schema.tables where table_name = 'ref_county_boundary'",
  );
  if (hasBoundary?.n) {
    await db.run(`create or replace table drv_geo as
with b as (select ST_GeomFromText(wkt) g from ref_county_boundary)
select p.parcel_id,
  case when p.lat is null or p.lon is null then 'missing_geometry'
       when ST_Contains(ST_Buffer(b.g, 0.002), ST_Point(p.lon, p.lat)) then 'parcel_centroid'
       else 'outside_county' end as geo_status
from stg_parcels p, b`);
  } else {
    const bb = COUNTY.bbox;
    await db.run(`create or replace table drv_geo as
select parcel_id, case when lat is null or lon is null then 'missing_geometry'
  when lat between ${bb.minLat} and ${bb.maxLat} and lon between ${bb.minLon} and ${bb.maxLon} then 'parcel_centroid'
  else 'outside_county' end as geo_status from stg_parcels`);
  }
  log("derive: geometry status");

  // 2. Permits: one row per permit key (Weston closed report wins over issued), matched to parcels.
  await db.run(`create or replace table drv_permits as
select * exclude (rn) from (
  select p.*, row_number() over (partition by p.permit_key
      order by case when p.close_date is not null then 0 else 1 end, p.source_key) rn
  from stg_permits p
) where rn = 1`);
  await matchPermitsByAddress(db, log);
  const permits = await db.all<any>(
    `select permit_key, raw_status, status, issue_date, application_date from drv_permits`,
  );
  const upd: Record<string, unknown>[] = permits.map((p) => ({
    permit_key: p.permit_key,
    open_days: computeOpenDays(
      { status: p.status as PermitStatus, issuedDate: p.issue_date ?? p.application_date },
      opts.asOf,
    ),
    lexicon_status: lexiconImprovementStatus(p.raw_status),
  }));
  await db.run(
    `create or replace table drv_permit_calc (permit_key VARCHAR, open_days INTEGER, lexicon_status VARCHAR)`,
  );
  await db.appendRows("drv_permit_calc", upd);
  await db.run(`create or replace table drv_permits as
select d.*, c.open_days, c.lexicon_status, (sp.parcel_id is not null) as parcel_matched,
  case when d.status = 'completed' then coalesce(d.final_date, d.close_date,
       case when d.source_system = 'broward_ftl_arcgis_permits' then d.last_update_date end) end as completion_date_resolved
from drv_permits d join drv_permit_calc c using (permit_key)
left join stg_parcels sp on sp.parcel_id = d.parcel_id`);
  log(`derive: ${permits.length} permits`);

  // 3. Contractors: Accela licensed professional (open FTL roofing permits) → DBPR record by license id.
  const hasAccela = await db.one<{ n: number }>(
    "select count(*)::INTEGER n from information_schema.tables where table_name = 'stg_ftl_accela'",
  );
  const hasDbpr = await db.one<{ n: number }>(
    "select count(*)::INTEGER n from information_schema.tables where table_name = 'stg_dbpr'",
  );
  if (hasAccela?.n && hasDbpr?.n) {
    await db.run(`create or replace table drv_contractor_links as
select p.permit_key, a.license_number, a.licensed_professional, a.project_description, a.record_status as accela_status,
  d.license_id, d.class_code, d.licensee_name, d.dba_name, d.city as license_city, d.state as license_state,
  d.zip as license_zip, d.primary_status, d.secondary_status, d.expiry_date, d.retrieved_at as dbpr_retrieved_at
from drv_permits p join stg_ftl_accela a on a.case_key = p.case_key
left join (select * from stg_dbpr qualify row_number() over (partition by license_id order by status_effective_date desc) = 1) d
  on upper(trim(d.license_id)) = upper(trim(a.license_number))
where a.license_number is not null`);
  } else {
    await db.run(`create or replace table drv_contractor_links (permit_key VARCHAR, license_number VARCHAR,
      licensed_professional VARCHAR, project_description VARCHAR, accela_status VARCHAR, license_id VARCHAR,
      class_code VARCHAR, licensee_name VARCHAR, dba_name VARCHAR, license_city VARCHAR, license_state VARCHAR,
      license_zip VARCHAR, primary_status VARCHAR, secondary_status VARCHAR, expiry_date VARCHAR, dbpr_retrieved_at VARCHAR)`);
  }
  log("derive: contractor links");

  // 4. Roof age per parcel (kit resolver) — permits only exist for covered jurisdictions.
  const coveredCities = Object.values(PERMIT_JURISDICTIONS).flatMap((j) => j.cities);
  const roofPermits =
    await db.all<any>(`select parcel_id, permit_key, source_system, status, roof_work_class, is_roofing,
      completion_date_resolved, close_date, issue_date, application_date
    from drv_permits where parcel_matched and is_roofing`);
  const byParcel = new Map<string, RoofPermitInput[]>();
  for (const r of roofPermits) {
    const list = byParcel.get(r.parcel_id) ?? [];
    list.push({
      sourceSystem: r.source_system,
      permitKey: r.permit_key,
      status: r.status as PermitStatus,
      roofWorkClass: r.roof_work_class as RoofWorkClass,
      isRoofing: Boolean(r.is_roofing),
      completionDate: r.completion_date_resolved,
      closeDate: r.close_date,
      issueDate: r.issue_date,
      applicationDate: r.application_date,
    });
    byParcel.set(r.parcel_id, list);
  }
  const parcels = await db.all<{ parcel_id: string; year_built: number | null; situs_city: string | null }>(
    "select parcel_id, year_built, situs_city from stg_parcels",
  );
  const roofRows: Record<string, unknown>[] = [];
  for (const p of parcels) {
    const res = computeRoofAge({
      parcelId: p.parcel_id,
      builtYear: p.year_built,
      permits: byParcel.get(p.parcel_id) ?? [],
      asOf: opts.asOf,
      historicalCoverage: coveredCities.includes(p.situs_city ?? "") ? "partial" : "unavailable",
    });
    roofRows.push({
      parcel_id: p.parcel_id,
      roof_date: res.roofDate,
      roof_age_years: res.roofAgeYears,
      roof_age_basis: res.basis,
      roof_age_confidence: res.lineage.confidence,
      roof_age_permit_key: res.lineage.selectedPermit?.sourceRecordId ?? null,
      roof_age_policy: `${res.lineage.policy.version}/${res.lineage.policy.profileVersion}`,
    });
  }
  await db.run(`create or replace table drv_roof_age (parcel_id VARCHAR, roof_date VARCHAR, roof_age_years INTEGER,
    roof_age_basis VARCHAR, roof_age_confidence VARCHAR, roof_age_permit_key VARCHAR, roof_age_policy VARCHAR)`);
  await db.appendRows("drv_roof_age", roofRows);
  log(`derive: roof age for ${roofRows.length} parcels`);

  // 5. Owner type / location / occupancy (derived only; names never leave the work store).
  const zips = await db
    .all<{ zip: string }>(
      "select zip from ref_broward_zips where exists (select 1 from information_schema.tables where table_name='ref_broward_zips')",
    )
    .catch(() => []);
  if (zips.length) setBrowardZips(zips.map((z) => z.zip));
  const owners =
    await db.all<any>(`select p.parcel_id, p.land_use_code, p.homestead, o.name_1, o.mail_state, o.mail_zip,
      o.mail_city, o.mail_line_2, s.last_sale_date
    from stg_parcels p left join stg_owner_raw o using (parcel_id)
    left join (select parcel_id, max(sale_date) as last_sale_date from stg_sales group by 1) s using (parcel_id)`);
  const sig: Record<string, unknown>[] = owners.map((o) => {
    const ownerType = classifyOwnerType(o.name_1);
    const foreign =
      !o.mail_state && o.mail_line_2 && !/\b[A-Z]{2}\s*\d{5}/.test(o.mail_line_2) ? "FOREIGN" : null;
    return {
      parcel_id: o.parcel_id,
      owner_type: ownerType,
      owner_location_class: classifyOwnerLocation({ state: o.mail_state, zip: o.mail_zip, country: foreign }),
      owner_mail_city: o.mail_city ?? null,
      owner_mail_state: o.mail_state ?? null,
      owner_mail_zip5: (o.mail_zip ?? "").slice(0, 5) || null,
      occupancy_class: classifyOccupancy({ landUseCode: o.land_use_code, homestead: o.homestead, ownerType }),
      occupancy_basis: `land_use=${o.land_use_code ?? "null"};homestead=${o.homestead ?? "null"};owner_type=${ownerType}`,
      last_sale_date: o.last_sale_date ?? null,
    };
  });
  await db.run(`create or replace table drv_property_signals (parcel_id VARCHAR, owner_type VARCHAR,
    owner_location_class VARCHAR, owner_mail_city VARCHAR, owner_mail_state VARCHAR, owner_mail_zip5 VARCHAR,
    occupancy_class VARCHAR, occupancy_basis VARCHAR, last_sale_date VARCHAR)`);
  await db.appendRows("drv_property_signals", sig);
  log(`derive: owner/occupancy signals for ${sig.length} parcels`);
}

/** Street-suffix and direction spellings seen in permit text → the roll's spelling. */
const ADDRESS_TOKENS: Record<string, string> = {
  AV: "AVE",
  AVENUE: "AVE",
  WY: "WAY",
  TERR: "TER",
  TERRACE: "TER",
  STREET: "ST",
  COURT: "CT",
  DRIVE: "DR",
  ROAD: "RD",
  BOULEVARD: "BLVD",
  BL: "BLVD",
  PLACE: "PL",
  LANE: "LN",
  CIRCLE: "CIR",
  CR: "CIR",
  HIGHWAY: "HWY",
  PKY: "PKWY",
  PARKWAY: "PKWY",
  NORTH: "N",
  SOUTH: "S",
  EAST: "E",
  WEST: "W",
};

/**
 * Link permits that carry no folio (61 % of the Fort Lauderdale layer leaves PARCELID empty) to
 * a roll parcel by street address, within the permit's jurisdiction. Deterministic and
 * conservative: a permit links only when its normalized address (+ unit, when given) names
 * exactly one parcel; ambiguous addresses (condo buildings without a unit) stay unmatched.
 * Sets `parcel_match_method` = 'folio' | 'address_unit' | 'address' | null.
 */
export async function matchPermitsByAddress(db: WorkDb, log: (m: string) => void = () => {}): Promise<void> {
  const cases = Object.entries(ADDRESS_TOKENS)
    .map(([k, v]) => `when '${k}' then '${v}'`)
    .join(" ");
  await db.run(`create or replace macro oracle_norm_addr(s) as
    array_to_string(list_transform(
      list_filter(string_split(regexp_replace(upper(coalesce(s, '')), '[^A-Z0-9 ]', ' ', 'g'), ' '), t -> t <> ''),
      t -> case t ${cases} else t end), ' ')`);
  await db.run(`create or replace macro oracle_norm_unit(s) as
    nullif(ltrim(regexp_replace(upper(coalesce(s, '')), '^(UNIT|APT|STE|SUITE|#)\\s*', ''), '0'), '')`);
  const cityCases = Object.values(PERMIT_JURISDICTIONS)
    .map((j) => `when '${j.sourceSystem}' then [${j.cities.map((c) => `'${c}'`).join(", ")}]`)
    .join(" ");
  await db.run(`create or replace table drv_addr_parcels as
select parcel_id, situs_city,
  oracle_norm_addr(concat_ws(' ', situs_number, situs_dir, situs_street, situs_type, situs_post_dir)) as base,
  oracle_norm_unit(situs_unit) as unit
from stg_parcels where situs_number is not null and situs_street is not null`);
  await db.run(`create or replace table drv_permit_addr_match as
with q as (
  select permit_key, case source_system ${cityCases} else [] end as cities,
    oracle_norm_addr(split_part(address, '#', 1)) as base,
    oracle_norm_unit(nullif(trim(split_part(address, '#', 2)), '')) as unit
  from drv_permits where parcel_id is null and address is not null
),
by_unit as (
  select q.permit_key, min(a.parcel_id) parcel_id, count(*) n from q join drv_addr_parcels a
    on a.base = q.base and a.unit = q.unit and list_contains(q.cities, a.situs_city)
  where q.unit is not null group by 1
),
by_base as (
  select q.permit_key, min(a.parcel_id) parcel_id, count(*) n from q join drv_addr_parcels a
    on a.base = q.base and list_contains(q.cities, a.situs_city)
  group by 1
)
select q.permit_key,
  case when u.n = 1 then u.parcel_id when b.n = 1 then b.parcel_id end as parcel_id,
  case when u.n = 1 then 'address_unit' when b.n = 1 then 'address' end as method
from q left join by_unit u using (permit_key) left join by_base b using (permit_key)
where u.n = 1 or b.n = 1`);
  await db.run(`create or replace table drv_permits as
select d.* replace (coalesce(d.parcel_id, m.parcel_id) as parcel_id),
  case when d.parcel_id is not null then 'folio' else m.method end as parcel_match_method
from drv_permits d left join drv_permit_addr_match m using (permit_key)`);
  const r = await db.one<{ folio: number; addr: number; unmatched: number }>(
    `select count(*) filter (parcel_match_method = 'folio')::INTEGER folio,
       count(*) filter (parcel_match_method like 'address%')::INTEGER addr,
       count(*) filter (parcel_match_method is null)::INTEGER unmatched from drv_permits`,
  );
  log(`derive: permit→parcel links folio ${r?.folio}, address ${r?.addr}, unmatched ${r?.unmatched}`);
}

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { WorkDb } from "../work-db.ts";

/**
 * Supplementary derived inputs for the query index: classifier outputs and source fields with no
 * Lexicon home (permit description/raw status, contractor license detail, owner-location and
 * occupancy classes, roof-age lineage). Written per run from the work store, keyed by the stable
 * identifiers (`parcel_identifier`, permit key, license id). Never contains owner names or
 * mailing street lines (Open Q3 default).
 */
export async function writeSupplement(db: WorkDb, runDir: string): Promise<string[]> {
  const dir = path.join(runDir, "supplement");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const out: [string, string][] = [
    [
      "property_signals",
      `select p.parcel_id as parcel_identifier, p.roll_source, p.land_use_code, p.homestead, p.situs_city, p.situs_zip,
         g.geo_status, s.owner_type, s.owner_location_class, s.owner_mail_state, s.owner_mail_zip5,
         s.occupancy_class, s.occupancy_basis, s.last_sale_date,
         r.roof_date, r.roof_age_years, r.roof_age_basis, r.roof_age_confidence, r.roof_age_permit_key, r.roof_age_policy,
         p.retrieved_at
       from stg_parcels p join drv_geo g using (parcel_id)
       left join drv_property_signals s using (parcel_id) left join drv_roof_age r using (parcel_id)
       order by p.parcel_id`,
    ],
    [
      "permit_details",
      `select d.permit_key, d.source_system, d.source_key, d.jurisdiction, d.permit_number, d.case_key,
         d.parcel_id as parcel_identifier, d.parcel_matched, d.parcel_match_method, d.address as permit_address, d.permit_type, d.permit_subtype,
         d.raw_status, d.status, d.lexicon_status, coalesce(c.project_description, d.description) as description,
         d.is_roofing, d.roof_work_class, d.application_date, d.issue_date, d.final_date, d.close_date,
         d.completion_date_resolved, d.last_update_date, d.open_days, d.est_value,
         coalesce(nullif(trim(c.dba_name), ''), c.licensee_name) as contractor_name, c.license_number as contractor_license,
         c.license_id as dbpr_license_id, c.class_code as contractor_license_class,
         c.primary_status as contractor_license_status, c.expiry_date as contractor_license_expiry,
         c.accela_status, cast(null as VARCHAR) as bbb_rating, cast(null as VARCHAR) as bbb_accredited,
         json_extract_string(d.request_json, '$.url') || coalesce('?where=' || json_extract_string(d.request_json, '$.multiValueQueryString.where[0]') || '&outFields=*&f=json', '') as source_url,
         d.request_json, d.retrieved_at
       from drv_permits d left join drv_contractor_links c on c.permit_key = d.permit_key
       order by d.permit_key`,
    ],
    [
      "contractors",
      `select c.license_id as dbpr_license_id, any_value(coalesce(nullif(trim(c.dba_name), ''), c.licensee_name)) as contractor_name,
         any_value(c.class_code) as license_class, any_value(c.primary_status) as license_status,
         any_value(c.expiry_date) as license_expiry, any_value(c.license_city) as city, any_value(c.license_state) as state,
         count(*)::INTEGER as permits, count(*) filter (where d.status = 'open')::INTEGER as open_permits,
         cast(null as VARCHAR) as bbb_rating, cast(null as VARCHAR) as bbb_accredited,
         any_value(c.dbpr_retrieved_at) as retrieved_at
       from drv_contractor_links c join drv_permits d using (permit_key)
       where c.license_id is not null group by c.license_id order by c.license_id`,
    ],
    ["places", `select name, census_name, geoid, lat, lon from ref_places order by name`],
  ];
  // The published county archive's property CIDs (oracle ingest --source atlas-county): the index
  // hands these out as property_cid, so every CID in the Oracle resolves on IPFS.
  const seed = await db.one<{ n: number }>(
    "select count(*)::INTEGER n from information_schema.tables where table_name = 'ref_atlas_seed'",
  );
  if ((seed?.n ?? 0) > 0) {
    out.push([
      "atlas_seed",
      "select parcel_id as parcel_identifier, property_cid from ref_atlas_seed order by parcel_id",
    ]);
  }
  const files: string[] = [];
  for (const [name, sql] of out) {
    const file = path.join(dir, `${name}.parquet`);
    await db.run(`copy (${sql}) to '${file}' (format parquet, compression zstd)`);
    files.push(file);
  }
  return files;
}

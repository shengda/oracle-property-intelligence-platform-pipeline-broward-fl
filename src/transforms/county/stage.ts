import type { WorkDb } from "../../work-db.ts";
import { BCPA_CITY_CODES } from "../../sources/bcpa-taxroll.ts";

/**
 * Normalize `stg_bcpa_raw` into the staging tables the county group is built from:
 * `stg_parcels` (one row per valid folio), `stg_sales` (up to five sales per parcel) and
 * `stg_owner_raw` (owner name + mailing address; internal only, never published raw).
 */
export async function stageParcels(
  db: WorkDb,
  opts: { asOfYear: number },
): Promise<{
  parcels: number;
  invalidParcelIds: number;
  duplicateFolios: number;
  sales: number;
  fromFullRoll: number;
}> {
  const cityCase = Object.entries(BCPA_CITY_CODES)
    .map(([k, v]) => `when '${k}' then '${v}'`)
    .join(" ");
  const n = (c: string) => `try_cast(nullif(trim(${c}), '') as DOUBLE)`;
  const t = (c: string) => `nullif(trim(${c}), '')`;
  // One roll source per folio: the current layer wins; the fuller (older) layer fills missing folios.
  await db.run(`create or replace table stg_bcpa_chosen as
select * exclude (rn) from (
  select *, row_number() over (partition by trim(FOLIO)
      order by roll_priority, try_cast(OBJECTID_12 as BIGINT) desc) as rn
  from stg_bcpa_raw where regexp_full_match(trim(coalesce(FOLIO, '')), '[0-9A-Z]{12}')
) where rn = 1`);
  await db.run(`create or replace table stg_parcels as
with base as (select *, 1 as rn from stg_bcpa_chosen)
select
  trim(FOLIO) as parcel_id,
  roll_source,
  ${t("PARCEL_TYP")} as parcel_type,
  lpad(${t("USE_CODE")}, 2, '0') as land_use_code,
  case when try_cast(nullif(trim(HE1_AMOUNT), '') as DOUBLE) > 0 then true
       when nullif(trim(HE1_AMOUNT), '') is not null then false else null end as homestead,
  ${t("SITUS_STREET_NUMBER")} as situs_number,
  ${t("SITUS_STREET_DIRECTION")} as situs_dir,
  ${t("SITUS_STREET_NAME")} as situs_street,
  ${t("SITUS_STREET_TYPE")} as situs_type,
  ${t("SITUS_STREET_POST_DIR")} as situs_post_dir,
  ${t("SITUS_UNIT_NUMBER")} as situs_unit,
  ${t("SITUS_CITY")} as situs_city_code,
  case ${t("SITUS_CITY")} ${cityCase} else null end as situs_city,
  lpad(cast(try_cast(${t("SITUS_ZIP_CODE")} as INTEGER) as VARCHAR), 5, '0') as situs_zip,
  ${t("MUNICIPALITY")} as municipality,
  nullif(trim(concat_ws(' ', ${t("LEGAL_LINE_1")}, ${t("LEGAL_LINE_2")}, ${t("LEGAL_LINE_3")})), '') as legal_description,
  case when try_cast(${t("ACTUAL_YEAR_BUILT")} as INTEGER) between 1800 and ${opts.asOfYear}
       then try_cast(${t("ACTUAL_YEAR_BUILT")} as INTEGER)
       when try_cast(${t("BLDG_YEAR_BUILT")} as INTEGER) between 1800 and ${opts.asOfYear}
       then try_cast(${t("BLDG_YEAR_BUILT")} as INTEGER) end as year_built,
  case when try_cast(${t("BLDG_YEAR_BUILT")} as INTEGER) between 1800 and ${opts.asOfYear}
       then try_cast(${t("BLDG_YEAR_BUILT")} as INTEGER) end as effective_year_built,
  try_cast(${n("BLDG_TOT_SQ_FOOTAGE")} as BIGINT) as building_sqft,
  try_cast(${n("BLDG_ADJ_SQ_FOOTAGE")} as BIGINT) as building_adj_sqft,
  try_cast(${n("BLDG_UNITS")} as INTEGER) as units,
  try_cast(${n("BLDG_NUM_OF")} as INTEGER) as buildings,
  try_cast(${n("GIS_SQUARE_FOOT")} as BIGINT) as lot_sqft,
  ${n("JUST_LAND_VALUE")} as land_value,
  ${n("JUST_BUILDING_VALUE")} as building_value,
  ${n("JUST_OTHER_VALUE")} as other_value,
  ${n("NEW_SOH_VALUE")} as assessed_value,
  ${n("EXEMPTION_AMOUNT")} as exemption_amount,
  ${n("COUNTY_TAXABLE")} as county_taxable,
  ${n("SCHOOL_TAXABLE")} as school_taxable,
  ${n("CITY_TAXABLE")} as city_taxable,
  ${t("MILLAGE_CODE")} as millage_code,
  centroid_lat as lat,
  centroid_lon as lon,
  retrieved_at
from base where rn = 1`);

  await db.run(`create or replace table stg_sales as
with u as (
  ${[1, 2, 3, 4, 5]
    .map(
      (i) => `select trim(FOLIO) as parcel_id, ${i} as seq,
    try_cast(SALE_DATE_${i} as BIGINT) as sale_ms,
    ${t(`DEED_TYPE_${i}`)} as deed_type,
    try_cast(${t(`STAMP_AMOUNT_${i}`)} as DOUBLE) as stamp_amount,
    ${t(`SALE${i}_QUAL_CODE`)} as qual_code
  from stg_bcpa_chosen`,
    )
    .join("\n  union all\n  ")}
)
select distinct on (parcel_id, sale_date, deed_type)
  parcel_id, seq,
  strftime(to_timestamp(sale_ms / 1000)::DATE, '%Y-%m-%d') as sale_date,
  replace(deed_type, '*', '') as deed_type,
  stamp_amount,
  case when stamp_amount > 0.71 then round(stamp_amount / 0.007) end as price,
  qual_code
from u
where sale_ms is not null and sale_ms > -2208988800000 and to_timestamp(sale_ms / 1000)::DATE <= current_date
order by parcel_id, sale_date, deed_type, seq`);

  await db.run(`create or replace table stg_owner_raw as
select trim(FOLIO) as parcel_id,
  ${t("NAME_LINE_1")} as name_1, ${t("NAME_LINE_2")} as name_2,
  ${t("ADDRESS_LINE_1")} as mail_line_1, ${t("ADDRESS_LINE_2")} as mail_line_2,
  ${t("CITY")} as mail_city, upper(${t("STATE")}) as mail_state, ${t("ZIP")} as mail_zip
from stg_bcpa_chosen`);

  const counts = await db.one<any>(`select
    (select count(*) from stg_parcels)::INTEGER as parcels,
    (select count(*) from stg_bcpa_raw where not regexp_full_match(trim(coalesce(FOLIO, '')), '[0-9A-Z]{12}'))::INTEGER as invalid,
    (select count(*) - count(distinct trim(FOLIO)) from stg_bcpa_raw where regexp_full_match(trim(coalesce(FOLIO, '')), '[0-9A-Z]{12}'))::INTEGER as dups,
    (select count(*) from stg_parcels where roll_source <> 'bcpa-taxroll')::INTEGER as from_full,
    (select count(*) from stg_sales)::INTEGER as sales`);
  return {
    parcels: counts.parcels,
    invalidParcelIds: counts.invalid,
    duplicateFolios: counts.dups,
    sales: counts.sales,
    fromFullRoll: counts.from_full,
  };
}

/** Broward DOR sale qualification: codes 01–05 are qualified arm's-length sales (FL DOR SDF). */
export function isQualifiedSale(code: string | null | undefined): boolean {
  return /^0[1-5]$/.test((code ?? "").trim());
}

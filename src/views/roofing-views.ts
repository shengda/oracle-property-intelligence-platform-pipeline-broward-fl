import type { WorkDb } from "../work-db.ts";

export const ROOFING_VIEWS_VERSION = "roofing-views.v1";

export const ROOFING_VIEWS = [
  "v_property",
  "v_roof_permit",
  "v_contractor",
  "v_business",
  "v_owner",
] as const;

/** Column contract of each roofing view (architecture §3.5; the CRM reads these through the API). */
export const ROOFING_VIEW_COLUMNS: Record<(typeof ROOFING_VIEWS)[number], string[]> = {
  v_property: [
    "parcel_identifier",
    "property_cid",
    "address",
    "city",
    "zip",
    "lat",
    "lon",
    "geo_status",
    "property_type",
    "property_usage_type",
    "year_built",
    "roof_date",
    "roof_age_years",
    "roof_age_basis",
    "roof_age_confidence",
    "owner_type",
    "owner_location_class",
    "occupancy_class",
    "homestead",
    "last_sale_date",
    "years_since_transfer",
    "last_sale_price",
    "market_value",
    "open_roof_permits",
    "max_open_days",
    "permit_jurisdiction_covered",
    "roll_source",
    "source_url",
    "retrieved_at",
  ],
  v_roof_permit: [
    "permit_key",
    "property_improvement_cid",
    "parcel_identifier",
    "property_cid",
    "address",
    "city",
    "lat",
    "lon",
    "permit_number",
    "permit_type",
    "description",
    "raw_status",
    "status",
    "roof_work_class",
    "application_date",
    "issue_date",
    "completion_date",
    "open_days",
    "open_years",
    "contractor_name",
    "contractor_license",
    "contractor_license_status",
    "contractor_company_cid",
    "bbb_rating",
    "bbb_accredited",
    "source_system",
    "source_url",
    "retrieved_at",
  ],
  v_contractor: [
    "dbpr_license_id",
    "contractor_name",
    "company_cid",
    "license_class",
    "license_status",
    "license_expiry",
    "city",
    "state",
    "permits",
    "open_permits",
    "bbb_rating",
    "bbb_accredited",
    "source_url",
  ],
  v_business: ["business_key", "name", "role", "company_cid", "properties", "license_id", "source_url"],
  v_owner: [
    "parcel_identifier",
    "property_cid",
    "owner_type",
    "owner_name",
    "owner_location_class",
    "owner_mail_state",
    "owner_mail_zip5",
    "occupancy_class",
    "occupancy_basis",
    "last_sale_date",
    "years_since_transfer",
    "lat",
    "lon",
  ],
};

/**
 * Compact county detail the queries read, keyed by `parcel_identifier`: structure, sales, tax and
 * company owners. Built from the run's county Lexicon tables at index time and published as
 * `query/qd_*.parquet` (26 MB), because the run's own county archive is not published (only the
 * `property_improvement` group is, next to the county group already in Atlas); `oracle sync`
 * loads these instead. They carry no CIDs: the county entities they come from are local.
 */
export const COUNTY_DETAIL_TABLES = ["qd_structure", "qd_sales", "qd_tax", "qd_company"] as const;

export async function createCountyDetail(db: WorkDb): Promise<void> {
  // Roof date and age come from this run's permit-aware signals (as in v_property), so a county
  // group reused from an earlier run never shows a stale permit-derived roof date.
  await db.run(`create or replace table qd_structure as
select p.parcel_identifier,
  s.* exclude (cid, property_cid, source_http_request, data_group_cid, request_identifier, roof_date, roof_age_years),
  sig.roof_date, sig.roof_age_years
from lx_county_structure s join lx_county_property p using (property_cid)
left join sp_property_signals sig on sig.parcel_identifier = p.parcel_identifier order by 1`);
  await db.run(`create or replace table qd_sales as
select p.parcel_identifier, s.ownership_transfer_date as date, try_cast(s.purchase_price_amount as DOUBLE) as price, s.sale_type
from lx_county_sales_history s join lx_county_property p using (property_cid) order by 1, 2`);
  await db.run(`create or replace table qd_tax as
select p.parcel_identifier, try_cast(t.tax_year as INTEGER) tax_year,
  try_cast(t.property_market_value_amount as DOUBLE) market_value, try_cast(t.property_assessed_value_amount as DOUBLE) assessed_value,
  try_cast(t.property_taxable_value_amount as DOUBLE) taxable_value, try_cast(t.property_land_amount as DOUBLE) land_value,
  try_cast(t.property_building_amount as DOUBLE) building_value
from lx_county_tax t join lx_county_property p using (property_cid) order by 1, 2`);
  await db.run(`create or replace table qd_company as
select p.parcel_identifier, c.name, json_extract_string(c.source_http_request, '$.url') as source_url
from lx_county_company c join lx_county_property p using (property_cid) order by 1, 2`);
}

/**
 * `property_ids`: each county parcel's local property CID (this run's county archive) and its
 * public one. With the published Atlas Seed loaded (`sp_atlas_seed`), the public CID is the
 * property CID of the published county archive (null for a parcel that archive lacks), so every
 * CID the Oracle hands out resolves on IPFS; without it (fixtures, local runs) it is the local one.
 */
export async function createPropertyIds(db: WorkDb, opts: { atlasSeed: boolean }): Promise<void> {
  await db.run(
    opts.atlasSeed
      ? `create or replace table property_ids as
select p.parcel_identifier, p.property_cid as local_property_cid, a.property_cid
from lx_county_property p left join sp_atlas_seed a using (parcel_identifier)`
      : `create or replace table property_ids as
select parcel_identifier, property_cid as local_property_cid, property_cid from lx_county_property`,
  );
}

/**
 * Create `roofing-views.v1` over the Lexicon tables (`lx_<group>_<table>`) and the supplementary
 * derived tables (`sp_*`) already loaded into the index. Thresholds (roof age, long-held years)
 * are query parameters, never baked in.
 */
export async function createRoofingViews(db: WorkDb, opts: { asOf: string }): Promise<void> {
  const asOf = opts.asOf;
  await db.run(`create or replace view v_property as
with addr as (
  select r.from_cid as property_entity_cid, a.unnormalized_address, a.property_cid
  from lx_county_property_has_address r join lx_county_address a on a.cid = r.to_cid
),
geo as (
  select a.property_cid, try_cast(g.latitude as DOUBLE) lat, try_cast(g.longitude as DOUBLE) lon
  from lx_county_address_has_geometry r join lx_county_address a on a.cid = r.from_cid
  join lx_county_geometry g on g.cid = r.to_cid
),
sales as (
  select property_cid, max(ownership_transfer_date) last_sale_date,
    arg_max(try_cast(purchase_price_amount as DOUBLE), ownership_transfer_date) last_sale_price
  from lx_county_sales_history group by 1
),
tax as (select property_cid, max(try_cast(property_market_value_amount as DOUBLE)) market_value from lx_county_tax group by 1),
permits as (
  select parcel_identifier, count(*) filter (where status = 'open' and is_roofing)::INTEGER open_roof_permits,
    max(open_days) filter (where is_roofing) max_open_days
  from sp_permit_details where parcel_matched group by 1
)
select p.parcel_identifier, ids.property_cid,
  addr.unnormalized_address as address, s.situs_city as city, s.situs_zip as zip,
  geo.lat, geo.lon, s.geo_status,
  p.property_type, p.property_usage_type,
  try_cast(p.property_structure_built_year as INTEGER) as year_built,
  s.roof_date, s.roof_age_years, s.roof_age_basis, s.roof_age_confidence,
  s.owner_type, s.owner_location_class, s.occupancy_class, s.homestead,
  sales.last_sale_date,
  case when sales.last_sale_date is not null
       then date_diff('year', try_cast(sales.last_sale_date as DATE), DATE '${asOf}')
            - case when strftime(try_cast(sales.last_sale_date as DATE), '%m-%d') > strftime(DATE '${asOf}', '%m-%d') then 1 else 0 end
  end::INTEGER as years_since_transfer,
  sales.last_sale_price, tax.market_value,
  coalesce(permits.open_roof_permits, 0) as open_roof_permits, permits.max_open_days,
  coalesce(s.situs_city in (select unnest(string_split(cities, '|')) from sp_permit_coverage where status = 'covered'), false) as permit_jurisdiction_covered,
  coalesce(s.roll_source, 'bcpa-taxroll') as roll_source,
  json_extract_string(p.source_http_request, '$.url') || '?where=' || replace(json_extract_string(p.source_http_request, '$.multiValueQueryString.where[0]'), '%27', '''') || '&outFields=*&f=json' as source_url,
  s.retrieved_at
from lx_county_property p
left join property_ids ids on ids.parcel_identifier = p.parcel_identifier
left join addr on addr.property_entity_cid = p.cid
left join geo on geo.property_cid = p.property_cid
left join sales on sales.property_cid = p.property_cid
left join tax on tax.property_cid = p.property_cid
left join sp_property_signals s on s.parcel_identifier = p.parcel_identifier
left join permits on permits.parcel_identifier = p.parcel_identifier`);

  await createPermitViews(db);

  await db.run(`create or replace view v_business as
select 'owner:' || lower(regexp_replace(co.name, '[^A-Za-z0-9]+', '-', 'g')) as business_key, co.name, 'property_owner' as role,
  cast(null as VARCHAR) as company_cid, count(distinct co.parcel_identifier)::INTEGER as properties, null as license_id,
  any_value(co.source_url) as source_url
from qd_company co group by co.name
union all
select 'dbpr:' || c.dbpr_license_id, c.contractor_name, 'contractor', c.company_cid, c.permits, c.dbpr_license_id, c.source_url
from v_contractor c`);

  await db.run(`create or replace view v_owner as
select vp.parcel_identifier, vp.property_cid, vp.owner_type,
  case when vp.owner_type = 'company' then oc.owner_company_name end as owner_name,
  vp.owner_location_class, s.owner_mail_state, s.owner_mail_zip5, vp.occupancy_class, s.occupancy_basis,
  vp.last_sale_date, vp.years_since_transfer, vp.lat, vp.lon
from v_property vp
left join sp_property_signals s on s.parcel_identifier = vp.parcel_identifier
left join (select parcel_identifier, any_value(name) as owner_company_name from qd_company group by 1) oc on oc.parcel_identifier = vp.parcel_identifier`);
}

/**
 * The permit views, from the published `property_improvement` Lexicon tables, the permit
 * supplement and `v_property`. Separate so `oracle sync --rebuild` can recompute them from the
 * published Lexicon record and compare them with the published `query/v_roof_permit.parquet`.
 */
export async function createPermitViews(db: WorkDb, opts: { prefix?: string } = {}): Promise<void> {
  const px = opts.prefix ?? "";
  await db.run(`create or replace view ${px}v_roof_permit as
select d.permit_key, pi.cid as property_improvement_cid, d.parcel_identifier, vp.property_cid,
  vp.address, vp.city, vp.lat, vp.lon, d.permit_number, d.permit_type, d.description, d.raw_status, d.status,
  d.roof_work_class, d.application_date, d.issue_date, d.completion_date_resolved as completion_date,
  d.open_days, round(d.open_days / 365.25, 1) as open_years,
  d.contractor_name, d.contractor_license, d.contractor_license_status,
  ct.company_cid as contractor_company_cid, d.bbb_rating, d.bbb_accredited,
  d.source_system, d.source_url, d.retrieved_at
from sp_permit_details d
left join lx_property_improvement_property_improvement pi on pi.request_identifier = d.permit_key
left join v_property vp on vp.parcel_identifier = d.parcel_identifier
left join (select request_identifier, any_value(cid) company_cid from lx_property_improvement_company group by 1) ct
  on ct.request_identifier = d.dbpr_license_id
where d.is_roofing`);

  await db.run(`create or replace view ${px}v_contractor as
select c.dbpr_license_id, c.contractor_name, co.company_cid, c.license_class, c.license_status, c.license_expiry,
  c.city, c.state, c.permits, c.open_permits, c.bbb_rating, c.bbb_accredited,
  'https://www2.myfloridalicense.com/sto/file_download/extracts/CONSTRUCTIONLICENSE_1.csv' as source_url
from sp_contractors c
left join (select request_identifier, any_value(cid) company_cid from lx_property_improvement_company group by 1) co
  on co.request_identifier = c.dbpr_license_id`);
}

/** Lookup keys indexed on each materialized view (ART indexes for point lookups). */
const VIEW_KEYS: Record<(typeof ROOFING_VIEWS)[number], string[]> = {
  v_property: ["parcel_identifier", "property_cid"],
  v_roof_permit: ["permit_key", "parcel_identifier"],
  v_contractor: ["dbpr_license_id", "company_cid"],
  v_business: ["business_key", "company_cid"],
  v_owner: ["parcel_identifier"],
};

/**
 * Materialize `roofing-views.v1` inside the index: each view's rows go to `mv_<name>` (ordered by
 * location so radius bbox prefilters prune row groups) and `v_<name>` becomes `select * from
 * mv_<name>`. Names and columns are unchanged; queries drop from ~0.7 s to milliseconds because
 * the joins run once, at index build, not per request. Views are materialized in dependency
 * order (v_roof_permit and v_owner read v_property; v_business reads v_contractor).
 */
export async function materializeRoofingViews(db: WorkDb): Promise<void> {
  for (const v of ROOFING_VIEWS) {
    const mv = `m${v}`;
    const order = ROOFING_VIEW_COLUMNS[v].includes("lat") ? "order by lat nulls last, lon" : "";
    await db.run(`create or replace table ${mv} as select * from ${v} ${order}`);
    await db.run(`create or replace view ${v} as select * from ${mv}`);
    for (const k of VIEW_KEYS[v]) await db.run(`create index ${mv}_${k} on ${mv} (${k})`);
  }
}

/**
 * Load published view Parquet (`query/<view>.parquet`) as `mv_<view>` with the same ordering and
 * lookup indexes `materializeRoofingViews` gives a locally built index, and point `v_<view>` at it.
 */
export async function loadMaterializedViews(db: WorkDb, queryDir: string): Promise<void> {
  for (const v of ROOFING_VIEWS) {
    const mv = `m${v}`;
    const order = ROOFING_VIEW_COLUMNS[v].includes("lat") ? "order by lat nulls last, lon" : "";
    await db.run(
      `create or replace table ${mv} as select * from read_parquet('${queryDir}/${v}.parquet') ${order}`,
    );
    await db.run(`create or replace view ${v} as select * from ${mv}`);
    for (const k of VIEW_KEYS[v]) await db.run(`create index ${mv}_${k} on ${mv} (${k})`);
  }
}

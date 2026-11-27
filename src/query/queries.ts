/**
 * Typed roofing queries over a read-only `SnapshotDb` (Task 13). All query SQL lives here and in
 * `views/roofing-views.ts`. Radius = bounding-box prefilter, then the haversine distance, so a
 * property without usable geometry never appears in a radius result (Review Focus 3).
 */
import {
  ContractorsQuery,
  DEFAULTS,
  LongHeldQuery,
  OccupancyQuery,
  OpenRoofPermitsQuery,
  OutOfAreaOwnersQuery,
  AgedRoofsQuery,
  SearchQuery,
  type BusinessDetail,
  type ContractorDetail,
  type ContractorRow,
  type DatasetInfo,
  type PermitCoverage,
  type PermitDetail,
  type PermitLead,
  type PermitSummary,
  type PropertyDetail,
  type PropertyLead,
  type SearchHit,
  type SqlResult,
} from "../contract/index.ts";
import { ROOFING_VIEW_COLUMNS } from "../views/roofing-views.ts";
import type { SnapshotDb } from "./db.ts";
import { semanticSearch } from "./embeddings.ts";
import { runReadOnlySql } from "./sql-guard.ts";

const EARTH_RADIUS_MILES = 3958.7613;
const APPRAISER_URL = "https://web.bcpa.net/BcpaClient/#/Record-Search?folio=";

type LatLon = { lat: number; lon: number };

function num(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`not a finite number: ${x}`);
  return String(x);
}

/** SQL: great-circle distance in miles from (lat, lon) columns of `alias` to a center. */
export function distanceSql(center: LatLon, alias = ""): string {
  const a = alias ? `${alias}.` : "";
  const lat = num(center.lat);
  const lon = num(center.lon);
  return `(${EARTH_RADIUS_MILES} * 2 * asin(sqrt(power(sin(radians(${a}lat - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(${a}lat)) * power(sin(radians(${a}lon - ${lon}) / 2), 2))))`;
}

/** SQL predicate: has a usable point and lies within `miles` of the center (bbox, then haversine). */
export function radiusSql(center: LatLon, miles: number, alias = ""): string {
  const a = alias ? `${alias}.` : "";
  const dLat = miles / 69.0;
  const dLon = miles / (69.172 * Math.cos((center.lat * Math.PI) / 180));
  return `(${a}lat is not null and ${a}lon is not null
    and ${a}lat between ${num(center.lat - dLat)} and ${num(center.lat + dLat)}
    and ${a}lon between ${num(center.lon - dLon)} and ${num(center.lon + dLon)}
    and ${distanceSql(center, alias)} <= ${num(miles)})`;
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Source URL of a Lexicon entity, from its `source_http_request` (url + where parameter). */
function sourceUrlSql(col = "source_http_request"): string {
  return `json_extract_string(${col}, '$.url') || coalesce('?where=' || replace(json_extract_string(${col}, '$.multiValueQueryString.where[0]'), '%27', '''') || '&outFields=*&f=json', '')`;
}

const PROPERTY_COLS = ROOFING_VIEW_COLUMNS.v_property.map((c) => `p.${c}`).join(", ");
const PERMIT_COLS = ROOFING_VIEW_COLUMNS.v_roof_permit.map((c) => `r.${c}`).join(", ");

function propertyLead(db: SnapshotDb, row: any): PropertyLead {
  return {
    ...row,
    distance_miles: row.distance_miles == null ? null : Math.round(row.distance_miles * 100) / 100,
    manifest_cid: db.manifestCid,
    provenance: row.source_url ? [{ source_url: row.source_url, retrieved_at: row.retrieved_at }] : [],
  };
}

function permitLead(db: SnapshotDb, row: any): PermitLead {
  return {
    ...row,
    distance_miles: row.distance_miles == null ? null : Math.round(row.distance_miles * 100) / 100,
    manifest_cid: db.manifestCid,
    provenance: row.source_url ? [{ source_url: row.source_url, retrieved_at: row.retrieved_at }] : [],
  };
}

function lim(n: number | undefined): number {
  return Math.max(1, Math.min(n ?? DEFAULTS.limit, 5000));
}

// ── Lead queries ─────────────────────────────────────────────────────────────────────────────

export async function findAgedRoofs(db: SnapshotDb, input: unknown): Promise<PropertyLead[]> {
  const q = AgedRoofsQuery.parse(input);
  const rows = await db.all(
    `select ${PROPERTY_COLS}, ${distanceSql(q.center, "p")} as distance_miles from v_property p
     where ${radiusSql(q.center, q.radiusMiles, "p")} and p.roof_age_years >= ${num(q.minRoofAgeYears)}
     order by p.roof_age_years desc, distance_miles, p.parcel_identifier limit ${lim(q.limit)}`,
  );
  return rows.map((r) => propertyLead(db, r));
}

/** Number of properties matching an aged-roofs query (ignores `limit`). */
export async function countAgedRoofs(db: SnapshotDb, input: unknown): Promise<number> {
  const q = AgedRoofsQuery.parse(input);
  const r = await db.one<{ n: number }>(
    `select count(*)::INTEGER n from v_property p
     where ${radiusSql(q.center, q.radiusMiles, "p")} and p.roof_age_years >= ${num(q.minRoofAgeYears)}`,
  );
  return r?.n ?? 0;
}

/** Number of open roofing permits matching a query (ignores `limit`). */
export async function countOpenRoofPermits(db: SnapshotDb, input: unknown): Promise<number> {
  const q = OpenRoofPermitsQuery.parse(input);
  const r = await db.one<{ n: number }>(
    `select count(*)::INTEGER n from v_roof_permit r
     where r.status = 'open' and r.open_days is not null and r.open_days >= ${Math.round(q.minOpenYears * 365.25)}
       and ${radiusSql(q.center, q.radiusMiles, "r")}`,
  );
  return r?.n ?? 0;
}

/** Open roofing permits, longest open first. `needs_review` permits never appear (status = open only). */
export async function findOpenRoofPermits(db: SnapshotDb, input: unknown): Promise<PermitLead[]> {
  const q = OpenRoofPermitsQuery.parse(input);
  const minDays = Math.round(q.minOpenYears * 365.25);
  const rows = await db.all(
    `select ${PERMIT_COLS}, ${distanceSql(q.center, "r")} as distance_miles from v_roof_permit r
     where r.status = 'open' and r.open_days is not null and r.open_days >= ${minDays}
       and ${radiusSql(q.center, q.radiusMiles, "r")}
     order by r.open_days desc, r.permit_key limit ${lim(q.limit)}`,
  );
  return rows.map((r) => permitLead(db, r));
}

function optionalRadius(center: LatLon | undefined, miles: number | undefined, alias: string) {
  if (!center) return { where: "true", distance: "cast(null as DOUBLE)" };
  const r = miles ?? DEFAULTS.radiusMiles;
  return { where: radiusSql(center, r, alias), distance: distanceSql(center, alias) };
}

export async function findLongHeldProperties(db: SnapshotDb, input: unknown): Promise<PropertyLead[]> {
  const q = LongHeldQuery.parse(input);
  const r = optionalRadius(q.center, q.radiusMiles, "p");
  const rows = await db.all(
    `select ${PROPERTY_COLS}, ${r.distance} as distance_miles from v_property p
     where ${r.where} and p.years_since_transfer >= ${num(q.minYearsSinceTransfer)}
     order by p.years_since_transfer desc, distance_miles nulls last, p.parcel_identifier limit ${lim(q.limit)}`,
  );
  return rows.map((x) => propertyLead(db, x));
}

/** `out_of_state` = out of state or foreign; `out_of_county` additionally includes in-state owners outside Broward. */
export async function findOutOfAreaOwners(db: SnapshotDb, input: unknown): Promise<PropertyLead[]> {
  const q = OutOfAreaOwnersQuery.parse(input);
  const classes =
    q.scope === "out_of_state"
      ? ["out_of_state", "foreign"]
      : ["in_state_out_of_county", "out_of_state", "foreign"];
  const r = optionalRadius(q.center, q.radiusMiles, "p");
  const rows = await db.all(
    `select ${PROPERTY_COLS}, ${r.distance} as distance_miles from v_property p
     where ${r.where} and p.owner_location_class in (${classes.map(sqlString).join(", ")})
     order by distance_miles nulls last, p.parcel_identifier limit ${lim(q.limit)}`,
  );
  return rows.map((x) => propertyLead(db, x));
}

export async function findByOccupancy(
  db: SnapshotDb,
  input: unknown,
): Promise<(PropertyLead & { occupancy_basis: string | null })[]> {
  const q = OccupancyQuery.parse(input);
  const r = optionalRadius(q.center, q.radiusMiles, "p");
  const roof = q.minRoofAgeYears != null ? `and p.roof_age_years >= ${num(q.minRoofAgeYears)}` : "";
  const rows = await db.all(
    `select ${PROPERTY_COLS}, o.occupancy_basis, ${r.distance} as distance_miles
     from v_property p left join v_owner o on o.parcel_identifier = p.parcel_identifier
     where ${r.where} and p.occupancy_class in (${q.occupancy.map(sqlString).join(", ")}) ${roof}
     order by distance_miles nulls last, p.parcel_identifier limit ${lim(q.limit)}`,
  );
  return rows.map((x: any) => ({ ...propertyLead(db, x), occupancy_basis: x.occupancy_basis ?? null }));
}

// ── Entity detail ────────────────────────────────────────────────────────────────────────────

const PERMIT_SUMMARY_COLS = `d.permit_key, d.permit_number, d.permit_type, d.description, d.status, d.raw_status,
  coalesce(d.is_roofing, false) as is_roofing, d.roof_work_class, d.issue_date,
  d.completion_date_resolved as completion_date, d.open_days, d.contractor_name, d.contractor_license,
  d.parcel_match_method, d.source_url`;

/** Lexicon classes with one or more rows per property in the county group (detail page entity list). */
const COUNTY_ENTITY_CLASSES = [
  "property",
  "parcel",
  "address",
  "geometry",
  "structure",
  "tax",
  "sales_history",
  "company",
];

export async function getProperty(db: SnapshotDb, parcelId: string): Promise<PropertyDetail | null> {
  const id = parcelId.trim().toUpperCase();
  const p = await db.one(`select ${PROPERTY_COLS} from v_property p where p.parcel_identifier = ?`, [id]);
  if (!p) return null;
  const pcid = (p as any).property_cid as string;
  const [owner, signals, structure, sales, tax, permits, entities] = await Promise.all([
    db.one(
      `select owner_type, owner_name, owner_location_class, owner_mail_state, owner_mail_zip5, occupancy_class, occupancy_basis
       from v_owner where parcel_identifier = ?`,
      [id],
    ),
    db.one<any>(
      `select roof_age_basis, roof_age_confidence, roof_age_permit_key, roof_age_policy from sp_property_signals where parcel_identifier = ?`,
      [id],
    ),
    db.one<any>(
      `select * exclude (source_http_request, data_group_cid, request_identifier) from lx_county_structure where property_cid = ?`,
      [pcid],
    ),
    db.all<any>(
      `select ownership_transfer_date as date, try_cast(purchase_price_amount as DOUBLE) as price, sale_type, cid
       from lx_county_sales_history where property_cid = ? order by ownership_transfer_date desc nulls last`,
      [pcid],
    ),
    db.all<any>(
      `select try_cast(tax_year as INTEGER) tax_year, try_cast(property_market_value_amount as DOUBLE) market_value,
         try_cast(property_assessed_value_amount as DOUBLE) assessed_value, try_cast(property_taxable_value_amount as DOUBLE) taxable_value,
         try_cast(property_land_amount as DOUBLE) land_value, try_cast(property_building_amount as DOUBLE) building_value, cid
       from lx_county_tax where property_cid = ? order by tax_year desc`,
      [pcid],
    ),
    db.all<PermitSummary>(
      `select ${PERMIT_SUMMARY_COLS} from sp_permit_details d where d.parcel_identifier = ?
       order by coalesce(d.issue_date, d.application_date) desc nulls last, d.permit_key`,
      [id],
    ),
    db.all<{ class: string; cid: string; source_url: string | null }>(
      COUNTY_ENTITY_CLASSES.map(
        (c) =>
          `select '${c}' as class, cid, ${sourceUrlSql()} as source_url from lx_county_${c} where property_cid = $1`,
      ).join(" union all ") + " order by class, cid",
      [pcid],
    ),
  ]);
  const structureClean = structure
    ? Object.fromEntries(Object.entries(structure).filter(([k, v]) => v != null && k !== "property_cid"))
    : null;
  return {
    property: propertyLead(db, p),
    owner: (owner as any) ?? null,
    structure: structureClean,
    roof_age: {
      basis: signals?.roof_age_basis ?? null,
      confidence: signals?.roof_age_confidence ?? null,
      permit_key: signals?.roof_age_permit_key ?? null,
      policy: signals?.roof_age_policy ?? null,
    },
    sales,
    tax,
    permits,
    entities,
    appraiser_url: `${APPRAISER_URL}${id}`,
  };
}

export async function getPermit(db: SnapshotDb, permitKey: string): Promise<PermitDetail | null> {
  const d = await db.one<any>(
    `select ${PERMIT_SUMMARY_COLS}, d.source_system, d.jurisdiction, d.application_date, d.final_date,
       try_cast(d.est_value as DOUBLE) as est_value, d.dbpr_license_id, d.contractor_license_status,
       d.bbb_rating, d.bbb_accredited, d.retrieved_at, d.parcel_identifier,
       (select any_value(cid) from lx_property_improvement_property_improvement pi where pi.request_identifier = d.permit_key) as property_improvement_cid
     from sp_permit_details d where d.permit_key = ?`,
    [permitKey],
  );
  if (!d) return null;
  const { parcel_identifier, ...permit } = d;
  const [p, c] = await Promise.all([
    parcel_identifier
      ? db.one(`select ${PROPERTY_COLS} from v_property p where p.parcel_identifier = ?`, [parcel_identifier])
      : Promise.resolve(null),
    d.dbpr_license_id
      ? db.one<ContractorRow>(`select * from v_contractor where dbpr_license_id = ?`, [d.dbpr_license_id])
      : Promise.resolve(null),
  ]);
  return { permit, property: p ? propertyLead(db, p) : null, contractor: c ?? null };
}

const NO_BBB =
  "No BBB rating: BBB returned HTTP 403 to automated requests in this run, so no ratings were collected (recorded as a source limitation).";

export async function getContractor(db: SnapshotDb, id: string): Promise<ContractorDetail | null> {
  const c = await db.one<ContractorRow>(
    `select * from v_contractor where dbpr_license_id = ? or company_cid = ? order by permits desc limit 1`,
    [id, id],
  );
  if (!c) return null;
  const permits = await db.all(
    `select ${PERMIT_COLS}, cast(null as DOUBLE) as distance_miles from v_roof_permit r
     where r.permit_key in (select permit_key from sp_permit_details where dbpr_license_id = ?)
     order by r.status = 'open' desc, r.open_days desc nulls last, r.permit_key limit 500`,
    [c.dbpr_license_id],
  );
  const leads = permits.map((r) => permitLead(db, r));
  return {
    contractor: c,
    permits: leads,
    open_permit_count: leads.filter((x) => x.status === "open").length,
    bbb: {
      rating: c.bbb_rating,
      accredited: c.bbb_accredited,
      note: c.bbb_rating ? "BBB rating as published by BBB." : NO_BBB,
    },
  };
}

export async function listContractors(db: SnapshotDb, input: unknown): Promise<ContractorRow[]> {
  const q = ContractorsQuery.parse(input);
  const inRadius = q.center
    ? `and c.dbpr_license_id in (select d.dbpr_license_id from sp_permit_details d
         join v_property p on p.parcel_identifier = d.parcel_identifier
         where d.dbpr_license_id is not null and ${radiusSql(q.center, q.radiusMiles ?? DEFAULTS.radiusMiles, "p")})`
    : "";
  return db.all<ContractorRow>(
    `select c.* from v_contractor c where c.open_permits >= ${num(q.minOpenPermits)} ${inRadius}
     order by c.open_permits desc, c.permits desc, c.dbpr_license_id limit ${lim(q.limit)}`,
  );
}

export async function getBusiness(db: SnapshotDb, id: string): Promise<BusinessDetail | null> {
  const b = await db.one<any>(
    `select * from v_business where business_key = ? or company_cid = ? order by properties desc limit 1`,
    [id, id],
  );
  if (!b) return null;
  if (b.role === "contractor") {
    const c = await db.one<ContractorRow>(`select * from v_contractor where dbpr_license_id = ?`, [
      b.license_id,
    ]);
    return {
      ...b,
      properties: [],
      contractor: c ?? null,
      note: "Licensed contractor (FL DBPR). Sunbiz corporate records were not loaded this run (source blocked).",
    };
  }
  const rows = await db.all(
    `select ${PROPERTY_COLS}, cast(null as DOUBLE) as distance_miles from v_property p
     where p.property_cid in (select property_cid from lx_county_company where name = ?)
     order by p.parcel_identifier limit 500`,
    [b.name],
  );
  return {
    ...b,
    properties: rows.map((r) => propertyLead(db, r)),
    contractor: null,
    note: "Company owner from the Broward Property Appraiser roll. Sunbiz corporate records were not loaded this run (source blocked).",
  };
}

// ── Search ───────────────────────────────────────────────────────────────────────────────────

/**
 * Full-text (BM25), semantic (local MiniLM embeddings, cosine) or hybrid (reciprocal-rank
 * fusion of both) search over permit descriptions, addresses, businesses and contractors.
 */
export async function searchRecords(
  db: SnapshotDb,
  input: unknown,
  opts: { embedder?: (t: string[]) => Promise<number[][]> } = {},
): Promise<SearchHit[]> {
  const q = SearchQuery.parse(input);
  const pool = Math.min(q.limit * 4, 400);
  const lists: { kind: "text" | "semantic"; rows: any[] }[] = [];
  if (q.mode !== "semantic") {
    const rows = await db.all(
      `select * from (select doc_id, kind, ref, parcel_identifier, text,
          fts_main_fts_docs.match_bm25(doc_id, ?) as score from fts_docs) where score is not null
       order by score desc, doc_id limit ${pool}`,
      [q.text],
    );
    lists.push({ kind: "text", rows });
  }
  if (q.mode !== "text") {
    const rows = await semanticSearch(db, q.text, pool, opts.embedder);
    const withParcel = rows.length
      ? await db.all<{ doc_id: string; parcel_identifier: string | null }>(
          `select doc_id, parcel_identifier from vec_docs where doc_id in (${rows.map((r) => sqlString(r.doc_id)).join(", ")})`,
        )
      : [];
    const pmap = new Map(withParcel.map((r) => [r.doc_id, r.parcel_identifier]));
    lists.push({
      kind: "semantic",
      rows: rows.map((r) => ({ ...r, parcel_identifier: pmap.get(r.doc_id) ?? null })),
    });
  }
  // Reciprocal-rank fusion (k = 60); a single list keeps its own order.
  const fused = new Map<string, SearchHit>();
  for (const l of lists) {
    l.rows.forEach((r, i) => {
      const prev = fused.get(r.doc_id);
      const s = 1 / (60 + i + 1);
      if (prev) {
        prev.score += s;
        if (!prev.match.includes(l.kind)) prev.match.push(l.kind);
      } else {
        fused.set(r.doc_id, {
          doc_id: r.doc_id,
          kind: r.kind,
          ref: r.ref,
          parcel_identifier: r.parcel_identifier ?? null,
          text: r.text,
          score: s,
          match: [l.kind],
        });
      }
    });
  }
  let hits = [...fused.values()].sort((a, b) => b.score - a.score || a.doc_id.localeCompare(b.doc_id));
  if (q.center) {
    const ids = [...new Set(hits.map((h) => h.parcel_identifier).filter(Boolean))] as string[];
    const inside = ids.length
      ? new Set(
          (
            await db.all<{ parcel_identifier: string }>(
              `select parcel_identifier from v_property p where p.parcel_identifier in (${ids.map(sqlString).join(", ")})
               and ${radiusSql(q.center, q.radiusMiles ?? DEFAULTS.radiusMiles, "p")}`,
            )
          ).map((r) => r.parcel_identifier),
        )
      : new Set<string>();
    hits = hits.filter((h) => h.parcel_identifier && inside.has(h.parcel_identifier));
  }
  return hits.slice(0, q.limit).map((h) => ({ ...h, score: Math.round(h.score * 1e6) / 1e6 }));
}

// ── Dataset info and SQL ─────────────────────────────────────────────────────────────────────

export async function permitCoverage(db: SnapshotDb): Promise<PermitCoverage[]> {
  const rows = await db.all<any>(`select * from sp_permit_coverage order by status, name`);
  return rows.map((r) => ({
    jurisdiction: r.jurisdiction,
    name: r.name,
    cities: r.cities ? String(r.cities).split("|") : [],
    status: r.status,
    parcels: r.parcels ?? 0,
    permits: r.permits ?? 0,
    roofingPermits: r.roofing_permits ?? 0,
    ...(r.reason ? { reason: r.reason } : {}),
  }));
}

/** Jurisdictions without loaded permit data whose cities have parcels inside the radius. */
export async function uncoveredJurisdictionsInRadius(
  db: SnapshotDb,
  center: LatLon,
  radiusMiles: number,
): Promise<{ name: string; status: string; parcels: number }[]> {
  return db.all(
    `with cov as (select name, status, unnest(string_split(cities, '|')) as city from sp_permit_coverage where status <> 'covered')
     select cov.name, any_value(cov.status) as status, count(*)::INTEGER as parcels
     from v_property p join cov on cov.city = p.city
     where ${radiusSql(center, radiusMiles, "p")} group by cov.name order by parcels desc`,
  );
}

export async function datasetInfo(db: SnapshotDb): Promise<DatasetInfo> {
  const counts: Record<string, number> = {};
  for (const v of Object.keys(ROOFING_VIEW_COLUMNS)) {
    counts[v] = (await db.one<{ n: number }>(`select count(*)::INTEGER n from ${v}`))?.n ?? 0;
  }
  const coverage = await db.readMeta<any>("coverage.json");
  const limitations: string[] = [];
  for (const s of coverage?.sources ?? []) {
    if (s.limitation && s.status !== "not_run") limitations.push(`${s.title} (${s.status}): ${s.limitation}`);
  }
  if (!db.published)
    limitations.unshift("UNPUBLISHED local run: no manifest CID yet; not retrievable from IPFS gateways.");
  const { permit_coverage: _pc, sources: _s, ...coverageSummary } = coverage ?? {};
  return {
    manifestCid: db.manifestCid,
    published: db.published,
    runId: db.meta.run_id,
    asOf: db.meta.as_of,
    builtAt: db.meta.built_at,
    viewsVersion: db.meta.views_version,
    counts,
    coverage: coverage ? coverageSummary : null,
    permitCoverage: await permitCoverage(db),
    limitations,
  };
}

export async function readOnlySql(db: SnapshotDb, sql: string, maxRows = 500): Promise<SqlResult> {
  const r = await runReadOnlySql(db, sql, maxRows);
  return { columns: r.rows[0] ? Object.keys(r.rows[0]) : [], rows: r.rows, truncated: r.truncated };
}

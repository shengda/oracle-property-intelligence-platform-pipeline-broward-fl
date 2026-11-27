/**
 * Oracle ↔ CRM data contract (`<pkg>/contract`): zod schemas and inferred types for the query
 * inputs and `roofing-views.v1` rows. No runtime dependency on DuckDB — the CRM imports only this.
 * The HTTP API v1 DTOs (detail pages, search, dataset info) are defined below the view rows.
 */
import { z } from "zod";

export const ROOFING_VIEWS_VERSION = "roofing-views.v1" as const;

export const BROWARD = {
  state: "FL",
  name: "Broward",
  fips: "12011",
  center: { lat: 26.15, lon: -80.3 },
  bbox: { minLat: 25.95, maxLat: 26.35, minLon: -80.89, maxLon: -80.03 },
} as const;

export const DEFAULTS = { roofAgeYears: 15, longHeldYears: 10, radiusMiles: 5, limit: 200 } as const;

export const PermitStatus = z.enum(["open", "completed", "other", "needs_review"]);
export const RoofWorkClass = z.enum([
  "primary_roof_replacement",
  "primary_roof_new_construction",
  "repair_or_coating",
  "accessory_roof",
  "other",
]);
export const OwnerLocationClass = z.enum([
  "in_county",
  "in_state_out_of_county",
  "out_of_state",
  "foreign",
  "unknown",
]);
export const OccupancyClass = z.enum([
  "owner_occupied",
  "likely_tenant_occupied",
  "commercial",
  "vacant_land",
  "government_or_exempt",
  "unknown",
]);
export const GeoStatus = z.enum(["parcel_centroid", "missing_geometry", "outside_county"]);
export const RoofAgeBasis = z.enum(["permit", "year_built", "unknown"]);

export const LatLon = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });

export const Provenance = z.object({
  source_url: z.string(),
  retrieved_at: z.string().nullable().optional(),
});

/** Every query row carries provenance, the Elephant property CID and the run's manifest CID. */
const RowMeta = z.object({
  property_cid: z.string().nullable(),
  manifest_cid: z.string().nullable(),
  provenance: z.array(Provenance),
  /** Great-circle distance from the query center, when the query had one. */
  distance_miles: z.number().nullable().optional(),
});

export const AgedRoofsQuery = z.object({
  center: LatLon,
  radiusMiles: z.number().positive().max(50),
  minRoofAgeYears: z.number().int().min(0).default(DEFAULTS.roofAgeYears),
  limit: z.number().int().positive().max(5000).default(DEFAULTS.limit),
});

export const OpenRoofPermitsQuery = z.object({
  center: LatLon,
  radiusMiles: z.number().positive().max(50),
  minOpenYears: z.number().min(0).default(0),
  limit: z.number().int().positive().max(5000).default(DEFAULTS.limit),
});

export const LongHeldQuery = z.object({
  center: LatLon.optional(),
  radiusMiles: z.number().positive().max(50).optional(),
  minYearsSinceTransfer: z.number().int().min(0).default(DEFAULTS.longHeldYears),
  limit: z.number().int().positive().max(5000).default(DEFAULTS.limit),
});

export const OutOfAreaOwnersQuery = z.object({
  center: LatLon.optional(),
  radiusMiles: z.number().positive().max(50).optional(),
  scope: z.enum(["out_of_county", "out_of_state"]).default("out_of_county"),
  limit: z.number().int().positive().max(5000).default(DEFAULTS.limit),
});

export const OccupancyQuery = z.object({
  center: LatLon.optional(),
  radiusMiles: z.number().positive().max(50).optional(),
  occupancy: z.array(OccupancyClass).min(1),
  minRoofAgeYears: z.number().int().min(0).optional(),
  limit: z.number().int().positive().max(5000).default(DEFAULTS.limit),
});

/** `v_property` row (roofing-views.v1). */
export const PropertyRow = z.object({
  parcel_identifier: z.string(),
  /** CID of the property in the published county archive; null for a parcel that archive lacks. */
  property_cid: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  zip: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  geo_status: GeoStatus,
  property_type: z.string().nullable(),
  property_usage_type: z.string().nullable(),
  year_built: z.number().int().nullable(),
  roof_date: z.string().nullable(),
  roof_age_years: z.number().int().nullable(),
  roof_age_basis: RoofAgeBasis.nullable(),
  roof_age_confidence: z.string().nullable(),
  owner_type: z.string().nullable(),
  owner_location_class: OwnerLocationClass.nullable(),
  occupancy_class: OccupancyClass.nullable(),
  homestead: z.boolean().nullable(),
  last_sale_date: z.string().nullable(),
  years_since_transfer: z.number().int().nullable(),
  last_sale_price: z.number().nullable(),
  market_value: z.number().nullable(),
  open_roof_permits: z.number().int(),
  max_open_days: z.number().int().nullable(),
  permit_jurisdiction_covered: z.boolean(),
  /** Which official roll layer the record came from (vintage differs; see docs/SOURCES.md). */
  roll_source: z.enum(["bcpa-taxroll", "bcpa-taxroll-full"]),
  source_url: z.string().nullable(),
  retrieved_at: z.string().nullable(),
});

/** `v_roof_permit` row (roofing-views.v1). BBB fields stay null when no rating is published. */
export const RoofPermitRow = z.object({
  permit_key: z.string(),
  property_improvement_cid: z.string().nullable(),
  parcel_identifier: z.string().nullable(),
  property_cid: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  permit_number: z.string().nullable(),
  permit_type: z.string().nullable(),
  description: z.string().nullable(),
  raw_status: z.string().nullable(),
  status: PermitStatus,
  roof_work_class: RoofWorkClass,
  application_date: z.string().nullable(),
  issue_date: z.string().nullable(),
  completion_date: z.string().nullable(),
  open_days: z.number().int().nullable(),
  open_years: z.number().nullable(),
  contractor_name: z.string().nullable(),
  contractor_license: z.string().nullable(),
  contractor_license_status: z.string().nullable(),
  contractor_company_cid: z.string().nullable(),
  bbb_rating: z.string().nullable(),
  bbb_accredited: z.string().nullable(),
  source_system: z.string(),
  source_url: z.string().nullable(),
  retrieved_at: z.string().nullable(),
});

export const ContractorRow = z.object({
  dbpr_license_id: z.string(),
  contractor_name: z.string().nullable(),
  company_cid: z.string().nullable(),
  license_class: z.string().nullable(),
  license_status: z.string().nullable(),
  license_expiry: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  permits: z.number().int(),
  open_permits: z.number().int(),
  bbb_rating: z.string().nullable(),
  bbb_accredited: z.string().nullable(),
  source_url: z.string(),
});

export const PermitCoverage = z.object({
  jurisdiction: z.string(),
  name: z.string(),
  cities: z.array(z.string()),
  status: z.enum(["covered", "skipped", "blocked"]),
  parcels: z.number().int(),
  permits: z.number().int(),
  roofingPermits: z.number().int(),
  reason: z.string().optional(),
  estimate: z.object({ size: z.string(), time: z.string() }).optional(),
});

export const PropertyLead = PropertyRow.merge(RowMeta);
export const PermitLead = RoofPermitRow.merge(RowMeta);

// ── HTTP API v1 / MCP tool DTOs ──────────────────────────────────────────────────────────────

export const ContractorsQuery = z.object({
  center: LatLon.optional(),
  radiusMiles: z.number().positive().max(50).optional(),
  minOpenPermits: z.number().int().min(0).default(0),
  limit: z.number().int().positive().max(5000).default(DEFAULTS.limit),
});

export const SearchQuery = z.object({
  text: z.string().min(1).max(500),
  mode: z.enum(["hybrid", "text", "semantic"]).default("hybrid"),
  center: LatLon.optional(),
  radiusMiles: z.number().positive().max(50).optional(),
  limit: z.number().int().positive().max(200).default(20),
});

export const SearchHit = z.object({
  doc_id: z.string(),
  kind: z.enum(["permit", "property", "business", "contractor"]),
  ref: z.string(),
  parcel_identifier: z.string().nullable(),
  text: z.string(),
  score: z.number(),
  match: z.array(z.enum(["text", "semantic"])),
});

export const OwnerSummary = z.object({
  owner_type: z.string().nullable(),
  /** Company owners only; individual owner names are never published (Open Q3 default). */
  owner_name: z.string().nullable(),
  owner_location_class: OwnerLocationClass.nullable(),
  owner_mail_state: z.string().nullable(),
  owner_mail_zip5: z.string().nullable(),
  occupancy_class: OccupancyClass.nullable(),
  occupancy_basis: z.string().nullable(),
});

export const SaleRow = z.object({
  date: z.string().nullable(),
  price: z.number().nullable(),
  sale_type: z.string().nullable(),
});

export const TaxRow = z.object({
  tax_year: z.number().int().nullable(),
  market_value: z.number().nullable(),
  assessed_value: z.number().nullable(),
  taxable_value: z.number().nullable(),
  land_value: z.number().nullable(),
  building_value: z.number().nullable(),
});

export const PermitSummary = z.object({
  permit_key: z.string(),
  permit_number: z.string().nullable(),
  permit_type: z.string().nullable(),
  description: z.string().nullable(),
  status: PermitStatus,
  raw_status: z.string().nullable(),
  is_roofing: z.boolean(),
  roof_work_class: RoofWorkClass.nullable(),
  issue_date: z.string().nullable(),
  completion_date: z.string().nullable(),
  open_days: z.number().int().nullable(),
  contractor_name: z.string().nullable(),
  contractor_license: z.string().nullable(),
  parcel_match_method: z.string().nullable(),
  source_url: z.string().nullable(),
});

/** One Lexicon entity behind a record, with its CID (gateway links are built from the CID). */
export const EntityRef = z.object({ class: z.string(), cid: z.string(), source_url: z.string().nullable() });

export const PropertyDetail = z.object({
  property: PropertyLead,
  owner: OwnerSummary.nullable(),
  structure: z.record(z.string(), z.unknown()).nullable(),
  roof_age: z.object({
    basis: RoofAgeBasis.nullable(),
    confidence: z.string().nullable(),
    permit_key: z.string().nullable(),
    policy: z.string().nullable(),
  }),
  sales: z.array(SaleRow),
  tax: z.array(TaxRow),
  permits: z.array(PermitSummary),
  entities: z.array(EntityRef),
  appraiser_url: z.string(),
});

export const PermitDetail = z.object({
  permit: PermitSummary.extend({
    source_system: z.string(),
    jurisdiction: z.string().nullable(),
    application_date: z.string().nullable(),
    final_date: z.string().nullable(),
    est_value: z.number().nullable(),
    dbpr_license_id: z.string().nullable(),
    contractor_license_status: z.string().nullable(),
    bbb_rating: z.string().nullable(),
    bbb_accredited: z.string().nullable(),
    retrieved_at: z.string().nullable(),
    property_improvement_cid: z.string().nullable(),
  }),
  property: PropertyLead.nullable(),
  contractor: ContractorRow.nullable(),
});

export const ContractorDetail = z.object({
  contractor: ContractorRow,
  permits: z.array(PermitLead),
  open_permit_count: z.number().int(),
  bbb: z.object({ rating: z.string().nullable(), accredited: z.string().nullable(), note: z.string() }),
});

export const BusinessDetail = z.object({
  business_key: z.string(),
  name: z.string().nullable(),
  role: z.enum(["property_owner", "contractor"]),
  company_cid: z.string().nullable(),
  license_id: z.string().nullable(),
  source_url: z.string().nullable(),
  properties: z.array(PropertyLead),
  contractor: ContractorRow.nullable(),
  note: z.string(),
});

export const DatasetInfo = z.object({
  manifestCid: z.string().nullable(),
  published: z.boolean(),
  runId: z.string(),
  asOf: z.string(),
  builtAt: z.string(),
  viewsVersion: z.string(),
  counts: z.record(z.string(), z.number()),
  coverage: z.record(z.string(), z.unknown()).nullable(),
  permitCoverage: z.array(PermitCoverage),
  limitations: z.array(z.string()),
});

export const ResolvedPlace = z.object({
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  basis: z.enum(["census_place", "county"]),
  source_url: z.string(),
});

export const SqlResult = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
});

export type AgedRoofsQuery = z.infer<typeof AgedRoofsQuery>;
export type OpenRoofPermitsQuery = z.infer<typeof OpenRoofPermitsQuery>;
export type LongHeldQuery = z.infer<typeof LongHeldQuery>;
export type OutOfAreaOwnersQuery = z.infer<typeof OutOfAreaOwnersQuery>;
export type OccupancyQuery = z.infer<typeof OccupancyQuery>;
export type PropertyRow = z.infer<typeof PropertyRow>;
export type RoofPermitRow = z.infer<typeof RoofPermitRow>;
export type ContractorRow = z.infer<typeof ContractorRow>;
export type PermitCoverage = z.infer<typeof PermitCoverage>;
export type PropertyLead = z.infer<typeof PropertyLead>;
export type PermitLead = z.infer<typeof PermitLead>;

// ── Agent chat (Task 16) ─────────────────────────────────────────────────────────────────────

export const AgentContext = z.object({
  center: LatLon.optional(),
  placeName: z.string().optional(),
  radiusMiles: z.number().optional(),
});

export const ChatTurn = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(20_000),
  /** Returned by the agent on assistant turns; sent back so follow-ups can reuse the area. */
  context: AgentContext.optional(),
});

export const AgentRequest = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(ChatTurn).max(40).default([]),
});

export const AgentAnswer = z.object({
  text: z.string(),
  results: z.array(z.object({ parcelId: z.string(), lat: z.number(), lon: z.number(), label: z.string() })),
  citations: z.array(
    z.object({ parcelId: z.string().optional(), permitKey: z.string().optional(), sourceUrl: z.string() }),
  ),
  assumptions: z.array(z.string()),
  missingData: z.array(z.string()),
  /** Built from the AI SDK step results (what was actually retrieved), never from model text. */
  steps: z.array(
    z.object({
      tool: z.string(),
      args: z.record(z.string(), z.unknown()),
      rowCount: z.number().int(),
      sample: z.array(z.string()),
      error: z.string().optional(),
    }),
  ),
  context: AgentContext,
  manifestCid: z.string().nullable(),
  model: z.string(),
  usage: z.object({ totalTokens: z.number().int() }),
});
export type ContractorsQuery = z.infer<typeof ContractorsQuery>;
export type SearchQuery = z.infer<typeof SearchQuery>;
export type SearchHit = z.infer<typeof SearchHit>;
export type OwnerSummary = z.infer<typeof OwnerSummary>;
export type PermitSummary = z.infer<typeof PermitSummary>;
export type PropertyDetail = z.infer<typeof PropertyDetail>;
export type PermitDetail = z.infer<typeof PermitDetail>;
export type ContractorDetail = z.infer<typeof ContractorDetail>;
export type BusinessDetail = z.infer<typeof BusinessDetail>;
export type DatasetInfo = z.infer<typeof DatasetInfo>;
export type ResolvedPlace = z.infer<typeof ResolvedPlace>;
export type SqlResult = z.infer<typeof SqlResult>;
export type AgentContext = z.infer<typeof AgentContext>;
export type ChatTurn = z.infer<typeof ChatTurn>;
export type AgentRequest = z.infer<typeof AgentRequest>;
export type AgentAnswer = z.infer<typeof AgentAnswer>;

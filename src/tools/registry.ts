/**
 * The one Oracle tool registry (Task 14): name, description, zod input schema and handler over a
 * `SnapshotDb`. The MCP server registers exactly these tools, and the agent maps the same list to
 * AI SDK tools (Task 16), so both surfaces always agree.
 *
 * Tool inputs take a flat `lat`/`lon` center (easier for models and MCP consoles) and map onto the
 * contract query schemas. Outputs are JSON: rows with provenance, `property_cid` and
 * `manifest_cid`, plus `notes` that state what is missing (uncovered permit jurisdictions,
 * unpublished run, BBB blocked) so callers never have to guess.
 */
import { z } from "zod";
import { DEFAULTS, OccupancyClass } from "../contract/index.ts";
import type { SnapshotDb } from "../query/db.ts";
import { resolvePlace } from "../query/places.ts";
import * as Q from "../query/queries.ts";

export interface ToolOutput {
  manifest_cid: string | null;
  published: boolean;
  notes: string[];
  [k: string]: unknown;
}

export interface OracleTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  handler(db: SnapshotDb, input: z.infer<S>): Promise<ToolOutput>;
}

const FTL_SOURCE_SYSTEM = "broward_ftl_arcgis_permits";
/** The Fort Lauderdale layer stopped updating in Jan 2021 (docs/SOURCES.md). */
export const FTL_FROZEN_NOTE =
  "Fort Lauderdale permit statuses come from a city layer frozen in January 2021: a permit shown as open was open at that snapshot and may have closed since; open duration is counted to today.";

/** Default row cap for tool calls (kept small so answers fit a model's context; max 500). */
export const TOOL_DEFAULT_LIMIT = 25;

const lat = z.number().min(-90).max(90).describe("Center latitude (WGS84), e.g. 26.1412 for Fort Lauderdale");
const lon = z
  .number()
  .min(-180)
  .max(180)
  .describe("Center longitude (WGS84), e.g. -80.1467 for Fort Lauderdale");
const radiusMiles = z.number().positive().max(50).describe("Search radius in miles");
const limit = z
  .number()
  .int()
  .positive()
  .max(500)
  .default(TOOL_DEFAULT_LIMIT)
  .describe(`Maximum rows to return (default ${TOOL_DEFAULT_LIMIT}, max 500)`);

function base(db: SnapshotDb, notes: string[] = []): ToolOutput {
  const n = [...notes];
  if (!db.published)
    n.push(
      "Data is from an UNPUBLISHED local run (no manifest CID yet); identifiers are final, CIDs are local.",
    );
  return { manifest_cid: db.manifestCid, published: db.published, notes: n };
}

async function coverageNotes(
  db: SnapshotDb,
  center: { lat: number; lon: number },
  miles: number,
): Promise<string[]> {
  const unc = await Q.uncoveredJurisdictionsInRadius(db, center, miles);
  if (!unc.length) return [];
  const names = unc.map((u) => `${u.name} (${u.status}, ${u.parcels.toLocaleString("en-US")} parcels)`);
  return [
    `No permit data inside this radius for: ${names.join("; ")}. There, roof age comes from the year built, and open permits cannot be listed.`,
  ];
}

const center = (i: { lat?: number; lon?: number }) =>
  i.lat != null && i.lon != null ? { lat: i.lat, lon: i.lon } : undefined;

const tools = [
  {
    name: "dataset_info",
    title: "Dataset info",
    description:
      "Describe the loaded Broward County, FL run: run id, as-of date, manifest CID (null when unpublished), row counts per view, permit coverage by jurisdiction and known limitations. Call this first when unsure what data exists.",
    inputSchema: z.object({}),
    async handler(db) {
      const info = await Q.datasetInfo(db);
      return { ...base(db), ...info };
    },
  },
  {
    name: "resolve_place",
    title: "Resolve place",
    description:
      "Resolve a Broward County place name (city or CDP, e.g. 'Fort Lauderdale', 'Weston') to a center lat/lon from the Census Gazetteer. Returns found:false for places outside Broward; never invent coordinates.",
    inputSchema: z.object({ name: z.string().min(1).describe("Place name, e.g. 'Fort Lauderdale'") }),
    async handler(db, i) {
      const p = resolvePlace(i.name);
      return p
        ? { ...base(db), found: true, place: p }
        : {
            ...base(db, [`'${i.name}' is not a Broward County place in the Census Gazetteer.`]),
            found: false,
            place: null,
          };
    },
  },
  {
    name: "find_aged_roofs",
    title: "Find aged roofs",
    description:
      "Properties within radiusMiles of (lat, lon) whose roof is at least minRoofAgeYears old (default 15). Roof age comes from the latest primary roof permit when one exists, else the year built (see roof_age_basis). Oldest roofs first. Returns total_matching plus up to `limit` rows.",
    inputSchema: z.object({
      lat,
      lon,
      radiusMiles,
      minRoofAgeYears: z
        .number()
        .int()
        .min(0)
        .default(DEFAULTS.roofAgeYears)
        .describe("Minimum roof age in years (default 15)"),
      limit,
    }),
    async handler(db, i) {
      const q = {
        center: { lat: i.lat, lon: i.lon },
        radiusMiles: i.radiusMiles,
        minRoofAgeYears: i.minRoofAgeYears,
        limit: i.limit,
      };
      const [rows, total] = await Promise.all([Q.findAgedRoofs(db, q), Q.countAgedRoofs(db, q)]);
      return {
        ...base(db, await coverageNotes(db, q.center, i.radiusMiles)),
        total_matching: total,
        count: rows.length,
        rows,
      };
    },
  },
  {
    name: "find_open_roof_permits",
    title: "Find open roof permits",
    description:
      "Open roofing permits within radiusMiles of (lat, lon), longest open first, with open duration (open_days, open_years), contractor name and license, and BBB fields (null when no BBB rating is published). Permits with ambiguous dates or status (needs_review) are never included.",
    inputSchema: z.object({
      lat,
      lon,
      radiusMiles,
      minOpenYears: z
        .number()
        .min(0)
        .default(0)
        .describe("Only permits open at least this many years (default 0)"),
      limit,
    }),
    async handler(db, i) {
      const q = {
        center: { lat: i.lat, lon: i.lon },
        radiusMiles: i.radiusMiles,
        minOpenYears: i.minOpenYears,
        limit: i.limit,
      };
      const [rows, total] = await Promise.all([Q.findOpenRoofPermits(db, q), Q.countOpenRoofPermits(db, q)]);
      const notes = await coverageNotes(db, q.center, i.radiusMiles);
      if (rows.length && rows.every((r) => !r.bbb_rating))
        notes.push(
          "No BBB rating on these permits: BBB returned HTTP 403 to automated requests, so no ratings were collected.",
        );
      if (rows.some((r) => r.source_system === FTL_SOURCE_SYSTEM)) notes.push(FTL_FROZEN_NOTE);
      return { ...base(db, notes), total_matching: total, count: rows.length, rows };
    },
  },
  {
    name: "find_long_held_properties",
    title: "Find long-held properties",
    description:
      "Properties whose last recorded transfer is at least minYearsSinceTransfer years ago (default 10), optionally within radiusMiles of (lat, lon). Longest held first.",
    inputSchema: z.object({
      lat: lat.optional(),
      lon: lon.optional(),
      radiusMiles: radiusMiles.optional(),
      minYearsSinceTransfer: z.number().int().min(0).default(DEFAULTS.longHeldYears),
      limit,
    }),
    async handler(db, i) {
      const rows = await Q.findLongHeldProperties(db, {
        center: center(i),
        radiusMiles: i.radiusMiles,
        minYearsSinceTransfer: i.minYearsSinceTransfer,
        limit: i.limit,
      });
      return { ...base(db), count: rows.length, rows };
    },
  },
  {
    name: "find_out_of_area_owners",
    title: "Find out-of-area owners",
    description:
      "Properties whose owner mailing address is outside Broward (scope out_of_county) or outside Florida/abroad (scope out_of_state), optionally within radiusMiles of (lat, lon).",
    inputSchema: z.object({
      lat: lat.optional(),
      lon: lon.optional(),
      radiusMiles: radiusMiles.optional(),
      scope: z.enum(["out_of_county", "out_of_state"]).default("out_of_county"),
      limit,
    }),
    async handler(db, i) {
      const rows = await Q.findOutOfAreaOwners(db, {
        center: center(i),
        radiusMiles: i.radiusMiles,
        scope: i.scope,
        limit: i.limit,
      });
      return { ...base(db), count: rows.length, rows };
    },
  },
  {
    name: "find_by_occupancy",
    title: "Find by occupancy",
    description:
      "Owner & occupancy (tenant) view: properties in the given occupancy classes (e.g. likely_tenant_occupied), optionally with a minimum roof age and within radiusMiles of (lat, lon). Each row carries occupancy_basis (why it was classified so).",
    inputSchema: z.object({
      lat: lat.optional(),
      lon: lon.optional(),
      radiusMiles: radiusMiles.optional(),
      occupancy: z.array(OccupancyClass).min(1),
      minRoofAgeYears: z.number().int().min(0).optional(),
      limit,
    }),
    async handler(db, i) {
      const rows = await Q.findByOccupancy(db, {
        center: center(i),
        radiusMiles: i.radiusMiles,
        occupancy: i.occupancy,
        minRoofAgeYears: i.minRoofAgeYears,
        limit: i.limit,
      });
      return { ...base(db), count: rows.length, rows };
    },
  },
  {
    name: "get_property",
    title: "Get property",
    description:
      "Full record for one parcel by its 12-character Broward folio (parcel_identifier): property, roof age with basis, owner type/location and occupancy (company owner names only), sales, tax values, every permit on the parcel and the Lexicon entity CIDs.",
    inputSchema: z.object({ parcelId: z.string().min(6).describe("Broward folio, e.g. 504201080220") }),
    async handler(db, i) {
      const d = await Q.getProperty(db, i.parcelId);
      return d
        ? { ...base(db), found: true, ...d }
        : { ...base(db, [`No parcel ${i.parcelId} in this run.`]), found: false };
    },
  },
  {
    name: "get_permit",
    title: "Get permit",
    description:
      "One permit by permit_key (as returned by other tools): dates, status, open days, contractor, the property it is linked to and how it was linked.",
    inputSchema: z.object({ permitKey: z.string().min(3) }),
    async handler(db, i) {
      const d = await Q.getPermit(db, i.permitKey);
      return d
        ? { ...base(db), found: true, ...d }
        : { ...base(db, [`No permit ${i.permitKey} in this run.`]), found: false };
    },
  },
  {
    name: "get_business",
    title: "Get business",
    description:
      "A business by business_key (owner:<slug> or dbpr:<license id>) or company CID: role (property owner or contractor), properties owned, contractor license.",
    inputSchema: z.object({ companyId: z.string().min(3) }),
    async handler(db, i) {
      const d = await Q.getBusiness(db, i.companyId);
      return d
        ? { ...base(db), found: true, ...d }
        : { ...base(db, [`No business ${i.companyId} in this run.`]), found: false };
    },
  },
  {
    name: "get_contractor",
    title: "Get contractor",
    description:
      "A licensed contractor by DBPR license id (e.g. CCC1234567) or company CID: license class/status/expiry, BBB fields, roofing permits and open-permit count.",
    inputSchema: z.object({ companyId: z.string().min(3) }),
    async handler(db, i) {
      const d = await Q.getContractor(db, i.companyId);
      return d
        ? { ...base(db), found: true, ...d }
        : { ...base(db, [`No contractor ${i.companyId} in this run.`]), found: false };
    },
  },
  {
    name: "search_records",
    title: "Search records",
    description:
      "Search permits, properties, businesses and contractors by text. mode 'hybrid' (default) fuses BM25 full-text and semantic similarity (local sentence embeddings); 'text' or 'semantic' use one. Optionally restrict to radiusMiles of (lat, lon).",
    inputSchema: z.object({
      text: z.string().min(1).max(500),
      mode: z.enum(["hybrid", "text", "semantic"]).default("hybrid"),
      lat: lat.optional(),
      lon: lon.optional(),
      radiusMiles: radiusMiles.optional(),
      limit: z.number().int().positive().max(200).default(10),
    }),
    async handler(db, i) {
      const rows = await Q.searchRecords(db, {
        text: i.text,
        mode: i.mode,
        center: center(i),
        radiusMiles: i.radiusMiles,
        limit: i.limit,
      });
      return { ...base(db), count: rows.length, rows };
    },
  },
  {
    name: "run_read_only_sql",
    title: "Run read-only SQL",
    description:
      "Run ONE read-only DuckDB SELECT against the roofing views (v_property, v_roof_permit, v_contractor, v_business, v_owner) or Lexicon tables (lx_*). DDL, DML, COPY, ATTACH, INSTALL, PRAGMA, file functions and multiple statements are rejected; rows are capped at maxRows (default 100, max 500). Read the oracle://views-guide resource for columns.",
    inputSchema: z.object({
      sql: z.string().min(1).max(10_000),
      maxRows: z.number().int().positive().max(500).default(100),
    }),
    async handler(db, i) {
      const r = await Q.readOnlySql(db, i.sql, i.maxRows);
      return { ...base(db, r.truncated ? [`Truncated to ${i.maxRows} rows.`] : []), ...r };
    },
  },
] satisfies OracleTool<any>[];

export const ORACLE_TOOLS: OracleTool[] = tools as OracleTool[];

export function getTool(name: string): OracleTool | undefined {
  return ORACLE_TOOLS.find((t) => t.name === name);
}

/** Validate input with the tool's schema, then run it. Throws a ZodError on bad input. */
export async function callTool(db: SnapshotDb, name: string, input: unknown): Promise<ToolOutput> {
  const t = getTool(name);
  if (!t) throw new Error(`unknown tool: ${name}`);
  return t.handler(db, t.inputSchema.parse(input ?? {}));
}

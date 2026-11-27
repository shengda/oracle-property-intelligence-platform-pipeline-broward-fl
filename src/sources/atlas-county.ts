import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SourceRunResult } from "../types.ts";
import { blockMatchesCid } from "../util/cid.ts";
import { newStats, politeFetch, type FetchStats } from "../util/http.ts";
import type { WorkDb } from "../work-db.ts";
import { ATLAS_BROWARD_PAGE_URL } from "./registry.ts";

/**
 * Gateways Atlas itself exports from, in its order (atlas README, Publication step 1). Reading the
 * published Seed only needs one that serves it; every block is checked against its CID or size.
 */
export const ATLAS_READ_GATEWAYS = ["https://ipfs.filebase.io", "https://trustless-gateway.link"];

const AtlasGroup = z.object({
  cid: z.string(),
  schema: z.string(),
  tables: z.string(),
  car: z.string().optional(),
});
export const AtlasPage = z.object({
  county: z.string(),
  state: z.string(),
  fips: z.string(),
  groups: z.record(z.string(), AtlasGroup),
});
export type AtlasPage = z.infer<typeof AtlasPage>;

const TablePart = z.object({ bytes: z.number(), cid: z.object({ "/": z.string() }), rows: z.number() });
export const CountyTablesBlock = z.object({
  label: z.literal("CountyTables"),
  county_root: z.object({ "/": z.string() }),
  tables: z.record(z.string(), z.object({ rows: z.number(), parts: z.array(TablePart) })),
});
export type CountyTablesBlock = z.infer<typeof CountyTablesBlock>;

/** Tables that hold the Seed data group of every published property. */
export const SEED_TABLES = ["parcel", "address", "address_has_parcel"] as const;

/** Columns export-tables adds to every class table; they are not part of the entity JSON. */
const TABLE_META_COLUMNS = new Set(["cid", "property_cid", "data_group_cid"]);

/**
 * Rebuild one entity's JSON from its export-tables row: drop export-tables' own columns and the
 * columns the entity never had (null), and parse `source_http_request` back to an object. This
 * reproduces the hashed file byte for byte after canonicalization (verified: same property CIDs).
 */
export function entityFromTableRow(row: Record<string, unknown>): {
  requestIdentifier: string;
  sourceHttpRequest: Record<string, unknown>;
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = {};
  let requestIdentifier: string | null = null;
  let sourceHttpRequest: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(row)) {
    if (TABLE_META_COLUMNS.has(k) || v === null || v === undefined) continue;
    if (k === "request_identifier") requestIdentifier = String(v);
    else if (k === "source_http_request")
      sourceHttpRequest = typeof v === "string" ? JSON.parse(v) : (v as never);
    else data[k] = v;
  }
  if (!requestIdentifier || !sourceHttpRequest) {
    throw new Error("published Seed entity lacks request_identifier or source_http_request");
  }
  return { requestIdentifier, sourceHttpRequest, data };
}

async function fromGateways(
  cid: string,
  opts: { stats: FetchStats; raw?: boolean; timeoutMs: number; gateways: string[]; fetchImpl?: typeof fetch },
): Promise<Buffer> {
  let last: unknown;
  for (const gw of opts.gateways) {
    const url = `${gw}/ipfs/${cid}${opts.raw ? "?format=raw" : ""}`;
    try {
      const res = await politeFetch(url, {
        stats: opts.stats,
        timeoutMs: opts.timeoutMs,
        minDelayMs: 0,
        retries: 2,
        accept: opts.raw ? "application/vnd.ipld.raw" : "*/*",
        fetchImpl: opts.fetchImpl,
      });
      if (res.status === 200) return res.body;
      last = new Error(`HTTP ${res.status} at ${url}`);
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`no gateway served ${cid}: ${(last as Error)?.message ?? last}`);
}

/**
 * Read Broward's Atlas page and download the Seed tables of the published `county` archive.
 * The CountyTables block is checked against its CID; each Parquet part against the byte size
 * that block records. The build then proves every property CID matches the published archive.
 */
export async function loadAtlasCountySeed(
  db: WorkDb,
  opts: {
    rawDir: string;
    retrievedAt: string;
    pageUrl?: string;
    gateways?: string[];
    fetchImpl?: typeof fetch;
    log?: (m: string) => void;
  },
): Promise<SourceRunResult & { atlas: { county_root: string; tables_root: string; page_sha256: string } }> {
  const stats = newStats();
  const started = new Date().toISOString();
  const gateways = opts.gateways ?? ATLAS_READ_GATEWAYS;
  const pageUrl = opts.pageUrl ?? ATLAS_BROWARD_PAGE_URL;
  const fetchImpl = opts.fetchImpl;
  const pageRes = await politeFetch(pageUrl, { stats, minDelayMs: 0, accept: "application/json", fetchImpl });
  if (pageRes.status !== 200) throw new Error(`HTTP ${pageRes.status} at ${pageUrl}`);
  const page = AtlasPage.parse(JSON.parse(pageRes.body.toString("utf8")));
  const county = page.groups.county;
  if (!county) throw new Error(`Atlas page ${pageUrl} has no county group`);

  const tablesBytes = await fromGateways(county.tables, {
    stats,
    raw: true,
    timeoutMs: 120_000,
    gateways,
    fetchImpl,
  });
  if (!blockMatchesCid(county.tables, tablesBytes)) {
    throw new Error(`CountyTables block from the gateway does not hash to ${county.tables}`);
  }
  const tables = CountyTablesBlock.parse(JSON.parse(tablesBytes.toString("utf8")));
  if (tables.county_root["/"] !== county.cid) {
    throw new Error(`CountyTables ${county.tables} points at ${tables.county_root["/"]}, not ${county.cid}`);
  }

  const dir = path.join(opts.rawDir, "atlas-county", opts.retrievedAt.replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "page.json"), pageRes.body);
  await writeFile(path.join(dir, "county-tables.json"), tablesBytes);
  const files: Record<string, string[]> = {};
  const digest = createHash("sha256").update(pageRes.body).update(tablesBytes);
  for (const t of SEED_TABLES) {
    const entry = tables.tables[t];
    if (!entry) throw new Error(`published archive has no ${t} table`);
    files[t] = [];
    for (const [i, part] of entry.parts.entries()) {
      const cid = part.cid["/"];
      opts.log?.(`atlas-county: ${t} part ${i} (${Math.round(part.bytes / 1e6)} MB) ${cid}`);
      const body = await fromGateways(cid, { stats, timeoutMs: 900_000, gateways, fetchImpl });
      if (body.length !== part.bytes) {
        throw new Error(`${t} part ${cid}: ${body.length} bytes, CountyTables records ${part.bytes}`);
      }
      const file = path.join(dir, `${t}-${String(i).padStart(5, "0")}.parquet`);
      await writeFile(file, body);
      digest.update(body);
      files[t].push(file);
    }
  }

  const list = (t: string) => `[${files[t].map((f) => `'${f}'`).join(",")}]`;
  // One row per published property: its Seed parcel and address rows as JSON (nulls kept here;
  // entityFromTableRow drops them when the entity is rebuilt).
  await db.run(`create or replace table ref_atlas_seed as
select p.parcel_identifier as parcel_id, p.property_cid,
  to_json(p)::VARCHAR as parcel_row, to_json(a)::VARCHAR as address_row
from read_parquet(${list("parcel")}) p
join read_parquet(${list("address_has_parcel")}) r on r.to_cid = p.cid and r.property_cid = p.property_cid
join read_parquet(${list("address")}) a on a.cid = r.from_cid and a.property_cid = p.property_cid`);
  await db.run(`create or replace table ref_atlas_meta as
select '${county.cid}' as county_root, '${county.tables}' as tables_root, '${county.schema}' as schema_cid,
  '${pageUrl}' as page_url, '${opts.retrievedAt}' as retrieved_at`);
  const n = await db.one<{ n: number; d: number; p: number }>(
    "select count(*)::INTEGER n, count(distinct parcel_id)::INTEGER d, count(distinct property_cid)::INTEGER p from ref_atlas_seed",
  );
  const parcels = tables.tables.parcel.rows;
  if (!n || n.n !== parcels || n.d !== parcels || n.p !== parcels) {
    throw new Error(
      `published Seed did not resolve to one row per parcel: ${JSON.stringify(n)} vs ${parcels} parcels`,
    );
  }
  return {
    key: "atlas-county",
    status: "loaded",
    records: n.n,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    requests: stats.requests,
    avgLatencyMs: stats.requests ? Math.round(stats.totalMs / stats.requests) : undefined,
    bytes: stats.bytes,
    sha256: digest.digest("hex"),
    rawPath: dir,
    limitation: `Seed of the published Broward county archive ${county.cid} (tables ${county.tables}); the property_improvement group links permits to these properties.`,
    atlas: {
      county_root: county.cid,
      tables_root: county.tables,
      page_sha256: createHash("sha256").update(pageRes.body).digest("hex"),
    },
  };
}

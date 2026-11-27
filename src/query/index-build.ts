import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  ROOFING_VIEWS_VERSION,
  createRoofingViews,
  materializeRoofingViews,
} from "../views/roofing-views.ts";
import { openWorkDb, type WorkDb } from "../work-db.ts";
import { buildVectorIndex } from "./embeddings.ts";

/** Lexicon tables the roofing views read; created empty when a group has no rows of a class. */
const REQUIRED_LX: Record<string, string> = {
  lx_county_company:
    "cid VARCHAR, property_cid VARCHAR, name VARCHAR, request_identifier VARCHAR, source_http_request VARCHAR",
  lx_county_address_has_geometry: "from_cid VARCHAR, to_cid VARCHAR, property_cid VARCHAR",
  lx_county_geometry: "cid VARCHAR, property_cid VARCHAR, latitude VARCHAR, longitude VARCHAR",
  lx_county_sales_history:
    "cid VARCHAR, property_cid VARCHAR, ownership_transfer_date VARCHAR, purchase_price_amount VARCHAR",
  lx_county_tax: "cid VARCHAR, property_cid VARCHAR, property_market_value_amount VARCHAR",
  lx_property_improvement_property_improvement:
    "cid VARCHAR, property_cid VARCHAR, request_identifier VARCHAR",
  lx_property_improvement_company:
    "cid VARCHAR, property_cid VARCHAR, request_identifier VARCHAR, name VARCHAR",
};

export interface IndexBuildResult {
  path: string;
  tables: Record<string, number>;
  views: Record<string, number>;
  fts: { docs: number };
  vectors: { docs: number; model: string | null; status: "built" | "skipped"; reason?: string };
}

async function tableExists(db: WorkDb, name: string): Promise<boolean> {
  const r = await db.one<{ n: number }>(
    "select count(*)::INTEGER n from information_schema.tables where table_name = ?",
    [name],
  );
  return (r?.n ?? 0) > 0;
}

/**
 * Build `query/index.duckdb` once per run, only from that run's exported Lexicon tables plus the
 * run's supplementary derived tables (classifier outputs). Contains: one table per group class /
 * relationship, `roofing-views.v1`, a full-text index and a vector index.
 */
export async function buildIndex(
  src: { runDir: string; asOf: string; runId: string },
  outPath: string,
  opts: {
    log?: (m: string) => void;
    vectors?: boolean;
    /** Injected embedder (tests); defaults to the local MiniLM model. */
    embedder?: (texts: string[]) => Promise<number[][]>;
  } = {},
): Promise<IndexBuildResult> {
  const log = opts.log ?? (() => {});
  await rm(outPath, { force: true });
  await rm(`${outPath}.wal`, { force: true });
  const db = await openWorkDb(outPath);
  const tables: Record<string, number> = {};
  try {
    await db.run("install fts; load fts; install vss; load vss;");
    const tablesRoot = path.join(src.runDir, "tables");
    for (const group of (await readdir(tablesRoot)).sort()) {
      const gdir = path.join(tablesRoot, group);
      for (const t of (await readdir(gdir)).sort()) {
        const tdir = path.join(gdir, t);
        if (!existsSync(tdir) || t.endsWith(".car") || t.endsWith(".json")) continue;
        const parts = (await readdir(tdir)).filter((f) => f.endsWith(".parquet"));
        if (!parts.length) continue;
        const name = `lx_${group}_${t}`;
        await db.run(
          `create or replace table ${name} as select * from read_parquet('${path.join(tdir, "*.parquet")}')`,
        );
        const n = await db.one<{ n: number }>(`select count(*)::INTEGER n from ${name}`);
        tables[name] = n?.n ?? 0;
      }
    }
    for (const [name, cols] of Object.entries(REQUIRED_LX)) {
      if (!(await tableExists(db, name))) await db.run(`create table ${name} (${cols})`);
    }
    const sup = path.join(src.runDir, "supplement");
    for (const f of (await readdir(sup)).filter((x) => x.endsWith(".parquet")).sort()) {
      const name = `sp_${f.replace(/\.parquet$/, "")}`;
      await db.run(`create or replace table ${name} as select * from read_parquet('${path.join(sup, f)}')`);
      const n = await db.one<{ n: number }>(`select count(*)::INTEGER n from ${name}`);
      tables[name] = n?.n ?? 0;
    }
    // Permit coverage by jurisdiction, from the run's published coverage.json.
    const coverage = JSON.parse(await readFile(path.join(src.runDir, "meta", "coverage.json"), "utf8"));
    await db.run(`create or replace table sp_permit_coverage (jurisdiction VARCHAR, name VARCHAR, cities VARCHAR,
      status VARCHAR, parcels INTEGER, permits INTEGER, roofing_permits INTEGER, reason VARCHAR)`);
    await db.appendRows(
      "sp_permit_coverage",
      (coverage.permit_coverage ?? []).map((j: any) => ({
        jurisdiction: j.jurisdiction,
        name: j.name,
        cities: (j.cities ?? []).join("|"),
        status: j.status,
        parcels: j.parcels,
        permits: j.permits,
        roofing_permits: j.roofingPermits,
        reason: j.reason ?? null,
      })),
    );
    tables.sp_permit_coverage = (coverage.permit_coverage ?? []).length;
    log(`index: ${Object.keys(tables).length} tables loaded`);

    await createRoofingViews(db, { asOf: src.asOf });
    await materializeRoofingViews(db);
    const views: Record<string, number> = {};
    for (const v of ["v_property", "v_roof_permit", "v_contractor", "v_business", "v_owner"]) {
      const n = await db.one<{ n: number }>(`select count(*)::INTEGER n from ${v}`);
      views[v] = n?.n ?? 0;
    }
    log(`index: roofing views ${JSON.stringify(views)}`);

    // Full-text index over permit descriptions, addresses and business names.
    await db.run(`create or replace table fts_docs as
      select 'permit:' || permit_key as doc_id, 'permit' as kind, permit_key as ref, parcel_identifier,
        concat_ws(' ', permit_type, description, raw_status, contractor_name, permit_address) as text
      from sp_permit_details
      union all
      select 'property:' || parcel_identifier, 'property', parcel_identifier, parcel_identifier, concat_ws(' ', address, city, zip)
      from v_property
      union all
      select 'business:' || business_key, 'business', business_key, null, concat_ws(' ', name, role) from v_business`);
    await db.run(`pragma create_fts_index('fts_docs', 'doc_id', 'text', overwrite = 1)`);
    const ftsDocs = (await db.one<{ n: number }>("select count(*)::INTEGER n from fts_docs"))?.n ?? 0;
    log(`index: full-text index over ${ftsDocs} documents`);

    const vectors =
      opts.vectors === false
        ? { docs: 0, model: null, status: "skipped" as const, reason: "disabled (--no-vectors)" }
        : await buildVectorIndex(db, { log, embedder: opts.embedder });

    await db.run(`create or replace table index_meta as select '${ROOFING_VIEWS_VERSION}' as views_version,
      '${src.runId}' as run_id, '${src.asOf}' as as_of, now()::VARCHAR as built_at,
      cast(null as VARCHAR) as manifest_cid`);
    await db.run("checkpoint");
    return { path: outPath, tables, views, fts: { docs: ftsDocs }, vectors };
  } finally {
    await db.close();
  }
}

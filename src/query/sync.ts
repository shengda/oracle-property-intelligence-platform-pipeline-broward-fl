import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, link, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../config.ts";
import { type FileRef, type Manifest, ManifestSchema, RunHistorySchema } from "../publish/manifest.ts";
import { downloadVerified, fetchRawByCid, PUBLIC_GATEWAYS } from "../publish/verify.ts";
import {
  COUNTY_DETAIL_TABLES,
  ROOFING_VIEWS,
  createPermitViews,
  loadMaterializedViews,
} from "../views/roofing-views.ts";
import { openWorkDb, type WorkDb } from "../work-db.ts";
import { finishIndex, loadPermitCoverage } from "./index-build.ts";

type FetchImpl = typeof fetch;

export interface LocalRun {
  /** `cache/published/<manifest cid>/`: meta/, query/, supplement/, tables/, publish/manifest.json. */
  dir: string;
  indexPath: string;
  manifest: Manifest;
  manifestCid: string;
  /** Row counts of the rebuilt views (each equal to the manifest's). */
  views: Record<string, number>;
  /** With `rebuild`: the permit views recomputed from the published Lexicon tables vs the published ones. */
  rebuild?: Record<string, { rows: number; missing: number; extra: number }>;
  downloaded: number;
  cached: number;
  reusedIndex: boolean;
}

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** A file artifact in the CID cache (`cache/ipfs/<cid>`), downloaded and checked when missing. */
async function cached(
  f: FileRef,
  cacheDir: string,
  o: { gateways: string[]; fetchImpl?: FetchImpl },
): Promise<{ file: string; fresh: boolean }> {
  const file = path.join(cacheDir, "ipfs", f.cid);
  if (existsSync(file) && (await stat(file)).size === f.size && (await sha256File(file)) === f.sha256) {
    return { file, fresh: false };
  }
  await mkdir(path.dirname(file), { recursive: true });
  await downloadVerified(f, file, o);
  return { file, fresh: true };
}

async function place(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  await rm(to, { force: true });
  try {
    await link(from, to);
  } catch {
    await copyFile(from, to);
  }
}

/** Fetches and checks the manifest itself: a single raw block that must hash to its CID. */
export async function fetchManifest(
  manifestCid: string,
  o: { gateways?: string[]; fetchImpl?: FetchImpl } = {},
): Promise<Manifest> {
  const bytes = await fetchRawByCid(manifestCid, o);
  return ManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
}

/**
 * Builds `index.duckdb` from a published run's artifacts only: the `property_improvement` Lexicon
 * tables (`lx_*`), the supplement (`sp_*`), the county detail (`qd_*`) and the published views
 * (`mv_*`), then the full-text and vector indexes. No local run, no county archive needed.
 */
export async function buildPublishedIndex(
  dir: string,
  manifest: Manifest,
  manifestCid: string,
  opts: {
    log?: (m: string) => void;
    vectors?: boolean;
    embedder?: (texts: string[]) => Promise<number[][]>;
    rebuild?: boolean;
  } = {},
): Promise<{ views: Record<string, number>; rebuild?: LocalRun["rebuild"] }> {
  const log = opts.log ?? (() => {});
  const indexPath = path.join(dir, "query", "index.duckdb");
  await rm(indexPath, { force: true });
  await rm(`${indexPath}.wal`, { force: true });
  const db = await openWorkDb(indexPath);
  let ok = false;
  try {
    await db.run("install fts; load fts; install vss; load vss;");
    for (const g of manifest.groups) {
      for (const table of [...new Set(g.tables.parts.map((p) => p.table))].sort()) {
        await db.run(
          `create or replace table lx_${g.key}_${table} as select * from read_parquet('${path.join(dir, "tables", g.key, table)}/*.parquet')`,
        );
      }
    }
    for (const a of manifest.artifacts.filter((x) => x.name.startsWith("supplement/"))) {
      const name = `sp_${path.basename(a.name, ".parquet")}`;
      await db.run(
        `create or replace table ${name} as select * from read_parquet('${path.join(dir, a.name)}')`,
      );
    }
    await loadPermitCoverage(db, JSON.parse(await readFile(path.join(dir, "meta", "coverage.json"), "utf8")));
    for (const t of COUNTY_DETAIL_TABLES) {
      await db.run(
        `create or replace table ${t} as select * from read_parquet('${path.join(dir, "query", `${t}.parquet`)}')`,
      );
    }
    await loadMaterializedViews(db, path.join(dir, "query"));
    log(`sync: loaded ${manifest.groups.length} Lexicon group(s), supplement, county detail and views`);

    let rebuild: LocalRun["rebuild"];
    if (opts.rebuild) rebuild = await rebuildPermitViews(db, log);

    const rest = await finishIndex(db, {
      runId: manifest.run_id,
      asOf: manifest.as_of,
      identity: manifest.derived_index.property_identity,
      manifestCid,
      log,
      vectors: opts.vectors,
      embedder: opts.embedder,
    });
    const mismatch = ROOFING_VIEWS.filter((v) => rest.views[v] !== manifest.derived_index.views[v]);
    if (mismatch.length) {
      throw new Error(
        `rebuilt index differs from the published run: ${mismatch
          .map((v) => `${v} ${rest.views[v]} rows, manifest ${manifest.derived_index.views[v]}`)
          .join("; ")}`,
      );
    }
    ok = true;
    return { views: rest.views, rebuild };
  } finally {
    await db.close();
    if (!ok) await rm(indexPath, { force: true });
  }
}

/**
 * Recompute `v_roof_permit` and `v_contractor` from the published `property_improvement` Lexicon
 * tables (property-improvement and contractor CIDs) and the permit supplement, and compare them
 * row for row with the published view Parquet. Any difference fails the sync.
 */
async function rebuildPermitViews(
  db: WorkDb,
  log: (m: string) => void,
): Promise<NonNullable<LocalRun["rebuild"]>> {
  await createPermitViews(db, { prefix: "rb_" });
  const out: NonNullable<LocalRun["rebuild"]> = {};
  for (const v of ["v_roof_permit", "v_contractor"]) {
    const r = await db.one<{ n_rows: number; missing: number; extra: number }>(
      `select (select count(*) from rb_${v})::INTEGER n_rows,
         (select count(*) from (select * from ${v} except all select * from rb_${v}))::INTEGER missing,
         (select count(*) from (select * from rb_${v} except all select * from ${v}))::INTEGER extra`,
    );
    out[v] = { rows: r!.n_rows, missing: r!.missing, extra: r!.extra };
    log(
      `sync --rebuild: ${v} from the Lexicon tables: ${r!.n_rows} rows, ${r!.missing} missing, ${r!.extra} extra`,
    );
  }
  await db.run("drop view rb_v_roof_permit; drop view rb_v_contractor;");
  const bad = Object.entries(out).filter(([, r]) => r.missing || r.extra);
  if (bad.length) {
    throw new Error(
      `published views are not reproducible from the published Lexicon tables: ${bad.map(([v, r]) => `${v} ${r.missing} missing / ${r.extra} extra`).join("; ")}`,
    );
  }
  return out;
}

/**
 * The run history (and, for a run published on this machine, its verification report) next to a
 * synced manifest. A manifest cannot name its history (the history lists the manifest's CID), so
 * it comes from `historyCid` (fetched, checked against its CID, and required to list this
 * manifest) or from the local run whose publish record names this manifest.
 */
async function syncHistory(
  dir: string,
  manifestCid: string,
  o: {
    historyCid?: string;
    runsDir: string;
    gateways: string[];
    fetchImpl?: FetchImpl;
    log: (m: string) => void;
  },
): Promise<string | null> {
  const pub = path.join(dir, "publish");
  let historyCid: string | null = null;
  let history: Buffer | null = null;
  if (o.historyCid) {
    history = await fetchRawByCid(o.historyCid, { gateways: o.gateways, fetchImpl: o.fetchImpl });
    historyCid = o.historyCid;
  } else if (existsSync(o.runsDir)) {
    for (const run of await readdir(o.runsDir)) {
      const rec = path.join(o.runsDir, run, "publish", "publish.json");
      if (!existsSync(rec)) continue;
      const r = JSON.parse(await readFile(rec, "utf8"));
      if (r.manifest_cid !== manifestCid) continue;
      const h = path.join(o.runsDir, run, "publish", "run-history.json");
      if (existsSync(h)) history = await readFile(h);
      historyCid = r.history_cid ?? null;
      const v = path.join(o.runsDir, run, "publish", "verification.json");
      if (existsSync(v)) await copyFile(v, path.join(pub, "verification.json"));
      break;
    }
  }
  if (!history) return null;
  const parsed = RunHistorySchema.parse(JSON.parse(history.toString("utf8")));
  if (!parsed.runs.some((r) => r.manifest_cid === manifestCid)) {
    throw new Error(`run history ${historyCid} does not list manifest ${manifestCid}`);
  }
  await writeFile(path.join(pub, "run-history.json"), history);
  o.log(`sync: run history ${historyCid ?? "(local)"} (${parsed.runs.length} run(s))`);
  return historyCid;
}

/**
 * `oracle sync --manifest <cid>`: fetch the manifest (checked against its CID), download every
 * artifact the index needs (each checked against the manifest's size and SHA-256, cached by CID,
 * offline once cached), lay them out under `cache/published/<cid>/` and build the index there.
 * The index is reused when it was already built for this manifest, unless `rebuild`.
 */
export async function syncRun(opts: {
  manifestCid: string;
  cacheDir?: string;
  gateways?: string[];
  rebuild?: boolean;
  vectors?: boolean;
  embedder?: (texts: string[]) => Promise<number[][]>;
  fetchImpl?: FetchImpl;
  log?: (m: string) => void;
  /** CID of a published run history listing this manifest (the manifest cannot name it). */
  historyCid?: string;
  /** Where local runs live, to pick up the history and verification of a run published here. */
  runsDir?: string;
}): Promise<LocalRun> {
  const log = opts.log ?? (() => {});
  const cacheDir = opts.cacheDir ?? PATHS.cache;
  const gateways = opts.gateways ?? PUBLIC_GATEWAYS;
  const dir = path.join(cacheDir, "published", opts.manifestCid);
  const manifestFile = path.join(dir, "publish", "manifest.json");
  const manifest = existsSync(manifestFile)
    ? ManifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")))
    : await fetchManifest(opts.manifestCid, { gateways, fetchImpl: opts.fetchImpl });
  await mkdir(path.dirname(manifestFile), { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`sync: manifest ${opts.manifestCid} (run ${manifest.run_id}, as of ${manifest.as_of})`);

  const needed: { ref: FileRef; rel: string }[] = [
    ...manifest.artifacts.map((a) => ({ ref: a as FileRef, rel: a.name })),
    ...manifest.groups.flatMap((g) =>
      g.tables.parts.map((p) => ({
        ref: p as FileRef,
        rel: path.join("tables", g.key, p.table, path.basename(p.name)),
      })),
    ),
  ];
  let downloaded = 0;
  let fromCache = 0;
  for (const n of needed) {
    const c = await cached(n.ref, cacheDir, { gateways, fetchImpl: opts.fetchImpl });
    if (c.fresh) downloaded++;
    else fromCache++;
    await place(c.file, path.join(dir, n.rel));
  }
  log(`sync: ${needed.length} files (${downloaded} downloaded, ${fromCache} from the CID cache)`);
  const historyCid = await syncHistory(dir, opts.manifestCid, {
    historyCid: opts.historyCid,
    runsDir: opts.runsDir ?? PATHS.runs,
    gateways,
    fetchImpl: opts.fetchImpl,
    log,
  });
  await writeFile(
    path.join(dir, "publish", "publish.json"),
    `${JSON.stringify({ run_id: manifest.run_id, manifest_cid: opts.manifestCid, history_cid: historyCid, synced_at: new Date().toISOString() }, null, 2)}\n`,
  );

  const indexPath = path.join(dir, "query", "index.duckdb");
  if (!opts.rebuild && existsSync(indexPath)) {
    const db = await openWorkDb(indexPath, { readOnly: true });
    try {
      const m = await db
        .one<{ manifest_cid: string | null }>("select manifest_cid from index_meta")
        .catch(() => null);
      if (m?.manifest_cid === opts.manifestCid) {
        const views: Record<string, number> = {};
        for (const v of ROOFING_VIEWS) {
          views[v] = (await db.one<{ n: number }>(`select count(*)::INTEGER n from ${v}`))?.n ?? 0;
        }
        log("sync: index already built for this manifest");
        return {
          dir,
          indexPath,
          manifest,
          manifestCid: opts.manifestCid,
          views,
          downloaded,
          cached: fromCache,
          reusedIndex: true,
        };
      }
    } finally {
      await db.close();
    }
  }
  const built = await buildPublishedIndex(dir, manifest, opts.manifestCid, {
    log,
    vectors: opts.vectors,
    embedder: opts.embedder,
    rebuild: opts.rebuild,
  });
  return {
    dir,
    indexPath,
    manifest,
    manifestCid: opts.manifestCid,
    views: built.views,
    rebuild: built.rebuild,
    downloaded,
    cached: fromCache,
    reusedIndex: false,
  };
}

import { readFile, statfs, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "./config.ts";
import { enrichFtlContractors } from "./sources/accela-ftl.ts";
import { loadAtlasCountySeed } from "./sources/atlas-county.ts";
import { downloadBcpaTaxroll, stageBcpaTaxroll } from "./sources/bcpa-taxroll.ts";
import { loadCensusPlaces, loadCensusZcta, loadCountyBoundary } from "./sources/census.ts";
import { loadDbprLicenses } from "./sources/dbpr.ts";
import { loadPermitFeed, PERMIT_FEEDS } from "./sources/permits.ts";
import { probeBbb, probeSunbiz } from "./sources/probes.ts";
import { SOURCES } from "./sources/registry.ts";
import { stageParcels } from "./transforms/county/stage.ts";
import type { SourceRunResult } from "./types.ts";
import { openWorkDb, type WorkDb } from "./work-db.ts";

export interface SourcesFile {
  updated_at: string;
  sources: Record<string, SourceRunResult & { previous_sha256?: string | null; changed?: boolean | null }>;
}

export async function readSourcesFile(file = PATHS.sourcesJson): Promise<SourcesFile> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as SourcesFile;
  } catch {
    return { updated_at: new Date(0).toISOString(), sources: {} };
  }
}

/** Ingest keys in run order (bulk first; the bounded crawl last). */
export const INGEST_ORDER = [
  "census-zcta-county",
  "census-places",
  "census-county-boundary",
  "bcpa-taxroll",
  "bcpa-taxroll-full",
  "atlas-county",
  "ftl-permits",
  "weston-permits",
  "hced-permits",
  "dbpr-licenses",
  "ftl-accela-contractors",
  "bbb",
  "sunbiz",
] as const;

export async function ingest(opts: {
  sources?: string[];
  accelaMaxRequests?: number;
  log?: (m: string) => void;
}): Promise<SourcesFile> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const selected = new Set(opts.sources?.length ? opts.sources : INGEST_ORDER);
  for (const s of selected) {
    if (!INGEST_ORDER.includes(s as never) && !SOURCES.some((x) => x.key === s))
      throw new Error(`unknown source ${s}`);
  }
  const file = await readSourcesFile();
  const db = await openWorkDb(PATHS.workDb);
  const retrievedAt = new Date().toISOString();
  const record = (r: SourceRunResult) => {
    const prev = file.sources[r.key];
    file.sources[r.key] = {
      ...r,
      previous_sha256: prev?.sha256 ?? null,
      changed: r.sha256 && prev?.sha256 ? r.sha256 !== prev.sha256 : r.sha256 ? true : null,
    };
    log(`${r.key}: ${r.status} (${r.records} records${r.limitation ? `; ${r.limitation}` : ""})`);
  };
  const save = async () => {
    file.updated_at = new Date().toISOString();
    await mkdir(path.dirname(PATHS.sourcesJson), { recursive: true });
    await writeFile(PATHS.sourcesJson, `${JSON.stringify(file, null, 2)}\n`);
  };
  try {
    for (const key of INGEST_ORDER) {
      if (!selected.has(key)) continue;
      log(`ingest ${key} …`);
      const r = await runSource(db, key, {
        retrievedAt,
        log,
        accelaMaxRequests: opts.accelaMaxRequests ?? 4000,
      });
      for (const x of r) record(x);
      await save();
    }
    // Skipped sources (never fetched) are still listed with their reason and estimate.
    for (const s of SOURCES.filter((x) => x.status === "skipped")) {
      record({
        key: s.key,
        status: "skipped",
        records: 0,
        startedAt: retrievedAt,
        finishedAt: retrievedAt,
        skipReason: s.skipReason,
        estimate: s.estimate,
        limitation: s.limitation,
      });
    }
    await save();
  } finally {
    await db.close();
  }
  return file;
}

async function runSource(
  db: WorkDb,
  key: any,
  ctx: { retrievedAt: string; log: (m: string) => void; accelaMaxRequests: number },
): Promise<SourceRunResult[]> {
  const raw = PATHS.raw;
  switch (key) {
    case "census-zcta-county":
      return [await loadCensusZcta(db, { rawDir: raw, retrievedAt: ctx.retrievedAt })];
    case "census-places":
      return [await loadCensusPlaces(db, { rawDir: raw, retrievedAt: ctx.retrievedAt })];
    case "census-county-boundary":
      return [await loadCountyBoundary(db, { rawDir: raw, retrievedAt: ctx.retrievedAt })];
    case "bcpa-taxroll":
    case "bcpa-taxroll-full": {
      const r = await downloadBcpaTaxroll({ rawDir: raw, retrievedAt: ctx.retrievedAt, key, log: ctx.log });
      const staged = await stageBcpaTaxroll(db, r.rawPath, ctx.retrievedAt, key);
      const s = await stageParcels(db, { asOfYear: Number(ctx.retrievedAt.slice(0, 4)) });
      ctx.log(
        `${key}: staged ${staged} rows → ${s.parcels} parcels (${s.fromFullRoll} from the full roll), ${s.sales} sales (${s.duplicateFolios} duplicate folio rows merged, ${s.invalidParcelIds} invalid ids)`,
      );
      const { fields: _fields, ...rest } = r;
      return [
        {
          ...rest,
          limitation:
            SOURCES.find((x) => x.key === key)?.limitation ??
            (key === "bcpa-taxroll"
              ? "Latest recorded sale in this layer is 2024-09-27; some condominium units are only in bcpa-taxroll-full."
              : undefined),
        },
      ];
    }
    case "atlas-county":
      return [await loadAtlasCountySeed(db, { rawDir: raw, retrievedAt: ctx.retrievedAt, log: ctx.log })];
    case "ftl-permits":
    case "hced-permits": {
      const feed = PERMIT_FEEDS.find((f) => f.key === key)!;
      const r = await loadPermitFeed(db, feed, { rawDir: raw, retrievedAt: ctx.retrievedAt, log: ctx.log });
      if (key === "ftl-permits" && r.status === "loaded") {
        r.limitation = SOURCES.find((s) => s.key === key)?.limitation;
      }
      return [r];
    }
    case "weston-permits": {
      const out: SourceRunResult[] = [];
      for (const f of PERMIT_FEEDS.filter((x) => x.key.startsWith("weston-"))) {
        const r = await loadPermitFeed(db, f, { rawDir: raw, retrievedAt: ctx.retrievedAt, log: ctx.log });
        r.limitation = SOURCES.find((s) => s.key === "weston-permits")?.limitation;
        out.push(r);
      }
      return out;
    }
    case "dbpr-licenses":
      return [await loadDbprLicenses(db, { rawDir: raw, retrievedAt: ctx.retrievedAt })];
    case "ftl-accela-contractors":
      return [
        await enrichFtlContractors(db, {
          maxRequests: ctx.accelaMaxRequests,
          retrievedAt: ctx.retrievedAt,
          log: ctx.log,
        }),
      ];
    case "bbb":
      return [await probeBbb()];
    case "sunbiz": {
      const fs = await statfs(PATHS.work).catch(() => null);
      const freeGb = fs ? Math.round((fs.bavail * fs.bsize) / 1e9) : 0;
      return [await probeSunbiz({ freeDiskGb: freeGb })];
    }
    default:
      throw new Error(`no loader for ${key}`);
  }
}

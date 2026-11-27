/**
 * Resolve which index `oracle serve` / `oracle mcp` answer from: a local run (`--run`, default
 * latest), an explicit `--index` file, or the synthetic fixture (`--fixture`, index built once
 * into cache/). `--manifest <cid>` syncs a published run into cache/published/<cid>/ and serves it.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { latestRun } from "./build/run-build.ts";
import { PATHS, REPO_ROOT, runDir } from "./config.ts";
import { readPublishRecord } from "./publish/commands.ts";
import { openIndex, type SnapshotDb } from "./query/db.ts";
import { writeDerived } from "./query/derived.ts";
import { buildIndex } from "./query/index-build.ts";

export interface IndexSourceOpts {
  run?: string;
  index?: string;
  fixture?: string | boolean;
  manifest?: string;
}

/** Load `.env` (ANTHROPIC_API_KEY etc.) without overriding variables already set. */
export function loadDotEnv(): void {
  const f = path.join(REPO_ROOT, ".env");
  if (!existsSync(f)) return;
  try {
    (process as any).loadEnvFile?.(f);
  } catch {
    /* malformed .env: ignore, variables simply stay unset */
  }
}

/** Digest of the sources that shape a built index (views, index build, QA, derived exports). */
async function indexCodeDigest(): Promise<string> {
  const h = createHash("sha256");
  for (const rel of [
    "src/views",
    "src/query/index-build.ts",
    "src/query/qa.ts",
    "src/query/derived.ts",
    "src/contract/index.ts",
  ]) {
    const abs = path.join(REPO_ROOT, rel);
    const files = (await stat(abs)).isDirectory()
      ? (await readdir(abs))
          .filter((f) => f.endsWith(".ts"))
          .sort()
          .map((f) => path.join(abs, f))
      : [abs];
    for (const f of files) h.update(f.slice(REPO_ROOT.length)).update(await readFile(f));
  }
  return h.digest("hex");
}

/**
 * Lay the fixture out like a real run under cache/fixture-run/: meta/ (copied), query/index.duckdb
 * (built once, rebuilt when the fixture changes) and the derived Parquet/CSV files.
 */
export async function fixtureRun(
  fixture: string | boolean,
  log: (m: string) => void = console.error,
): Promise<[string, { runDir: string }]> {
  const dir = path.resolve(
    typeof fixture === "string" ? fixture : path.join(REPO_ROOT, "fixtures", "elephant-mini"),
  );
  const runDirPath = path.join(PATHS.cache, "fixture-run");
  const out = path.join(runDirPath, "query", "index.duckdb");
  const manifest = path.join(dir, "fixture-manifest.json");
  // Rebuild when the fixture changes, or when the code that builds the index does (new tables,
  // views or QA checks): the stamp records a digest of those sources.
  const stampFile = path.join(runDirPath, "index-build.stamp");
  const stamp = await indexCodeDigest();
  const stale =
    !existsSync(out) ||
    (existsSync(manifest) && (await stat(manifest)).mtimeMs > (await stat(out)).mtimeMs) ||
    (existsSync(stampFile) ? (await readFile(stampFile, "utf8")).trim() !== stamp : true);
  if (stale) {
    log(`building fixture index from ${dir} …`);
    await rm(runDirPath, { recursive: true, force: true });
    await mkdir(path.join(runDirPath, "query"), { recursive: true });
    await cp(path.join(dir, "meta"), path.join(runDirPath, "meta"), { recursive: true });
    await buildIndex({ runDir: dir, asOf: "2026-11-25", runId: "fixture" }, out, { log });
    await writeDerived(out, runDirPath);
    await writeFile(stampFile, `${stamp}\n`);
  }
  return [out, { runDir: runDirPath }];
}

export async function openIndexFrom(
  o: IndexSourceOpts,
  log: (m: string) => void = console.error,
): Promise<SnapshotDb> {
  if (o.manifest) {
    const { syncRun } = await import("./query/sync.ts");
    const { gatewaysFromEnv } = await import("./publish/verify.ts");
    const r = await syncRun({ manifestCid: o.manifest, gateways: gatewaysFromEnv(), log });
    return openIndex(r.indexPath, { runDir: r.dir, manifestCid: r.manifestCid });
  }
  if (o.fixture) return openIndex(...(await fixtureRun(o.fixture, log)));
  if (o.index) return openIndex(path.resolve(o.index));
  const runId = o.run ?? (await latestRun());
  if (!runId)
    throw new Error(
      "no local run found under runs/ — run `oracle run --no-publish` first, or pass --index / --fixture",
    );
  const p = path.join(runDir(runId), "query", "index.duckdb");
  if (!existsSync(p)) throw new Error(`run ${runId} has no index yet — run \`oracle index --run ${runId}\``);
  // A local run that has been published is served with its manifest CID.
  const rec = await readPublishRecord(runDir(runId));
  return openIndex(p, { runDir: runDir(runId), manifestCid: rec?.manifest_cid ?? null });
}

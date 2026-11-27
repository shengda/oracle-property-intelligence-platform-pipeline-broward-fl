/**
 * Resolve which index `oracle serve` / `oracle mcp` answer from: a local run (`--run`, default
 * latest), an explicit `--index` file, or the synthetic fixture (`--fixture`, index built once
 * into cache/). `--manifest <cid>` (a published run) arrives with `oracle sync` in M3.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { latestRun } from "./build/run-build.ts";
import { PATHS, REPO_ROOT, runDir } from "./config.ts";
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
  const stale =
    !existsSync(out) || (existsSync(manifest) && (await stat(manifest)).mtimeMs > (await stat(out)).mtimeMs);
  if (stale) {
    log(`building fixture index from ${dir} …`);
    await rm(runDirPath, { recursive: true, force: true });
    await mkdir(path.join(runDirPath, "query"), { recursive: true });
    await cp(path.join(dir, "meta"), path.join(runDirPath, "meta"), { recursive: true });
    await buildIndex({ runDir: dir, asOf: "2026-11-25", runId: "fixture" }, out, { log });
    await writeDerived(out, runDirPath);
  }
  return [out, { runDir: runDirPath }];
}

export async function openIndexFrom(
  o: IndexSourceOpts,
  log: (m: string) => void = console.error,
): Promise<SnapshotDb> {
  if (o.manifest) {
    throw Object.assign(
      new Error(
        "--manifest (serve a published run by CID) arrives with `oracle sync` in milestone M3; use --run or --index.",
      ),
      { exitCode: 2 },
    );
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
  return openIndex(p, { runDir: runDir(runId) });
}

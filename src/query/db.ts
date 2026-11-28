import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DuckDBValue } from "@duckdb/node-api";
import { openWorkDb, type WorkDb } from "../work-db.ts";

export interface IndexMeta {
  views_version: string;
  run_id: string;
  as_of: string;
  built_at: string;
  manifest_cid: string | null;
}

/**
 * A read-only handle on one run's `query/index.duckdb`. Every query is serialized on one
 * connection (DuckDB connections are not re-entrant), which is plenty for an inspection UI and
 * an MCP server; the hosted deployment runs one handle per Lambda instance.
 */
export interface SnapshotDb {
  readonly path: string;
  readonly meta: IndexMeta;
  /** false for a local, unpublished run (`oracle serve --index`). */
  readonly published: boolean;
  readonly manifestCid: string | null;
  /** The run directory next to the index (`runs/<id>`), when it is a local run. */
  readonly runDir: string | null;
  all<T = Record<string, unknown>>(sql: string, params?: DuckDBValue[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: DuckDBValue[]): Promise<T | null>;
  /** Reads a JSON file from the run's `meta/` directory, or null when absent. */
  readMeta<T = unknown>(name: string): Promise<T | null>;
  /** Reads a JSON file relative to the run directory (e.g. `publish/manifest.json`), or null. */
  readRunFile<T = unknown>(rel: string): Promise<T | null>;
  close(): Promise<void>;
}

async function readJsonIn(runDir: string | null, rel: string): Promise<any> {
  if (!runDir) return null;
  const f = path.join(runDir, rel);
  if (!existsSync(f)) return null;
  return JSON.parse(await readFile(f, "utf8"));
}

export async function openIndex(
  indexPath: string,
  opts: { runDir?: string | null; manifestCid?: string | null } = {},
): Promise<SnapshotDb> {
  if (!existsSync(indexPath)) throw new Error(`index not found: ${indexPath}`);
  const db: WorkDb = await openWorkDb(indexPath, { readOnly: true });
  await db.run("load fts; load vss;");
  // The served index needs nothing outside itself: no files, no network. Locking the setting
  // closes replacement scans (`FROM 'package.json'`) and file functions for every query path,
  // whatever the SQL guard misses.
  await db.run("set enable_external_access = false; set lock_configuration = true;");
  const meta = (await db.one<IndexMeta>("select * from index_meta")) ?? {
    views_version: "unknown",
    run_id: "unknown",
    as_of: "",
    built_at: "",
    manifest_cid: null,
  };
  const guessedRunDir = path.resolve(path.dirname(indexPath), "..");
  const runDir =
    opts.runDir !== undefined
      ? opts.runDir
      : existsSync(path.join(guessedRunDir, "meta"))
        ? guessedRunDir
        : null;
  const manifestCid = opts.manifestCid ?? meta.manifest_cid ?? null;

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  return {
    path: indexPath,
    meta,
    published: manifestCid !== null,
    manifestCid,
    runDir,
    all: (sql, params) => serial(() => db.all(sql, params)),
    one: (sql, params) => serial(() => db.one(sql, params)),
    async readMeta(name) {
      return readJsonIn(runDir, path.join("meta", name));
    },
    async readRunFile(rel) {
      return readJsonIn(runDir, rel);
    },
    close: () => serial(() => db.close()),
  };
}

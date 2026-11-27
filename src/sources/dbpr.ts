import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SourceRunResult } from "../types.ts";
import { newStats, politeFetch } from "../util/http.ts";
import type { WorkDb } from "../work-db.ts";
import { DBPR_CONSTRUCTION_LICENSES_URL } from "./registry.ts";

/**
 * Column layout of the DBPR construction licensee extract (no header row). Verified against the
 * 2026-11-26 file: board, class, licensee name, DBA, …, address, city, state, zip, county code,
 * license number, primary/secondary status, original/effective/expiry dates, full license id.
 */
export const DBPR_COLUMNS = [
  "board",
  "class_code",
  "licensee_name",
  "dba_name",
  "unknown_5",
  "addr_1",
  "addr_2",
  "addr_3",
  "city",
  "state",
  "zip",
  "county_code",
  "license_number",
  "primary_status",
  "secondary_status",
  "original_date",
  "status_effective_date",
  "expiry_date",
  "unknown_19",
  "unknown_20",
  "license_id",
  "unknown_22",
];

export async function loadDbprLicenses(
  db: WorkDb,
  opts: { rawDir: string; retrievedAt: string },
): Promise<SourceRunResult> {
  const startedAt = new Date().toISOString();
  const stats = newStats();
  const res = await politeFetch(DBPR_CONSTRUCTION_LICENSES_URL, { stats, timeoutMs: 600_000, minDelayMs: 0 });
  if (res.status !== 200) throw new Error(`DBPR HTTP ${res.status}`);
  const dir = path.join(opts.rawDir, "dbpr-licenses", opts.retrievedAt.replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "CONSTRUCTIONLICENSE_1.csv");
  await writeFile(file, res.body);
  const sha256 = createHash("sha256").update(res.body).digest("hex");
  const cols = DBPR_COLUMNS.map((c) => `'${c}': 'VARCHAR'`).join(", ");
  await db.run(`create or replace table stg_dbpr as
select *, '${opts.retrievedAt}' as retrieved_at from read_csv('${file}', header=false, quote='"', escape='"',
  columns={${cols}}, ignore_errors=true, null_padding=true, strict_mode=false)`);
  const n = await db.one<{ n: number }>("select count(*)::INTEGER n from stg_dbpr");
  return {
    key: "dbpr-licenses",
    status: "loaded",
    records: n?.n ?? 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    requests: stats.requests,
    avgLatencyMs: stats.requests ? Math.round(stats.totalMs / stats.requests) : undefined,
    bytes: stats.bytes,
    sha256,
    rawPath: file,
  };
}

import type { WorkDb } from "../work-db.ts";

const FORBIDDEN =
  /\b(COPY|ATTACH|DETACH|INSTALL|LOAD|PRAGMA|CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|REPLACE|MERGE|EXPORT|IMPORT|SET|RESET|CALL|CHECKPOINT|VACUUM|USE|BEGIN|COMMIT|ROLLBACK|GRANT)\b/i;
const FILE_FUNCS =
  /\b(read_csv\w*|read_json\w*|read_parquet|read_text|read_blob|parquet_scan|glob|st_read|sniff_csv|getenv)\s*\(/i;

/** Strip string literals and comments so keyword checks do not trip on quoted text. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Validate an agent/user SQL string: exactly one SELECT/WITH statement, no DDL/DML, no file or
 * extension access. Throws with a readable reason.
 */
export function assertReadOnlySql(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  const bare = stripLiterals(trimmed);
  if (bare.includes(";")) throw new Error("only one statement is allowed");
  if (!/^\s*(SELECT|WITH|FROM)\b/i.test(bare)) throw new Error("only SELECT queries are allowed");
  const bad = FORBIDDEN.exec(bare);
  if (bad) throw new Error(`statement keyword ${bad[1].toUpperCase()} is not allowed`);
  const fn = FILE_FUNCS.exec(bare);
  if (fn) throw new Error(`function ${fn[1]} is not allowed`);
  return trimmed;
}

export async function runReadOnlySql(
  db: WorkDb,
  sql: string,
  maxRows = 500,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const q = assertReadOnlySql(sql);
  const cap = Math.max(1, Math.min(maxRows, 5000));
  const rows = await db.all(`select * from (${q}) as q limit ${cap + 1}`);
  return { rows: rows.slice(0, cap), truncated: rows.length > cap };
}

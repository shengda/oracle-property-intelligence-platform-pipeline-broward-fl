import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DuckDBConnection, DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";

/** Thin wrapper over a DuckDB connection used as the internal work store (never published). */
export interface WorkDb {
  readonly conn: DuckDBConnection;
  run(sql: string, params?: DuckDBValue[] | Record<string, DuckDBValue>): Promise<void>;
  all<T = Record<string, unknown>>(
    sql: string,
    params?: DuckDBValue[] | Record<string, DuckDBValue>,
  ): Promise<T[]>;
  one<T = Record<string, unknown>>(
    sql: string,
    params?: DuckDBValue[] | Record<string, DuckDBValue>,
  ): Promise<T | null>;
  appendRows(table: string, rows: Record<string, unknown>[]): Promise<number>;
  close(): Promise<void>;
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    value.constructor?.name?.startsWith("DuckDB")
  ) {
    // DuckDB timestamp/date/decimal value wrappers → ISO-ish strings.
    return String(value);
  }
  return value;
}

export async function openWorkDb(dbPath: string, opts: { readOnly?: boolean } = {}): Promise<WorkDb> {
  if (dbPath !== ":memory:") await mkdir(path.dirname(dbPath), { recursive: true });
  const instance = await DuckDBInstance.create(
    dbPath,
    opts.readOnly ? { access_mode: "READ_ONLY" } : { threads: "4" },
  );
  const conn = await instance.connect();

  const all = async <T>(sql: string, params?: DuckDBValue[] | Record<string, DuckDBValue>): Promise<T[]> => {
    const reader = await conn.runAndReadAll(sql, params as never);
    return reader.getRowObjects().map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = normalize(v);
      return out as T;
    });
  };

  return {
    conn,
    async run(sql, params) {
      await conn.run(sql, params as never);
    },
    all,
    async one(sql, params) {
      const rows = await all<any>(sql, params);
      return rows[0] ?? null;
    },
    async appendRows(table, rows) {
      if (rows.length === 0) return 0;
      const cols = Object.keys(rows[0]);
      const placeholders = `(${cols.map(() => "?").join(", ")})`;
      const chunk = 500;
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk);
        const values: DuckDBValue[] = [];
        for (const r of slice) for (const c of cols) values.push((r[c] ?? null) as DuckDBValue);
        await conn.run(
          `insert into ${table} (${cols.map((c) => `"${c}"`).join(", ")}) values ${slice.map(() => placeholders).join(", ")}`,
          values,
        );
      }
      return rows.length;
    },
    async close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}

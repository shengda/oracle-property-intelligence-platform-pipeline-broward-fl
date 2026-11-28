/* global process, console */
// Installs the DuckDB extensions the hosted server loads (fts, vss) into a fixed directory at
// image build time, with the same @duckdb/node-api version the server runs, so the read-only
// Lambda filesystem never needs to download them. Usage: node scripts/install-duckdb-extensions.mjs <dir>
import { DuckDBInstance } from "@duckdb/node-api";

const dir = process.argv[2];
if (!dir) throw new Error("usage: install-duckdb-extensions.mjs <dir>");
const db = await DuckDBInstance.create(":memory:", { extension_directory: dir });
const conn = await db.connect();
for (const ext of ["fts", "vss"]) {
  await conn.run(`install ${ext}; load ${ext};`);
  console.log(`duckdb: installed ${ext} into ${dir}`);
}

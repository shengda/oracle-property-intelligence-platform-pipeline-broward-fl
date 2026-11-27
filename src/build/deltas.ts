import { existsSync } from "node:fs";
import path from "node:path";
import { openWorkDb } from "../work-db.ts";

export interface Deltas {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
}

/**
 * Per-group deltas from the exported `properties` table: property CID → data-group root CID of
 * this group. A property whose group root CID differs is `changed`.
 */
export async function computeDeltas(prevTablesDir: string | null, curTablesDir: string): Promise<Deltas> {
  const cur = path.join(curTablesDir, "properties", "*.parquet");
  const db = await openWorkDb(":memory:");
  try {
    // The properties table carries one row per property with its data-group map; take the
    // non-seed root as the comparison key.
    const read = (glob: string) =>
      `(select property_cid, data_groups::VARCHAR as groups_json from read_parquet('${glob}'))`;
    const cols = await db.all<{ column_name: string }>(
      `select column_name from (describe select * from read_parquet('${cur}'))`,
    );
    const hasGroups = cols.some((c) => c.column_name === "data_groups");
    const keyExpr = hasGroups
      ? read
      : (glob: string) =>
          `(select property_cid, to_json(t)::VARCHAR as groups_json from read_parquet('${glob}') t)`;
    if (!prevTablesDir || !existsSync(path.join(prevTablesDir, "properties"))) {
      const n = await db.one<{ n: number }>(`select count(*)::INTEGER n from read_parquet('${cur}')`);
      return { added: n?.n ?? 0, changed: 0, removed: 0, unchanged: 0 };
    }
    const prev = path.join(prevTablesDir, "properties", "*.parquet");
    const r = await db.one<Deltas>(`with c as ${keyExpr(cur)}, p as ${keyExpr(prev)}
      select
        count(*) filter (where p.property_cid is null)::INTEGER as added,
        count(*) filter (where c.property_cid is null)::INTEGER as removed,
        count(*) filter (where c.property_cid is not null and p.property_cid is not null and c.groups_json <> p.groups_json)::INTEGER as changed,
        count(*) filter (where c.property_cid is not null and p.property_cid is not null and c.groups_json = p.groups_json)::INTEGER as unchanged
      from c full outer join p on c.property_cid = p.property_cid`);
    return r ?? { added: 0, changed: 0, removed: 0, unchanged: 0 };
  } finally {
    await db.close();
  }
}

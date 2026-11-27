import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { computeDeltas } from "../../src/build/deltas.ts";
import { openWorkDb } from "../../src/work-db.ts";

async function tables(rows: [string, string][]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deltas-"));
  await mkdir(path.join(dir, "properties"));
  const db = await openWorkDb(":memory:");
  const values = rows.map(([p, g]) => `('${p}', '${g}', 'seed-${p}')`).join(",");
  await db.run(
    `copy (select * from (values ${values}) t(property_cid, bafkreigroup, bafkreiseed)) to '${path.join(dir, "properties", "part-00000.parquet")}' (format parquet)`,
  );
  await db.close();
  return dir;
}

test("deltas: changed group root counted as changed; new as added; missing as removed", async () => {
  const prev = await tables([
    ["p1", "g1"],
    ["p2", "g2"],
    ["p3", "g3"],
  ]);
  const cur = await tables([
    ["p1", "g1"],
    ["p2", "g2-new"],
    ["p4", "g4"],
  ]);
  expect(await computeDeltas(prev, cur)).toEqual({ added: 1, changed: 1, removed: 1, unchanged: 1 });
});

test("no-change incremental → all deltas zero", async () => {
  const a = await tables([
    ["p1", "g1"],
    ["p2", "g2"],
  ]);
  const b = await tables([
    ["p1", "g1"],
    ["p2", "g2"],
  ]);
  expect(await computeDeltas(a, b)).toEqual({ added: 0, changed: 0, removed: 0, unchanged: 2 });
});

test("first run: every property is added", async () => {
  const cur = await tables([
    ["p1", "g1"],
    ["p2", "g2"],
  ]);
  expect(await computeDeltas(null, cur)).toEqual({ added: 2, changed: 0, removed: 0, unchanged: 0 });
});

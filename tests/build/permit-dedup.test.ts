import { expect, test } from "vitest";
import { createDrvPermits } from "../../src/build/derive.ts";
import { openWorkDb } from "../../src/work-db.ts";

const rows = [
  // Same key, both open, same source and update date: only the content differs.
  {
    permit_key: "ftl:A",
    source_key: "ftl",
    close_date: null,
    last_update_date: "2020-01-01",
    status: "open",
  },
  {
    permit_key: "ftl:A",
    source_key: "ftl",
    close_date: null,
    last_update_date: "2020-01-01",
    status: "other",
  },
  // The later update wins.
  {
    permit_key: "ftl:B",
    source_key: "ftl",
    close_date: null,
    last_update_date: "2019-05-01",
    status: "open",
  },
  {
    permit_key: "ftl:B",
    source_key: "ftl",
    close_date: null,
    last_update_date: "2020-06-01",
    status: "completed",
  },
  // A closed record wins over a later open one (Weston closed report over issued).
  {
    permit_key: "wes:C",
    source_key: "weston-issued",
    close_date: null,
    last_update_date: "2026-11-01",
    status: "open",
  },
  {
    permit_key: "wes:C",
    source_key: "weston-closed",
    close_date: "2026-10-01",
    last_update_date: null,
    status: "completed",
  },
];

async function pick(order: typeof rows) {
  const db = await openWorkDb(":memory:");
  await db.run(
    "create table stg_permits (permit_key VARCHAR, source_key VARCHAR, close_date VARCHAR, last_update_date VARCHAR, status VARCHAR)",
  );
  await db.appendRows("stg_permits", order);
  await createDrvPermits(db);
  const out = await db.all<{ permit_key: string; status: string }>(
    "select permit_key, status from drv_permits order by permit_key",
  );
  await db.close();
  return out;
}

test("duplicate permit rows resolve to the same row whatever order the source lists them in", async () => {
  const a = await pick(rows);
  const b = await pick([...rows].reverse());
  expect(a).toEqual(b);
  expect(a.map((r) => r.permit_key)).toEqual(["ftl:A", "ftl:B", "wes:C"]);
  expect(a.find((r) => r.permit_key === "ftl:B")!.status).toBe("completed");
  expect(a.find((r) => r.permit_key === "wes:C")!.status).toBe("completed");
});

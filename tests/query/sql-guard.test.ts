import { expect, test } from "vitest";
import { assertReadOnlySql, runReadOnlySql } from "../../src/query/sql-guard.ts";
import { openWorkDb } from "../../src/work-db.ts";

test.each([
  "COPY t TO 'x'",
  "ATTACH 'x'",
  "INSTALL httpfs",
  "PRAGMA x",
  "CREATE TABLE x(a int)",
  "SELECT 1; SELECT 2",
  "select * from read_csv('/etc/passwd')",
  "delete from t",
  "select * from sqlite_scan('x.db', 't')",
  "select * from query('drop table v_property')",
  "select * from 'package.json'",
  'select * from "package.json"',
  "select 1 from v_property join '/etc/passwd' on true",
])("runReadOnlySql rejects %s", (sql) => {
  expect(() => assertReadOnlySql(sql)).toThrow();
});

test("keywords inside string literals are fine", () => {
  expect(assertReadOnlySql("select 'COPY; DROP' as x")).toBe("select 'COPY; DROP' as x");
});

test("runReadOnlySql caps rows at maxRows", async () => {
  const db = await openWorkDb(":memory:");
  const r = await runReadOnlySql(db, "select * from range(100) t(i)", 10);
  expect(r.rows).toHaveLength(10);
  expect(r.truncated).toBe(true);
  await db.close();
});

test("the served index refuses file access even when the guard is bypassed", async () => {
  const { fixtureIndex } = await import("../helpers/fixture-index.ts");
  const { db } = await fixtureIndex();
  await expect(db.all("select * from 'package.json'")).rejects.toThrow(
    /external access|disabled|Permission/i,
  );
  await expect(db.all("select * from read_text('package.json')")).rejects.toThrow();
  await expect(db.all("set enable_external_access = true")).rejects.toThrow(/lock|configuration/i);
  expect((await db.all<{ n: number }>("select count(*)::int n from v_property"))[0].n).toBeGreaterThan(0);
});

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

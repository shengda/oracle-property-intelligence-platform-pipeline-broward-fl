import { expect, test } from "vitest";
import { openWorkDb } from "../src/work-db.ts";

test("work db round-trips rows", async () => {
  const db = await openWorkDb(":memory:");
  await db.run("create table t(id varchar, n integer)");
  expect(await db.appendRows("t", [{ id: "a", n: 1 }])).toBe(1);
  expect(await db.all("select * from t")).toEqual([{ id: "a", n: 1 }]);
  await db.close();
});

test("appendRows handles more rows than one insert chunk and nulls", async () => {
  const db = await openWorkDb(":memory:");
  await db.run("create table t(id varchar, n integer)");
  const rows = Array.from({ length: 1234 }, (_, i) => ({ id: `r${i}`, n: i % 3 === 0 ? null : i }));
  expect(await db.appendRows("t", rows)).toBe(1234);
  expect(await db.one("select count(*)::INTEGER c, count(n)::INTEGER nn from t")).toEqual({
    c: 1234,
    nn: 822,
  });
  await db.close();
});

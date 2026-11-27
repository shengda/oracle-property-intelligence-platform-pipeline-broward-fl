import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { SnapshotDb } from "../../src/query/db.ts";
import { startUiServer } from "../../src/ui/server.ts";
import { fixtureIndex } from "../helpers/fixture-index.ts";

let db: SnapshotDb;
let server: Awaited<ReturnType<typeof startUiServer>>;
let dist: string;

beforeAll(async () => {
  ({ db } = await fixtureIndex());
  dist = await mkdtemp(path.join(tmpdir(), "oracle-ui-dist-"));
  await mkdir(path.join(dist, "assets"));
  await writeFile(path.join(dist, "index.html"), "<!doctype html><div id=root></div>");
  server = await startUiServer({ db, port: 0, staticDir: dist, logger: false });
}, 120_000);
afterAll(async () => {
  await server?.close();
  await db?.close();
});

test("UI: assets written after startup (a rebuild with new hashed names) are served, not index.html", async () => {
  await writeFile(path.join(dist, "assets", "index-NEW.js"), "console.log(1)");
  const res = await fetch(`${server.url}/assets/index-NEW.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/javascript/);
  expect(await res.text()).toBe("console.log(1)");
});

test("UI: unknown paths fall back to index.html; unknown /api paths stay 404 JSON", async () => {
  const page = await fetch(`${server.url}/explorer/deep`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("id=root");
  const api = await fetch(`${server.url}/api/nope`);
  expect(api.status).toBe(404);
  expect(api.headers.get("content-type")).toMatch(/json/);
});

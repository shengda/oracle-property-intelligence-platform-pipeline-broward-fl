import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Every test temp dir (fixture runs, sync caches, fake Atlas pages) goes under one directory per
 * test run, removed at the end: forks inherit TMPDIR, so os.tmpdir() points there in every test.
 */
let dir: string | undefined;

export function setup() {
  dir = mkdtempSync(path.join(tmpdir(), "oracle-tests-"));
  process.env.TMPDIR = dir;
}

export function teardown() {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

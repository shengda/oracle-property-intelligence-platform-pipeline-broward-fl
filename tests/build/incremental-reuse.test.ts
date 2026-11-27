import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { changedCountyInputs, reuseGroupOutputs } from "../../src/build/run-build.ts";

const wm = (sha: string) => ({ sha256: sha, retrieved_at: "2026-11-27", records: 1 });

test("the county group is reused only when none of its inputs changed; permit and DBPR refreshes do not count", () => {
  const prev = {
    "bcpa-taxroll": wm("a"),
    "dor-nal-sdf": wm("b"),
    "ftl-permits": wm("c"),
    "dbpr-licenses": wm("d"),
  };
  expect(changedCountyInputs(prev, { ...prev, "ftl-permits": wm("c2"), "dbpr-licenses": wm("d2") })).toEqual(
    [],
  );
  expect(changedCountyInputs(prev, { ...prev, "bcpa-taxroll": wm("a2") })).toEqual(["bcpa-taxroll"]);
  // A source loaded in one run only is a change.
  expect(changedCountyInputs(prev, { ...prev, sunbiz: wm("s") })).toEqual(["sunbiz"]);
});

test("reused group outputs are hardlinks of the previous run's files (no extra disk)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "oracle-reuse-"));
  const [a, b] = [path.join(root, "a"), path.join(root, "b")];
  await mkdir(path.join(a, "build"), { recursive: true });
  await mkdir(path.join(a, "tables", "county", "property"), { recursive: true });
  await writeFile(path.join(a, "build", "county.car"), "car");
  await writeFile(path.join(a, "build", "county-hash.csv"), "csv");
  await writeFile(path.join(a, "build", "property_improvement.car"), "other group");
  await writeFile(path.join(a, "tables", "county", "property", "part-00000.parquet"), "part");
  await reuseGroupOutputs(a, b, "county");
  for (const f of [
    "build/county.car",
    "build/county-hash.csv",
    "tables/county/property/part-00000.parquet",
  ]) {
    expect((await stat(path.join(b, f))).ino).toBe((await stat(path.join(a, f))).ino);
  }
  await expect(readFile(path.join(b, "build", "property_improvement.car"))).rejects.toThrow();
});

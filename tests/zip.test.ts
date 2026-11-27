import { expect, test } from "vitest";
import { buildZip, readZip } from "../src/util/zip.ts";

test("zip round-trips files in sorted order", () => {
  const z = buildZip([
    { name: "b.json", data: '{"b":1}' },
    { name: "a.json", data: '{"a":1}' },
  ]);
  expect(readZip(z).map((f) => [f.name, f.data.toString()])).toEqual([
    ["a.json", '{"a":1}'],
    ["b.json", '{"b":1}'],
  ]);
});

test("identical inputs give byte-identical archives (deterministic CIDs)", () => {
  const files = [
    { name: "x.json", data: "1" },
    { name: "y.json", data: "2" },
  ];
  expect(buildZip(files).equals(buildZip([...files].reverse()))).toBe(true);
});

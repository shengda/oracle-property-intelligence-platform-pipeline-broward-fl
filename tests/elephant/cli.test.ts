import { expect, test } from "vitest";
import { createElephantCli, ElephantCliError } from "../../src/elephant/cli.ts";

const fake =
  (out: Record<string, { code: number; json: unknown }>) => async (_bin: string, args: string[]) => {
    const cmd = args.find((a) => !a.startsWith("--"))!;
    const r = out[cmd];
    return { code: r.code, stdout: JSON.stringify(r.json), stderr: r.code ? "boom" : "" };
  };

test("cli wrapper parses hash summary", async () => {
  const cli = createElephantCli(
    "fake",
    fake({
      hash: {
        code: 0,
        json: { properties: 1, not_packed: 0, failed: [], car: { root: "bagu…", blocks: 12 } },
      },
    }),
  );
  expect(await cli.hash("in", { zipDir: "z", csv: "c", car: "x.car" })).toEqual({
    root: "bagu…",
    blocks: 12,
    properties: 1,
    notPacked: 0,
    failed: [],
  });
});

test("validate reports errors without throwing (exit 1 = input failed its checks)", async () => {
  const cli = createElephantCli(
    "fake",
    fake({ validate: { code: 1, json: { valid: false, error_count: 3, properties: 2 } } }),
  );
  expect(await cli.validate("in", "e.csv")).toEqual({ valid: false, errors: 3, properties: 2 });
});

test("a command that could not run (exit 2) throws ElephantCliError", async () => {
  const cli = createElephantCli("fake", fake({ "export-tables": { code: 2, json: {} } }));
  await expect(cli.exportTables("x.car", "out", { partSize: "64m" })).rejects.toBeInstanceOf(
    ElephantCliError,
  );
});

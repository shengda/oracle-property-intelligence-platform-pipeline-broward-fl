import { describe, expect, test } from "vitest";
import { publishableSources } from "../../src/build/run-build.ts";

describe("publishableSources", () => {
  test("published raw-capture paths are relative to the repository", () => {
    const out = publishableSources(
      {
        updated_at: "x",
        sources: {
          a: { rawPath: "/home/op/repo/work/raw/a/features.ndjson.gz" },
          b: { rawPath: "work/raw/b" },
          c: {},
        },
      },
      "/home/op/repo",
    );
    expect(out.sources.a.rawPath).toBe("work/raw/a/features.ndjson.gz");
    expect(out.sources.b.rawPath).toBe("work/raw/b");
    expect(JSON.stringify(out)).not.toContain("/home/op");
  });
});

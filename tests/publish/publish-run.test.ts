import { readFile } from "node:fs/promises";
import path from "node:path";
import { CarReader } from "@ipld/car";
import { describe, expect, test } from "vitest";
import { ManifestSchema, manifestDags, manifestFiles } from "../../src/publish/manifest.ts";
import { publishRun } from "../../src/publish/publish-run.ts";
import { FakeIpfs, fakeUploadCli, indexedFixtureRun } from "../helpers/published-fixture.ts";

const quiet = { log: () => {} };

describe("publishRun (fixture run, fake providers)", () => {
  test("manifest lists each group's roots, both CAR files, every Parquet part and every meta and derived file", async () => {
    const { runDir, roots } = await indexedFixtureRun();
    const ipfs = new FakeIpfs();
    const cli = fakeUploadCli(roots);
    const { manifest, manifestCid } = await publishRun(
      { runDir, previousManifestCid: null },
      { cli, primary: ipfs.pinner("filebase"), second: ipfs.pinner("pinata"), ...quiet },
    );
    ManifestSchema.parse(manifest);
    expect(cli.uploads.map((u) => path.relative(runDir, u))).toEqual([
      "build/property_improvement.car",
      "tables/property_improvement",
    ]);
    const [g] = manifest.groups;
    expect(g.key).toBe("property_improvement");
    expect(g.archive).toMatchObject({
      cid: roots["property_improvement.car"],
      codec: "directory",
      ipld_codec: "dag-json",
    });
    expect(g.tables).toMatchObject({
      cid: roots.property_improvement,
      codec: "directory",
      ipld_codec: "dag-json",
    });
    expect(g.archive.car.name).toBe("property_improvement.car");
    expect(g.tables.car.name).toBe("property_improvement-tables/tables.car");
    expect(g.tables.parts.length).toBe(11);
    // Every part was pinned under the CID the tables index records (checked inside publishRun).
    expect(g.tables.parts.every((p) => p.rows > 0)).toBe(true);

    const names = manifest.artifacts.map((a) => a.name);
    for (const n of [
      "query/v_property.parquet",
      "query/qd_sales.parquet",
      "supplement/permit_details.parquet",
      "samples/aged-roofs.csv",
      "meta/coverage.json",
      "meta/state.json",
      "meta/qa.json",
    ]) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain("query/index.duckdb");
    expect(manifest.artifacts.find((a) => a.name === "meta/qa.json")!.kind).toBe("meta");
    expect(manifest.artifacts.find((a) => a.name === "query/v_property.parquet")!.kind).toBe("derived");
    expect(manifest.artifacts.every((a) => a.codec === "file" && /^[0-9a-f]{64}$/.test(a.sha256))).toBe(true);

    const cids = [
      manifestCid,
      ...manifestFiles(manifest).map((f) => f.cid),
      ...manifestDags(manifest).map((d) => d.cid),
    ];
    expect(cids.every((c) => /^b[a-z2-7]+$/.test(c))).toBe(true);
    expect(manifest.encoding.elephant_cli_version).toMatch(/elephant-cli/);
    expect(manifest.derived_index.published).toBe(false);
    expect(manifest.derived_index.views.v_property).toBe(50);
    expect(JSON.stringify(manifest)).not.toMatch(/ipns/i);
    expect(manifest.pins.map((p) => p.provider)).toEqual(["filebase", "pinata"]);

    // The manifest on disk is the published one.
    const onDisk = JSON.parse(await readFile(path.join(runDir, "publish", "manifest.json"), "utf8"));
    expect(ipfs.cidOf(await readFile(path.join(runDir, "publish", "manifest.json")))).toBe(manifestCid);
    expect(onDisk.run_id).toBe(manifest.run_id);
  });

  test("previous_manifest_cid chains runs", async () => {
    const { runDir, roots } = await indexedFixtureRun();
    const ipfs = new FakeIpfs();
    const prev = "bafkreigi3mio4lw6kqmjdvttb2awr3tckiboouqqupqzdg3z4cfkij4m2e";
    const { manifest } = await publishRun(
      { runDir, previousManifestCid: prev },
      {
        cli: fakeUploadCli(roots),
        primary: ipfs.pinner("filebase"),
        second: ipfs.pinner("pinata"),
        ...quiet,
      },
    );
    expect(manifest.previous_manifest_cid).toBe(prev);
  });

  test("a second provider computing a different CID fails the publish", async () => {
    const { runDir, roots } = await indexedFixtureRun();
    const ipfs = new FakeIpfs();
    await expect(
      publishRun(
        { runDir, previousManifestCid: null },
        {
          cli: fakeUploadCli(roots),
          primary: ipfs.pinner("filebase"),
          second: ipfs.pinner("pinata", { corrupt: (n) => n.endsWith("tables.car") }),
          ...quiet,
        },
      ),
    ).rejects.toThrow(/pinata computed .* for property_improvement-tables\/tables.car, filebase/);
  });

  test("an upload reporting another root fails the publish", async () => {
    const { runDir, roots } = await indexedFixtureRun();
    const ipfs = new FakeIpfs();
    await expect(
      publishRun(
        { runDir, previousManifestCid: null },
        {
          cli: fakeUploadCli({ ...roots, property_improvement: roots["property_improvement.car"] }),
          primary: ipfs.pinner("filebase"),
          second: ipfs.pinner("pinata"),
          ...quiet,
        },
      ),
    ).rejects.toThrow(/reported root/);
  });

  test("publish refuses a run whose qa.json has a fail check; force publishes and records qa.overridden", async () => {
    const { runDir, roots } = await indexedFixtureRun({ qaFail: true });
    const ipfs = new FakeIpfs();
    const deps = {
      cli: fakeUploadCli(roots),
      primary: ipfs.pinner("filebase"),
      second: ipfs.pinner("pinata"),
      ...quiet,
    };
    await expect(publishRun({ runDir, previousManifestCid: null }, deps)).rejects.toThrow(/failing check/);
    const { manifest } = await publishRun({ runDir, previousManifestCid: null, force: true }, deps);
    expect(manifest.qa).toMatchObject({ status: "fail", overridden: true });
  });

  test("when the provider refuses tables.car as an incomplete DAG, the complete tables DAG is imported instead", async () => {
    const { runDir, roots } = await indexedFixtureRun();
    const ipfs = new FakeIpfs();
    const cli = fakeUploadCli(roots);
    const upload = cli.upload;
    cli.upload = async (input, opts) => {
      if (input.endsWith("tables/property_improvement")) {
        throw new Error(
          "elephant-cli upload exited 2: the CAR is missing blocks its DAG requires (12 missing)",
        );
      }
      return upload(input, opts);
    };
    const imported: { root: string; blocks: string[] }[] = [];
    const { manifest } = await publishRun(
      { runDir, previousManifestCid: null },
      {
        cli,
        primary: ipfs.pinner("filebase"),
        second: ipfs.pinner("pinata"),
        ...quiet,
        dagImport: async (car) => {
          const r = await CarReader.fromBytes(await readFile(car));
          const blocks: string[] = [];
          for await (const b of r.blocks()) blocks.push(b.cid.toString());
          const root = String((await r.getRoots())[0]);
          imported.push({ root, blocks });
          return root;
        },
      },
    );
    const [g] = manifest.groups;
    expect(g.uploads).toEqual({ archive: "elephant-cli", tables: "complete-car" });
    expect(imported).toHaveLength(1);
    expect(imported[0].root).toBe(roots.property_improvement);
    // CountyTables block + 2 archive blocks + 11 single-block parts.
    expect(imported[0].blocks).toContain(roots.property_improvement);
    for (const p of g.tables.parts) expect(imported[0].blocks).toContain(p.cid);
    expect(imported[0].blocks).toHaveLength(1 + 2 + g.tables.parts.length);
  });
});

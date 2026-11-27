import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { appendRun } from "../../src/publish/manifest.ts";
import { historyEntry, publishRun } from "../../src/publish/publish-run.ts";
import { openIndex } from "../../src/query/db.ts";
import * as Q from "../../src/query/queries.ts";
import { syncRun } from "../../src/query/sync.ts";
import { fakeEmbedder } from "../helpers/fixture-index.ts";
import { FakeIpfs, fakeUploadCli, indexedFixtureRun } from "../helpers/published-fixture.ts";

const GW = ["https://gw-a.example", "https://gw-b.example"];
const FTL = { lat: 26.1224, lon: -80.1373 };

let ipfs: FakeIpfs;
let manifestCid: string;
let localViews: Record<string, number>;
let fixtureRunDir: string;
let publishedManifest: Awaited<ReturnType<typeof publishRun>>["manifest"];

beforeAll(async () => {
  const { runDir, roots } = await indexedFixtureRun();
  ipfs = new FakeIpfs();
  const r = await publishRun(
    { runDir, previousManifestCid: null },
    {
      cli: fakeUploadCli(roots),
      primary: ipfs.pinner("filebase"),
      second: ipfs.pinner("pinata"),
      log: () => {},
    },
  );
  manifestCid = r.manifestCid;
  localViews = r.manifest.derived_index.views;
  fixtureRunDir = runDir;
  publishedManifest = r.manifest;
}, 120_000);

describe("oracle sync --manifest", () => {
  test("rebuilds the index from published artifacts only; --rebuild reproduces the permit views from the Lexicon tables", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "oracle-sync-"));
    const r = await syncRun({
      manifestCid,
      cacheDir,
      runsDir: cacheDir,
      gateways: GW,
      rebuild: true,
      embedder: fakeEmbedder,
      fetchImpl: ipfs.fetch(),
    });
    expect(r.views).toEqual(localViews);
    expect(r.rebuild!.v_roof_permit).toMatchObject({ missing: 0, extra: 0 });
    expect(r.rebuild!.v_roof_permit.rows).toBe(localViews.v_roof_permit);
    expect(r.rebuild!.v_contractor).toMatchObject({ missing: 0, extra: 0 });
    expect(r.downloaded).toBeGreaterThan(20);

    // The synced index answers the same queries, labelled with the manifest CID.
    const db = await openIndex(r.indexPath, { runDir: r.dir, manifestCid });
    try {
      expect(db.published).toBe(true);
      const rows = await Q.findAgedRoofs(db, { center: FTL, radiusMiles: 10, minRoofAgeYears: 0, limit: 5 });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].manifest_cid).toBe(manifestCid);
      const d = await Q.getProperty(db, rows[0].parcel_identifier);
      expect(d!.sales.length + d!.tax.length).toBeGreaterThan(0);
      expect((await Q.searchRecords(db, { text: "reroof", mode: "text", limit: 3 })).length).toBeGreaterThan(
        0,
      );
    } finally {
      await db.close();
    }

    // A second sync is offline: the manifest and every file come from the CID cache.
    const again = await syncRun({
      manifestCid,
      cacheDir,
      gateways: GW,
      fetchImpl: ipfs.fetch({ down: true }),
    });
    expect(again).toMatchObject({ downloaded: 0, reusedIndex: true, views: localViews });
  }, 120_000);

  test("rejects a file whose bytes differ from the manifest's SHA-256 on every gateway", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "oracle-sync-"));
    const tamper = (cid: string, b: Buffer) => (cid === manifestCid ? b : Buffer.from(b).fill(0, 0, 1));
    await expect(
      syncRun({
        manifestCid,
        cacheDir,
        gateways: GW,
        embedder: fakeEmbedder,
        fetchImpl: ipfs.fetch({ tamper }),
      }),
    ).rejects.toThrow(/could not download .*size\/sha256 mismatch/);
  });

  test("rejects a manifest whose bytes do not hash to the requested CID", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "oracle-sync-"));
    const tamper = (cid: string, b: Buffer) =>
      cid === manifestCid ? Buffer.from(b.toString().replace("fixture", "fixturX")) : b;
    await expect(
      syncRun({ manifestCid, cacheDir, gateways: GW, fetchImpl: ipfs.fetch({ tamper }) }),
    ).rejects.toThrow(/do not hash to the CID/);
  });
});

describe("sync --history", () => {
  const verification = {
    ok: true,
    checkedAt: "2026-11-27T00:00:00Z",
    gateways: GW,
    quick: false,
    results: [],
  };
  const history = async (cid: string) =>
    Buffer.from(
      JSON.stringify(
        appendRun(null, await historyEntry(fixtureRunDir, publishedManifest, cid, verification)),
      ),
    );

  test("keeps a history that lists the manifest, refuses one that does not", async () => {
    const ok = await history(manifestCid);
    const bad = await history("bafkreihndgnyrwxk7pqrt4hbdng4zpthn4h75bpg37e4224m3bz6ixoj4u");
    const [okCid, badCid] = [ipfs.cidOf(ok), ipfs.cidOf(bad)];
    ipfs.blobs.set(okCid, ok);
    ipfs.blobs.set(badCid, bad);
    const cacheDir = await mkdtemp(path.join(tmpdir(), "oracle-sync-"));
    const common = {
      manifestCid,
      cacheDir,
      runsDir: cacheDir,
      gateways: GW,
      embedder: fakeEmbedder,
      fetchImpl: ipfs.fetch(),
    };
    await expect(syncRun({ ...common, historyCid: badCid })).rejects.toThrow(/does not list manifest/);
    const r = await syncRun({ ...common, historyCid: okCid });
    expect(
      JSON.parse(await readFile(path.join(r.dir, "publish", "run-history.json"), "utf8")).runs[0]
        .manifest_cid,
    ).toBe(manifestCid);
    expect(JSON.parse(await readFile(path.join(r.dir, "publish", "publish.json"), "utf8")).history_cid).toBe(
      okCid,
    );
  }, 120_000);
});

import { createHash } from "node:crypto";
import { CarWriter } from "@ipld/car";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, test } from "vitest";
import { appendRun, type Manifest, type RunHistoryEntry } from "../../src/publish/manifest.ts";
import {
  assertPublicGateways,
  checkDag,
  checkDagSample,
  checkTablesRoot,
  verifyManifest,
} from "../../src/publish/verify.ts";
import { FakeIpfs } from "../helpers/published-fixture.ts";

const GW = ["https://gw-a.example", "https://gw-b.example"];
const noSleep = async () => {};

function manifestFor(files: { name: string; cid: string; bytes: Buffer }[]): Manifest {
  return {
    artifacts: files.map((f) => ({
      name: f.name,
      cid: f.cid,
      size: f.bytes.length,
      sha256: createHash("sha256").update(f.bytes).digest("hex"),
      codec: "file",
      media_type: "application/json",
      kind: "meta",
    })),
    groups: [],
  } as unknown as Manifest;
}

function store() {
  const ipfs = new FakeIpfs();
  const a = Buffer.from('{"a":1}');
  const b = Buffer.from("x".repeat(5000));
  const files = [
    { name: "meta/a.json", cid: ipfs.cidOf(a), bytes: a },
    { name: "meta/b.json", cid: ipfs.cidOf(b), bytes: b },
  ];
  for (const f of files) ipfs.blobs.set(f.cid, f.bytes);
  return { ipfs, files, manifest: manifestFor(files) };
}

/** Routes requests per gateway host to its own fetch. */
function perGateway(map: Record<string, typeof fetch>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    map[new URL(String(input)).origin](input, init)) as typeof fetch;
}

describe("verifyManifest", () => {
  test("passes when both gateways return matching bytes", async () => {
    const { ipfs, manifest } = store();
    const r = await verifyManifest(manifest, { gateways: GW, fetchImpl: ipfs.fetch(), sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(4);
    expect(r.results.every((x) => x.ok && x.mode === "bytes" && x.attempts === 1)).toBe(true);
  });

  test("digest mismatch on one gateway → ok false with that result flagged", async () => {
    const { ipfs, manifest, files } = store();
    const bad = ipfs.fetch({
      tamper: (cid, b) => (cid === files[1].cid ? Buffer.from("y".repeat(b.length)) : b),
    });
    const r = await verifyManifest(manifest, {
      gateways: GW,
      fetchImpl: perGateway({ [GW[0]]: ipfs.fetch(), [GW[1]]: bad }),
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    const failed = r.results.filter((x) => !x.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ name: "meta/b.json", gateway: GW[1], attempts: 1 });
    expect(failed[0].error).toMatch(/sha256/);
  });

  test("timeouts retry with backoff, then report attempts and 'timeout' without hanging", async () => {
    const { manifest } = store();
    const sleeps: number[] = [];
    const hang = ((_: string | URL | Request, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      )) as typeof fetch;
    const r = await verifyManifest(manifest, {
      gateways: GW,
      fetchImpl: hang,
      timeoutMs: 20,
      retries: 4,
      concurrency: 4,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(r.ok).toBe(false);
    expect(r.results.every((x) => x.attempts === 4 && x.error === "timeout")).toBe(true);
    // Four jobs, each backing off 2 s, 4 s, 8 s between its four attempts.
    expect([...sleeps].sort((a, b) => a - b)).toEqual([
      2000, 2000, 2000, 2000, 4000, 4000, 4000, 4000, 8000, 8000, 8000, 8000,
    ]);
  });

  test("a 429 is retried and a later success counts", async () => {
    const { ipfs, manifest } = store();
    let n = 0;
    const flaky = ((input: string | URL | Request, init?: RequestInit) =>
      n++ === 0
        ? Promise.resolve(new Response("slow down", { status: 429 }))
        : ipfs.fetch()(input, init)) as typeof fetch;
    const r = await verifyManifest(manifest, {
      gateways: GW,
      fetchImpl: flaky,
      sleep: noSleep,
      concurrency: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.results[0].attempts).toBe(2);
  });

  test("only-local gateways are rejected", () => {
    expect(() => assertPublicGateways(["http://127.0.0.1:8080", "https://ipfs.filebase.io"])).toThrow(
      /local/,
    );
    expect(() => assertPublicGateways(["http://localhost:8080", "https://ipfs.filebase.io"])).toThrow(
      /local/,
    );
    expect(() => assertPublicGateways(["https://ipfs.filebase.io"])).toThrow(/two public gateways/);
    expect(() => assertPublicGateways(GW)).not.toThrow();
  });
});

async function carOf(blocks: { cid: CID; bytes: Uint8Array }[], root: CID): Promise<Buffer> {
  // @ipld/car bundles its own multiformats; the CIDs are the same values.
  const { writer, out } = CarWriter.create([root as never]);
  const chunks: Uint8Array[] = [];
  const done = (async () => {
    for await (const c of out) chunks.push(c);
  })();
  for (const b of blocks) await writer.put(b as never);
  await writer.close();
  await done;
  return Buffer.concat(chunks);
}

describe("checkDag (trustless CAR)", () => {
  test("an intact DAG passes; a tampered block fails", async () => {
    const leaf = new TextEncoder().encode('{"leaf":true}');
    const leafCid = CID.create(1, 0x0129, await sha256.digest(leaf));
    const root = new TextEncoder().encode(JSON.stringify({ link: { "/": leafCid.toString() } }));
    const rootCid = CID.create(1, 0x0129, await sha256.digest(root));
    const good = await carOf(
      [
        { cid: rootCid, bytes: root },
        { cid: leafCid, bytes: leaf },
      ],
      rootCid,
    );
    const bad = await carOf(
      [
        { cid: rootCid, bytes: root },
        { cid: leafCid, bytes: new TextEncoder().encode('{"leaf":false}') },
      ],
      rootCid,
    );
    const serve = (car: Buffer) =>
      (async () => new Response(car, { status: 200 })) as unknown as typeof fetch;
    const o = (car: Buffer) => ({ fetchImpl: serve(car), timeoutMs: 5000 });
    expect(await checkDag(GW[0], { cid: rootCid.toString(), expectBlocks: 2 }, o(good))).toMatchObject({
      ok: true,
      blocks: 2,
    });
    const r = await checkDag(GW[0], { cid: rootCid.toString() }, o(bad));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/does not hash to its CID/);
    const wrongCount = await checkDag(GW[0], { cid: rootCid.toString(), expectBlocks: 3 }, o(good));
    expect((wrongCount as { error: string }).error).toMatch(/2 blocks ≠ 3/);
  });
});

describe("run history", () => {
  const entry = (
    run_id: string,
    manifest_cid: string,
    previous_manifest_cid: string | null,
  ): RunHistoryEntry => ({
    run_id,
    mode: previous_manifest_cid ? "incremental" : "full",
    simulated: run_id.includes("sim"),
    as_of: "2026-11-27",
    started_at: null,
    finished_at: null,
    sources: {},
    deltas_by_group: {},
    groups: [
      { key: "property_improvement", archive_root: `${manifest_cid}a`, tables_root: `${manifest_cid}t` },
    ],
    derived: [],
    qa: { status: "warn", overridden: false, cid: null },
    manifest_cid,
    previous_manifest_cid,
    verification: { ok: true, checkedAt: "2026-11-27T00:00:00Z", gateways: GW },
  });

  test("appendRun keeps previous CIDs, chains previous_manifest_cid and labels simulated runs", () => {
    const h1 = appendRun(null, entry("r1", "bafkreione", null));
    const h2 = appendRun(h1, entry("r2-sim", "bafkreitwo", "bafkreione"));
    expect(h2.runs.map((r) => r.manifest_cid)).toEqual(["bafkreione", "bafkreitwo"]);
    expect(h2.runs[0]).toEqual(h1.runs[0]);
    expect(h2.runs[1].simulated).toBe(true);
    expect(h1.runs).toHaveLength(1); // pure
    expect(() => appendRun(h2, entry("r3", "bafkreithree", "bafkreione"))).toThrow(/chains to/);
    // Re-publishing the latest run replaces only its own entry.
    expect(
      appendRun(h2, entry("r2-sim", "bafkreitwo2", "bafkreione")).runs.map((r) => r.manifest_cid),
    ).toEqual(["bafkreione", "bafkreitwo2"]);
  });
});

describe("checkTablesRoot", () => {
  const archive = "baguqeera2jyy5dburmd3iykey4gkad7bzwktnj5fix4cmusjq5d3nqetpw7a";
  async function served(parts: string[]) {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        label: "CountyTables",
        county_root: { "/": archive },
        tables: {
          t: { rows: parts.length, parts: parts.map((c) => ({ cid: { "/": c }, bytes: 1, rows: 1 })) },
        },
      }),
    );
    const cid = CID.create(1, 0x0129, await sha256.digest(bytes)).toString();
    const f = (async () => new Response(bytes)) as unknown as typeof fetch;
    return { cid, f };
  }
  const p1 = "bafkreigdrq3tmzv6wk4ymglnlncrxflgsdkcw6g4z6hmzbbtdtp4lxvdqi";
  const p2 = "bafkreid2ygifq6qt4agza4bcaevednzlsgery2pbeas2pgqjiyofmy75yi";
  const o = (f: typeof fetch) => ({ timeoutMs: 1000, fetchImpl: f }) as never;

  test("passes when the root links exactly the archive and the manifest's parts", async () => {
    const { cid, f } = await served([p1, p2]);
    expect(
      await checkTablesRoot(GW[0], { cid, archiveCid: archive, partCids: [p2, p1] }, o(f)),
    ).toMatchObject({ ok: true, blocks: 3 });
  });

  test("fails when the parts it links differ from the manifest's", async () => {
    const { cid, f } = await served([p1]);
    const r = await checkTablesRoot(GW[0], { cid, archiveCid: archive, partCids: [p1, p2] }, o(f));
    expect(r).toMatchObject({ ok: false });
  });
});

describe("a gateway answering ?format=raw with a cached CAR", () => {
  test("checkBlock reads the requested block out of the CAR and stops", async () => {
    const mk = async (t: string) => {
      const bytes = new TextEncoder().encode(t);
      return { cid: CID.create(1, 0x0129, await sha256.digest(bytes)), bytes };
    };
    const [root, child] = [await mk('{"root":1}'), await mk('{"child":2}')];
    const { writer, out } = CarWriter.create([root.cid as never]);
    const chunks: Uint8Array[] = [];
    const done = (async () => {
      for await (const c of out) chunks.push(c);
    })();
    await writer.put(root as never);
    await writer.put(child as never);
    await writer.close();
    await done;
    const car = Buffer.concat(chunks);
    const f = (async () =>
      new Response(car, {
        headers: { "content-type": "application/vnd.ipld.car; version=1" },
      })) as unknown as typeof fetch;
    const r = await checkDagSample(GW[0], { cid: root.cid.toString(), sample: 1 }, {
      timeoutMs: 1000,
      fetchImpl: f,
    } as never);
    expect(r).toMatchObject({ ok: true, blocks: 1 });
  });
});

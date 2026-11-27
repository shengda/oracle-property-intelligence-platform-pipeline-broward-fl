import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CarBlockIterator, CarReader, CarWriter } from "@ipld/car";
import { CID } from "multiformats/cid";
import { CODEC, parseCid } from "../util/cid.ts";

type FetchImpl = typeof fetch;

/** Every block of a CAR stream, each checked to hash (sha2-256) to its CID. */
async function* verifiedBlocks(
  source: AsyncIterable<Uint8Array>,
  what: string,
): AsyncGenerator<{ cid: CID; bytes: Uint8Array }> {
  const it = await CarBlockIterator.fromIterable(source);
  for await (const b of it) {
    const digest = createHash("sha256").update(b.bytes).digest();
    if (b.cid.multihash.code !== 0x12 || !Buffer.from(b.cid.multihash.digest).equals(digest)) {
      throw new Error(`${what}: block ${b.cid} does not hash to its CID`);
    }
    yield { cid: CID.parse(b.cid.toString()), bytes: b.bytes };
  }
}

/**
 * Writes the complete tables DAG as one CAR rooted at the `CountyTables` block: that block, every
 * block of the archive it points back at (from the local archive CAR), and every block of each
 * Parquet part. A raw part is its own single block (read locally, checked against its CID); a
 * multi-block part is read from `blocksGateway` as a trustless CAR, every block checked.
 *
 * Needed because Filebase's `dag/import` refuses a CAR that is not a complete DAG, and
 * `export-tables` writes `tables.car` with the root block only (observed 2026-11-27,
 * elephant-cli 2.0.0-alpha.0: "the CAR is missing blocks its DAG requires (12 missing)").
 */
export async function writeCompleteTablesCar(opts: {
  tablesCar: string;
  archiveCar: string;
  parts: { file: string; cid: string }[];
  out: string;
  blocksGateway: string;
  fetchImpl?: FetchImpl;
}): Promise<{ root: string; blocks: number }> {
  const f = opts.fetchImpl ?? fetch;
  const tables = await CarReader.fromBytes(await readFile(opts.tablesCar));
  const [rootAny] = await tables.getRoots();
  const root = CID.parse(rootAny.toString());
  const { writer, out } = CarWriter.create([root as never]);
  const written = pipeline(Readable.from(out), createWriteStream(opts.out));
  const seen = new Set<string>();
  const put = async (b: { cid: CID; bytes: Uint8Array }) => {
    const k = b.cid.toString();
    if (seen.has(k)) return;
    seen.add(k);
    await writer.put(b as never);
  };
  try {
    for await (const b of tables.blocks()) await put({ cid: CID.parse(b.cid.toString()), bytes: b.bytes });
    for await (const b of verifiedBlocks(
      createReadStream(opts.archiveCar) as unknown as AsyncIterable<Uint8Array>,
      opts.archiveCar,
    )) {
      await put(b);
    }
    for (const p of opts.parts) {
      if (parseCid(p.cid).codec === CODEC.raw) {
        const bytes = await readFile(p.file);
        if (!parseCid(p.cid).digest.equals(createHash("sha256").update(bytes).digest())) {
          throw new Error(`${p.file} does not hash to ${p.cid}`);
        }
        await put({ cid: CID.parse(p.cid), bytes });
        continue;
      }
      const res = await f(`${opts.blocksGateway}/ipfs/${p.cid}?format=car&dag-scope=all`, {
        headers: { accept: "application/vnd.ipld.car" },
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!res.ok || !res.body)
        throw new Error(`blocks of ${p.cid}: HTTP ${res.status} from ${opts.blocksGateway}`);
      for await (const b of verifiedBlocks(res.body as unknown as AsyncIterable<Uint8Array>, p.cid))
        await put(b);
    }
  } finally {
    await writer.close();
    await written;
  }
  return { root: root.toString(), blocks: seen.size };
}

/** `dag/import` of a complete CAR into a Kubo RPC (Filebase pins what it imports); returns the root. */
export async function importCar(
  car: string,
  opts: { api: string; token: string; fetchImpl?: FetchImpl },
): Promise<string> {
  const form = new FormData();
  form.append("file", await openAsBlob(car), "tables.car");
  const res = await (opts.fetchImpl ?? fetch)(`${opts.api}/api/v0/dag/import?pin-roots=true`, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.token}` },
    body: form,
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`dag/import: HTTP ${res.status}: ${text.slice(0, 300)}`);
  const roots = text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { Root?: { Cid?: { "/": string }; PinErrorMsg?: string } })
    .filter((x) => x.Root);
  const r = roots[0]?.Root;
  if (!r?.Cid) throw new Error(`dag/import: no root in response: ${text.slice(0, 300)}`);
  if (r.PinErrorMsg) throw new Error(`dag/import: pin failed: ${r.PinErrorMsg}`);
  return r.Cid["/"];
}

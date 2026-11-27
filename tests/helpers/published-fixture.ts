import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CarWriter } from "@ipld/car";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type { ElephantCli } from "../../src/elephant/cli.ts";
import type { Pinner } from "../../src/publish/providers.ts";
import { writeDerived } from "../../src/query/derived.ts";
import { buildIndex } from "../../src/query/index-build.ts";
import { cidFor } from "./cid.ts";
import { FIXTURE_DIR, fakeEmbedder } from "./fixture-index.ts";

/**
 * In-memory IPFS for tests. Files up to one block (256 KiB) get their real CIDv1 raw CID, which is
 * what Filebase and Pinata compute for them; larger files get a stand-in CID (tests verify those by
 * size + SHA-256 only, as the code does).
 */
export class FakeIpfs {
  readonly blobs = new Map<string, Buffer>();
  cidOf(bytes: Buffer): string {
    return bytes.length <= 262_144 ? cidFor([0x55], bytes) : cidFor([0x70], bytes);
  }
  pinner(provider: string, opts: { corrupt?: (name: string) => boolean } = {}): Pinner & { added: string[] } {
    const added: string[] = [];
    return {
      provider,
      added,
      addFile: async (file, name) => {
        let bytes = await readFile(file);
        if (opts.corrupt?.(name)) bytes = Buffer.concat([bytes, Buffer.from("x")]);
        const cid = this.cidOf(bytes);
        this.blobs.set(cid, bytes);
        added.push(name);
        return { cid, size: bytes.length };
      },
    };
  }
  /** A gateway serving the store: `/ipfs/<cid>` (bytes) and `?format=raw` (single block). */
  fetch(opts: { tamper?: (cid: string, b: Buffer) => Buffer; down?: boolean } = {}): typeof fetch {
    return (async (input: string | URL | Request) => {
      if (opts.down) throw new Error("network down");
      const url = new URL(String(input));
      const cid = url.pathname.split("/")[2];
      const b = this.blobs.get(cid);
      if (!b) return new Response("not found", { status: 404 });
      return new Response(opts.tamper ? opts.tamper(cid, b) : b, { status: 200 });
    }) as typeof fetch;
  }
}

/** A fake elephant-cli whose upload reports the roots the run state recorded. */
export function fakeUploadCli(
  roots: Record<string, string>,
): Pick<ElephantCli, "upload"> & { uploads: string[] } {
  const uploads: string[] = [];
  return {
    uploads,
    async upload(input, opts) {
      uploads.push(input);
      const root = roots[path.basename(input)] ?? roots[input];
      const summary = { api: opts.api, root };
      await writeFile(opts.summaryJson, JSON.stringify(summary));
      return { root, summary };
    },
  };
}

/** A small valid CAR standing in for an archive: header root `root`, two self-consistent blocks. */
export async function tinyCar(root: string): Promise<Buffer> {
  const blocks = await Promise.all(
    ['{"a":1}', '{"b":2}'].map(async (t) => {
      const bytes = new TextEncoder().encode(t);
      return { cid: CID.create(1, 0x0129, await sha256.digest(bytes)), bytes };
    }),
  );
  const { writer, out } = CarWriter.create([CID.parse(root) as never]);
  const chunks: Uint8Array[] = [];
  const done = (async () => {
    for await (const c of out) chunks.push(c);
  })();
  for (const b of blocks) await writer.put(b as never);
  await writer.close();
  await done;
  return Buffer.concat(chunks);
}

/**
 * The fixture laid out as an indexed run ready to publish: meta/ with QA passing (or one failing
 * check with `qaFail`), query/ + samples/ from the real index build, a stand-in archive CAR.
 */
export async function indexedFixtureRun(opts: { qaFail?: boolean } = {}): Promise<{
  runDir: string;
  roots: Record<string, string>;
}> {
  const runDir = path.join(await mkdtemp(path.join(tmpdir(), "oracle-pubfx-")), "run");
  await cp(FIXTURE_DIR, runDir, { recursive: true });
  await mkdir(path.join(runDir, "build"), { recursive: true });

  const statePath = path.join(runDir, "meta", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.mode = "full";
  state.status = "indexed";
  state.previous_run_id = null;
  state.lexicon_manifest_url = "https://lexicon.elephant.xyz/api/manifest";
  state.started_at = "2026-11-25T00:00:00.000Z";
  state.finished_at = "2026-11-25T01:00:00.000Z";
  for (const g of state.groups) {
    g.car = `build/${g.group}.car`;
    g.tables_dir = `tables/${g.group}`;
    g.blocks = 10;
    g.notPacked = 0;
  }
  await writeFile(statePath, JSON.stringify(state));
  const pi = state.groups.find((g: any) => g.group === "property_improvement");
  await writeFile(path.join(runDir, "build", "property_improvement.car"), await tinyCar(pi.archiveRoot));

  const qaPath = path.join(runDir, "meta", "qa.json");
  const qa = JSON.parse(await readFile(qaPath, "utf8"));
  qa.checks = qa.checks.map((c: any) => ({
    ...c,
    status: c.status === "fail" && !opts.qaFail ? "warn" : c.status,
  }));
  const counts = { pass: 0, warn: 0, fail: 0 } as Record<string, number>;
  for (const c of qa.checks) counts[c.status]++;
  qa.counts = counts;
  qa.status = counts.fail ? "fail" : counts.warn ? "warn" : "pass";
  await writeFile(qaPath, JSON.stringify(qa));
  await writeFile(
    path.join(runDir, "meta", "sources.json"),
    JSON.stringify({ sources: { "ftl-permits": { changed: true, records: 10 } } }),
  );
  await writeFile(
    path.join(runDir, "meta", "deltas.json"),
    JSON.stringify({ groups: { property_improvement: { added: 1, changed: 0, removed: 0 } } }),
  );

  const indexPath = path.join(runDir, "query", "index.duckdb");
  await buildIndex({ runDir, asOf: "2026-11-25", runId: "fixture" }, indexPath, { embedder: fakeEmbedder });
  await writeDerived(indexPath, runDir);
  return {
    runDir,
    roots: { "property_improvement.car": pi.archiveRoot, property_improvement: pi.tablesRoot },
  };
}

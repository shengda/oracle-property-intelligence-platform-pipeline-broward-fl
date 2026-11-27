import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { CarBlockIterator } from "@ipld/car";
import { CountyTablesBlock } from "../sources/atlas-county.ts";
import { blockMatchesCid, CODEC, parseCid } from "../util/cid.ts";
import {
  type FileRef,
  type Manifest,
  manifestDags,
  manifestFiles,
  type VerificationReport,
} from "./manifest.ts";

/**
 * Public gateways used to verify a publish, in order. Observed 2026-11-27: `ipfs.io`,
 * `dweb.link` and `trustless-gateway.link` answered 429/52x for every request, while
 * `ipfs.filebase.io` and `gw.ipfs-lens.dev` served (ipfs-lens is independent of both providers
 * we pin on). Override with `ORACLE_GATEWAYS` (comma-separated) or `--gateway`.
 */
export const PUBLIC_GATEWAYS = ["https://ipfs.filebase.io", "https://gw.ipfs-lens.dev"];

export function gatewaysFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const v = (env.ORACLE_GATEWAYS ?? "").trim();
  return v ? v.split(",").map((g) => g.trim().replace(/\/+$/, "")) : PUBLIC_GATEWAYS;
}

/** Verification proves public retrieval, so a gateway on this machine or network is refused. */
export function assertPublicGateways(gateways: string[]): void {
  if (gateways.length < 2) throw new Error("verification needs at least two public gateways");
  for (const g of gateways) {
    const host = new URL(g).hostname;
    if (
      /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|::1|\[::1\])/.test(host) ||
      host.endsWith(".local") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      throw new Error(`gateway ${g} is local; verification must use public gateways`);
    }
  }
}

type FetchImpl = typeof fetch;
interface CheckOpts {
  fetchImpl: FetchImpl;
  timeoutMs: number;
}
type Check =
  | { ok: true; size?: number; sha256?: string; blocks?: number }
  | { ok: false; error: string; retry: boolean; retryAfterMs?: number; notRaw?: boolean };

class Timeout extends Error {}

async function get(url: string, accept: string | null, o: CheckOpts, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Timeout("timeout")), timeoutMs);
  try {
    const res = await o.fetchImpl(url, {
      headers: accept ? { accept } : {},
      signal: ctrl.signal,
      redirect: "follow",
    });
    // Keep the timer armed while the body streams; callers clear it via the returned response.
    (res as any).__timer = timer;
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw ctrl.signal.aborted ? new Timeout("timeout") : err;
  }
}

function failure(err: unknown): Check {
  if (
    err instanceof Timeout ||
    (err as Error)?.name === "TimeoutError" ||
    (err as Error)?.message === "timeout"
  ) {
    return { ok: false, error: "timeout", retry: true };
  }
  return { ok: false, error: (err as Error)?.message ?? String(err), retry: true };
}

function httpFailure(res: Response): Check {
  const retry = res.status === 429 || res.status >= 500;
  if (res.status !== 429) return { ok: false, error: `HTTP ${res.status}`, retry };
  // Rate limited: wait what the gateway asks (Retry-After seconds), else back off harder.
  const after = Number(res.headers.get("retry-after"));
  return {
    ok: false,
    error: "HTTP 429",
    retry,
    retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : 0,
  };
}

/** A file artifact: the gateway's bytes must have the manifest's size and SHA-256. */
export async function checkFile(gw: string, f: FileRef, o: CheckOpts): Promise<Check> {
  // Allow at least 256 KiB/s on top of the base timeout for large files.
  const timeout = o.timeoutMs + Math.ceil(f.size / 262_144) * 1000;
  try {
    const res = await get(`${gw}/ipfs/${f.cid}`, null, o, timeout);
    try {
      if (!res.ok || !res.body) return httpFailure(res);
      const h = createHash("sha256");
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > f.size) return { ok: false, error: `more than ${f.size} bytes`, retry: false };
        h.update(chunk);
      }
      const sha256 = h.digest("hex");
      if (size !== f.size) return { ok: false, error: `size ${size} ≠ ${f.size}`, retry: false };
      if (sha256 !== f.sha256)
        return { ok: false, error: `sha256 ${sha256.slice(0, 12)}… ≠ manifest`, retry: false };
      return { ok: true, size, sha256 };
    } finally {
      clearTimeout((res as any).__timer);
    }
  } catch (err) {
    return failure(err);
  }
}

/**
 * A DAG root, trustlessly: `?format=car` (whole DAG); the CAR's root must be the CID and every
 * block must hash to its own CID. With `expectBlocks` the block count must match too.
 */
export async function checkDag(
  gw: string,
  d: { cid: string; expectBlocks?: number; sizeHint?: number },
  o: CheckOpts,
): Promise<Check> {
  const timeout = o.timeoutMs + Math.ceil((d.sizeHint ?? 0) / 262_144) * 1000;
  try {
    const res = await get(
      `${gw}/ipfs/${d.cid}?format=car&dag-scope=all`,
      "application/vnd.ipld.car",
      o,
      timeout,
    );
    try {
      if (!res.ok || !res.body) return httpFailure(res);
      const it = await CarBlockIterator.fromIterable(res.body as unknown as AsyncIterable<Uint8Array>);
      const roots = (await it.getRoots()).map(String);
      if (roots[0] !== d.cid) return { ok: false, error: `CAR root ${roots[0]} ≠ ${d.cid}`, retry: false };
      let blocks = 0;
      let sawRoot = false;
      for await (const b of it) {
        const cid = b.cid.toString();
        if (b.cid.multihash.code !== 0x12) {
          return { ok: false, error: `block ${cid} is not sha2-256`, retry: false };
        }
        const digest = createHash("sha256").update(b.bytes).digest();
        if (!Buffer.from(b.cid.multihash.digest).equals(digest)) {
          return { ok: false, error: `block ${cid} does not hash to its CID`, retry: false };
        }
        if (cid === d.cid) sawRoot = true;
        blocks++;
      }
      if (!sawRoot) return { ok: false, error: "CAR lacks the root block", retry: false };
      if (d.expectBlocks !== undefined && blocks !== d.expectBlocks) {
        return { ok: false, error: `${blocks} blocks ≠ ${d.expectBlocks}`, retry: false };
      }
      return { ok: true, blocks };
    } finally {
      clearTimeout((res as any).__timer);
    }
  } catch (err) {
    return failure(err);
  }
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Above this many blocks a DAG is checked by sample (+ its CAR file), not by a full gateway export. */
export const FULL_EXPORT_MAX_BLOCKS = 2_000;

/**
 * The `CountyTables` root: its block must hash to its CID and link exactly the archive root and
 * the manifest's parts. The linked DAGs are checked on their own (the archive as a CAR, every
 * part byte for byte), so this is complete without re-downloading the archive through the tables
 * root (`dag-scope=all` here pulls all of it again and times out on public gateways).
 */
export async function checkTablesRoot(
  gw: string,
  t: { cid: string; archiveCid: string; partCids: string[] },
  o: CheckOpts,
): Promise<Check> {
  try {
    const res = await get(`${gw}/ipfs/${t.cid}?format=raw`, "application/vnd.ipld.raw", o, o.timeoutMs);
    try {
      if (!res.ok) return httpFailure(res);
      const bytes = await blockBytes(res, t.cid);
      if (!parseCid(t.cid).digest.equals(createHash("sha256").update(bytes).digest())) {
        return { ok: false, error: "tables root block does not hash to its CID", retry: false };
      }
      const block = CountyTablesBlock.parse(JSON.parse(new TextDecoder().decode(bytes)));
      if (block.county_root["/"] !== t.archiveCid) {
        return {
          ok: false,
          error: `links archive ${block.county_root["/"]}, manifest ${t.archiveCid}`,
          retry: false,
        };
      }
      const linked = Object.keys(block.tables)
        .sort()
        .flatMap((k) => block.tables[k].parts.map((p) => p.cid["/"]));
      const want = [...t.partCids].sort();
      if ([...linked].sort().join() !== want.join()) {
        return {
          ok: false,
          error: `links ${linked.length} parts, manifest lists ${want.length} (or CIDs differ)`,
          retry: false,
        };
      }
      return { ok: true, size: bytes.length, blocks: 1 + linked.length };
    } finally {
      clearTimeout((res as any).__timer);
    }
  } catch (err) {
    return failure(err);
  }
}

function dagJsonLinks(v: unknown, out: string[]): void {
  if (Array.isArray(v)) for (const x of v) dagJsonLinks(x, out);
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["/"] === "string" && Object.keys(o).length === 1) out.push(o["/"]);
    else for (const x of Object.values(o)) dagJsonLinks(x, out);
  }
}

/**
 * A Lexicon archive DAG through a gateway: the root block and a breadth-first sample of the blocks
 * it links (`?format=raw`), each hashed to its CID and dag-json links followed. Public gateways
 * cut off a full export of a 133k-block DAG ("CAR stream truncated", observed 2026-11-27 on
 * ipfs.filebase.io after 3,526 blocks), so every byte of the archive is checked through its CAR
 * file instead (checkFile, rooted at this CID and every block hashed at publish), as Atlas does.
 */
export async function checkDagSample(
  gw: string,
  d: { cid: string; sample: number; spacingMs?: number; sleep?: (ms: number) => Promise<void> },
  o: CheckOpts,
): Promise<Check> {
  const queue = [d.cid];
  const seen = new Set<string>(queue);
  let blocks = 0;
  try {
    while (queue.length && blocks < d.sample) {
      const cid = queue.shift()!;
      // Space the requests and retry a rate-limited block in place, so one 429 does not restart
      // the whole sample (Filebase limits a burst of block requests, observed 2026-11-27).
      if (blocks > 0) await (d.sleep ?? sleepMs)(d.spacingMs ?? 250);
      let res = await get(`${gw}/ipfs/${cid}?format=raw`, "application/vnd.ipld.raw", o, o.timeoutMs);
      for (let t = 1; res.status === 429 && t <= 3; t++) {
        clearTimeout((res as any).__timer);
        await (d.sleep ?? sleepMs)(5000 * t);
        res = await get(`${gw}/ipfs/${cid}?format=raw`, "application/vnd.ipld.raw", o, o.timeoutMs);
      }
      try {
        if (!res.ok) return httpFailure(res);
        const bytes = await blockBytes(res, cid);
        if (!parseCid(cid).digest.equals(createHash("sha256").update(bytes).digest())) {
          return { ok: false, error: `block ${cid} does not hash to its CID`, retry: false };
        }
        blocks++;
        if (parseCid(cid).codec === CODEC.dagJson) {
          const links: string[] = [];
          dagJsonLinks(JSON.parse(new TextDecoder().decode(bytes)), links);
          for (const l of links) {
            if (seen.has(l)) continue;
            seen.add(l);
            queue.push(l);
          }
        }
      } finally {
        clearTimeout((res as any).__timer);
      }
    }
    return { ok: true, blocks };
  } catch (err) {
    return failure(err);
  }
}

/**
 * The bytes of block `cid` from a `?format=raw` response. A gateway behind a path-keyed CDN cache
 * can answer with a CAR it cached for an earlier `?format=car` request of the same CID
 * (gw.ipfs-lens.dev, observed 2026-11-27: a 31 MB CAR for a 485-byte root block). That is still a
 * trustless answer: read the CAR up to the requested block (the first one in DFS order), stop.
 */
class NotRawBlock extends Error {}

async function blockBytes(res: Response, cid: string): Promise<Uint8Array> {
  const type = res.headers.get("content-type") ?? "";
  if (!/vnd\.ipld\.car/.test(type)) {
    // The same path-keyed cache can also hold the file's bytes from a plain GET.
    if (type && !/vnd\.ipld\.raw|octet-stream/.test(type)) {
      await res.body?.cancel().catch(() => {});
      throw new NotRawBlock(`gateway answered ?format=raw with ${type.split(";")[0]}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  const it = await CarBlockIterator.fromIterable(res.body as unknown as AsyncIterable<Uint8Array>);
  try {
    for await (const b of it) if (b.cid.toString() === cid) return b.bytes;
  } finally {
    await res.body?.cancel().catch(() => {});
  }
  throw new Error(`CAR response lacks block ${cid}`);
}

/** Quick check: only the root block (`?format=raw`), which must hash to its CID. */
export async function checkBlock(gw: string, cid: string, o: CheckOpts): Promise<Check> {
  try {
    const res = await get(`${gw}/ipfs/${cid}?format=raw`, "application/vnd.ipld.raw", o, o.timeoutMs);
    try {
      if (!res.ok) return httpFailure(res);
      const bytes = await blockBytes(res, cid);
      const digest = createHash("sha256").update(bytes).digest();
      if (!parseCid(cid).digest.equals(digest)) {
        return { ok: false, error: "root block does not hash to its CID", retry: false, notRaw: true };
      }
      return { ok: true, size: bytes.length };
    } finally {
      clearTimeout((res as any).__timer);
    }
  } catch (err) {
    if (err instanceof NotRawBlock) return { ok: false, error: err.message, retry: false, notRaw: true };
    return failure(err);
  }
}

async function withAttempts(
  run: () => Promise<Check>,
  retries: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ check: Check; attempts: number; ms: number }> {
  const t0 = Date.now();
  let check: Check = { ok: false, error: "not run", retry: true };
  let attempts = 0;
  while (attempts < retries) {
    attempts++;
    check = await run();
    if (check.ok || !check.retry) break;
    if (attempts >= retries) break;
    const backoff = 2000 * 2 ** (attempts - 1);
    const limited = check.retryAfterMs !== undefined;
    await sleep(limited ? Math.min(Math.max(check.retryAfterMs ?? 0, 15_000 * attempts), 120_000) : backoff);
  }
  return { check, attempts, ms: Date.now() - t0 };
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

/**
 * Checks every CID of a manifest on every gateway: files byte for byte, DAG roots as trustless
 * CARs, and the manifest itself against its CID. `quick` (the UI's "Verify now") checks only each
 * root block. Retries timeouts and 429/5xx with backoff; never hangs past the per-request timeout.
 */
export async function verifyManifest(
  m: Manifest,
  opts: {
    manifestCid?: string;
    /** Expected block count per DAG root CID (from the run state). */
    dagBlocks?: Record<string, number>;
    gateways?: string[];
    retries?: number;
    timeoutMs?: number;
    quick?: boolean;
    concurrency?: number;
    fetchImpl?: FetchImpl;
    sleep?: (ms: number) => Promise<void>;
    log?: (m: string) => void;
  } = {},
): Promise<VerificationReport> {
  const gateways = opts.gateways ?? PUBLIC_GATEWAYS;
  assertPublicGateways(gateways);
  const o: CheckOpts = { fetchImpl: opts.fetchImpl ?? fetch, timeoutMs: opts.timeoutMs ?? 120_000 };
  const retries = opts.retries ?? 4;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const quick = opts.quick ?? false;
  const log = opts.log ?? (() => {});

  type Item = {
    name: string;
    cid: string;
    run: (gw: string) => Promise<Check>;
    mode: "bytes" | "car" | "block" | "links" | "sample";
  };
  const items: Item[] = [];
  if (opts.manifestCid) {
    const cid = opts.manifestCid;
    items.push({
      name: "manifest",
      cid,
      mode: "block",
      run: (gw) => checkBlock(gw, cid, o),
    });
  }
  const carSize = new Map(
    m.groups.flatMap((g) => [
      [g.archive.cid, g.archive.car.size],
      [g.tables.cid, g.tables.car.size],
    ]),
  );
  const tablesOf = new Map(m.groups.map((g) => [g.tables.cid, g]));
  for (const d of manifestDags(m)) {
    const tg = tablesOf.get(d.cid);
    if (tg && !quick) {
      items.push({
        name: d.name,
        cid: d.cid,
        mode: "links",
        run: (gw) =>
          checkTablesRoot(
            gw,
            { cid: d.cid, archiveCid: tg.archive.cid, partCids: tg.tables.parts.map((p) => p.cid) },
            o,
          ),
      });
      continue;
    }
    const big = (opts.dagBlocks?.[d.cid] ?? 0) > FULL_EXPORT_MAX_BLOCKS;
    items.push(
      quick
        ? { name: d.name, cid: d.cid, mode: "block", run: (gw) => checkBlock(gw, d.cid, o) }
        : big
          ? {
              name: d.name,
              cid: d.cid,
              mode: "sample",
              run: (gw) => checkDagSample(gw, { cid: d.cid, sample: 16 }, o),
            }
          : {
              name: d.name,
              cid: d.cid,
              mode: "car",
              run: (gw) =>
                checkDag(
                  gw,
                  { cid: d.cid, expectBlocks: opts.dagBlocks?.[d.cid], sizeHint: carSize.get(d.cid) },
                  o,
                ),
            },
    );
  }
  for (const f of manifestFiles(m)) {
    items.push(
      quick && f.size > 5_000_000
        ? {
            name: f.name,
            cid: f.cid,
            mode: "block",
            // A gateway that ignores ?format=raw (path-keyed CDN cache) gets the full byte check.
            run: async (gw) => {
              const c = await checkBlock(gw, f.cid, o);
              return c.ok || !c.notRaw ? c : checkFile(gw, f, o);
            },
          }
        : { name: f.name, cid: f.cid, mode: "bytes", run: (gw) => checkFile(gw, f, o) },
    );
  }

  const results: VerificationReport["results"] = [];
  const jobs = gateways.flatMap((gateway) => items.map((item) => ({ gateway, item })));
  await pool(jobs, opts.concurrency ?? 4, async ({ gateway, item }) => {
    const { check, attempts, ms } = await withAttempts(() => item.run(gateway), retries, sleep);
    results.push({
      name: item.name,
      cid: item.cid,
      gateway,
      ok: check.ok,
      mode: item.mode,
      attempts,
      ms,
      ...(check.ok
        ? {
            ...(check.size !== undefined ? { size: check.size } : {}),
            ...(check.sha256 ? { sha256: check.sha256 } : {}),
            ...(check.blocks !== undefined ? { blocks: check.blocks } : {}),
          }
        : { error: check.error }),
    });
    log(
      `verify ${check.ok ? "ok  " : "FAIL"} ${new URL(gateway).host} ${item.name}${check.ok ? "" : ` (${check.error})`}`,
    );
  });
  const order = new Map(items.map((x, i) => [x.cid + x.name, i]));
  results.sort(
    (a, b) =>
      (order.get(a.cid + a.name) ?? 0) - (order.get(b.cid + b.name) ?? 0) ||
      a.gateway.localeCompare(b.gateway),
  );
  return { ok: results.every((r) => r.ok), checkedAt: new Date().toISOString(), gateways, quick, results };
}

/**
 * Fetches a single-block file (raw codec, ≤ 256 KiB: manifests, run histories) by CID from the
 * first gateway that serves bytes hashing to it.
 */
export async function fetchRawByCid(
  cid: string,
  opts: { gateways?: string[]; fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<Buffer> {
  if (parseCid(cid).codec !== CODEC.raw) {
    throw new Error(`${cid} is not a single-block (raw) CID; manifests and histories are`);
  }
  const f = opts.fetchImpl ?? fetch;
  const errors: string[] = [];
  for (const gw of opts.gateways ?? PUBLIC_GATEWAYS) {
    try {
      const res = await f(`${gw}/ipfs/${cid}?format=raw`, {
        headers: { accept: "application/vnd.ipld.raw" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (!res.ok) {
        errors.push(`${gw}: HTTP ${res.status}`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (blockMatchesCid(cid, bytes)) return bytes;
      errors.push(`${gw}: bytes do not hash to the CID`);
    } catch (err) {
      errors.push(`${gw}: ${(err as Error).message}`);
    }
  }
  throw new Error(`could not fetch ${cid}: ${errors.join("; ")}`);
}

/**
 * Downloads one file artifact from the first gateway whose bytes match the manifest's size and
 * SHA-256, streaming to `dest`.
 */
export async function downloadVerified(
  f: FileRef,
  dest: string,
  opts: { gateways?: string[]; fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const errors: string[] = [];
  for (const gw of opts.gateways ?? PUBLIC_GATEWAYS) {
    const tmp = `${dest}.part`;
    try {
      const res = await fetchImpl(`${gw}/ipfs/${f.cid}`, {
        signal: AbortSignal.timeout((opts.timeoutMs ?? 120_000) + Math.ceil(f.size / 262_144) * 1000),
      });
      if (!res.ok || !res.body) {
        errors.push(`${gw}: HTTP ${res.status}`);
        continue;
      }
      const h = createHash("sha256");
      let size = 0;
      await pipeline(
        res.body as unknown as AsyncIterable<Uint8Array>,
        async function* (src: AsyncIterable<Uint8Array>) {
          for await (const chunk of src) {
            size += chunk.length;
            h.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(tmp),
      );
      const sha = h.digest("hex");
      if (size !== f.size || sha !== f.sha256) {
        await rm(tmp, { force: true });
        errors.push(`${gw}: size/sha256 mismatch`);
        continue;
      }
      await rename(tmp, dest);
      return gw;
    } catch (err) {
      await rm(tmp, { force: true });
      errors.push(`${gw}: ${(err as Error).message}`);
    }
  }
  throw new Error(`could not download ${f.name} (${f.cid}): ${errors.join("; ")}`);
}

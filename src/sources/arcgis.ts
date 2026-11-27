import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createGzip } from "node:zlib";
import type { SourceHttpRequest } from "../types.ts";
import { fetchJson, type FetchStats } from "../util/http.ts";

export interface ArcgisFeature {
  attributes: Record<string, unknown>;
  centroid?: { x: number; y: number };
  geometry?: { x?: number; y?: number };
}

/**
 * Exact, replayable provenance for one record of an ArcGIS layer: a GET of the layer's `query`
 * endpoint filtered to that record. Query parameters go in `multiValueQueryString`, because the
 * Lexicon `source_http_request.url` pattern does not allow a query string.
 */
export function arcgisRecordRequest(layerUrl: string, where: string, outFields = "*"): SourceHttpRequest {
  return {
    method: "GET",
    url: `${layerUrl}/query`,
    multiValueQueryString: { where: [where], outFields: [outFields], f: ["json"] },
  };
}

export function buildQueryUrl(layerUrl: string, params: Record<string, string | number | boolean>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  return `${layerUrl}/query?${qs.toString()}`;
}

export async function arcgisCount(layerUrl: string, where = "1=1", stats?: FetchStats): Promise<number> {
  const res = await fetchJson(buildQueryUrl(layerUrl, { where, returnCountOnly: true, f: "json" }), {
    stats,
  });
  if (res.error) throw new Error(`ArcGIS count error: ${JSON.stringify(res.error)}`);
  return Number(res.count);
}

/**
 * Keyset-paginate an ArcGIS layer by its object-id field and stream every page to a gzipped
 * NDJSON file (one feature per line). Returns the record count and the SHA-256 of the
 * uncompressed NDJSON, which is the `file_digest` change-detection value for the source.
 */
export async function downloadArcgisLayer(opts: {
  layerUrl: string;
  oidField: string;
  outFields: string[];
  where?: string;
  pageSize: number;
  outPath: string;
  returnCentroid?: boolean;
  returnGeometry?: boolean;
  minDelayMs?: number;
  stats?: FetchStats;
  onPage?: (n: number) => void;
}): Promise<{ records: number; sha256: string; pages: number }> {
  await mkdir(path.dirname(opts.outPath), { recursive: true });
  const gz = createGzip();
  const out = createWriteStream(opts.outPath);
  gz.pipe(out);
  const hash = createHash("sha256");
  let lastOid = -1;
  let records = 0;
  let pages = 0;
  const baseWhere = opts.where ?? "1=1";
  const fields = Array.from(new Set([opts.oidField, ...opts.outFields])).join(",");
  for (;;) {
    const url = buildQueryUrl(opts.layerUrl, {
      where: `(${baseWhere}) AND ${opts.oidField} > ${lastOid}`,
      outFields: fields,
      orderByFields: `${opts.oidField} ASC`,
      resultRecordCount: opts.pageSize,
      returnGeometry: opts.returnGeometry ?? false,
      ...(opts.returnCentroid ? { returnCentroid: true } : {}),
      outSR: 4326,
      f: "json",
    });
    const page = await fetchJson<{
      features?: ArcgisFeature[];
      error?: unknown;
      exceededTransferLimit?: boolean;
    }>(url, { stats: opts.stats, minDelayMs: opts.minDelayMs ?? 500, timeoutMs: 180_000 });
    if (page.error) throw new Error(`ArcGIS query error: ${JSON.stringify(page.error)}`);
    const feats = page.features ?? [];
    if (feats.length === 0) break;
    pages++;
    for (const f of feats) {
      const line = `${JSON.stringify(f)}\n`;
      hash.update(line);
      if (!gz.write(line)) await new Promise((r) => gz.once("drain", r));
      lastOid = Math.max(lastOid, Number(f.attributes[opts.oidField]));
    }
    records += feats.length;
    opts.onPage?.(records);
    if (feats.length < opts.pageSize && !page.exceededTransferLimit) break;
  }
  gz.end();
  await new Promise<void>((resolve, reject) => {
    out.on("finish", () => resolve());
    out.on("error", reject);
  });
  return { records, sha256: hash.digest("hex"), pages };
}

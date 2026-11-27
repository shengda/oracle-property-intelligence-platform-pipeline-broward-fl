import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openIndex, type SnapshotDb } from "../../src/query/db.ts";
import { buildIndex } from "../../src/query/index-build.ts";

export const FIXTURE_DIR = path.resolve(import.meta.dirname, "../../fixtures/elephant-mini");

/**
 * Deterministic stand-in for the MiniLM embedder: hashed bag of crude word stems (plural `s`
 * stripped; any word containing "roof" also counts as "roof"), L2-normalized, 384 dims.
 */
export async function fakeEmbedder(texts: string[]): Promise<number[][]> {
  return texts.map((t) => {
    const v = new Array(384).fill(0);
    const words = t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    for (const w0 of words) {
      const w = w0.length > 3 ? w0.replace(/s$/, "") : w0;
      for (const tok of w.includes("roof") && w !== "roof" ? [w, "roof"] : [w]) {
        let h = 2166136261;
        for (const ch of tok) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
        v[h % 384] += 1;
      }
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
}

let cached: Promise<{ db: SnapshotDb; indexPath: string }> | null = null;

/** Builds the fixture index once per test file and opens it read-only (unpublished, like `serve --index`). */
export function fixtureIndex(): Promise<{ db: SnapshotDb; indexPath: string }> {
  cached ??= (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oracle-fixture-index-"));
    const indexPath = path.join(dir, "index.duckdb");
    await buildIndex({ runDir: FIXTURE_DIR, asOf: "2026-11-25", runId: "fixture" }, indexPath, {
      embedder: fakeEmbedder,
    });
    const db = await openIndex(indexPath, { runDir: FIXTURE_DIR });
    return { db, indexPath };
  })();
  return cached;
}

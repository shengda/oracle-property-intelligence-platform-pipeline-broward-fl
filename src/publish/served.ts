import type { SnapshotDb } from "../query/db.ts";
import { type Manifest, ManifestSchema, type RunHistory, type VerificationReport } from "./manifest.ts";

/** One row of the Manifest page: every CID of the run with what lets anyone check it. */
export interface ServedFile {
  name: string;
  kind: "lexicon" | "derived" | "meta" | "manifest";
  codec: "directory" | "file";
  size: number | null;
  sha256: string | null;
  cid: string | null;
  note?: string;
}

/** The published manifest of the served run (`publish/manifest.json`), or null when unpublished. */
export async function servedManifest(db: SnapshotDb): Promise<Manifest | null> {
  const m = await db.readRunFile<unknown>("publish/manifest.json");
  return m ? ManifestSchema.parse(m) : null;
}

export async function servedHistory(db: SnapshotDb): Promise<RunHistory | null> {
  return db.readRunFile<RunHistory>("publish/run-history.json");
}

export async function servedVerification(db: SnapshotDb): Promise<VerificationReport | null> {
  return db.readRunFile<VerificationReport>("publish/verification.json");
}

/** Every CID of a published manifest as Manifest-page rows, the manifest itself first. */
export function manifestRows(m: Manifest, manifestCid: string | null): ServedFile[] {
  const rows: ServedFile[] = [];
  if (manifestCid) {
    rows.push({
      name: `manifest (${m.run_id})`,
      kind: "manifest",
      codec: "file",
      size: null,
      sha256: null,
      cid: manifestCid,
      note: `previous: ${m.previous_manifest_cid ?? "none (first published run)"}`,
    });
  }
  for (const g of m.groups) {
    rows.push({
      name: `${g.key} archive (CountyIndex, packed)`,
      kind: "lexicon",
      codec: "directory",
      size: g.archive.car.size,
      sha256: null,
      cid: g.archive.cid,
      note: `${g.properties} properties, ${g.blocks} blocks; dag-json${g.reused_from_run ? `; unchanged since run ${g.reused_from_run}` : ""}`,
    });
    rows.push({
      name: `${g.key} tables (CountyTables)`,
      kind: "lexicon",
      codec: "directory",
      size: g.tables.parts.reduce((n, p) => n + p.size, 0),
      sha256: null,
      cid: g.tables.cid,
      note: `${g.tables.parts.length} Parquet parts; dag-json`,
    });
    for (const f of [g.archive.car, g.tables.car, ...g.tables.parts]) {
      rows.push({ name: f.name, kind: "lexicon", codec: "file", size: f.size, sha256: f.sha256, cid: f.cid });
    }
  }
  for (const a of m.artifacts) {
    rows.push({ name: a.name, kind: a.kind, codec: "file", size: a.size, sha256: a.sha256, cid: a.cid });
  }
  return rows;
}

/** Group roots and artifacts whose CID differs between two manifests (or exist in only one). */
export function compareManifests(
  a: Manifest,
  b: Manifest,
): { changed: { name: string; before: string | null; after: string | null }[]; unchanged: number } {
  const map = (m: Manifest) =>
    new Map<string, string>([
      ...m.groups.flatMap(
        (g) =>
          [
            [`${g.key} archive`, g.archive.cid],
            [`${g.key} tables`, g.tables.cid],
          ] as [string, string][],
      ),
      ...m.artifacts.map((x) => [x.name, x.cid] as [string, string]),
    ]);
  const before = map(a);
  const after = map(b);
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = names
    .filter((n) => before.get(n) !== after.get(n))
    .map((n) => ({ name: n, before: before.get(n) ?? null, after: after.get(n) ?? null }));
  return { changed, unchanged: names.length - changed.length };
}

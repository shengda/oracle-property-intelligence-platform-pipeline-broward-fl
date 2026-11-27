import { z } from "zod";

/** Every CID this project publishes or records is CIDv1 in base32. */
export const Cid = z.string().regex(/^b[a-z2-7]{20,}$/, "CIDv1 base32");
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** A byte artifact: a UnixFS file CID plus the size and SHA-256 that let anyone check it. */
export const FileRef = z.object({
  name: z.string(),
  cid: Cid,
  size: z.number().int().nonnegative(),
  sha256: Sha256,
});
export type FileRef = z.infer<typeof FileRef>;

/** A Lexicon DAG root (dag-json) and the CAR file that carries it. */
const DagRef = z.object({
  cid: Cid,
  codec: z.literal("directory"),
  ipld_codec: z.literal("dag-json"),
  car: FileRef,
});

export const TablePartRef = FileRef.extend({ table: z.string(), rows: z.number().int().nonnegative() });
export type TablePartRef = z.infer<typeof TablePartRef>;

export const GroupEntry = z.object({
  key: z.string(),
  schema_cid: Cid,
  properties: z.number().int(),
  blocks: z.number().int(),
  not_packed: z.number().int(),
  archive: DagRef,
  tables: DagRef.extend({ parts: z.array(TablePartRef) }),
  /** Set when this run reused the group unchanged from an earlier run (same roots). */
  reused_from_run: z.string().nullable(),
  /** How each DAG reached the primary provider (elephant-cli upload, or a complete-CAR import). */
  uploads: z.object({
    archive: z.literal("elephant-cli"),
    tables: z.enum(["elephant-cli", "complete-car"]),
  }),
});
export type GroupEntry = z.infer<typeof GroupEntry>;

export const Artifact = FileRef.extend({
  codec: z.literal("file"),
  media_type: z.string(),
  kind: z.enum(["derived", "meta"]),
});
export type Artifact = z.infer<typeof Artifact>;

/**
 * `oracle.manifest.v1` (architecture §3.3): every CID of one run. The Lexicon groups are
 * registrable in Atlas; derived and meta artifacts are this Oracle's own. The DuckDB index is not
 * published: `derived_index` records what `oracle sync` must reproduce from the artifacts.
 */
export const ManifestSchema = z.object({
  schema: z.literal("oracle.manifest.v1"),
  run_id: z.string(),
  mode: z.enum(["full", "incremental"]),
  as_of: z.string(),
  created_at: z.string(),
  county: z.object({ state: z.literal("FL"), name: z.literal("Broward"), fips: z.literal("12011") }),
  lexicon: z.object({ manifest_url: z.string() }),
  encoding: z.object({
    elephant_cli_version: z.string(),
    elephant_cli_build: z.string(),
    layout: z.literal("packed"),
    part_size: z.string(),
  }),
  /** The Atlas county group the published groups extend (same property CIDs). */
  extends: z.object({ atlas_page: z.string(), county_root: Cid, tables_root: Cid }).nullable(),
  groups: z.array(GroupEntry),
  artifacts: z.array(Artifact),
  derived_index: z.object({
    published: z.literal(false),
    views_version: z.string(),
    property_identity: z.enum(["atlas", "local"]),
    views: z.record(z.string(), z.number().int()),
    rebuild: z.string(),
  }),
  qa: z.object({
    status: z.enum(["pass", "warn", "fail"]),
    counts: z.object({ pass: z.number().int(), warn: z.number().int(), fail: z.number().int() }),
    overridden: z.boolean(),
  }),
  previous_manifest_cid: Cid.nullable(),
  pins: z.array(z.object({ provider: z.string(), pinned_at: z.string(), holds: z.string() })),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** Every byte file of a manifest (CAR files, Parquet parts, derived and meta artifacts). */
export function manifestFiles(m: Manifest): (FileRef & { role: string })[] {
  const out: (FileRef & { role: string })[] = [];
  for (const g of m.groups) {
    out.push({ ...g.archive.car, role: `${g.key} archive CAR` });
    out.push({ ...g.tables.car, role: `${g.key} tables CAR` });
    for (const p of g.tables.parts) out.push({ ...p, role: `${g.key} table ${p.table}` });
  }
  for (const a of m.artifacts) out.push({ ...a, role: a.kind });
  return out;
}

/** Every Lexicon DAG root of a manifest. */
export function manifestDags(m: Manifest): { name: string; cid: string }[] {
  return m.groups.flatMap((g) => [
    { name: `${g.key} archive root`, cid: g.archive.cid },
    { name: `${g.key} tables root`, cid: g.tables.cid },
  ]);
}

export const VerificationResult = z.object({
  name: z.string(),
  cid: z.string(),
  gateway: z.string(),
  ok: z.boolean(),
  mode: z.enum(["bytes", "car", "block", "links", "sample"]),
  size: z.number().optional(),
  sha256: z.string().optional(),
  blocks: z.number().optional(),
  attempts: z.number().int(),
  ms: z.number().optional(),
  error: z.string().optional(),
});
export const VerificationReport = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  gateways: z.array(z.string()),
  quick: z.boolean(),
  results: z.array(VerificationResult),
});
export type VerificationReport = z.infer<typeof VerificationReport>;

export const RunHistoryEntry = z.object({
  run_id: z.string(),
  mode: z.enum(["full", "incremental"]),
  simulated: z.boolean(),
  as_of: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  sources: z.record(
    z.string(),
    z.object({ changed: z.boolean().nullable(), records: z.number().nullable() }),
  ),
  deltas_by_group: z.record(
    z.string(),
    z.object({ added: z.number(), changed: z.number(), removed: z.number() }),
  ),
  groups: z.array(z.object({ key: z.string(), archive_root: z.string(), tables_root: z.string() })),
  derived: z.array(z.object({ name: z.string(), cid: z.string() })),
  qa: z.object({
    status: z.enum(["pass", "warn", "fail"]),
    overridden: z.boolean(),
    cid: z.string().nullable(),
  }),
  manifest_cid: z.string(),
  previous_manifest_cid: z.string().nullable(),
  verification: z.object({ ok: z.boolean(), checkedAt: z.string(), gateways: z.array(z.string()) }),
});
export type RunHistoryEntry = z.infer<typeof RunHistoryEntry>;

export const RunHistorySchema = z.object({
  schema: z.literal("oracle.run-history.v1"),
  county: z.string(),
  runs: z.array(RunHistoryEntry),
});
export type RunHistory = z.infer<typeof RunHistorySchema>;

/**
 * Adds one run to the history (pure). Earlier runs are never dropped or rewritten; re-publishing
 * the same run replaces its own entry. The new entry must chain onto the latest earlier run.
 */
export function appendRun(h: RunHistory | null, entry: RunHistoryEntry): RunHistory {
  const prior = (h?.runs ?? []).filter((r) => r.run_id !== entry.run_id);
  const latest = prior.at(-1);
  if (latest && entry.previous_manifest_cid !== latest.manifest_cid) {
    throw new Error(
      `run ${entry.run_id} chains to ${entry.previous_manifest_cid ?? "nothing"}, but the latest published run ${latest.run_id} is ${latest.manifest_cid}`,
    );
  }
  return RunHistorySchema.parse({
    schema: "oracle.run-history.v1",
    county: "FL/Broward",
    runs: [...prior, RunHistoryEntry.parse(entry)],
  });
}

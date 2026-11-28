import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CarReader } from "@ipld/car";
import { COUNTY, REPO_ROOT } from "../config.ts";
import type { ElephantCli } from "../elephant/cli.ts";
import { groupContext } from "../lexicon/output-writer.ts";
import { loadLexiconManifest } from "../lexicon/manifest.ts";
import { openIndex } from "../query/db.ts";
import { CountyTablesBlock } from "../sources/atlas-county.ts";
import { CODEC, parseCid } from "../util/cid.ts";
import { ROOFING_VIEWS } from "../views/roofing-views.ts";
import {
  appendRun,
  type Artifact,
  type FileRef,
  type GroupEntry,
  type Manifest,
  ManifestSchema,
  type RunHistory,
  type RunHistoryEntry,
  type TablePartRef,
  type VerificationReport,
} from "./manifest.ts";
import { FILEBASE_RPC, type Pinner } from "./providers.ts";
import { writeCompleteTablesCar } from "./tables-dag.ts";

/**
 * Lexicon groups this Oracle publishes (DECISIONS.md, M3): `property_improvement`, registered
 * next to the county group Elephant already holds in Atlas. The run's own county archive stays
 * local; its query-relevant content ships as derived `query/*.parquet`.
 */
export const PUBLISHED_GROUPS = ["property_improvement"] as const;

const GROUP_TITLES: Record<string, string> = {
  county: "County",
  property_improvement: "Property Improvement",
};

const META_FILES = ["coverage.json", "sources.json", "state.json", "deltas.json", "qa.json"];

export interface PublishDeps {
  cli: Pick<ElephantCli, "upload">;
  /** Holds the Lexicon DAGs (CAR import through elephant-cli) and every file. */
  primary: Pinner;
  /** Holds every file again, including both CAR files; its CIDs must equal the primary's. */
  second: Pinner;
  /** Kubo RPC `elephant-cli upload` imports into (Filebase). */
  api?: string;
  /**
   * Imports a complete CAR into the primary (Filebase `dag/import`) and returns its root. Used
   * for a tables DAG when `elephant-cli upload <tables dir>` is refused (see tables-dag.ts).
   */
  dagImport?: (car: string) => Promise<string>;
  /** Gateway of the primary, to read back multi-block parts for the complete tables CAR. */
  primaryGateway?: string;
  log?: (m: string) => void;
  now?: () => Date;
}

/** The record of one publish, kept at `runs/<id>/publish/publish.json`. */
export interface PublishRecord {
  run_id: string;
  manifest_cid: string;
  history_cid: string | null;
  published_at: string;
  verification_ok: boolean | null;
  qa_overridden: boolean;
}

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

function mediaType(file: string): string {
  if (file.endsWith(".parquet")) return "application/vnd.apache.parquet";
  if (file.endsWith(".csv")) return "text/csv";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".car")) return "application/vnd.ipld.car";
  return "application/octet-stream";
}

/** Derived (`query/`, `supplement/`, `samples/`) and meta files of a run, in a stable order. */
export async function runArtifactFiles(runDir: string): Promise<{ rel: string; kind: "derived" | "meta" }[]> {
  const out: { rel: string; kind: "derived" | "meta" }[] = [];
  for (const [sub, ext] of [
    ["query", ".parquet"],
    ["supplement", ".parquet"],
    ["samples", ".csv"],
  ] as const) {
    const dir = path.join(runDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of (await readdir(dir)).filter((x) => x.endsWith(ext)).sort()) {
      out.push({ rel: `${sub}/${f}`, kind: "derived" });
    }
  }
  for (const f of META_FILES) {
    if (existsSync(path.join(runDir, "meta", f))) out.push({ rel: `meta/${f}`, kind: "meta" });
  }
  return out;
}

/** Parts of a tables directory, from its `tables.car` (`CountyTables` block). */
export async function tablesParts(tablesDir: string): Promise<{
  root: string;
  countyRoot: string;
  parts: { table: string; file: string; cid: string; bytes: number; rows: number }[];
}> {
  const reader = await CarReader.fromBytes(await readFile(path.join(tablesDir, "tables.car")));
  const [root] = (await reader.getRoots()).map(String);
  const block = await reader.get((await reader.getRoots())[0]);
  if (!block) throw new Error(`${tablesDir}/tables.car lacks its root block`);
  const t = CountyTablesBlock.parse(JSON.parse(new TextDecoder().decode(block.bytes)));
  const parts = Object.entries(t.tables)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([table, v]) =>
      v.parts.map((p, i) => ({
        table,
        file: path.join(tablesDir, table, `part-${String(i).padStart(5, "0")}.parquet`),
        cid: p.cid["/"],
        bytes: p.bytes,
        rows: p.rows,
      })),
    );
  return { root, countyRoot: t.county_root["/"], parts };
}

/**
 * Publishes one built and indexed run: uploads each published Lexicon group (archive and tables
 * DAGs) with elephant-cli, adds every file to both providers (their CIDs must agree), then writes
 * and adds the manifest. Refuses a run whose QA has a failing check unless `force` (recorded).
 */
export async function publishRun(
  input: { runDir: string; previousManifestCid: string | null; force?: boolean },
  deps: PublishDeps,
): Promise<{ manifest: Manifest; manifestCid: string; manifestFile: FileRef }> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const { runDir } = input;
  const state = await readJson<any>(path.join(runDir, "meta", "state.json"));
  const qa = await readJson<any>(path.join(runDir, "meta", "qa.json"));
  const coverage = await readJson<any>(path.join(runDir, "meta", "coverage.json"));
  if (state.status !== "indexed")
    throw new Error(`run ${state.run_id} is ${state.status}; run oracle index first`);
  const failing = (qa.checks ?? []).filter((c: any) => c.status === "fail").map((c: any) => c.id);
  if (failing.length && !input.force) {
    throw new Error(
      `QA has ${failing.length} failing check(s): ${failing.join(", ")}. Fix them, or publish --force (recorded in the manifest).`,
    );
  }
  const pubDir = path.join(runDir, "publish");
  await mkdir(pubDir, { recursive: true });

  const second = deps.second;
  async function pinBoth(file: string, name: string, expectCid?: string): Promise<FileRef> {
    const [size, sha256] = [(await stat(file)).size, await sha256File(file)];
    const a = await deps.primary.addFile(file, name);
    if (expectCid && a.cid !== expectCid) {
      throw new Error(`${deps.primary.provider} computed ${a.cid} for ${name}, expected ${expectCid}`);
    }
    if (!(second.has && (await second.has(a.cid)))) {
      const b = await second.addFile(file, name);
      if (b.cid !== a.cid) {
        throw new Error(
          `${second.provider} computed ${b.cid} for ${name}, ${deps.primary.provider} ${a.cid}`,
        );
      }
    }
    log(`publish: ${name} ${a.cid} (${size} bytes) on ${deps.primary.provider} + ${second.provider}`);
    return { name, cid: a.cid, size, sha256 };
  }

  const lexicon = await loadLexiconManifest();
  const api = deps.api ?? FILEBASE_RPC;
  const groups: GroupEntry[] = [];
  for (const key of PUBLISHED_GROUPS) {
    const g = (state.groups ?? []).find((x: any) => x.group === key);
    if (!g) throw new Error(`run ${state.run_id} has no ${key} group`);
    const carPath = path.join(runDir, g.car);
    const tablesDir = path.join(runDir, g.tables_dir);
    log(`publish: elephant-cli upload ${g.car} → ${api}`);
    const up = await deps.cli.upload(carPath, { api, summaryJson: path.join(pubDir, `${key}-upload.json`) });
    if (up.root !== g.archiveRoot)
      throw new Error(`upload of ${g.car} reported root ${up.root}, built ${g.archiveRoot}`);
    const t = await tablesParts(tablesDir);
    if (t.root !== g.tablesRoot || t.countyRoot !== g.archiveRoot) {
      throw new Error(`${g.tables_dir}/tables.car does not match the run state`);
    }
    // Parts first, on both providers, each under the CID the tables index records.
    const parts: TablePartRef[] = [];
    for (const p of t.parts) {
      const size = (await stat(p.file)).size;
      if (size !== p.bytes) throw new Error(`${p.file}: ${size} bytes, tables index says ${p.bytes}`);
      const ref = await pinBoth(p.file, `${key}-tables/${p.table}/${path.basename(p.file)}`, p.cid);
      parts.push({ ...ref, table: p.table, rows: p.rows });
    }
    log(`publish: elephant-cli upload ${g.tables_dir} → ${api}`);
    let tablesVia: "elephant-cli" | "complete-car" = "elephant-cli";
    try {
      const upT = await deps.cli.upload(tablesDir, {
        api,
        summaryJson: path.join(pubDir, `${key}-tables-upload.json`),
      });
      if (upT.root !== g.tablesRoot)
        throw new Error(`upload of ${g.tables_dir} reported root ${upT.root}, built ${g.tablesRoot}`);
    } catch (err) {
      if (!/missing blocks/i.test((err as Error).message) || !deps.dagImport) throw err;
      // Filebase imports complete DAGs only; tables.car holds the root block alone.
      log(`publish: ${api} refused tables.car (incomplete DAG); importing the complete tables DAG instead`);
      const car = path.join(pubDir, `${key}-tables-complete.car`);
      try {
        const w = await writeCompleteTablesCar({
          tablesCar: path.join(tablesDir, "tables.car"),
          archiveCar: carPath,
          parts: t.parts,
          out: car,
          blocksGateway: deps.primaryGateway ?? "https://ipfs.filebase.io",
        });
        const root = await deps.dagImport(car);
        if (root !== g.tablesRoot || w.root !== g.tablesRoot) {
          throw new Error(`complete tables CAR imported as ${root}, built ${g.tablesRoot}`);
        }
        log(`publish: tables DAG ${root} imported (${w.blocks} blocks)`);
        tablesVia = "complete-car";
      } finally {
        await rm(car, { force: true });
      }
    }
    groups.push({
      key,
      schema_cid: (await groupContext(lexicon, GROUP_TITLES[key])).groupCid,
      properties: g.properties,
      blocks: g.blocks,
      not_packed: g.notPacked,
      archive: {
        cid: g.archiveRoot,
        codec: "directory",
        ipld_codec: "dag-json",
        car: await pinBoth(carPath, `${key}.car`),
      },
      tables: {
        cid: g.tablesRoot,
        codec: "directory",
        ipld_codec: "dag-json",
        car: await pinBoth(path.join(tablesDir, "tables.car"), `${key}-tables/tables.car`),
        parts,
      },
      reused_from_run: g.reused_from_run ?? null,
      uploads: { archive: "elephant-cli", tables: tablesVia },
    });
  }

  const artifacts: Artifact[] = [];
  for (const a of await runArtifactFiles(runDir)) {
    const ref = await pinBoth(path.join(runDir, a.rel), a.rel);
    artifacts.push({ ...ref, codec: "file", media_type: mediaType(a.rel), kind: a.kind });
  }

  // What `oracle sync` must reproduce: the views' row counts and whose property CIDs they carry.
  const index = await openIndex(path.join(runDir, "query", "index.duckdb"), { runDir });
  const views: Record<string, number> = {};
  let identity: "atlas" | "local" = "local";
  try {
    for (const v of ROOFING_VIEWS) {
      views[v] = (await index.one<{ n: number }>(`select count(*)::INTEGER n from ${v}`))?.n ?? 0;
    }
    const m = await index.one<{ property_identity?: string }>("select * from index_meta");
    identity = m?.property_identity === "atlas" ? "atlas" : "local";
  } finally {
    await index.close();
  }

  const pi = coverage.groups?.property_improvement;
  let ext: Manifest["extends"] = null;
  if (pi?.seed_source === "atlas") {
    const sources = await readJson<any>(path.join(runDir, "meta", "sources.json"));
    const rel = sources.sources?.["atlas-county"]?.rawPath;
    const raw = rel ? path.resolve(REPO_ROOT, rel) : undefined;
    const page =
      raw && existsSync(path.join(raw, "page.json"))
        ? await readJson<any>(path.join(raw, "page.json"))
        : null;
    if (!page?.groups?.county)
      throw new Error(
        "atlas-county capture (page.json) not found; re-run oracle ingest --source atlas-county",
      );
    ext = {
      atlas_page: `counties/${COUNTY.state}/${COUNTY.name.toLowerCase()}.json`,
      county_root: page.groups.county.cid,
      tables_root: page.groups.county.tables,
    };
  }

  const createdAt = now().toISOString();
  const manifest = ManifestSchema.parse({
    schema: "oracle.manifest.v1",
    run_id: state.run_id,
    mode: state.mode,
    as_of: state.as_of,
    created_at: createdAt,
    county: { state: COUNTY.state, name: COUNTY.name, fips: COUNTY.fips },
    lexicon: { manifest_url: state.lexicon_manifest_url },
    encoding: {
      elephant_cli_version: state.elephant_cli.version,
      elephant_cli_build: state.elephant_cli.build,
      layout: state.elephant_cli.layout,
      part_size: state.elephant_cli.part_size,
    },
    extends: ext,
    groups,
    artifacts,
    derived_index: {
      published: false,
      views_version: qa.views_version ?? "roofing-views.v1",
      property_identity: identity,
      views,
      rebuild:
        "oracle sync --manifest <cid> rebuilds query/index.duckdb from the artifacts above and checks these row counts",
    },
    qa: { status: qa.status, counts: qa.counts, overridden: failing.length > 0 },
    previous_manifest_cid: input.previousManifestCid,
    pins: [
      {
        provider: deps.primary.provider,
        pinned_at: createdAt,
        holds: "Lexicon DAGs (CAR import) and every file",
      },
      {
        provider: second.provider,
        pinned_at: createdAt,
        holds: "every file, including both CAR files of each group (DAGs re-importable from them)",
      },
    ],
  });
  const manifestPath = path.join(pubDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestFile = await pinBoth(manifestPath, `manifest-${state.run_id}.json`);
  if (parseCid(manifestFile.cid).codec !== CODEC.raw) {
    throw new Error(`manifest is larger than one block (${manifestFile.size} bytes); sync expects a raw CID`);
  }
  return { manifest, manifestCid: manifestFile.cid, manifestFile };
}

/** The run-history entry of a published, verified run. */
export async function historyEntry(
  runDir: string,
  manifest: Manifest,
  manifestCid: string,
  verification: VerificationReport,
  opts: { simulated?: boolean } = {},
): Promise<RunHistoryEntry> {
  const state = await readJson<any>(path.join(runDir, "meta", "state.json"));
  const sources = await readJson<any>(path.join(runDir, "meta", "sources.json"));
  const deltas = await readJson<any>(path.join(runDir, "meta", "deltas.json"));
  return {
    run_id: manifest.run_id,
    mode: manifest.mode,
    simulated: opts.simulated ?? false,
    as_of: manifest.as_of,
    started_at: state.started_at ?? null,
    finished_at: state.finished_at ?? null,
    sources: Object.fromEntries(
      Object.entries<any>(sources.sources ?? {}).map(([k, v]) => [
        k,
        { changed: typeof v.changed === "boolean" ? v.changed : null, records: v.records ?? null },
      ]),
    ),
    deltas_by_group: Object.fromEntries(
      Object.entries<any>(deltas.groups ?? {}).map(([k, v]) => [
        k,
        { added: v.added, changed: v.changed, removed: v.removed },
      ]),
    ),
    groups: manifest.groups.map((g) => ({
      key: g.key,
      archive_root: g.archive.cid,
      tables_root: g.tables.cid,
    })),
    derived: manifest.artifacts
      .filter((a) => a.kind === "derived")
      .map((a) => ({ name: a.name, cid: a.cid })),
    qa: {
      status: manifest.qa.status,
      overridden: manifest.qa.overridden,
      cid: manifest.artifacts.find((a) => a.name === "meta/qa.json")?.cid ?? null,
    },
    manifest_cid: manifestCid,
    previous_manifest_cid: manifest.previous_manifest_cid,
    verification: { ok: verification.ok, checkedAt: verification.checkedAt, gateways: verification.gateways },
  };
}

/** Appends the run to the prior history, writes `publish/run-history.json` and adds it to both providers. */
export async function publishHistory(
  runDir: string,
  prior: RunHistory | null,
  entry: RunHistoryEntry,
  deps: Pick<PublishDeps, "primary" | "second" | "log">,
): Promise<{ history: RunHistory; historyCid: string }> {
  const history = appendRun(prior, entry);
  const file = path.join(runDir, "publish", "run-history.json");
  await writeFile(file, `${JSON.stringify(history, null, 2)}\n`);
  const a = await deps.primary.addFile(file, `run-history-${entry.run_id}.json`);
  const b = await deps.second.addFile(file, `run-history-${entry.run_id}.json`);
  if (a.cid !== b.cid)
    throw new Error(`run history: ${deps.primary.provider} ${a.cid} ≠ ${deps.second.provider} ${b.cid}`);
  deps.log?.(`publish: run history ${a.cid} (${history.runs.length} run(s))`);
  return { history, historyCid: a.cid };
}

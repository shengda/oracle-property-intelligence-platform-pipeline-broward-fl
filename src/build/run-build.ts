import { existsSync } from "node:fs";
import { copyFile, link, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { COUNTY, PART_SIZE, PATHS, REPO_ROOT, runDir } from "../config.ts";
import { createElephantCli } from "../elephant/cli.ts";
import { readSourcesFile } from "../ingest.ts";
import { loadLexiconManifest } from "../lexicon/manifest.ts";
import { groupContext } from "../lexicon/output-writer.ts";
import { permitCoverage } from "../sources/permit-coverage.ts";
import { SOURCES } from "../sources/registry.ts";
import { buildCountyGroup } from "../transforms/county/index.ts";
import { buildPropertyImprovementGroup } from "../transforms/property-improvement/index.ts";
import type { GroupKey } from "../types.ts";
import { openWorkDb } from "../work-db.ts";
import { buildGroup, type GroupBuildResult } from "./build-group.ts";
import { computeDeltas, type Deltas } from "./deltas.ts";
import { deriveAll } from "./derive.ts";
import { writeSupplement } from "./supplement.ts";

export interface RunState {
  schema: "oracle.run-state.v1";
  run_id: string;
  mode: "full" | "incremental";
  as_of: string;
  started_at: string;
  finished_at?: string;
  status: "building" | "built" | "indexed" | "failed";
  elephant_cli: { version: string; build: string; layout: "packed"; part_size: string };
  lexicon_manifest_url: string;
  previous_run_id: string | null;
  groups: (Omit<GroupBuildResult, "carPath" | "tablesDir" | "tablesCar" | "validate" | "carValidate"> & {
    car: string;
    tables_dir: string;
    validate_errors: number;
    car_checks: Record<string, number>;
    /** Set when an incremental run reused this group's outputs unchanged (hardlinked) from that run. */
    reused_from_run?: string;
  })[];
  watermarks: Record<
    string,
    { sha256?: string; retrieved_at: string; records: number; window?: { from: string; to: string } }
  >;
  /** Groups rebuilt into this run after it was first built (unpublished runs only). */
  rebuilt?: { at: string; groups: GroupKey[] }[];
  error?: string;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readRunState(dir: string): Promise<RunState | null> {
  return readJson<RunState>(path.join(dir, "meta", "state.json"));
}

async function hasTable(db: Awaited<ReturnType<typeof openWorkDb>>, name: string): Promise<boolean> {
  const r = await db.one<{ n: number }>(
    `select count(*)::INTEGER n from information_schema.tables where table_name = '${name}'`,
  );
  return (r?.n ?? 0) > 0;
}

/**
 * Every property CID that hash gave the property_improvement group must be a property of the
 * published county archive: that is what lets Atlas register the group next to it.
 */
export async function checkPublishedPropertyCids(
  db: Awaited<ReturnType<typeof openWorkDb>>,
  hashCsv: string,
): Promise<{ properties: number; matched: number; missing: number; sample: string[] }> {
  const csv = hashCsv.replace(/'/g, "''");
  const r = await db.one<{ n: number; m: number }>(`select count(*)::INTEGER n,
      count(*) filter (where property_cid in (select property_cid from ref_atlas_seed))::INTEGER m
    from (select distinct propertyCid as property_cid from read_csv('${csv}', header=true, all_varchar=true))`);
  const sample = await db.all<{ c: string }>(`select distinct propertyCid c
    from read_csv('${csv}', header=true, all_varchar=true)
    where propertyCid not in (select property_cid from ref_atlas_seed) limit 3`);
  const n = r?.n ?? 0;
  const m = r?.m ?? 0;
  return { properties: n, matched: m, missing: n - m, sample: sample.map((x) => x.c) };
}

export function newRunId(mode: string, now = new Date()): string {
  return `${now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}-${mode}`;
}

export async function latestRun(exclude?: string): Promise<string | null> {
  if (!existsSync(PATHS.runs)) return null;
  const ids = (await readdir(PATHS.runs)).filter((d) => d !== exclude).sort();
  for (const id of ids.reverse()) {
    try {
      const s = JSON.parse(await readFile(path.join(runDir(id), "meta", "state.json"), "utf8")) as RunState;
      if (s.status === "built" || s.status === "indexed") return id;
    } catch {
      /* not a finished run */
    }
  }
  return null;
}

/**
 * Sources the county group is built from (roll, DOR, Census geography, Sunbiz owners). Permit and
 * contractor sources are not among them: the only permit-derived county field (structure roof
 * date) is served from the run's own supplement instead (`qd_structure`, `v_property`).
 */
export const COUNTY_GROUP_SOURCES = [
  "bcpa-taxroll",
  "bcpa-taxroll-full",
  "dor-nal-sdf",
  "census-county-boundary",
  "census-zcta-county",
  "census-places",
  "sunbiz",
];

/** County-group inputs whose watermark (SHA-256 of what was loaded) differs between two runs. */
export function changedCountyInputs(
  prev: RunState["watermarks"] | undefined,
  cur: RunState["watermarks"],
): string[] {
  return COUNTY_GROUP_SOURCES.filter((k) => (prev?.[k]?.sha256 ?? null) !== (cur[k]?.sha256 ?? null));
}

async function linkTree(from: string, to: string): Promise<void> {
  const st = await stat(from);
  if (st.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const f of await readdir(from)) await linkTree(path.join(from, f), path.join(to, f));
    return;
  }
  await mkdir(path.dirname(to), { recursive: true });
  await rm(to, { force: true });
  await link(from, to).catch(() => copyFile(from, to));
}

/** Hardlink one group's build outputs (CAR, hash and error CSVs, export summary, tables) into a new run. */
export async function reuseGroupOutputs(fromRun: string, toRun: string, g: GroupKey): Promise<void> {
  for (const f of await readdir(path.join(fromRun, "build"))) {
    if (f === `${g}.car` || f.startsWith(`${g}-`)) {
      await linkTree(path.join(fromRun, "build", f), path.join(toRun, "build", f));
    }
  }
  await linkTree(path.join(fromRun, "tables", g), path.join(toRun, "tables", g));
}

export async function build(opts: {
  runId?: string;
  mode?: "full" | "incremental";
  groups?: GroupKey[];
  parcels?: string[];
  asOf?: string;
  log?: (m: string) => void;
}): Promise<RunState> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const mode = opts.mode ?? "full";
  const runId = opts.runId ?? newRunId(mode);
  const dir = runDir(runId);
  const requestedAsOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const groups: GroupKey[] = opts.groups?.length ? opts.groups : ["county", "property_improvement"];
  await mkdir(path.join(dir, "meta"), { recursive: true });
  const cli = createElephantCli();
  const version = await cli.version();
  const pinned = (
    await readFile(path.join(REPO_ROOT, "elephant-cli.version"), "utf8").catch(() => "")
  ).trim();
  const sourcesFile = await readSourcesFile();
  // Rebuilding some groups of an existing run keeps the other groups, the run's start time and
  // its place in the run chain; only the rebuilt groups' entries are replaced.
  const prior = await readRunState(dir);
  const asOf = prior?.as_of ?? requestedAsOf;
  const previous = prior ? prior.previous_run_id : await latestRun(runId);
  const priorCoverage = prior
    ? await readJson<{ groups?: Record<string, unknown> }>(path.join(dir, "meta", "coverage.json"))
    : null;
  const state: RunState = {
    schema: "oracle.run-state.v1",
    run_id: runId,
    mode: prior?.mode ?? mode,
    as_of: asOf,
    started_at: prior?.started_at ?? new Date().toISOString(),
    ...(prior ? { rebuilt: [...(prior.rebuilt ?? []), { at: new Date().toISOString(), groups }] } : {}),
    status: "building",
    elephant_cli: { version, build: pinned, layout: "packed", part_size: PART_SIZE },
    lexicon_manifest_url: "https://lexicon.elephant.xyz/api/manifest",
    previous_run_id: previous,
    groups: (prior?.groups ?? []).filter((g) => !groups.includes(g.group)),
    watermarks: Object.fromEntries(
      Object.values(sourcesFile.sources).map((s) => [
        s.key,
        {
          sha256: s.sha256,
          retrieved_at: s.finishedAt,
          records: s.records,
          ...(s.window ? { window: s.window } : {}),
        },
      ]),
    ),
  };
  const saveState = () =>
    writeFile(path.join(dir, "meta", "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  await saveState();

  // Incremental runs reuse the county group when none of its inputs changed since the previous
  // run (architecture §3.4: rebuild what changed sources touch, reuse the rest). It is not
  // published (DECISIONS.md, M3), and rebuilding it costs ~11 GB of disk and an hour.
  let toBuild = groups;
  let reusedCounty: { from: string; stats: unknown } | null = null;
  if (mode === "incremental" && !prior && !opts.groups?.length && previous && groups.includes("county")) {
    const prevDir = runDir(previous);
    const prevState = await readRunState(prevDir);
    const prevCounty = prevState?.groups.find((g) => g.group === "county");
    const changed = changedCountyInputs(prevState?.watermarks, state.watermarks);
    if (prevState && prevCounty && changed.length === 0) {
      await reuseGroupOutputs(prevDir, dir, "county");
      state.groups.push({ ...prevCounty, reused_from_run: prevCounty.reused_from_run ?? previous });
      const prevCoverage = await readJson<{ groups?: Record<string, unknown> }>(
        path.join(prevDir, "meta", "coverage.json"),
      );
      reusedCounty = { from: previous, stats: prevCoverage?.groups?.county ?? null };
      toBuild = groups.filter((g) => g !== "county");
      log(`build ${runId}: county inputs unchanged since ${previous}; reusing its county group (hardlinked)`);
    } else if (changed.length) {
      log(
        `build ${runId}: county inputs changed since ${previous} (${changed.join(", ")}); rebuilding county`,
      );
    }
  }

  const db = await openWorkDb(PATHS.workDb);
  try {
    log(`build ${runId}: deriving work tables (as of ${asOf})`);
    await deriveAll(db, { asOf, log });
    const manifest = await loadLexiconManifest();
    const priorDeltas = prior
      ? await readJson<{ groups?: Record<string, Deltas> }>(path.join(dir, "meta", "deltas.json"))
      : null;
    const deltas: Record<string, Deltas> = { ...(priorDeltas?.groups ?? {}) };
    const groupStats: Record<string, unknown> = { ...(priorCoverage?.groups ?? {}) };
    if (reusedCounty) {
      groupStats.county = { ...(reusedCounty.stats as object), reused_from_run: reusedCounty.from };
      deltas.county = await computeDeltas(
        path.join(runDir(reusedCounty.from), "tables", "county"),
        path.join(dir, "tables", "county"),
      );
    }
    for (const g of toBuild) {
      const groupDir = path.join(dir, "groups", g);
      if (g === "county") {
        const ctx = await groupContext(manifest, "County");
        groupStats.county = await buildCountyGroup(db, groupDir, ctx, {
          taxYear: 2025,
          parcels: opts.parcels,
          log,
        });
      } else {
        const ctx = await groupContext(manifest, "Property Improvement");
        const seedSource = (await hasTable(db, "ref_atlas_seed")) ? "atlas" : "own";
        if (seedSource === "own") {
          log(
            "build property_improvement: no published Seed loaded (oracle ingest --sources atlas-county); using our own Seeds — this group cannot be registered in Atlas",
          );
        }
        groupStats.property_improvement = await buildPropertyImprovementGroup(db, groupDir, ctx, {
          parcels: opts.parcels,
          seedSource,
          log,
        });
      }
      log(`build ${g}: elephant-cli validate → hash → validate CAR → export-tables`);
      const r = await buildGroup(g, groupDir, path.join(dir, "build"), cli, { partSize: PART_SIZE });
      if (g === "property_improvement" && (groupStats.property_improvement as any).seed_source === "atlas") {
        const check = await checkPublishedPropertyCids(db, path.join(dir, "build", `${g}-hash.csv`));
        (groupStats.property_improvement as any).published_property_cids = check;
        if (check.missing > 0) {
          throw new Error(
            `property_improvement: ${check.missing} of ${check.properties} property CIDs are not in the published county archive (e.g. ${check.sample.join(", ")})`,
          );
        }
        log(
          `build ${g}: all ${check.properties} property CIDs are properties of the published county archive`,
        );
      }
      log(
        `build ${g}: ${r.properties} properties, archive ${r.archiveRoot}, tables ${r.tablesRoot} (not_packed ${r.notPacked}; ${Math.round(r.timingsMs.hash / 1000)} s hash)`,
      );
      state.groups = state.groups.filter((x) => x.group !== r.group);
      state.groups.push({
        group: r.group,
        archiveRoot: r.archiveRoot,
        tablesRoot: r.tablesRoot,
        properties: r.properties,
        blocks: r.blocks,
        notPacked: r.notPacked,
        tables: r.tables,
        timingsMs: r.timingsMs,
        car: path.relative(dir, r.carPath),
        tables_dir: path.relative(dir, r.tablesDir),
        validate_errors: r.validate.errors,
        car_checks: r.carValidate.checks,
      });
      const prevTables = previous ? path.join(runDir(previous), "tables", g) : null;
      deltas[g] = await computeDeltas(prevTables, r.tablesDir);
      await saveState();
    }
    log("build: writing supplementary derived inputs");
    await writeSupplement(db, dir);

    // meta/*.json
    const sourceStatus = Object.fromEntries(Object.entries(sourcesFile.sources).map(([k, v]) => [k, v]));
    const pc = await permitCoverage(db, sourceStatus as never);
    const geo = await db.all<{ geo_status: string; n: number }>(
      "select geo_status, count(*)::INTEGER n from drv_geo group by 1 order by 1",
    );
    const coverage = {
      schema: "oracle.coverage.v1",
      run_id: runId,
      county: { state: COUNTY.state, name: COUNTY.name, fips: COUNTY.fips },
      as_of: asOf,
      properties: state.groups.find((g) => g.group === "county")?.properties ?? null,
      geo_status: Object.fromEntries(geo.map((g) => [g.geo_status, g.n])),
      groups: groupStats,
      sources: SOURCES.map((s) => {
        const r = sourcesFile.sources[s.key];
        return {
          key: s.key,
          title: s.title,
          readme_need: s.readmeNeed,
          change_mode: s.changeMode,
          status: r?.status ?? (s.status === "skipped" ? "skipped" : "not_run"),
          records: r?.records ?? 0,
          skip_reason: r?.skipReason ?? s.skipReason ?? null,
          estimate: r?.estimate ?? s.estimate ?? null,
          blocker_type: r?.blockerType ?? null,
          limitation: r?.limitation ?? s.limitation ?? null,
        };
      }),
      permit_coverage: pc,
    };
    const meta = path.join(dir, "meta");
    await writeFile(path.join(meta, "coverage.json"), `${JSON.stringify(coverage, null, 2)}\n`);
    await writeFile(path.join(meta, "sources.json"), `${JSON.stringify(sourcesFile, null, 2)}\n`);
    await writeFile(
      path.join(meta, "deltas.json"),
      `${JSON.stringify({ schema: "oracle.deltas.v1", run_id: runId, previous_run_id: previous, groups: deltas }, null, 2)}\n`,
    );
    state.status = "built";
    state.finished_at = new Date().toISOString();
    await saveState();
    return state;
  } catch (err) {
    state.status = "failed";
    state.error = (err as Error).message.slice(0, 4000);
    await saveState();
    throw err;
  } finally {
    await db.close();
  }
}

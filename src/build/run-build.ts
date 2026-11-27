import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
  })[];
  watermarks: Record<
    string,
    { sha256?: string; retrieved_at: string; records: number; window?: { from: string; to: string } }
  >;
  error?: string;
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
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const groups: GroupKey[] = opts.groups?.length ? opts.groups : ["county", "property_improvement"];
  await mkdir(path.join(dir, "meta"), { recursive: true });
  const cli = createElephantCli();
  const version = await cli.version();
  const pinned = (
    await readFile(path.join(REPO_ROOT, "elephant-cli.version"), "utf8").catch(() => "")
  ).trim();
  const previous = await latestRun(runId);
  const sourcesFile = await readSourcesFile();
  const state: RunState = {
    schema: "oracle.run-state.v1",
    run_id: runId,
    mode,
    as_of: asOf,
    started_at: new Date().toISOString(),
    status: "building",
    elephant_cli: { version, build: pinned, layout: "packed", part_size: PART_SIZE },
    lexicon_manifest_url: "https://lexicon.elephant.xyz/api/manifest",
    previous_run_id: previous,
    groups: [],
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

  const db = await openWorkDb(PATHS.workDb);
  try {
    log(`build ${runId}: deriving work tables (as of ${asOf})`);
    await deriveAll(db, { asOf, log });
    const manifest = await loadLexiconManifest();
    const deltas: Record<string, Deltas> = {};
    const groupStats: Record<string, unknown> = {};
    for (const g of groups) {
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
        groupStats.property_improvement = await buildPropertyImprovementGroup(db, groupDir, ctx, {
          parcels: opts.parcels,
          log,
        });
      }
      log(`build ${g}: elephant-cli validate → hash → validate CAR → export-tables`);
      const r = await buildGroup(g, groupDir, path.join(dir, "build"), cli, { partSize: PART_SIZE });
      log(
        `build ${g}: ${r.properties} properties, archive ${r.archiveRoot}, tables ${r.tablesRoot} (not_packed ${r.notPacked}; ${Math.round(r.timingsMs.hash / 1000)} s hash)`,
      );
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

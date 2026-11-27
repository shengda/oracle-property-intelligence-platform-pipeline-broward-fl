import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PATHS, runDir } from "../config.ts";
import type { RunState } from "../build/run-build.ts";
import { writeDerived } from "./derived.ts";
import { buildIndex, type IndexBuildResult } from "./index-build.ts";
import { qaReport, type QaReport } from "./qa.ts";

/**
 * `oracle index --run <id>`: build `query/index.duckdb` from the run's exported tables, write
 * `query/<view>.parquet` + `samples/*.csv`, then the QA checks → `meta/qa.json` (last step).
 * Exits 0 even when checks fail; `publish` is the gate.
 */
export async function indexRun(opts: {
  runId: string;
  vectors?: boolean;
  log?: (m: string) => void;
}): Promise<{ index: IndexBuildResult; derived: string[]; qa: QaReport }> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dir = runDir(opts.runId);
  const statePath = path.join(dir, "meta", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as RunState;
  if (state.status !== "built" && state.status !== "indexed") {
    throw new Error(`run ${opts.runId} is ${state.status}; build it first`);
  }
  const indexPath = path.join(dir, "query", "index.duckdb");
  const index = await buildIndex({ runDir: dir, asOf: state.as_of, runId: opts.runId }, indexPath, {
    log,
    vectors: opts.vectors,
  });
  const derived = await writeDerived(indexPath, dir);
  log(`index: wrote ${derived.files.length} derived files`);
  const qa = await qaReport({ indexPath, runDir: dir, runId: opts.runId, workDbPath: PATHS.workDb });
  await writeFile(path.join(dir, "meta", "qa.json"), `${JSON.stringify(qa, null, 2)}\n`);
  state.status = "indexed";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { index, derived: derived.files, qa };
}

export function formatQa(qa: QaReport): string {
  const lines = [
    `QA ${qa.run_id}: ${qa.status.toUpperCase()} (${qa.counts.pass} pass, ${qa.counts.warn} warn, ${qa.counts.fail} fail)`,
  ];
  for (const c of qa.checks) {
    const v = typeof c.value === "object" ? JSON.stringify(c.value) : String(c.value);
    lines.push(`  [${c.status.padEnd(4)}] ${c.id}: ${v.length > 160 ? `${v.slice(0, 157)}...` : v}`);
  }
  return lines.join("\n");
}

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { ElephantCli } from "../elephant/cli.ts";
import type { GroupKey } from "../types.ts";

export interface GroupBuildResult {
  group: GroupKey;
  archiveRoot: string;
  carPath: string;
  tablesRoot: string;
  tablesDir: string;
  tablesCar: string;
  properties: number;
  blocks: number;
  notPacked: number;
  tables: Record<string, { rows: number; parts: number }>;
  validate: { errors: number; errorsCsv: string };
  carValidate: { errors: number; checks: Record<string, number>; errorsCsv: string };
  timingsMs: { validate: number; hash: number; validateCar: number; exportTables: number };
}

export class GroupValidationError extends Error {
  constructor(
    readonly group: string,
    readonly errorsCsv: string,
    readonly errors: number,
    readonly sample: string,
  ) {
    super(`group ${group}: ${errors} Lexicon validation errors (see ${errorsCsv}); not hashed.\n${sample}`);
  }
}

/**
 * Build one data group with the pinned Elephant CLI: validate the property outputs (errors stop
 * the group before hash), hash packed into a county CAR, validate the CAR offline, export tables.
 */
export async function buildGroup(
  group: GroupKey,
  groupDir: string,
  outDir: string,
  cli: ElephantCli,
  opts: { partSize: string; keepHashedZips?: boolean; keepOutputs?: boolean },
): Promise<GroupBuildResult> {
  await mkdir(outDir, { recursive: true });
  const errorsCsv = path.join(outDir, `${group}-errors.csv`);
  const t0 = Date.now();
  const v = await cli.validate(groupDir, errorsCsv);
  const t1 = Date.now();
  if (!v.valid || v.errors > 0) {
    const csv = await readFile(errorsCsv, "utf8").catch(() => "");
    throw new GroupValidationError(group, errorsCsv, v.errors, csv.split("\n").slice(0, 12).join("\n"));
  }
  const hashedDir = path.join(outDir, `${group}-hashed`);
  const carPath = path.join(outDir, `${group}.car`);
  const h = await cli.hash(groupDir, {
    zipDir: hashedDir,
    csv: path.join(outDir, `${group}-hash.csv`),
    car: carPath,
  });
  const t2 = Date.now();
  if (!opts.keepHashedZips) await rm(hashedDir, { recursive: true, force: true });
  const carErrors = path.join(outDir, `${group}-car-errors.csv`);
  const cv = await cli.validateCar(carPath, carErrors);
  const t3 = Date.now();
  if (!cv.valid || cv.errors > 0) {
    throw new GroupValidationError(group, carErrors, cv.errors, JSON.stringify(cv.checks));
  }
  // Per-property outputs are an internal store, regenerated deterministically from the work store.
  if (!opts.keepOutputs) await rm(groupDir, { recursive: true, force: true });
  const tablesDir = path.join(path.dirname(outDir), "tables", group);
  await rm(tablesDir, { recursive: true, force: true });
  const ex = await cli.exportTables(carPath, tablesDir, {
    partSize: opts.partSize,
    summaryJson: path.join(outDir, `${group}-tables-export.json`),
  });
  const t4 = Date.now();
  return {
    group,
    archiveRoot: h.root,
    carPath,
    tablesRoot: ex.tablesRoot,
    tablesDir,
    tablesCar: path.join(tablesDir, "tables.car"),
    properties: h.properties,
    blocks: h.blocks,
    notPacked: h.notPacked,
    tables: ex.tables,
    validate: { errors: v.errors, errorsCsv },
    carValidate: { errors: cv.errors, checks: cv.checks, errorsCsv: carErrors },
    timingsMs: { validate: t1 - t0, hash: t2 - t1, validateCar: t3 - t2, exportTables: t4 - t3 },
  };
}

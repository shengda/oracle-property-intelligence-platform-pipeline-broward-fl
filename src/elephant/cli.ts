import { spawn } from "node:child_process";
import { PATHS } from "../config.ts";

export interface HashResult {
  root: string;
  blocks: number;
  properties: number;
  notPacked: number;
  failed: string[];
}

export interface ExportResult {
  tablesRoot: string;
  countyRoot: string;
  tables: Record<string, { rows: number; parts: number }>;
  parts: number;
}

export interface ElephantCli {
  readonly bin: string;
  version(): Promise<string>;
  validate(input: string, errorsCsv: string): Promise<{ valid: boolean; errors: number; properties: number }>;
  hash(input: string, out: { zipDir: string; csv: string; car: string }): Promise<HashResult>;
  validateCar(
    car: string,
    errorsCsv: string,
  ): Promise<{ valid: boolean; errors: number; checks: Record<string, number> }>;
  exportTables(
    car: string,
    outDir: string,
    opts: { partSize: string; summaryJson?: string },
  ): Promise<ExportResult>;
  /**
   * `upload` a county CAR or a tables directory to a Kubo RPC (Filebase by default, which reads
   * FILEBASE_* from the environment). It succeeds only once the gateway serves the root.
   */
  upload(input: string, opts: { api: string; summaryJson: string; timeoutS?: number }): Promise<UploadResult>;
}

export interface UploadResult {
  /** Archive root (for a CAR) or tables root (for a tables directory) the node reported. */
  root: string;
  /** The CLI's own summary document (api, root, blocks or parts, gateway URL, timestamp). */
  summary: Record<string, unknown>;
}

export class ElephantCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly json?: any,
  ) {
    super(message);
  }
}

type Runner = (
  bin: string,
  args: string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const defaultRunner: Runner = (bin, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

/** Wraps the pinned Elephant CLI 2 binary; every command runs with `--json` and is parsed. */
export function createElephantCli(
  bin: string = PATHS.elephantCli,
  runner: Runner = defaultRunner,
): ElephantCli {
  async function json(args: string[], okCodes = [0]): Promise<any> {
    const res = await runner(bin, ["--json", ...args]);
    let parsed: any;
    try {
      parsed = res.stdout.trim() ? JSON.parse(res.stdout) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!okCodes.includes(res.code ?? -1)) {
      throw new ElephantCliError(
        `elephant-cli ${args[0]} exited ${res.code}: ${res.stderr.slice(-2000)}`,
        res.code,
        res.stderr,
        parsed,
      );
    }
    return parsed;
  }
  return {
    bin,
    async version() {
      const res = await runner(bin, ["--version"]);
      return res.stdout.trim();
    },
    async validate(input, errorsCsv) {
      const r = await json(["validate", input, "--output-csv", errorsCsv], [0, 1]);
      return {
        valid: Boolean(r?.valid),
        errors: Number(r?.error_count ?? 0),
        properties: Number(r?.properties ?? 0),
      };
    },
    async hash(input, out) {
      const r = await json([
        "hash",
        input,
        "--output-zip",
        out.zipDir,
        "--output-csv",
        out.csv,
        "--output-car",
        out.car,
      ]);
      return {
        root: r.car.root,
        blocks: Number(r.car.blocks),
        properties: Number(r.properties),
        notPacked: Number(r.not_packed ?? 0),
        failed: r.failed ?? [],
      };
    },
    async validateCar(car, errorsCsv) {
      const r = await json(["validate", car, "--output-csv", errorsCsv], [0, 1]);
      return { valid: Boolean(r?.valid), errors: Number(r?.error_count ?? 0), checks: r?.errors ?? {} };
    },
    async exportTables(car, outDir, opts) {
      const args = ["export-tables", car, "--output", outDir, "--part-size", opts.partSize];
      if (opts.summaryJson) args.push("--output-json", opts.summaryJson);
      const r = await json(args);
      return { tablesRoot: r.root, countyRoot: r.county_root, tables: r.tables, parts: Number(r.parts) };
    },
    async upload(input, opts) {
      const args = ["upload", input, "--api", opts.api, "--output-json", opts.summaryJson];
      if (opts.timeoutS) args.push("--timeout", String(opts.timeoutS));
      const r = await json(args);
      const root = r?.root ?? r?.tables_root ?? r?.tablesRoot;
      if (typeof root !== "string") {
        throw new ElephantCliError(
          `elephant-cli upload printed no root: ${JSON.stringify(r).slice(0, 300)}`,
          0,
          "",
          r,
        );
      }
      return { root, summary: r };
    },
  };
}

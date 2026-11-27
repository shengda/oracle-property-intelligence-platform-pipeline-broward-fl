import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file lives in `<root>/src`). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Broward County, FL — the default and primary county for ingestion, queries and demos. */
export const COUNTY = {
  state: "FL",
  name: "Broward",
  key: "broward",
  fips: "12011",
  dorCountyNo: 16,
  dbprCountyCode: "16",
  center: { lat: 26.15, lon: -80.3 },
  /** Outer bounds of the Census TIGER county polygon (incl. the Everglades), rounded outward. */
  bbox: { minLat: 25.95, maxLat: 26.35, minLon: -80.89, maxLon: -80.03 },
} as const;

export const DEFAULT_ROOF_AGE_YEARS = 15;
export const DEFAULT_LONG_HELD_YEARS = 10;
export const PUBLIC_GATEWAYS = ["https://ipfs.io", "https://dweb.link"] as const;
export const LEXICON_MANIFEST_URL = "https://lexicon.elephant.xyz/api/manifest";

/** Lexicon data-group schema CIDs (live manifest, verified in Task 0 — docs/LEXICON-MAP.md). */
export const DATA_GROUP_LABELS = {
  seed: "Seed",
  county: "County",
  property_improvement: "Property Improvement",
} as const;

export const PATHS = {
  work: path.join(REPO_ROOT, "work"),
  workDb: path.join(REPO_ROOT, "work", "oracle.duckdb"),
  sourcesJson: path.join(REPO_ROOT, "work", "sources.json"),
  cache: path.join(REPO_ROOT, "cache"),
  raw: path.join(REPO_ROOT, "cache", "raw"),
  runs: path.join(REPO_ROOT, "runs"),
  elephantCli: process.env.ELEPHANT_CLI
    ? path.resolve(process.env.ELEPHANT_CLI)
    : path.join(REPO_ROOT, "bin", "elephant-cli"),
  kitRuntime: path.join(REPO_ROOT, "vendor", "soofi-xyz-team-kit", "skills", "use-oracle", "runtime"),
} as const;

/** Polite client identity for public sources (no personal contact details). */
export const USER_AGENT = "oracle-broward-pipeline/0.1 (public-records research; respects robots)";

/** Export-tables part cap (plan Task 0 Step 5: small parts for gateway range reads). */
export const PART_SIZE = "64m";

export function runDir(runId: string): string {
  return path.join(PATHS.runs, runId);
}

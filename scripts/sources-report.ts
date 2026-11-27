/**
 * Render the measured source table and run facts as Markdown (pasted into docs/SOURCES.md).
 *   npx tsx scripts/sources-report.ts [runId]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { latestRun } from "../src/build/run-build.ts";
import { runDir } from "../src/config.ts";
import { readSourcesFile } from "../src/ingest.ts";
import { SOURCES } from "../src/sources/registry.ts";

function mb(bytes?: number): string {
  if (!bytes) return "—";
  return bytes > 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}
function dur(a: string, b: string): string {
  const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
  return s >= 90 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

const runId = process.argv[2] ?? (await latestRun());
const sources = await readSourcesFile();
const lines: string[] = [];
lines.push(
  `| Key | Status | Records | Transferred | Requests | Avg latency | Fetch time | SHA-256 (first 12) | Limitation / reason |`,
);
lines.push(`|---|---|---:|---:|---:|---:|---:|---|---|`);
const keys = [...new Set([...SOURCES.map((s) => s.key), ...Object.keys(sources.sources)])];
for (const k of keys) {
  const r = sources.sources[k];
  const d = SOURCES.find((s) => s.key === k);
  if (!r && !d) continue;
  const reason = r?.limitation ?? d?.limitation ?? "";
  const extra = r?.skipReason
    ? ` (${r.skipReason}; est. ${r.estimate?.size ?? "?"}, ${r.estimate?.time ?? "?"})`
    : r?.blockerType
      ? ` (${r.blockerType})`
      : "";
  lines.push(
    `| \`${k}\` | ${r?.status ?? d?.status ?? "—"} | ${r?.records?.toLocaleString("en-US") ?? "—"} | ${mb(r?.bytes)} | ${r?.requests ?? "—"} | ${r?.avgLatencyMs ? `${r.avgLatencyMs} ms` : "—"} | ${r ? dur(r.startedAt, r.finishedAt) : "—"} | ${r?.sha256 ? `\`${r.sha256.slice(0, 12)}\`` : "—"} | ${(reason + extra).replace(/\|/g, "/")} |`,
  );
}
console.log(lines.join("\n"));
if (runId) {
  const dir = runDir(runId);
  const state = JSON.parse(await readFile(path.join(dir, "meta", "state.json"), "utf8"));
  console.log(`\n### Run ${runId} (${state.mode}, as of ${state.as_of})\n`);
  console.log(
    `| Group | Properties | Blocks | not_packed | Archive root | Tables root | validate | hash | validate CAR | export-tables |`,
  );
  console.log(`|---|---:|---:|---:|---|---|---:|---:|---:|---:|`);
  for (const g of state.groups) {
    const t = g.timingsMs;
    console.log(
      `| ${g.group} | ${g.properties.toLocaleString("en-US")} | ${g.blocks.toLocaleString("en-US")} | ${g.notPacked} | \`${g.archiveRoot}\` | \`${g.tablesRoot}\` | ${Math.round(t.validate / 1000)} s | ${Math.round(t.hash / 1000)} s | ${Math.round(t.validateCar / 1000)} s | ${Math.round(t.exportTables / 1000)} s |`,
    );
  }
  const coverage = JSON.parse(await readFile(path.join(dir, "meta", "coverage.json"), "utf8"));
  console.log(`\n### Permit coverage by jurisdiction (${runId})\n`);
  console.log(`| Jurisdiction | Status | Parcels | Permits | Roofing permits | Reason |`);
  console.log(`|---|---|---:|---:|---:|---|`);
  for (const j of coverage.permit_coverage) {
    console.log(
      `| ${j.name} | ${j.status} | ${j.parcels.toLocaleString("en-US")} | ${j.permits.toLocaleString("en-US")} | ${j.roofingPermits.toLocaleString("en-US")} | ${(j.reason ?? "").replace(/\|/g, "/")} |`,
    );
  }
}

#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import { build, latestRun } from "./build/run-build.ts";
import { PATHS, REPO_ROOT, runDir } from "./config.ts";
import { createElephantCli } from "./elephant/cli.ts";
import { ingest, INGEST_ORDER, readSourcesFile } from "./ingest.ts";
import { loadLexiconManifest } from "./lexicon/manifest.ts";
import { formatQa, indexRun } from "./query/run-index.ts";
import { runReadOnlySql } from "./query/sql-guard.ts";
import type { GroupKey } from "./types.ts";
import { openWorkDb } from "./work-db.ts";

const program = new Command();
program
  .name("oracle")
  .description("Broward County, FL property-intelligence pipeline (Elephant Lexicon + DuckDB + IPFS)")
  .showHelpAfterError();

const later = (cmd: string, milestone: string) => () => {
  console.error(
    `oracle ${cmd}: not available yet — implemented in milestone ${milestone} (see docs/2026-11-25-oracle-broward-pipeline-plan.md).`,
  );
  process.exit(2);
};

const list = (v: string, prev: string[] = []) => [
  ...prev,
  ...v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

program
  .command("readiness")
  .description(
    "Check the toolchain and sources: pinned Elephant CLI, Lexicon manifest, kit submodule, work store",
  )
  .action(async () => {
    const cli = createElephantCli();
    const pinned = (
      await readFile(path.join(REPO_ROOT, "elephant-cli.version"), "utf8").catch(() => "")
    ).trim();
    const results: [string, boolean, string][] = [];
    try {
      results.push(["elephant-cli", true, `${await cli.version()} (pinned build ${pinned || "?"})`]);
    } catch (err) {
      results.push([
        "elephant-cli",
        false,
        `${(err as Error).message} — run scripts/install-elephant-cli.sh`,
      ]);
    }
    try {
      const m = await loadLexiconManifest();
      results.push([
        "lexicon manifest",
        true,
        `${Object.keys(m).length} entries; County ${m.County?.ipfsCid}`,
      ]);
    } catch (err) {
      results.push(["lexicon manifest", false, (err as Error).message]);
    }
    try {
      await import("../vendor/soofi-xyz-team-kit/skills/use-oracle/runtime/src/roof-age/integration.ts");
      results.push(["team-kit runtime", true, "vendor/soofi-xyz-team-kit (read-only submodule) resolves"]);
    } catch (err) {
      results.push(["team-kit runtime", false, `${(err as Error).message} — git submodule update --init`]);
    }
    const sources = await readSourcesFile();
    results.push([
      "work store sources",
      true,
      `${Object.keys(sources.sources).length} sources recorded (updated ${sources.updated_at})`,
    ]);
    for (const [k, ok, d] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${k.padEnd(20)} ${d}`);
    process.exit(results.every((r) => r[1]) ? 0 : 1);
  });

program
  .command("ingest")
  .description("Fetch sources into cache/raw and stage them in the work store (work/oracle.duckdb)")
  .addOption(new Option("--source <key...>", `sources to ingest (default: all) — ${INGEST_ORDER.join(", ")}`))
  .option("--accela-max-requests <n>", "cap for the bounded Fort Lauderdale contractor lookup", "4000")
  .action(async (o) => {
    const res = await ingest({
      sources: o.source ? o.source.flatMap((s: string) => list(s)) : undefined,
      accelaMaxRequests: Number(o.accelaMaxRequests),
    });
    const rows = Object.values(res.sources);
    console.log(`\n${rows.length} sources recorded in ${path.relative(process.cwd(), PATHS.sourcesJson)}`);
  });

program
  .command("build")
  .description(
    "Write Lexicon property outputs per group and build them with elephant-cli (validate → hash → validate CAR → export-tables)",
  )
  .option("--run <id>", "run id (default: new)")
  .addOption(new Option("--mode <mode>", "run mode").choices(["full", "incremental"]).default("full"))
  .option("--group <key>", "groups to build (county, property_improvement)", list)
  .option("--parcels <ids>", "limit to these parcel ids (comma-separated) — smoke runs only", list)
  .option("--as-of <date>", "as-of date (YYYY-MM-DD)")
  .action(async (o) => {
    const s = await build({
      runId: o.run,
      mode: o.mode,
      groups: o.group as GroupKey[] | undefined,
      parcels: o.parcels,
      asOf: o.asOf,
    });
    console.log(
      `\nbuilt run ${s.run_id}: ${s.groups.map((g) => `${g.group}=${g.properties} (${g.archiveRoot})`).join(", ")}`,
    );
  });

program
  .command("index")
  .description(
    "Build query/index.duckdb, query/<view>.parquet, samples/*.csv and meta/qa.json from a run's exported tables",
  )
  .option("--run <id>", "run id (default: latest built run)")
  .option("--no-vectors", "skip the vector index")
  .action(async (o) => {
    const runId = o.run ?? (await latestRun());
    if (!runId) throw new Error("no built run found");
    const r = await indexRun({ runId, vectors: o.vectors });
    console.log(`\n${formatQa(r.qa)}`);
  });

program
  .command("run")
  .description("ingest → build → index (M1/M2); without --no-publish continues to publish → verify (M3)")
  .addOption(new Option("--mode <mode>", "run mode").choices(["full", "incremental"]).default("full"))
  .option("--no-publish", "stop after index (local, unpublished run)")
  .option("--skip-ingest", "reuse the current work store")
  .option("--source <key...>", "sources to ingest")
  .option("--accela-max-requests <n>", "cap for the bounded Fort Lauderdale contractor lookup", "4000")
  .option("--no-vectors", "skip the vector index")
  .action(async (o) => {
    if (o.publish) later("run (publish)", "M3")();
    const t0 = Date.now();
    if (!o.skipIngest) {
      await ingest({
        sources: o.source ? o.source.flatMap((s: string) => list(s)) : undefined,
        accelaMaxRequests: Number(o.accelaMaxRequests),
      });
    }
    const s = await build({ mode: o.mode });
    const r = await indexRun({ runId: s.run_id, vectors: o.vectors });
    console.log(`\n${formatQa(r.qa)}`);
    console.log(
      `\nrun ${s.run_id} complete (unpublished) in ${Math.round((Date.now() - t0) / 1000)} s → ${path.relative(process.cwd(), runDir(s.run_id))}`,
    );
  });

program
  .command("query")
  .description("Run a read-only SQL query against a run's index (SELECT only, rows capped)")
  .option("--run <id>", "run id (default: latest)")
  .option("--index <path>", "path to an index.duckdb")
  .option("--max-rows <n>", "row cap", "50")
  .argument("<sql>", "a single SELECT statement")
  .action(async (sql, o) => {
    const runId = o.index ? null : (o.run ?? (await latestRun()));
    const indexPath = o.index ?? path.join(runDir(runId!), "query", "index.duckdb");
    const db = await openWorkDb(indexPath, { readOnly: true });
    try {
      await db.run("load fts; load vss; load spatial;").catch(() => {});
      const res = await runReadOnlySql(db, sql, Number(o.maxRows));
      console.table(res.rows);
      if (res.truncated) console.log(`(truncated to ${o.maxRows} rows)`);
    } finally {
      await db.close();
    }
  });

program
  .command("publish")
  .description("Publish a run to Elephant IPFS (M3)")
  .option("--run <id>")
  .option("--force")
  .action(later("publish", "M3"));
program
  .command("verify")
  .description("Verify a manifest on two public gateways (M3)")
  .option("--manifest <cid>")
  .action(later("verify", "M3"));
program
  .command("sync")
  .description("Sync a published run by manifest CID (M3)")
  .option("--manifest <cid>")
  .option("--rebuild")
  .action(later("sync", "M3"));
program
  .command("mcp")
  .description("MCP server over a run's index (M2)")
  .option("--index <path>")
  .option("--manifest <cid>")
  .option("--fixture <dir>")
  .action(later("mcp", "M2"));
program
  .command("serve")
  .description("Explorer UI + HTTP API + /mcp (M2)")
  .option("--index <path>")
  .option("--manifest <cid>")
  .option("--fixture <dir>")
  .action(later("serve", "M2"));

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});

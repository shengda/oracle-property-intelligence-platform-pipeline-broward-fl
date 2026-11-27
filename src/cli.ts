#!/usr/bin/env node
import { existsSync } from "node:fs";
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
import { loadDotEnv, openIndexFrom } from "./serve.ts";

const program = new Command();
program
  .name("oracle")
  .description("Broward County, FL property-intelligence pipeline (Elephant Lexicon + DuckDB + IPFS)")
  .showHelpAfterError();

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
  .description("ingest → build → index; without --no-publish continues to publish → verify → run history")
  .addOption(new Option("--mode <mode>", "run mode").choices(["full", "incremental"]).default("full"))
  .option("--no-publish", "stop after index (local, unpublished run)")
  .option("--skip-ingest", "reuse the current work store")
  .option("--source <key...>", "sources to ingest")
  .option("--accela-max-requests <n>", "cap for the bounded Fort Lauderdale contractor lookup", "4000")
  .option("--no-vectors", "skip the vector index")
  .action(async (o) => {
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
    if (o.publish) {
      loadDotEnv();
      const { publishCommand, formatVerification } = await import("./publish/commands.ts");
      const p = await publishCommand({ runId: s.run_id });
      console.log(`\n${formatVerification(p.verification)}`);
      console.log(
        `\nrun ${s.run_id} published in ${Math.round((Date.now() - t0) / 1000)} s\n  manifest     ${p.record.manifest_cid}\n  run history  ${p.record.history_cid}`,
      );
      if (!p.verification.ok) process.exitCode = 1;
      return;
    }
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
  .description(
    "Publish a run: Lexicon groups + files on Filebase and the second provider, manifest, gateway verification, run history",
  )
  .option("--run <id>", "run id (default: latest)")
  .option("--force", "publish despite failing QA checks (recorded in the manifest)")
  .option("--resume", "reuse the manifest an interrupted publish of this run already pinned")
  .option(
    "--gateway <url...>",
    "public gateways to verify on (default: ORACLE_GATEWAYS or the built-in pair)",
  )
  .action(async (o) => {
    loadDotEnv();
    const { publishCommand, formatVerification } = await import("./publish/commands.ts");
    const runId = o.run ?? (await latestRun());
    if (!runId) throw new Error("no built run found");
    const r = await publishCommand({ runId, force: o.force, resume: o.resume, gateways: o.gateway });
    console.log(`\n${formatVerification(r.verification)}`);
    console.log(
      `\nrun ${runId} published\n  manifest     ${r.record.manifest_cid}\n  run history  ${r.record.history_cid}`,
    );
    if (!r.verification.ok) process.exitCode = 1;
  });
program
  .command("verify")
  .description("Verify every CID of a published run on two public gateways (exit 1 on any failure)")
  .option("--manifest <cid>", "manifest CID (fetched from the gateways and checked)")
  .option("--run <id>", "a local published run")
  .option("--quick", "root blocks only (seconds instead of minutes)")
  .option("--gateway <url...>", "public gateways (default: ORACLE_GATEWAYS or the built-in pair)")
  .action(async (o) => {
    loadDotEnv();
    const { verifyCommand, formatVerification } = await import("./publish/commands.ts");
    const runId = o.manifest ? undefined : (o.run ?? (await latestRun()));
    const r = await verifyCommand({ manifestCid: o.manifest, runId, quick: o.quick, gateways: o.gateway });
    console.log(formatVerification(r));
    if (!r.ok) process.exitCode = 1;
  });
program
  .command("sync")
  .description("Download a published run by manifest CID (verified, cached by CID) and build its index")
  .requiredOption("--manifest <cid>")
  .option("--rebuild", "also recompute the permit views from the published Lexicon tables and compare")
  .option("--history <cid>", "published run history listing this manifest (shown on the Runs page)")
  .option("--no-vectors", "skip the vector index")
  .option("--gateway <url...>", "gateways to read from (default: ORACLE_GATEWAYS or the built-in pair)")
  .action(async (o) => {
    loadDotEnv();
    const { syncRun } = await import("./query/sync.ts");
    const { gatewaysFromEnv } = await import("./publish/verify.ts");
    const r = await syncRun({
      manifestCid: o.manifest,
      historyCid: o.history,
      rebuild: o.rebuild,
      vectors: o.vectors,
      gateways: o.gateway ?? gatewaysFromEnv(),
      log: console.log,
    });
    console.log(
      `\nsynced run ${r.manifest.run_id} → ${path.relative(process.cwd(), r.indexPath)}\n  views ${JSON.stringify(r.views)} (equal to the manifest)`,
    );
    if (r.rebuild) console.log(`  rebuilt from Lexicon: ${JSON.stringify(r.rebuild)}`);
  });
program
  .command("mcp")
  .description(
    "MCP server (stdio) over a run's index: --run <id> (default latest), --index <path> or --fixture [dir]",
  )
  .option("--run <id>", "local run id (default: latest)")
  .option("--index <path>", "path to an index.duckdb")
  .option("--fixture [dir]", "serve the synthetic fixture (default fixtures/elephant-mini)")
  .option("--manifest <cid>", "published run by manifest CID (synced into cache/published/)")
  .action(async (o) => {
    loadDotEnv();
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { createOracleMcpServer } = await import("./mcp/server.ts");
    const db = await openIndexFrom(o);
    const server = createOracleMcpServer(db);
    await server.connect(new StdioServerTransport());
    console.error(
      `oracle mcp: serving run ${db.meta.run_id} (${db.published ? "published" : "UNPUBLISHED"}) on stdio`,
    );
  });
program
  .command("serve")
  .description("Explorer UI + HTTP API v1 + /mcp + agent over a run's index (unpublished runs are labelled)")
  .option("--run <id>", "local run id (default: latest)")
  .option("--index <path>", "path to an index.duckdb")
  .option("--fixture [dir]", "serve the synthetic fixture (default fixtures/elephant-mini)")
  .option("--manifest <cid>", "published run by manifest CID (synced into cache/published/)")
  .option("--host <host>", "bind address", "127.0.0.1")
  .option("--port <n>", "port", "4317")
  .action(async (o) => {
    loadDotEnv();
    const { startUiServer, UI_DIST } = await import("./ui/server.ts");
    const { agentFromEnv, createAgentHandler } = await import("./agent/agent.ts");
    const { budgetFromEnv } = await import("./agent/budget.ts");
    const db = await openIndexFrom(o);
    const agent = await agentFromEnv(db);
    const srv = await startUiServer({
      db,
      host: o.host,
      port: Number(o.port),
      agent: agent ? createAgentHandler(agent, budgetFromEnv()) : undefined,
    });
    const hasUi = existsSync(path.join(UI_DIST, "index.html"));
    console.log(
      `oracle serve: run ${db.meta.run_id} (${db.published ? "published" : "UNPUBLISHED"}, as of ${db.meta.as_of})`,
    );
    console.log(`  Explorer   ${srv.url}/${hasUi ? "" : "  (UI not built: npm run ui:build)"}`);
    console.log(`  API v1     ${srv.url}/api/health`);
    console.log(`  MCP        ${srv.url}/mcp  (Streamable HTTP, stateless)`);
    console.log(
      `  Agent      ${agent ? `on (${agent.modelId})` : "off — set ANTHROPIC_API_KEY in .env to enable"}`,
    );
    const stop = async () => {
      await srv.close();
      await db.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});

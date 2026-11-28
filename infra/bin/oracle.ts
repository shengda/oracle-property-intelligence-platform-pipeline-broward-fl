/**
 * CDK app for the hosted Oracle. Settings: deploy/hosted.json (committed, no secrets).
 * Alarm email: `-c alarmEmail=you@example.com` at deploy time (kept out of git).
 *   cd infra && npx cdk deploy -c alarmEmail=…
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { App, Tags } from "aws-cdk-lib";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { OracleStack, PROJECT_TAG } from "../lib/oracle-stack.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cfg = JSON.parse(readFileSync(path.join(root, "deploy", "hosted.json"), "utf8"));
const app = new App();
const manifestCid: string = app.node.tryGetContext("manifestCid") ?? cfg.manifestCid;

const published = path.join(root, "cache", "published", manifestCid, "query", "index.duckdb");
if (!existsSync(published))
  throw new Error(
    `run ${manifestCid} is not synced: run \`npm run oracle -- sync --manifest ${manifestCid}\` first (it verifies every file)`,
  );

new OracleStack(app, "OracleBroward", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-2" },
  manifestCid,
  image: lambda.DockerImageCode.fromImageAsset(root, {
    platform: Platform.LINUX_AMD64,
    buildArgs: { MANIFEST_CID: manifestCid },
  }),
  anthropicKeyParam: cfg.anthropicKeyParam,
  agentModel: cfg.agentModel,
  agentDailyTokens: cfg.agentDailyTokens,
  agentPerIpPerMinute: cfg.agentPerIpPerMinute,
  memoryMb: cfg.memoryMb,
  monthlyBudgetUsd: cfg.monthlyBudgetUsd,
  alarmEmail: app.node.tryGetContext("alarmEmail"),
});
Tags.of(app).add("project_name", PROJECT_TAG);

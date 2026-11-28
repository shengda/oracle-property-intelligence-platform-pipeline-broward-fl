/**
 * Hosted entry point (AWS Lambda container behind the Lambda Web Adapter, see Dockerfile).
 *
 * Serves the published run baked into the image at ORACLE_INDEX_DIR (sha256-checked against the
 * manifest when the image was built), read-only, on PORT. The Claude key is read from SSM at cold
 * start (ANTHROPIC_KEY_PARAM); the agent's daily token budget is shared across instances through
 * DynamoDB (ORACLE_BUDGET_TABLE). Logs and metrics use Powertools (JSON logs, CloudWatch EMF).
 */
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { Logger } from "@aws-lambda-powertools/logger";
import { MetricUnit, Metrics } from "@aws-lambda-powertools/metrics";
import { agentFromEnv, createAgentHandler } from "./agent/agent.ts";
import { budgetFromEnv } from "./agent/budget.ts";
import { openIndex } from "./query/db.ts";
import { startUiServer, type AgentHandler } from "./ui/server.ts";

export const METRICS_NAMESPACE = "OracleBroward";
const logger = new Logger({ serviceName: "oracle-broward" });
const metrics = new Metrics({ namespace: METRICS_NAMESPACE, serviceName: "oracle-broward" });

/** The Claude key: ANTHROPIC_API_KEY if set, else the SSM SecureString named by ANTHROPIC_KEY_PARAM. */
export async function loadAnthropicKey(env = process.env): Promise<string | null> {
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  if (!env.ANTHROPIC_KEY_PARAM) return null;
  const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
  const r = await new SSMClient({}).send(
    new GetParameterCommand({ Name: env.ANTHROPIC_KEY_PARAM, WithDecryption: true }),
  );
  return r.Parameter?.Value ?? null;
}

/** Counts agent calls, failures, budget rejections and tokens (one EMF record per call). */
export function withAgentMetrics(handler: AgentHandler, m: Metrics = metrics): AgentHandler {
  return async (body, ip) => {
    const r = await handler(body, ip);
    m.addMetric("AgentCalls", MetricUnit.Count, 1);
    if (r.status === 429) m.addMetric("AgentBudgetRejections", MetricUnit.Count, 1);
    if (r.status >= 500) m.addMetric("AgentFailures", MetricUnit.Count, 1);
    const tokens = (r.body as { usage?: { totalTokens?: number } } | null)?.usage?.totalTokens;
    if (typeof tokens === "number") m.addMetric("AgentTokens", MetricUnit.Count, tokens);
    m.publishStoredMetrics();
    return r;
  };
}

/**
 * Reads the index once in the background after start. Lambda loads container image files lazily,
 * so on a fresh instance the first query on each part of `index.duckdb` waits for those blocks
 * (a new CRM workspace took ~21 s instead of ~1 s); one sequential read pulls them all in.
 */
export function prefetchFile(file: string, log: (ms: number, bytes: number) => void): void {
  const t0 = Date.now();
  let bytes = 0;
  createReadStream(file, { highWaterMark: 8 << 20 })
    .on("data", (chunk) => {
      bytes += chunk.length;
    })
    .on("end", () => log(Date.now() - t0, bytes))
    .on("error", () => {});
}

export async function startHosted(env = process.env) {
  const dir = env.ORACLE_INDEX_DIR;
  const manifestCid = env.ORACLE_MANIFEST_CID;
  if (!dir || !manifestCid) throw new Error("ORACLE_INDEX_DIR and ORACLE_MANIFEST_CID are required");
  const indexPath = path.join(dir, "query", "index.duckdb");
  if (!existsSync(indexPath)) throw new Error(`no index at ${indexPath}`);

  const t0 = Date.now();
  const db = await openIndex(indexPath, { runDir: dir, manifestCid });
  const key = await loadAnthropicKey(env).catch((err) => {
    logger.error("could not read the Claude key from SSM; the agent stays off", err as Error);
    return null;
  });
  const agent = key ? await agentFromEnv(db, { ...env, ANTHROPIC_API_KEY: key }) : null;
  const srv = await startUiServer({
    db,
    host: "0.0.0.0",
    port: Number(env.PORT ?? 8080),
    trustProxy: 1,
    agent: agent ? withAgentMetrics(createAgentHandler(agent, budgetFromEnv(env))) : undefined,
    configure(app) {
      // Non-HTTP invocations (the EventBridge warm ping) arrive here through the Web Adapter.
      app.post("/events", async () => ({ ok: true }));
      app.addHook("onResponse", async (req, reply) => {
        if (reply.statusCode >= 500)
          logger.error("request failed", { method: req.method, url: req.url, status: reply.statusCode });
      });
    },
  });
  prefetchFile(indexPath, (ms, bytes) => logger.info("index prefetched", { ms, bytes }));
  logger.info("oracle hosted", {
    runId: db.meta.run_id,
    manifestCid,
    agent: agent ? agent.modelId : "off",
    startupMs: Date.now() - t0,
    url: srv.url,
  });
  return srv;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  startHosted().catch((err) => {
    logger.error("startup failed", err as Error);
    process.exit(1);
  });
}

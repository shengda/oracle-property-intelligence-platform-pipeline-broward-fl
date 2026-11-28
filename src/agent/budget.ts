import { createRateLimiter } from "../mcp/rate-limit.ts";
import { envPositiveNumber } from "../util/env.ts";

/** Per-IP request limit plus a daily token budget for the whole server (UTC day). */
export interface BudgetGuard {
  /** null when allowed, else a friendly reason (→ HTTP 429). */
  check(ip: string): string | null | Promise<string | null>;
  record(tokens: number): void | Promise<void>;
}

const BUDGET_USED_MSG =
  "The agent's daily budget is used up. It resets at midnight UTC — the map, search and MCP tools still work.";
const IP_LIMIT_MSG = "Too many questions in a minute from this address. Please wait a moment and ask again.";

export function createBudgetGuard(opts: {
  dailyTokens: number;
  perIpPerMinute: number;
  now?: () => number;
}): BudgetGuard & { status(): { day: string; used: number; limit: number } } {
  const now = opts.now ?? Date.now;
  const limiter = createRateLimiter({ limit: opts.perIpPerMinute, now });
  let day = new Date(now()).toISOString().slice(0, 10);
  let used = 0;
  const roll = () => {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      used = 0;
    }
  };
  return {
    check(ip) {
      roll();
      if (used >= opts.dailyTokens) return BUDGET_USED_MSG;
      if (!limiter.allow(ip)) return IP_LIMIT_MSG;
      return null;
    },
    record(tokens) {
      roll();
      used += Math.max(0, tokens);
    },
    status() {
      roll();
      return { day, used, limit: opts.dailyTokens };
    },
  };
}

/**
 * The hosted budget: the day's token count lives in DynamoDB (pk `AGENT#<day>`, TTL `expiresAt`)
 * so every Lambda instance shares one daily limit. The per-IP limit stays per instance.
 */
export function dynamoBudgetGuard(opts: {
  tableName: string;
  dailyTokens: number;
  perIpPerMinute: number;
  doc?: { send(cmd: unknown): Promise<{ Attributes?: Record<string, unknown> }> };
  now?: () => number;
}): BudgetGuard {
  const now = opts.now ?? Date.now;
  const limiter = createRateLimiter({ limit: opts.perIpPerMinute, now });
  let docClient = opts.doc;
  const doc = async () => {
    if (!docClient) {
      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
      docClient = DynamoDBDocumentClient.from(new DynamoDBClient({})) as never;
    }
    return docClient!;
  };
  const add = async (by: number): Promise<number> => {
    const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
    const t = now();
    const r = await (
      await doc()
    ).send(
      new UpdateCommand({
        TableName: opts.tableName,
        Key: { pk: `AGENT#${new Date(t).toISOString().slice(0, 10)}`, sk: "TOKENS" },
        UpdateExpression: "ADD #n :by SET expiresAt = if_not_exists(expiresAt, :exp)",
        ExpressionAttributeNames: { "#n": "n" },
        ExpressionAttributeValues: { ":by": by, ":exp": Math.floor(t / 1000) + 2 * 86_400 },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(r.Attributes?.n ?? 0);
  };
  return {
    async check(ip) {
      if ((await add(0)) >= opts.dailyTokens) return BUDGET_USED_MSG;
      if (!limiter.allow(ip)) return IP_LIMIT_MSG;
      return null;
    },
    async record(tokens) {
      if (tokens > 0) await add(tokens);
    },
  };
}

export function budgetFromEnv(env = process.env): BudgetGuard {
  if (env.ORACLE_BUDGET_TABLE)
    return dynamoBudgetGuard({
      tableName: env.ORACLE_BUDGET_TABLE,
      dailyTokens: envPositiveNumber(env, "ORACLE_AGENT_DAILY_TOKENS", 3_000_000),
      perIpPerMinute: envPositiveNumber(env, "ORACLE_AGENT_PER_IP_PER_MINUTE", 6),
    });
  return createBudgetGuard({
    dailyTokens: envPositiveNumber(env, "ORACLE_AGENT_DAILY_TOKENS", 3_000_000),
    perIpPerMinute: envPositiveNumber(env, "ORACLE_AGENT_PER_IP_PER_MINUTE", 6),
  });
}

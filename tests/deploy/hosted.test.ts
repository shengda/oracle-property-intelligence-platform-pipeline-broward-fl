import { expect, test } from "vitest";
import { dynamoBudgetGuard } from "../../src/agent/budget.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAnthropicKey, prefetchFile, withAgentMetrics } from "../../src/hosted.ts";

/** A DynamoDB document client stand-in: ADD on numeric attributes, keyed by pk/sk. */
function fakeDoc() {
  const items = new Map<string, number>();
  const sent: any[] = [];
  return {
    sent,
    async send(cmd: any) {
      const i = cmd.input;
      sent.push(i);
      const k = `${i.Key.pk}|${i.Key.sk}`;
      const n = (items.get(k) ?? 0) + i.ExpressionAttributeValues[":by"];
      items.set(k, n);
      return { Attributes: { n } };
    },
  };
}

test("dynamo budget: shared daily token count with TTL; denies once the day's budget is used", async () => {
  const doc = fakeDoc();
  const now = () => Date.parse("2026-11-28T10:00:00Z");
  const a = dynamoBudgetGuard({ tableName: "t", dailyTokens: 1000, perIpPerMinute: 10, doc, now });
  const b = dynamoBudgetGuard({ tableName: "t", dailyTokens: 1000, perIpPerMinute: 10, doc, now });
  expect(await a.check("1.1.1.1")).toBeNull();
  await a.record(600);
  await b.record(500); // another Lambda instance, same table
  expect(await a.check("1.1.1.1")).toMatch(/daily budget/);
  expect(doc.sent[0]).toMatchObject({ TableName: "t", Key: { pk: "AGENT#2026-11-28", sk: "TOKENS" } });
  expect(doc.sent[0].ExpressionAttributeValues[":exp"]).toBeGreaterThan(now() / 1000);
});

test("dynamo budget: per-IP limit still applies per minute", async () => {
  const g = dynamoBudgetGuard({ tableName: "t", dailyTokens: 1e9, perIpPerMinute: 2, doc: fakeDoc() });
  expect(await g.check("9.9.9.9")).toBeNull();
  expect(await g.check("9.9.9.9")).toBeNull();
  expect(await g.check("9.9.9.9")).toMatch(/Too many/);
  expect(await g.check("8.8.8.8")).toBeNull();
});

test("agent metrics: counts calls, rejections, failures and tokens", async () => {
  const added: [string, number][] = [];
  const m = {
    addMetric: (n: string, _u: unknown, v: number) => added.push([n, v]),
    publishStoredMetrics() {},
  };
  const ok = withAgentMetrics(
    async () => ({ status: 200, body: { usage: { totalTokens: 1234 } } }),
    m as any,
  );
  const limited = withAgentMetrics(async () => ({ status: 429, body: { error: "x" } }), m as any);
  const failed = withAgentMetrics(async () => ({ status: 502, body: { error: "x" } }), m as any);
  await ok({}, "ip");
  await limited({}, "ip");
  await failed({}, "ip");
  expect(added).toEqual([
    ["AgentCalls", 1],
    ["AgentTokens", 1234],
    ["AgentCalls", 1],
    ["AgentBudgetRejections", 1],
    ["AgentCalls", 1],
    ["AgentFailures", 1],
  ]);
});

test("claude key: env wins; no param and no env → null (agent off)", async () => {
  expect(await loadAnthropicKey({ ANTHROPIC_API_KEY: "k" })).toBe("k");
  expect(await loadAnthropicKey({})).toBeNull();
});

test("prefetch: reads the whole file once in the background", async () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "prefetch-")), "index.duckdb");
  writeFileSync(f, Buffer.alloc(20 << 20, 1));
  const bytes = await new Promise<number>((resolve) => prefetchFile(f, (_ms, n) => resolve(n)));
  expect(bytes).toBe(20 << 20);
});

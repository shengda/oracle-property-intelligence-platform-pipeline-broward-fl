import { readFile } from "node:fs/promises";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { AgentTimeoutError, createAgentHandler, createOracleAgent } from "../../src/agent/agent.ts";
import { createBudgetGuard } from "../../src/agent/budget.ts";
import { AgentAnswer } from "../../src/contract/index.ts";
import type { SnapshotDb } from "../../src/query/db.ts";
import { fixtureIndex } from "../helpers/fixture-index.ts";

let db: SnapshotDb;
beforeAll(async () => {
  ({ db } = await fixtureIndex());
}, 120_000);
afterAll(async () => db?.close());

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const call = (id: string, toolName: string, input: object) => ({
  content: [{ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
  usage,
  warnings: [],
});
const say = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "end_turn" },
  usage,
  warnings: [],
});
// Census point for Fort Lauderdale (src/data/broward-places.json)
const FTL = { lat: 26.14123, lon: -80.14673 };

function agentWith(script: any[]) {
  const model = new MockLanguageModelV4({ doGenerate: script });
  return { model, agent: createOracleAgent({ db, model, modelId: "mock" }) };
}

test("aged-roofs prompt calls resolve_place then find_aged_roofs{radiusMiles:5,minRoofAgeYears:15}; steps come from step results", async () => {
  const { agent } = agentWith([
    call("1", "resolve_place", { name: "Fort Lauderdale" }),
    call("2", "find_aged_roofs", { ...FTL, radiusMiles: 5, minRoofAgeYears: 15 }),
    say("Here are the aged roofs."),
  ]);
  const a = await agent.ask({
    message: "Show me properties near Fort Lauderdale with old roofs",
    history: [],
  });
  AgentAnswer.parse(a);
  expect(a.steps.map((s) => s.tool)).toEqual(["resolve_place", "find_aged_roofs"]);
  expect(a.steps[1].args).toMatchObject({ radiusMiles: 5, minRoofAgeYears: 15 });
  expect(a.steps[1].rowCount).toBeGreaterThan(0);
  expect(a.results.length).toBe(a.steps[1].rowCount);
  expect(a.context).toMatchObject({ center: FTL, radiusMiles: 5, placeName: "FORT LAUDERDALE" });
  expect(a.assumptions.join(" ")).toMatch(/resolved to FORT LAUDERDALE/);
  expect(a.assumptions.join(" ")).toMatch(/Radius 5 miles \(default/);
  expect(a.assumptions.join(" ")).toMatch(/threshold 15 years \(default/);
});

test("long-open prompt returns open duration and contractor, and 'no BBB rating' in missingData", async () => {
  const { agent } = agentWith([
    call("1", "find_open_roof_permits", { ...FTL, radiusMiles: 10, minOpenYears: 0 }),
    say("These permits have been open longest."),
  ]);
  const a = await agent.ask({
    message: "Which properties within 10 miles have long-open roofing permits?",
    history: [],
  });
  expect(a.steps[0].rowCount).toBeGreaterThan(0);
  expect(a.missingData.join(" ")).toMatch(/No BBB rating/);
});

test("unknown city → assumption recorded, no invented coordinates", async () => {
  const { agent } = agentWith([
    call("1", "resolve_place", { name: "Orlando" }),
    say("Orlando is not in Broward County."),
  ]);
  const a = await agent.ask({ message: "Aged roofs near Orlando", history: [] });
  expect(a.assumptions.join(" ")).toMatch(/"Orlando" is not a Broward County place/);
  expect(a.results).toEqual([]);
  expect(a.context.center).toBeUndefined();
});

test("radius crossing uncovered jurisdictions → missingData names them and says roof age comes from year built there", async () => {
  const { agent } = agentWith([
    call("1", "find_aged_roofs", { lat: 26.011, lon: -80.149, radiusMiles: 5, minRoofAgeYears: 15 }),
    say("Results near Hollywood."),
  ]);
  const a = await agent.ask({ message: "old roofs within 5 miles of Hollywood", history: [] });
  const m = a.missingData.join(" ");
  expect(m).toMatch(/Hollywood/i);
  expect(m).toMatch(/year built/);
});

test("citations reference only identifiers returned by tools", async () => {
  const { agent } = agentWith([
    call("1", "find_aged_roofs", { ...FTL, radiusMiles: 5, minRoofAgeYears: 0, limit: 3 }),
    say("See parcel 999999999999 (made up) and the results above."),
  ]);
  const a = await agent.ask({ message: "roofs near 26.14,-80.15", history: [] });
  const returned = new Set(a.results.map((r) => r.parcelId));
  expect(a.citations.length).toBeGreaterThan(0);
  for (const c of a.citations) {
    expect(returned.has(c.parcelId!)).toBe(true);
    expect(c.sourceUrl).toMatch(/^https?:/);
  }
  expect(a.citations.some((c) => c.parcelId === "999999999999")).toBe(false);
});

test("follow-up 'near that area' reuses the previous turn's center and radius and records that assumption", async () => {
  const { agent, model } = agentWith([
    call("1", "find_open_roof_permits", { ...FTL, radiusMiles: 5 }),
    say("Open permits in the same area."),
  ]);
  const prev = { center: FTL, radiusMiles: 5, placeName: "FORT LAUDERDALE" };
  const a = await agent.ask({
    message: "Which properties near that area have open roofing permits?",
    history: [
      { role: "user", content: "aged roofs near Fort Lauderdale" },
      { role: "assistant", content: "Here are aged roofs.", context: prev },
    ],
  });
  expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toMatch(
    /Previous turn's search area: center 26\.14123/,
  );
  expect(a.assumptions.join(" ")).toMatch(/Reused the previous search area: FORT LAUDERDALE, 5 miles/);
  expect(a.context).toEqual(prev);
});

test("over budget → 429 with a friendly message", async () => {
  const { agent } = agentWith([say("hi")]);
  const h = createAgentHandler(agent, createBudgetGuard({ dailyTokens: 0, perIpPerMinute: 10 }));
  const r: any = await h({ message: "hello", history: [] }, "1.2.3.4");
  expect(r.status).toBe(429);
  expect(r.body.error).toMatch(/daily budget/);
});

test("model timeout → friendly failure, no partial answer", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: ({ abortSignal }) =>
      new Promise((_, reject) => abortSignal?.addEventListener("abort", () => reject(abortSignal.reason))),
  });
  const agent = createOracleAgent({ db, model, modelId: "mock", timeoutMs: 50 });
  await expect(agent.ask({ message: "hello", history: [] })).rejects.toBeInstanceOf(AgentTimeoutError);
  const h = createAgentHandler(agent, createBudgetGuard({ dailyTokens: 1e9, perIpPerMinute: 10 }));
  const r: any = await h({ message: "hello", history: [] }, "1.2.3.4");
  expect(r.status).toBe(504);
  expect(r.body.text).toBeUndefined();
  expect(r.body.error).toMatch(/too long/);
});

test("no direct provider SDK is imported (lint rule bans @anthropic-ai/sdk)", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  expect(await readFile(path.join(root, "eslint.config.js"), "utf8")).toMatch(/@anthropic-ai\/sdk/);
  const agentSrc = await readFile(path.join(root, "src/agent/agent.ts"), "utf8");
  expect(agentSrc).not.toMatch(/from "@anthropic-ai\/sdk"/);
  expect(agentSrc).toMatch(/from "@ai-sdk\/anthropic"|import\("@ai-sdk\/anthropic"\)/);
});

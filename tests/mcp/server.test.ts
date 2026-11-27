import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { createOracleMcpServer } from "../../src/mcp/server.ts";
import type { SnapshotDb } from "../../src/query/db.ts";
import { ORACLE_TOOLS } from "../../src/tools/registry.ts";
import { fixtureIndex } from "../helpers/fixture-index.ts";

let db: SnapshotDb;
let client: Client;

beforeAll(async () => {
  ({ db } = await fixtureIndex());
  const server = createOracleMcpServer(db);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
}, 120_000);
afterAll(async () => {
  await client?.close();
  await db?.close();
});

test("lists exactly the thirteen tools, three resources and two prompts", async () => {
  expect((await client.listTools()).tools).toHaveLength(13);
  expect((await client.listResources()).resources.map((r) => r.uri).sort()).toEqual([
    "oracle://manifest/current",
    "oracle://run-history",
    "oracle://views-guide",
  ]);
  expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual([
    "aged_roofs_near_city",
    "long_open_roof_permits_near_city",
  ]);
});

test("MCP tool list and registry are identical (names and input schemas)", async () => {
  const listed = (await client.listTools()).tools;
  for (const t of ORACLE_TOOLS) {
    const m = listed.find((x) => x.name === t.name)!;
    expect(m, t.name).toBeTruthy();
    const expected = z.toJSONSchema(t.inputSchema, { io: "input" }) as any;
    expect(Object.keys(m.inputSchema.properties ?? {}).sort()).toEqual(
      Object.keys(expected.properties ?? {}).sort(),
    );
    expect((m.inputSchema.required ?? []).sort()).toEqual((expected.required ?? []).sort());
  }
});

test("find_aged_roofs returns rows with provenance, property_cid and manifest_cid", async () => {
  const r: any = await client.callTool({
    name: "find_aged_roofs",
    arguments: { lat: 26.122, lon: -80.137, radiusMiles: 5, minRoofAgeYears: 15 },
  });
  expect(r.isError).toBeFalsy();
  const out = r.structuredContent;
  expect(out.rows.length).toBeGreaterThan(0);
  expect(out.rows[0]).toHaveProperty("property_cid");
  expect(out.rows[0]).toHaveProperty("manifest_cid");
  expect(out.rows[0].provenance[0].source_url).toBeTruthy();
});

test("invalid radius (negative) returns a tool error, not a crash", async () => {
  const r: any = await client
    .callTool({ name: "find_aged_roofs", arguments: { lat: 26.1, lon: -80.1, radiusMiles: -2 } })
    .catch((e: Error) => ({ isError: true, thrown: e.message }));
  expect(r.isError).toBe(true);
  // the server keeps answering afterwards
  expect((await client.callTool({ name: "dataset_info", arguments: {} })).isError).toBeFalsy();
});

test("run_read_only_sql rejects DDL through MCP too", async () => {
  const r: any = await client.callTool({
    name: "run_read_only_sql",
    arguments: { sql: "CREATE TABLE x(a int)" },
  });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/SELECT/);
});

test("resources and prompts answer", async () => {
  const m: any = await client.readResource({ uri: "oracle://manifest/current" });
  expect(JSON.parse(m.contents[0].text).published).toBe(false);
  const g: any = await client.readResource({ uri: "oracle://views-guide" });
  expect(g.contents[0].text).toMatch(/v_property/);
  const p = await client.getPrompt({ name: "aged_roofs_near_city", arguments: { city: "Fort Lauderdale" } });
  expect(JSON.stringify(p.messages)).toMatch(/find_aged_roofs/);
});

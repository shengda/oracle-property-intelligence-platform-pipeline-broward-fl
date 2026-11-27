import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mountMcpHttp } from "../../src/mcp/http.ts";
import { createOracleMcpServer } from "../../src/mcp/server.ts";
import type { SnapshotDb } from "../../src/query/db.ts";
import { fixtureIndex } from "../helpers/fixture-index.ts";

let db: SnapshotDb;
let app: FastifyInstance;
let url: string;

beforeAll(async () => {
  ({ db } = await fixtureIndex());
  app = Fastify();
  mountMcpHttp(app, () => createOracleMcpServer(db), { rateLimitPerMinute: 8 });
  const addr = await app.listen({ port: 0, host: "127.0.0.1" });
  url = `${addr}/mcp`;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

test("HTTP: a Streamable HTTP client lists tools at /mcp without a session (stateless)", async () => {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "http-test", version: "0" });
  await client.connect(transport);
  expect(transport.sessionId).toBeUndefined();
  expect((await client.listTools()).tools).toHaveLength(13);
  const r: any = await client.callTool({ name: "resolve_place", arguments: { name: "Weston" } });
  expect(r.structuredContent.found).toBe(true);
  await client.close();
});

test("HTTP: GET is not offered in stateless mode", async () => {
  const res = await fetch(url, { headers: { accept: "text/event-stream" } });
  expect(res.status).toBe(405);
});

test("HTTP: requests over the per-IP limit get 429", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
    });
    statuses.push(res.status);
    await res.arrayBuffer();
  }
  expect(statuses).toContain(429);
});

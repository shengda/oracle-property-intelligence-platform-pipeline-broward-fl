/**
 * `oracle serve`: Fastify JSON API v1 (the CRM's contract, architecture §5), the Explorer UI
 * (static `ui/dist`), the stateless MCP endpoint at `/mcp`, the agent endpoint and read-only access
 * to the run's derived files (for the in-browser DuckDB-WASM proof). Every API response is
 * validated against its `contract` schema before it is sent.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { createRateLimiter } from "../mcp/rate-limit.ts";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import * as C from "../contract/index.ts";
import { REPO_ROOT } from "../config.ts";
import { mountMcpHttp } from "../mcp/http.ts";
import { createOracleMcpServer, currentManifest, runHistory } from "../mcp/server.ts";
import { compareManifests, manifestRows, servedManifest, servedVerification } from "../publish/served.ts";
import { gatewaysFromEnv, verifyManifest } from "../publish/verify.ts";
import { fetchManifest } from "../query/sync.ts";
import type { SnapshotDb } from "../query/db.ts";
import { listPlaces, resolvePlace } from "../query/places.ts";
import * as Q from "../query/queries.ts";
import { ORACLE_TOOLS } from "../tools/registry.ts";
import { viewsGuide } from "../views/views-guide.ts";

export const DEFAULT_PORT = 4317;
export const UI_DIST = path.join(REPO_ROOT, "ui", "dist");

/** Handler for POST /api/agent (Task 16); injected so the server has no LLM dependency itself. */
export type AgentHandler = (body: unknown, ip: string) => Promise<{ status: number; body: unknown }>;

export interface UiServerOptions {
  db: SnapshotDb;
  host?: string;
  port?: number;
  agent?: AgentHandler;
  /** Directory with the built UI; omitted or missing → API only. */
  staticDir?: string | null;
  mcpRateLimitPerMinute?: number;
  logger?: boolean;
  /**
   * Proxy hops to trust for the client IP. Hosted: 1 (the Lambda Web Adapter on 127.0.0.1), so
   * `req.ip` is the address the Function URL appended to X-Forwarded-For, not a spoofable one.
   */
  trustProxy?: number;
  /** Extra routes and hooks, registered before the server listens (hosted: warm pings, metrics). */
  configure?: (app: FastifyInstance) => void;
}

/** Derived/meta files the browser may fetch from a local run (never work stores or CARs). */
const SERVABLE = [/^query\/v_[a-z_]+\.parquet$/, /^samples\/[a-z-]+\.csv$/, /^meta\/[a-z]+\.json$/];

function send<T>(reply: FastifyReply, schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    reply.log.error({ issues: parsed.error.issues.slice(0, 5) }, "response failed contract validation");
    return reply
      .code(500)
      .send({ error: "response failed contract validation", issues: parsed.error.issues.slice(0, 5) });
  }
  return reply.send(parsed.data);
}

const qNum = z.coerce.number();
const qInt = z.coerce.number().int();

/** Query-string → contract query: lat/lon flat params, numbers coerced. */
function centerFrom(q: Record<string, string | undefined>) {
  if (q.lat == null || q.lon == null || q.lat === "" || q.lon === "") return undefined;
  return { lat: qNum.parse(q.lat), lon: qNum.parse(q.lon) };
}
function opt<T>(v: string | undefined, p: z.ZodType<T>): T | undefined {
  return v == null || v === "" ? undefined : p.parse(v);
}

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return h.digest("hex");
}

async function dirSize(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return n;
}

export async function startUiServer(
  opts: UiServerOptions,
): Promise<{ app: FastifyInstance; url: string; close(): Promise<void> }> {
  const { db } = opts;
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 1_000_000,
    trustProxy: (_addr: string, hop: number) => hop < (opts.trustProxy ?? 0),
  });
  const digestCache = new Map<string, string>();

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof z.ZodError || err?.name === "ZodError") {
      return reply.code(400).send({ error: "invalid request", issues: err.issues?.slice(0, 5) });
    }
    if (/only SELECT|not allowed|only one statement/.test(err?.message ?? "")) {
      return reply.code(400).send({ error: err.message });
    }
    reply.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "internal error" });
  });

  // ── health, run, sources, quality, manifest ──────────────────────────────────────────────
  app.get("/api/health", async () => ({
    ok: true,
    published: db.published,
    manifestCid: db.manifestCid,
    runId: db.meta.run_id,
    asOf: db.meta.as_of,
    index: { path: path.basename(db.path), viewsVersion: db.meta.views_version, builtAt: db.meta.built_at },
    agent: opts.agent ? "available" : "not configured",
  }));

  app.get("/api/dataset", async (_req, reply) => send(reply, C.DatasetInfo, await Q.datasetInfo(db)));

  app.get("/api/runs", async () => {
    const state = await db.readMeta<any>("state.json");
    const history = await runHistory(db);
    return {
      published: db.published,
      runs: [
        {
          run_id: db.meta.run_id,
          mode: state?.mode ?? null,
          as_of: db.meta.as_of,
          status: state?.status ?? null,
          started_at: state?.started_at ?? null,
          finished_at: state?.finished_at ?? null,
          manifest_cid: db.manifestCid,
          elephant_cli: state?.elephant_cli ?? null,
          groups: (state?.groups ?? []).map((g: any) => ({
            group: g.group,
            properties: g.properties,
            blocks: g.blocks,
            archive_root: g.archiveRoot,
            tables_root: g.tablesRoot,
            timings_ms: g.timingsMs ?? null,
            tables: g.tables ?? {},
          })),
          deltas: (await db.readMeta<any>("deltas.json")) ?? null,
        },
      ],
      // Published runs, newest first (each with its manifest CID, roots and verification).
      history: db.published ? history.runs : [],
      history_cid: ((await db.readRunFile<any>("publish/publish.json")) ?? {}).history_cid ?? null,
    };
  });

  app.get("/api/sources", async () => {
    const coverage = await db.readMeta<any>("coverage.json");
    const measured = (await db.readMeta<any>("sources.json"))?.sources ?? {};
    const sources = (coverage?.sources ?? []).map((s: any) => {
      // Weston loads as two feeds (issued/closed); fold their measurements into the registry row.
      const parts = [measured[s.key], measured[`${s.key}-issued`], measured[`${s.key}-closed`]].filter(
        Boolean,
      );
      const m = parts[0];
      return {
        ...s,
        status: s.status === "not_run" && parts.length ? parts[0].status : s.status,
        records: parts.reduce((n: number, p: any) => n + (p.records ?? 0), 0) || s.records,
        bytes: parts.reduce((n: number, p: any) => n + (p.bytes ?? 0), 0) || null,
        requests: parts.reduce((n: number, p: any) => n + (p.requests ?? 0), 0) || null,
        avg_latency_ms: m?.avgLatencyMs ?? null,
        started_at: m?.startedAt ?? null,
        finished_at: parts.at(-1)?.finishedAt ?? null,
        sha256: m?.sha256 ?? null,
        changed: m?.changed ?? null,
      };
    });
    const counts = await db.all<{ table_name: string; n: number }>(
      `select table_name, estimated_size::INTEGER as n from duckdb_tables() where table_name like 'lx_%' order by table_name`,
    );
    return {
      run_id: db.meta.run_id,
      sources,
      lexicon_classes: counts.map((c) => ({ table: c.table_name, rows: c.n })),
      permit_coverage: await Q.permitCoverage(db),
    };
  });

  const sameRun = (runId: string) => runId === db.meta.run_id || runId === "current";

  app.get<{ Params: { runId: string } }>("/api/qa/:runId", async (req, reply) => {
    if (!sameRun(req.params.runId))
      return reply.code(404).send({ error: `run ${req.params.runId} is not served here` });
    const qa = await db.readMeta<any>("qa.json");
    if (!qa) return reply.code(404).send({ error: "this run has no meta/qa.json (run `oracle index`)" });
    const m = await servedManifest(db);
    const qaCid = m?.artifacts.find((a) => a.name === "meta/qa.json")?.cid ?? null;
    return { ...qa, published: db.published, qa_cid: qaCid };
  });

  app.get<{ Params: { runId: string } }>("/api/manifest/:runId", async (req, reply) => {
    if (!sameRun(req.params.runId))
      return reply.code(404).send({ error: `run ${req.params.runId} is not served here` });
    const manifest = await currentManifest(db);
    const published = await servedManifest(db);
    if (published) {
      const v = await servedVerification(db);
      return {
        ...manifest,
        files: manifestRows(published, db.manifestCid),
        last_verification: v
          ? {
              ok: v.ok,
              checkedAt: v.checkedAt,
              gateways: v.gateways,
              quick: v.quick,
              results: v.results.length,
            }
          : null,
        verify: { available: true, reason: null },
      };
    }
    const files: {
      name: string;
      kind: string;
      codec: string;
      size: number | null;
      sha256: string | null;
      cid: string | null;
      note?: string;
    }[] = [];
    if (db.runDir) {
      const state = await db.readMeta<any>("state.json");
      for (const g of state?.groups ?? []) {
        const car = path.join(db.runDir, "build", `${g.group}.car`);
        files.push({
          name: `${g.group} archive (CountyIndex, packed)`,
          kind: "lexicon",
          codec: "directory",
          size: existsSync(car) ? (await stat(car)).size : null,
          sha256: null,
          cid: g.archiveRoot,
          note: `CAR at build/${g.group}.car; the CID is the content address.`,
        });
        const tdir = path.join(db.runDir, "tables", g.group);
        files.push({
          name: `${g.group} tables (export-tables Parquet)`,
          kind: "lexicon",
          codec: "directory",
          size: existsSync(tdir) ? await dirSize(tdir) : null,
          sha256: null,
          cid: g.tablesRoot,
        });
      }
      for (const sub of ["query", "samples", "meta"]) {
        const dir = path.join(db.runDir, sub);
        if (!existsSync(dir)) continue;
        for (const f of (await readdir(dir)).sort()) {
          const rel = `${sub}/${f}`;
          const full = path.join(dir, f);
          const size = (await stat(full)).size;
          let sha: string | null = null;
          if (size <= 200_000_000) {
            const key = `${rel}:${size}`;
            sha = digestCache.get(key) ?? (await sha256File(full));
            digestCache.set(key, sha);
          }
          files.push({
            name: rel,
            kind: sub === "meta" ? "meta" : "derived",
            codec: "file",
            size,
            sha256: sha,
            cid: null,
            note: sha ? undefined : "large file: digest computed at publish",
          });
        }
      }
    }
    return {
      ...manifest,
      files,
      verify: {
        available: db.published,
        reason: db.published
          ? null
          : "Unpublished run: gateway verification starts once the run is published (oracle publish).",
      },
    };
  });

  app.get<{ Params: { runId: string } }>("/api/verify/:runId", async (req, reply) => {
    if (!sameRun(req.params.runId))
      return reply.code(404).send({ error: `run ${req.params.runId} is not served here` });
    const report = db.published ? await servedVerification(db) : null;
    return {
      run_id: db.meta.run_id,
      published: db.published,
      report,
      reason: db.published
        ? report
          ? null
          : "No verification report stored for this run yet (oracle verify)."
        : "Unpublished run: nothing is on IPFS gateways yet.",
    };
  });

  // "Verify now": re-check every CID of the served manifest on the public gateways, quick mode
  // (each root block must hash to its CID; files up to 5 MB byte for byte). Seconds, not minutes.
  app.post<{ Params: { runId: string } }>("/api/verify/:runId", async (req, reply) => {
    if (!sameRun(req.params.runId))
      return reply.code(404).send({ error: `run ${req.params.runId} is not served here` });
    const m = await servedManifest(db);
    if (!m || !db.manifestCid) return reply.code(409).send({ error: "this run is not published" });
    const report = await verifyManifest(m, {
      manifestCid: db.manifestCid,
      gateways: gatewaysFromEnv(),
      quick: true,
      retries: 2,
      timeoutMs: 30_000,
      concurrency: 8,
    });
    return { run_id: db.meta.run_id, published: true, report, reason: null };
  });

  // "Check previous run": fetch the previous manifest by CID from the gateways (it must hash to
  // its CID) and list what changed. Proves an earlier run still resolves.
  app.get("/api/manifest/previous", async (_req, reply) => {
    const m = await servedManifest(db);
    if (!m) return reply.code(409).send({ error: "this run is not published" });
    if (!m.previous_manifest_cid) {
      return { previous_manifest_cid: null, reason: "This is the first published run." };
    }
    const t0 = Date.now();
    try {
      const prev = await fetchManifest(m.previous_manifest_cid, { gateways: gatewaysFromEnv() });
      return {
        previous_manifest_cid: m.previous_manifest_cid,
        resolved_in_ms: Date.now() - t0,
        run_id: prev.run_id,
        created_at: prev.created_at,
        groups: prev.groups.map((g) => ({
          group: g.key,
          archive_root: g.archive.cid,
          tables_root: g.tables.cid,
        })),
        ...compareManifests(prev, m),
      };
    } catch (err) {
      return reply
        .code(502)
        .send({ previous_manifest_cid: m.previous_manifest_cid, error: (err as Error).message });
    }
  });

  // ── queries ──────────────────────────────────────────────────────────────────────────────
  type QS = { Querystring: Record<string, string | undefined> };

  app.get<QS>("/api/query/aged-roofs", async (req, reply) => {
    const q = req.query;
    const input = C.AgedRoofsQuery.parse({
      center: centerFrom(q),
      radiusMiles: opt(q.radiusMiles, qNum) ?? C.DEFAULTS.radiusMiles,
      minRoofAgeYears: opt(q.minRoofAgeYears, qInt),
      limit: opt(q.limit, qInt),
      order: q.order === "nearest" || q.order === "spread" ? q.order : undefined,
    });
    const [rows, total, uncovered] = await Promise.all([
      Q.findAgedRoofs(db, input),
      Q.countAgedRoofs(db, input),
      Q.uncoveredJurisdictionsInRadius(db, input.center, input.radiusMiles),
    ]);
    return send(
      reply,
      z.object({ total: z.number(), rows: z.array(C.PropertyLead), uncovered: z.array(z.any()) }),
      { total, rows, uncovered },
    );
  });

  app.get<QS>("/api/query/open-permits", async (req, reply) => {
    const q = req.query;
    const input = C.OpenRoofPermitsQuery.parse({
      center: centerFrom(q),
      radiusMiles: opt(q.radiusMiles, qNum) ?? C.DEFAULTS.radiusMiles,
      minOpenYears: opt(q.minOpenYears, qNum),
      minRoofAgeYears: opt(q.minRoofAgeYears, qInt),
      limit: opt(q.limit, qInt),
    });
    const [rows, total, uncovered] = await Promise.all([
      Q.findOpenRoofPermits(db, input),
      Q.countOpenRoofPermits(db, input),
      Q.uncoveredJurisdictionsInRadius(db, input.center, input.radiusMiles),
    ]);
    return send(
      reply,
      z.object({ total: z.number(), rows: z.array(C.PermitLead), uncovered: z.array(z.any()) }),
      { total, rows, uncovered },
    );
  });

  app.get<QS>("/api/query/occupancy", async (req, reply) => {
    const q = req.query;
    const rows = await Q.findByOccupancy(db, {
      center: centerFrom(q),
      radiusMiles: opt(q.radiusMiles, qNum),
      occupancy: (q.occupancy ?? "likely_tenant_occupied").split(",").filter(Boolean),
      minRoofAgeYears: opt(q.minRoofAgeYears, qInt),
      limit: opt(q.limit, qInt),
    });
    return send(
      reply,
      z.object({ rows: z.array(C.PropertyLead.extend({ occupancy_basis: z.string().nullable() })) }),
      { rows },
    );
  });

  app.get<QS>("/api/query/long-held", async (req, reply) => {
    const q = req.query;
    const rows = await Q.findLongHeldProperties(db, {
      center: centerFrom(q),
      radiusMiles: opt(q.radiusMiles, qNum),
      minYearsSinceTransfer: opt(q.minYearsSinceTransfer, qInt),
      limit: opt(q.limit, qInt),
    });
    return send(reply, z.object({ rows: z.array(C.PropertyLead) }), { rows });
  });

  app.get<QS>("/api/query/out-of-area", async (req, reply) => {
    const q = req.query;
    const rows = await Q.findOutOfAreaOwners(db, {
      center: centerFrom(q),
      radiusMiles: opt(q.radiusMiles, qNum),
      scope: q.scope || undefined,
      limit: opt(q.limit, qInt),
    });
    return send(reply, z.object({ rows: z.array(C.PropertyLead) }), { rows });
  });

  app.get<QS>("/api/search", async (req, reply) => {
    const q = req.query;
    const rows = await Q.searchRecords(db, {
      text: q.q ?? q.text ?? "",
      mode: q.mode || undefined,
      center: centerFrom(q),
      radiusMiles: opt(q.radiusMiles, qNum),
      limit: opt(q.limit, qInt),
    });
    return send(reply, z.object({ rows: z.array(C.SearchHit) }), { rows });
  });

  const sqlLimiter = createRateLimiter({ limit: 30 });
  app.post<{ Body: { sql?: string; maxRows?: number } }>("/api/sql", async (req, reply) => {
    if (!sqlLimiter.allow(req.ip))
      return reply.code(429).send({ error: "Too many SQL queries in a minute; please wait a moment." });
    const r = await Q.readOnlySql(
      db,
      String(req.body?.sql ?? ""),
      Math.min(Number(req.body?.maxRows ?? 200), 1000),
    );
    return send(reply, C.SqlResult, r);
  });

  // ── entities ─────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { parcelId: string } }>("/api/property/:parcelId", async (req, reply) => {
    const d = await Q.getProperty(db, req.params.parcelId);
    if (!d) return reply.code(404).send({ error: `no parcel ${req.params.parcelId} in this run` });
    return send(reply, C.PropertyDetail, d);
  });
  app.get<{ Params: { permitKey: string } }>("/api/permit/:permitKey", async (req, reply) => {
    const d = await Q.getPermit(db, req.params.permitKey);
    if (!d) return reply.code(404).send({ error: `no permit ${req.params.permitKey} in this run` });
    return send(reply, C.PermitDetail, d);
  });
  app.get<{ Params: { companyId: string } }>("/api/business/:companyId", async (req, reply) => {
    const d = await Q.getBusiness(db, req.params.companyId);
    if (!d) return reply.code(404).send({ error: `no business ${req.params.companyId} in this run` });
    return send(reply, C.BusinessDetail, d);
  });
  app.get<{ Params: { companyId: string } }>("/api/contractor/:companyId", async (req, reply) => {
    const d = await Q.getContractor(db, req.params.companyId);
    if (!d) return reply.code(404).send({ error: `no contractor ${req.params.companyId} in this run` });
    return send(reply, C.ContractorDetail, d);
  });
  app.get<QS>("/api/contractors", async (req, reply) => {
    const q = req.query;
    const rows = await Q.listContractors(db, {
      center: centerFrom(q),
      radiusMiles: opt(q.radiusMiles, qNum),
      minOpenPermits: opt(q.minOpenPermits, qInt),
      limit: opt(q.limit, qInt),
    });
    return send(reply, z.object({ rows: z.array(C.ContractorRow) }), { rows });
  });
  app.get<QS>("/api/place", async (req, reply) => {
    const p = resolvePlace(req.query.name ?? "");
    if (!p)
      return reply.code(404).send({
        error: `'${req.query.name ?? ""}' is not a Broward County place`,
        places: listPlaces().map((x) => x.name),
      });
    return send(reply, C.ResolvedPlace, p);
  });
  app.get("/api/places", async () => ({ places: listPlaces() }));
  app.get("/api/views-guide", async (_req, reply) => reply.type("text/markdown").send(viewsGuide()));
  app.get("/api/tools", async () => ({
    tools: ORACLE_TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: z.toJSONSchema(t.inputSchema, { io: "input" }),
    })),
  }));

  // ── agent, MCP ───────────────────────────────────────────────────────────────────────────
  app.post("/api/agent", async (req, reply) => {
    if (!opts.agent) {
      return reply.code(503).send({
        error:
          "The agent is not configured on this server: set ANTHROPIC_API_KEY (and optionally ORACLE_AGENT_MODEL) in .env and restart `oracle serve`.",
      });
    }
    const r = await opts.agent(req.body, req.ip);
    return reply.code(r.status).send(r.body);
  });
  mountMcpHttp(app, () => createOracleMcpServer(db), {
    rateLimitPerMinute: opts.mcpRateLimitPerMinute ?? 120,
  });

  // ── run files (derived/meta only) and the UI ─────────────────────────────────────────────
  if (db.runDir) {
    await app.register(fastifyStatic, {
      root: db.runDir,
      prefix: "/files/",
      decorateReply: false,
      allowedPath: (p) => SERVABLE.some((re) => re.test(p.replace(/^\/+/, ""))),
      acceptRanges: true,
      cacheControl: false,
    });
  }
  const staticDir = opts.staticDir === undefined ? UI_DIST : opts.staticDir;
  if (staticDir && existsSync(path.join(staticDir, "index.html"))) {
    // wildcard: resolve files per request, so a UI rebuild (new hashed names) needs no restart.
    await app.register(fastifyStatic, { root: staticDir, prefix: "/", wildcard: true });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") || req.url.startsWith("/files/")
        ? reply.code(404).send({ error: "not found" })
        : reply.sendFile("index.html"),
    );
  } else {
    app.get("/", async (_req, reply) =>
      reply
        .type("text/html")
        .send(
          "<p>API is running. The UI is not built yet: run <code>npm run ui:build</code>, then restart <code>oracle serve</code>.</p>",
        ),
    );
  }

  opts.configure?.(app);
  const url = await app.listen({ host: opts.host ?? "127.0.0.1", port: opts.port ?? DEFAULT_PORT });
  return { app, url, close: () => app.close() };
}

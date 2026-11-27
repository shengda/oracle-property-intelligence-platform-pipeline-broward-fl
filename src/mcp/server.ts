import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SnapshotDb } from "../query/db.ts";
import { ORACLE_TOOLS } from "../tools/registry.ts";
import { viewsGuide } from "../views/views-guide.ts";

export const MCP_SERVER_NAME = "oracle-broward";

/** What the manifest resource reports for a local, unpublished run (M2), or a published one (M3). */
export async function currentManifest(db: SnapshotDb): Promise<Record<string, unknown>> {
  const state = await db.readMeta<any>("state.json");
  return {
    published: db.published,
    manifest_cid: db.manifestCid,
    run_id: db.meta.run_id,
    as_of: db.meta.as_of,
    views_version: db.meta.views_version,
    note: db.published
      ? "Published run; artifacts are addressed by CID."
      : "UNPUBLISHED local run: group roots below are computed locally and are not yet retrievable from IPFS gateways.",
    groups: (state?.groups ?? []).map((g: any) => ({
      group: g.group,
      properties: g.properties,
      archive_root: g.archiveRoot,
      tables_root: g.tablesRoot,
    })),
  };
}

export async function runHistory(db: SnapshotDb): Promise<Record<string, unknown>> {
  const state = await db.readMeta<any>("state.json");
  const deltas = await db.readMeta<any>("deltas.json");
  return {
    runs: [
      {
        run_id: db.meta.run_id,
        mode: state?.mode ?? null,
        as_of: db.meta.as_of,
        status: state?.status ?? null,
        manifest_cid: db.manifestCid,
        previous_manifest_cid: null,
        deltas: deltas ?? null,
      },
    ],
    note: db.published ? undefined : "History of published runs starts in M3; this lists the local run only.",
  };
}

function json(uri: string, value: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

/**
 * MCP server over one run's index: the thirteen registry tools, three resources and the two
 * README prompts. Stateless — safe to create per HTTP request.
 */
export function createOracleMcpServer(db: SnapshotDb): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: "0.2.0" },
    {
      instructions:
        "Broward County, FL property intelligence for roofing: aged roofs, open roof permits, contractors, owners and occupancy. Resolve city names with resolve_place first; every row carries provenance (source_url), property_cid and manifest_cid. Read oracle://views-guide before writing SQL.",
    },
  );

  for (const t of ORACLE_TOOLS) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args: unknown) => {
        try {
          const out = await t.handler(db, args as never);
          return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `${t.name} failed: ${(err as Error).message}` }],
          };
        }
      },
    );
  }

  server.registerResource(
    "manifest-current",
    "oracle://manifest/current",
    {
      title: "Current manifest",
      description: "The run this server answers from: manifest CID (null when unpublished) and group roots.",
      mimeType: "application/json",
    },
    async (uri) => json(uri.href, await currentManifest(db)),
  );
  server.registerResource(
    "run-history",
    "oracle://run-history",
    {
      title: "Run history",
      description: "Runs with their manifest CIDs and deltas.",
      mimeType: "application/json",
    },
    async (uri) => json(uri.href, await runHistory(db)),
  );
  server.registerResource(
    "views-guide",
    "oracle://views-guide",
    {
      title: "Roofing views guide",
      description: "Columns and meaning of roofing-views.v1 for SQL.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: viewsGuide() }] }),
  );

  server.registerPrompt(
    "aged_roofs_near_city",
    {
      title: "Aged roofs near a city",
      description:
        "README question 1: properties within N miles of a city whose roofs are at least M years old.",
      argsSchema: {
        city: z.string(),
        radiusMiles: z.string().optional(),
        minRoofAgeYears: z.string().optional(),
      },
    },
    ({ city, radiusMiles, minRoofAgeYears }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Show me properties within ${radiusMiles ?? "5"} miles of ${city}, FL with roofs more than ${minRoofAgeYears ?? "15"} years old. Resolve the city with resolve_place, then call find_aged_roofs. Report how many match, the roof-age basis, and any jurisdictions in the radius without permit data.`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    "long_open_roof_permits_near_city",
    {
      title: "Long-open roof permits near a city",
      description:
        "README question 2: properties near a city with roofing permits that have been open a long time, with contractor and BBB data.",
      argsSchema: {
        city: z.string(),
        radiusMiles: z.string().optional(),
        minOpenYears: z.string().optional(),
      },
    },
    ({ city, radiusMiles, minOpenYears }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Which properties within ${radiusMiles ?? "5"} miles of ${city}, FL have roofing permits that have been open for ${minOpenYears ? `at least ${minOpenYears} years` : "a long time"}? Show the open duration, the contractor and their BBB rating if available. Use resolve_place, then find_open_roof_permits.`,
          },
        },
      ],
    }),
  );
  return server;
}

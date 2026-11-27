import { tool, type ToolSet } from "ai";
import type { SnapshotDb } from "../query/db.ts";
import { ORACLE_TOOLS } from "../tools/registry.ts";

/** The same registry the MCP server serves, as AI SDK tools over one SnapshotDb. */
export function oracleAiTools(db: SnapshotDb): ToolSet {
  const out: ToolSet = {};
  for (const t of ORACLE_TOOLS) {
    out[t.name] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
      execute: async (input: unknown) => {
        try {
          return await t.handler(db, t.inputSchema.parse(input) as never);
        } catch (err) {
          // Returned (not thrown) so the model sees the reason and can correct its call.
          return { error: (err as Error).message };
        }
      },
    });
  }
  return out;
}

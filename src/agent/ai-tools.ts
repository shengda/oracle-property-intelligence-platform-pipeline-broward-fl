import { tool, type ToolSet } from "ai";
import type { SnapshotDb } from "../query/db.ts";
import { ORACLE_TOOLS } from "../tools/registry.ts";

/** Rows of one tool result the model reads; the full result stays in the step (UI evidence). */
export const MODEL_ROW_LIMIT = 40;
/** Per-row fields the model does not need to answer: provenance, URLs, content ids. */
const MODEL_DROP_KEYS = new Set([
  "provenance",
  "source_url",
  "source_system",
  "retrieved_at",
  "manifest_cid",
  "property_cid",
  "property_improvement_cid",
  "contractor_company_cid",
  "company_cid",
]);

function compactValue(v: unknown, depth: number): unknown {
  if (Array.isArray(v)) return v.map((x) => compactValue(x, depth + 1));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    // The run's manifest id stays once at the top; ids, URLs and nulls go from every row.
    if (x === null || (depth > 0 && MODEL_DROP_KEYS.has(k)) || (depth === 0 && k === "provenance")) continue;
    out[k] = compactValue(x, depth + 1);
  }
  return out;
}

/**
 * What the model reads from a tool result: rows without provenance, URLs, ids or nulls, at most
 * MODEL_ROW_LIMIT of them, totals kept. Without this a 174-row answer cost ~240k tokens across
 * the agent's steps; citations and map pins are still built from the full result.
 */
export function compactForModel(output: unknown): unknown {
  const c = compactValue(output, 0);
  if (c && typeof c === "object" && !Array.isArray(c)) {
    const o = c as Record<string, unknown>;
    if (Array.isArray(o.rows) && o.rows.length > MODEL_ROW_LIMIT) {
      const shown = o.rows.length;
      o.rows = o.rows.slice(0, MODEL_ROW_LIMIT);
      o.rows_note = `Showing ${MODEL_ROW_LIMIT} of the ${shown} rows returned (total_matching and count cover all of them). The user sees every row in the evidence.`;
    }
  }
  return c;
}

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
      toModelOutput: ({ output }) => ({ type: "json", value: compactForModel(output) as never }),
    });
  }
  return out;
}

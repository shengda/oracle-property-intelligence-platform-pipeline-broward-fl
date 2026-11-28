/**
 * Oracle agent (Task 16): Vercel AI SDK `generateText` + the Oracle tool registry. The answer's
 * text comes from the model; everything else (steps, map results, citations, missing data,
 * assumptions, the search context for follow-ups) is derived from the AI SDK step results, so
 * the panel shows what was actually retrieved and citations can only name tool-returned records.
 */
import { envPositiveNumber } from "../util/env.ts";
import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import { AgentAnswer, AgentRequest, type AgentContext, type ChatTurn } from "../contract/index.ts";
import type { SnapshotDb } from "../query/db.ts";
import type { AgentHandler } from "../ui/server.ts";
import { oracleAiTools } from "./ai-tools.ts";
import type { BudgetGuard } from "./budget.ts";
import { systemPrompt } from "./prompt.ts";

export const DEFAULT_AGENT_MODEL = "claude-opus-5-5";
export const MAX_STEPS = 8;

export class AgentTimeoutError extends Error {}

export interface OracleAgent {
  readonly modelId: string;
  ask(input: { message: string; history: ChatTurn[] }): Promise<AgentAnswer>;
}

type ToolRun = { tool: string; args: Record<string, unknown>; output: any };

const RADIUS_TOOLS = new Set([
  "find_aged_roofs",
  "find_open_roof_permits",
  "find_long_held_properties",
  "find_out_of_area_owners",
  "find_by_occupancy",
  "search_records",
]);

function rowsOf(o: any): any[] {
  if (!o || typeof o !== "object") return [];
  if (Array.isArray(o.rows)) return o.rows;
  if (o.property && typeof o.property === "object") return [o.property, ...(o.permits ?? [])];
  if (o.permit)
    return [
      {
        ...o.permit,
        ...(o.property
          ? {
              lat: o.property.lat,
              lon: o.property.lon,
              address: o.property.address,
              parcel_identifier: o.property.parcel_identifier,
            }
          : {}),
      },
    ];
  if (o.contractor && Array.isArray(o.permits)) return o.permits;
  if (Array.isArray(o.properties)) return o.properties;
  return [];
}

function label(r: any): string {
  return String(
    r.address ??
      r.permit_address ??
      r.contractor_name ??
      r.name ??
      r.permit_key ??
      r.parcel_identifier ??
      r.text ??
      "",
  ).slice(0, 120);
}

function near(a?: { lat: number; lon: number }, b?: { lat: number; lon: number }): boolean {
  return !!a && !!b && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;
}

/** Turn the tool runs of one answer into the panel's structured fields. */
export function summarizeRuns(
  runs: ToolRun[],
  text: string,
  message: string,
  previous: AgentContext | undefined,
) {
  const steps = runs.map((r) => {
    const rows = rowsOf(r.output);
    const found = r.output?.found;
    return {
      tool: r.tool,
      args: r.args,
      rowCount: rows.length || (found === true ? 1 : 0),
      sample: rows.slice(0, 3).map(label).filter(Boolean),
      ...(r.output?.error ? { error: String(r.output.error) } : {}),
    };
  });

  const results = new Map<string, { parcelId: string; lat: number; lon: number; label: string }>();
  const citations = new Map<string, { parcelId?: string; permitKey?: string; sourceUrl: string }>();
  const mentioned: typeof citations = new Map();
  for (const r of runs) {
    for (const row of rowsOf(r.output)) {
      const pid = row.parcel_identifier as string | undefined;
      if (
        pid &&
        typeof row.lat === "number" &&
        typeof row.lon === "number" &&
        !results.has(pid) &&
        results.size < 200
      )
        results.set(pid, { parcelId: pid, lat: row.lat, lon: row.lon, label: label(row) });
      const url = row.source_url ?? row.provenance?.[0]?.source_url;
      if (!url) continue;
      const key = String(row.permit_key ?? pid ?? url);
      const c = {
        ...(pid ? { parcelId: pid } : {}),
        ...(row.permit_key ? { permitKey: row.permit_key } : {}),
        sourceUrl: String(url),
      };
      if (!citations.has(key)) citations.set(key, c);
      if (
        (pid && text.includes(pid)) ||
        (row.permit_number && text.includes(row.permit_number)) ||
        (row.permit_key && text.includes(row.permit_key))
      )
        mentioned.set(key, c);
    }
  }
  const cites = (mentioned.size ? [...mentioned.values()] : [...citations.values()].slice(0, 10)).slice(
    0,
    25,
  );

  const assumptions: string[] = [];
  const missing = new Set<string>();
  let context: AgentContext = previous ?? {};
  let resolvedThisTurn: { name: string; lat: number; lon: number } | null = null;
  for (const r of runs) {
    const o = r.output ?? {};
    if (r.tool === "resolve_place") {
      if (o.found && o.place) {
        resolvedThisTurn = o.place;
        assumptions.push(
          `"${r.args.name}" was resolved to ${o.place.name} (Census Gazetteer point ${o.place.lat.toFixed(4)}, ${o.place.lon.toFixed(4)}).`,
        );
      } else {
        assumptions.push(
          `"${r.args.name}" is not a Broward County place in the Census Gazetteer; no coordinates were assumed.`,
        );
      }
    }
    for (const n of (o.notes ?? []) as string[]) {
      if (/UNPUBLISHED/.test(n)) continue;
      missing.add(n);
    }
    if (RADIUS_TOOLS.has(r.tool) && typeof r.args.lat === "number" && typeof r.args.lon === "number") {
      const center = { lat: r.args.lat as number, lon: r.args.lon as number };
      const radiusMiles = typeof r.args.radiusMiles === "number" ? (r.args.radiusMiles as number) : 5;
      let placeName: string | undefined;
      if (resolvedThisTurn && near(resolvedThisTurn, center)) placeName = resolvedThisTurn.name;
      else if (near(previous?.center, center)) {
        placeName = previous?.placeName;
        if (!resolvedThisTurn)
          assumptions.push(
            `Reused the previous search area: ${placeName ?? `${center.lat.toFixed(4)}, ${center.lon.toFixed(4)}`}, ${radiusMiles} miles.`,
          );
      }
      context = { center, radiusMiles, ...(placeName ? { placeName } : {}) };
    }
  }
  const radiusTold = /\bmi(le)?s?\b|\bradius\b/i.test(message);
  const ageTold = /\d+\s*(\+\s*)?(years?|yrs?|y)\b/i.test(message);
  if (
    runs.some((r) => RADIUS_TOOLS.has(r.tool) && r.args.radiusMiles === 5) &&
    !radiusTold &&
    !assumptions.some((a) => a.startsWith("Reused"))
  )
    assumptions.push("Radius 5 miles (default; not stated in the question).");
  if (runs.some((r) => r.tool === "find_aged_roofs" && r.args.minRoofAgeYears === 15) && !ageTold)
    assumptions.push("Roof age threshold 15 years (default; not stated in the question).");
  if (runs.some((r) => r.output?.published === false))
    assumptions.push("Answer comes from an UNPUBLISHED local run (no manifest CID yet).");
  if (!runs.length) missing.add("No tool was called, so this answer contains no Oracle data.");

  return {
    steps,
    results: [...results.values()],
    citations: cites,
    assumptions: [...new Set(assumptions)],
    missingData: [...missing],
    context,
  };
}

export function createOracleAgent(deps: {
  db: SnapshotDb;
  model: LanguageModel;
  modelId: string;
  timeoutMs?: number;
}): OracleAgent {
  const tools = oracleAiTools(deps.db);
  return {
    modelId: deps.modelId,
    async ask(input) {
      const req = AgentRequest.parse(input);
      const previous = [...req.history]
        .reverse()
        .find((t) => t.role === "assistant" && t.context?.center)?.context;
      const messages: ModelMessage[] = [
        ...req.history.map((t) => ({ role: t.role, content: t.content }) as ModelMessage),
        { role: "user", content: req.message },
      ];
      let result;
      try {
        result = await generateText({
          model: deps.model,
          system: systemPrompt({ asOf: deps.db.meta.as_of, published: deps.db.published, previous }),
          messages,
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
          abortSignal: AbortSignal.timeout(deps.timeoutMs ?? 90_000),
          maxRetries: 1,
        });
      } catch (err) {
        const e = err as Error;
        if (
          e?.name === "AbortError" ||
          e?.name === "TimeoutError" ||
          /abort|timed? ?out/i.test(e?.message ?? "")
        )
          throw new AgentTimeoutError("model call timed out");
        throw err;
      }
      const runs: ToolRun[] = result.steps.flatMap((s: any) =>
        (s.toolResults ?? []).map((tr: any) => ({
          tool: tr.toolName,
          args: (tr.input ?? {}) as Record<string, unknown>,
          output: tr.output,
        })),
      );
      const text = result.text?.trim() || "I could not produce an answer from the tool results.";
      const summary = summarizeRuns(runs, text, req.message, previous);
      const usage: any = (result as any).totalUsage ?? result.usage;
      return AgentAnswer.parse({
        text,
        ...summary,
        manifestCid: deps.db.manifestCid,
        model: deps.modelId,
        usage: { totalTokens: Number(usage?.totalTokens ?? 0) || 0 },
      });
    },
  };
}

/** HTTP handler for POST /api/agent: budget, validation, timeout and friendly failures. */
export function createAgentHandler(agent: OracleAgent, budget: BudgetGuard): AgentHandler {
  return async (body, ip) => {
    const denied = await budget.check(ip);
    if (denied) return { status: 429, body: { error: denied } };
    const parsed = AgentRequest.safeParse(body);
    if (!parsed.success)
      return { status: 400, body: { error: "invalid request", issues: parsed.error.issues.slice(0, 5) } };
    try {
      const answer = await agent.ask(parsed.data);
      await budget.record(answer.usage.totalTokens);
      return { status: 200, body: answer };
    } catch (err) {
      if (err instanceof AgentTimeoutError)
        return {
          status: 504,
          body: {
            error:
              "The agent took too long to answer, so no partial answer is shown. Please try again or narrow the question.",
          },
        };
      return {
        status: 502,
        body: {
          error: `The agent could not answer right now (${(err as Error).message.slice(0, 200)}). The map, search and MCP tools still work.`,
        },
      };
    }
  };
}

/** Builds the agent from env (ANTHROPIC_API_KEY, ORACLE_AGENT_MODEL); null when no key is set. */
export async function agentFromEnv(db: SnapshotDb, env = process.env): Promise<OracleAgent | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const modelId = env.ORACLE_AGENT_MODEL || DEFAULT_AGENT_MODEL;
  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return createOracleAgent({
    db,
    model: anthropic(modelId),
    modelId,
    timeoutMs: envPositiveNumber(env, "ORACLE_AGENT_TIMEOUT_MS", 90_000),
  });
}

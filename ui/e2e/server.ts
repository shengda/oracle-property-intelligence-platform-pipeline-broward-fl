/**
 * E2E server: the fixture run served exactly like `oracle serve --fixture`, plus an agent backed
 * by a scripted mock model (no API key, deterministic) so the Agent page can be tested.
 * Test-only — never used by `oracle serve`.
 */
import { MockLanguageModelV4 } from "ai/test";
import { createAgentHandler, createOracleAgent } from "../../src/agent/agent.ts";
import { createBudgetGuard } from "../../src/agent/budget.ts";
import { openIndexFrom } from "../../src/serve.ts";
import { startUiServer } from "../../src/ui/server.ts";

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
};
const toolCall = (name: string, input: object) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId: `c-${name}-${Date.now()}`,
      toolName: name,
      input: JSON.stringify(input),
    },
  ],
  finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
  usage,
  warnings: [],
});
const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: "end_turn" },
  usage,
  warnings: [],
});

/** Plays the README questions: resolve the city, then aged roofs or open permits; reuse the area on follow-ups. */
const model = new MockLanguageModelV4({
  doGenerate: async (opts: any) => {
    const prompt: any[] = opts.prompt;
    const system = prompt
      .filter((m) => m.role === "system")
      .map((m) => String(m.content))
      .join("\n");
    const lastUser = [...prompt].reverse().find((m) => m.role === "user");
    const userText = (
      Array.isArray(lastUser?.content)
        ? lastUser.content.map((p: any) => p.text ?? "").join(" ")
        : String(lastUser?.content ?? "")
    ).toLowerCase();
    const idx = prompt.lastIndexOf(lastUser);
    const results = prompt
      .slice(idx + 1)
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content);
    const out = (r: any) => r?.output?.value ?? r?.output;
    const wantsPermits = /permit/.test(userText);
    if (results.length === 0) {
      const prev = /Previous turn's search area: center (-?[\d.]+), (-?[\d.]+).*?radius ([\d.]+)/.exec(
        system,
      );
      if (prev && /that area|near there|same area/.test(userText))
        return toolCall(wantsPermits ? "find_open_roof_permits" : "find_aged_roofs", {
          lat: +prev[1],
          lon: +prev[2],
          radiusMiles: +prev[3],
        });
      const city =
        /(?:of|near)\s+([a-z .]+?)(?:\s+with|,|\?|\.|$)/.exec(userText)?.[1]?.trim() ?? "fort lauderdale";
      return toolCall("resolve_place", { name: city });
    }
    const last = out(results.at(-1));
    if (results.length === 1 && last?.place) {
      const { lat, lon } = last.place;
      return wantsPermits
        ? toolCall("find_open_roof_permits", { lat, lon, radiusMiles: 5 })
        : toolCall("find_aged_roofs", { lat, lon, radiusMiles: 5, minRoofAgeYears: 15 });
    }
    if (last?.found === false) return text("That place is not in Broward County, so I did not search.");
    const rows = last?.rows ?? [];
    const first = rows[0];
    return text(
      `Found ${last?.total_matching ?? rows.length} matching records (showing ${rows.length}).` +
        (first
          ? ` The first is ${first.address ?? first.parcel_identifier} (folio ${first.parcel_identifier}).`
          : ""),
    );
  },
});

const port = Number(process.env.E2E_PORT ?? 4399);
const db = await openIndexFrom({ fixture: true });
const agent = createOracleAgent({ db, model, modelId: "mock-e2e" });
const srv = await startUiServer({
  db,
  port,
  agent: createAgentHandler(agent, createBudgetGuard({ dailyTokens: 1e9, perIpPerMinute: 1000 })),
});
console.log(`e2e server ready at ${srv.url}`);

import { useMemo, useState } from "react";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorBox, Json, Section } from "../components/ui.tsx";

const EXAMPLES: Record<string, object> = {
  dataset_info: {},
  resolve_place: { name: "Fort Lauderdale" },
  find_aged_roofs: { lat: 26.14123, lon: -80.14673, radiusMiles: 5, minRoofAgeYears: 15, limit: 5 },
  find_open_roof_permits: { lat: 26.14123, lon: -80.14673, radiusMiles: 5, minOpenYears: 2, limit: 5 },
  run_read_only_sql: { sql: "select city, count(*) n from v_property group by 1 order by 2 desc limit 5" },
};

type Exchange = { method: string; request: unknown; response: unknown; ms: number };

export function Mcp() {
  const endpoint = `${window.location.origin}/mcp`;
  const [log, setLog] = useState<Exchange[]>([]);
  const [tools, setTools] = useState<{ name: string; description?: string }[] | null>(null);
  const [tool, setTool] = useState("find_aged_roofs");
  const [args, setArgs] = useState(JSON.stringify(EXAMPLES.find_aged_roofs, null, 2));
  const [error, setError] = useState<Error | null>(null);
  const [client, setClient] = useState<Client | null>(null);

  // A fetch that records the raw JSON-RPC request and response bodies.
  const recordingFetch = useMemo(
    () => async (input: RequestInfo | URL, init?: RequestInit) => {
      const t = performance.now();
      const res = await fetch(input, init);
      const text = await res.clone().text();
      let request: unknown = init?.body;
      try {
        request = JSON.parse(String(init?.body));
      } catch {
        /* keep raw */
      }
      let response: unknown = text;
      try {
        response = text ? JSON.parse(text) : `(HTTP ${res.status}, empty body)`;
      } catch {
        /* keep raw */
      }
      setLog((l) =>
        [
          {
            method: (request as any)?.method ?? init?.method ?? "?",
            request,
            response,
            ms: Math.round(performance.now() - t),
          },
          ...l,
        ].slice(0, 20),
      );
      return res;
    },
    [],
  );

  async function connect(): Promise<Client> {
    if (client) return client;
    const c = new Client({ name: "oracle-explorer-console", version: "0.2.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(endpoint), { fetch: recordingFetch }));
    setClient(c);
    return c;
  }
  const guard = (fn: () => Promise<void>) => async () => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e as Error);
    }
  };

  return (
    <>
      <Section title="MCP endpoint">
        <p>
          Streamable HTTP (stateless, JSON responses): <code data-testid="mcp-endpoint">{endpoint}</code>
        </p>
        <pre className="json">{`# Claude Code
claude mcp add --transport http oracle-broward ${endpoint}

# stdio (local run, no server)
claude mcp add oracle-broward -- ./bin/oracle.mjs mcp --index runs/<run_id>/query/index.duckdb`}</pre>
      </Section>
      <Section title="Live MCP console">
        <div className="row wrap">
          <button onClick={guard(async () => void (await connect()))} data-testid="mcp-initialize">
            initialize
          </button>
          <button
            data-testid="mcp-list"
            onClick={guard(async () => {
              const c = await connect();
              setTools((await c.listTools()).tools);
            })}
          >
            tools/list
          </button>
          <select
            value={tool}
            onChange={(e) => {
              setTool(e.target.value);
              setArgs(JSON.stringify(EXAMPLES[e.target.value] ?? {}, null, 2));
            }}
            aria-label="Tool"
          >
            {(tools?.map((t) => t.name) ?? Object.keys(EXAMPLES)).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <button
            data-testid="mcp-call"
            onClick={guard(async () => {
              const c = await connect();
              await c.callTool({ name: tool, arguments: JSON.parse(args) });
            })}
          >
            tools/call
          </button>
        </div>
        <textarea
          className="sql"
          rows={6}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          aria-label="Tool arguments (JSON)"
          spellCheck={false}
        />
        <ErrorBox error={error} />
        {tools && (
          <p className="small" data-testid="mcp-tool-count">
            {tools.length} tools: {tools.map((t) => t.name).join(", ")}
          </p>
        )}
      </Section>
      <Section title="JSON-RPC exchanges (newest first)">
        {log.length === 0 && <p className="muted">Press initialize to start.</p>}
        {log.map((x, i) => (
          <details key={log.length - i} open={i === 0} className="exchange">
            <summary>
              <code>{x.method}</code> · {x.ms} ms
            </summary>
            <div className="two">
              <div>
                <h3>Request</h3>
                <Json value={x.request} />
              </div>
              <div>
                <h3>Response</h3>
                <Json value={x.response} />
              </div>
            </div>
          </details>
        ))}
      </Section>
    </>
  );
}

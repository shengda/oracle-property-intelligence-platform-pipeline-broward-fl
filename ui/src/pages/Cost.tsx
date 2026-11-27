import { Section } from "../components/ui.tsx";

export function Cost() {
  return (
    <Section title="Cost — what runs where">
      <ul className="list">
        <li>
          <strong>Ingest, build and index</strong> run on the operator's machine (this laptop): about 1 h 20
          min for a full Broward run, no cloud cost.
        </li>
        <li>
          <strong>Published data</strong> is content-addressed on IPFS, pinned on two providers; readers fetch
          it from public gateways. Oracle runs no paid database.
        </li>
        <li>
          <strong>Queries</strong> run in DuckDB on the consumer side: this server, the CRM, an MCP client, or
          the browser itself (see the WASM proof page).
        </li>
        <li>
          <strong>The hosted Explorer and MCP endpoint</strong> (M5) run on AWS Lambda from the published
          index — pay per request, scale to zero when idle.
        </li>
        <li>
          <strong>The agent</strong> is the only metered part: Claude calls through the Vercel AI SDK, with a
          per-IP limit and a daily token budget (<code>ORACLE_AGENT_DAILY_TOKENS</code>).
        </li>
      </ul>
    </Section>
  );
}

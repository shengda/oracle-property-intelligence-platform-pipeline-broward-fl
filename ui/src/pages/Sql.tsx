import { useEffect, useState } from "react";
import { ErrorBox, Section, Table } from "../components/ui.tsx";
import { api } from "../lib/api.ts";

const EXAMPLES: [string, string][] = [
  [
    "Aged roofs by city",
    "select city, count(*) as properties, round(avg(roof_age_years), 1) as avg_roof_age\nfrom v_property where roof_age_years >= 15\ngroup by city order by properties desc",
  ],
  [
    "Roof-age basis mix",
    "select roof_age_basis, permit_jurisdiction_covered, count(*) n\nfrom v_property group by all order by n desc",
  ],
  [
    "Longest-open roof permits",
    "select permit_number, address, open_years, contractor_name, contractor_license\nfrom v_roof_permit where status = 'open'\norder by open_days desc limit 50",
  ],
  [
    "Owner location × occupancy",
    "select owner_location_class, occupancy_class, count(*) n\nfrom v_owner group by all order by n desc",
  ],
  ["Lexicon tables", "select table_name, estimated_size from duckdb_tables() order by table_name"],
];

export function Sql() {
  const [sql, setSql] = useState(EXAMPLES[0][1]);
  const [res, setRes] = useState<any | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [guide, setGuide] = useState("");
  useEffect(() => {
    fetch("/api/views-guide")
      .then((r) => r.text())
      .then(setGuide, () => {});
  }, []);
  async function run() {
    setBusy(true);
    setError(null);
    const t = performance.now();
    try {
      const r = await api<any>("/api/sql", { method: "POST", body: JSON.stringify({ sql, maxRows: 500 }) });
      setRes({ ...r, ms: Math.round(performance.now() - t) });
    } catch (e) {
      setError(e as Error);
      setRes(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Section
        title="Read-only SQL (DuckDB)"
        actions={
          <span className="muted small">
            One SELECT · rows capped at 500 · DDL, COPY, ATTACH, file functions rejected
          </span>
        }
      >
        <div className="row wrap">
          {EXAMPLES.map(([t, q]) => (
            <button key={t} className="ghost" onClick={() => setSql(q)}>
              {t}
            </button>
          ))}
        </div>
        <textarea
          className="sql"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && run()}
          rows={7}
          spellCheck={false}
          aria-label="SQL"
        />
        <div className="row">
          <button onClick={run} disabled={busy}>
            {busy ? "Running…" : "Run (⌘/Ctrl + Enter)"}
          </button>
          {res && (
            <span className="muted small">
              {res.rows.length} rows{res.truncated ? " (truncated)" : ""} · {res.ms} ms
            </span>
          )}
        </div>
        <ErrorBox error={error} />
      </Section>
      {res && (
        <Section title="Result">
          <Table
            testId="sql-result"
            rows={res.rows}
            cols={res.columns.map((c: string) => [
              c,
              (r: any) =>
                r[c] == null ? (
                  <span className="muted">null</span>
                ) : typeof r[c] === "object" ? (
                  JSON.stringify(r[c])
                ) : (
                  String(r[c])
                ),
            ])}
          />
        </Section>
      )}
      <Section title="Views guide">
        <pre className="guide">{guide}</pre>
      </Section>
    </>
  );
}

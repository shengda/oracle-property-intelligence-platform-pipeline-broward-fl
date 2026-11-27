import { useState } from "react";
import { ErrorBox, PropertyLink, Section, Table } from "../components/ui.tsx";
import { api, qs } from "../lib/api.ts";
import { href } from "../lib/router.ts";

const link = (h: any) => {
  const ref = h.ref as string;
  if (h.kind === "permit") return <a href={href("permit", ref)}>{ref.split(":").pop()}</a>;
  if (h.kind === "property") return <PropertyLink id={ref} />;
  if (h.kind === "contractor") return <a href={href("contractor", ref)}>{ref}</a>;
  return <a href={href("business", ref)}>{ref}</a>;
};

export function Search() {
  const [text, setText] = useState("replace roof shingles");
  const [mode, setMode] = useState("hybrid");
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Section title="Search permits, properties, businesses and contractors">
        <form
          className="inline"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              setRows((await api<any>(`/api/search${qs({ q: text, mode, limit: 50 })}`)).rows);
            } catch (err) {
              setError(err as Error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input
            className="grow"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Search text"
          />
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Mode">
            <option value="hybrid">hybrid (BM25 + semantic)</option>
            <option value="text">full-text (BM25)</option>
            <option value="semantic">semantic (embeddings)</option>
          </select>
          <button type="submit" disabled={busy}>
            {busy ? "Searching…" : "Search"}
          </button>
        </form>
        <p className="muted small">
          Semantic search embeds the query locally (MiniLM); the first query loads the model.
        </p>
        <ErrorBox error={error} />
      </Section>
      {rows && (
        <Section title={`${rows.length} results`}>
          <Table
            testId="search-results"
            rows={rows}
            cols={[
              ["Kind", (h: any) => h.kind],
              ["Record", link],
              ["Text", (h: any) => <span className="small">{h.text}</span>],
              ["Parcel", (h: any) => <PropertyLink id={h.parcel_identifier} />],
              ["Matched by", (h: any) => h.match.join(" + ")],
              ["Score", (h: any) => h.score.toFixed(4)],
            ]}
          />
        </Section>
      )}
    </>
  );
}

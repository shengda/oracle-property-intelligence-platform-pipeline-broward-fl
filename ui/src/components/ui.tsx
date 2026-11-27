import type { ReactNode } from "react";
import { href } from "../lib/router.ts";

export function Badge({ status, children }: { status: string; children?: ReactNode }) {
  return (
    <span className={`badge badge-${status.replace(/[^a-z_]/gi, "")}`}>
      {children ?? status.replace(/_/g, " ")}
    </span>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <p className="muted" role="status">
      {what}…
    </p>
  );
}

export function ErrorBox({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      {error.message}
    </div>
  );
}

export function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function Ext({ url, children }: { url: string | null | undefined; children?: ReactNode }) {
  if (!url) return <>—</>;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {children ?? url}
    </a>
  );
}

export function PropertyLink({ id, children }: { id: string | null | undefined; children?: ReactNode }) {
  if (!id) return <>—</>;
  return <a href={href("property", id)}>{children ?? id}</a>;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

/** Simple table: columns as [header, render] pairs. */
export function Table<T>({
  rows,
  cols,
  empty = "No rows.",
  testId,
}: {
  rows: T[];
  cols: [string, (r: T) => ReactNode][];
  empty?: string;
  testId?: string;
}) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return (
    <div className="table-wrap">
      <table data-testid={testId}>
        <thead>
          <tr>
            {cols.map(([h]) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map(([h, f]) => (
                <td key={h}>{f(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

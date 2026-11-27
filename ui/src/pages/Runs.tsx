import { Badge, ErrorBox, Kv, Loading, Section, Table } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { ms, n, shortCid } from "../lib/format.ts";
import { href } from "../lib/router.ts";

export function Runs() {
  const runs = useApi<any>("/api/runs");
  const info = useApi<any>("/api/dataset");
  if (runs.loading || info.loading) return <Loading />;
  const r = runs.data?.runs?.[0];
  const d = info.data;
  return (
    <>
      <ErrorBox error={runs.error ?? info.error} />
      {r && d && (
        <>
          <Section title={`Run ${r.run_id}`} actions={<a href={href("quality")}>Data quality →</a>}>
            <Kv
              rows={[
                [
                  "Status",
                  <Badge status={d.published ? "pass" : "warn"}>
                    {d.published ? "published" : `unpublished · ${r.status}`}
                  </Badge>,
                ],
                ["Mode", r.mode],
                ["As of", r.as_of],
                ["Manifest CID", r.manifest_cid ?? "— (published in M3)"],
                [
                  "Elephant CLI",
                  r.elephant_cli
                    ? `${r.elephant_cli.version} · ${r.elephant_cli.layout} · build ${r.elephant_cli.build.slice(0, 10)}`
                    : "—",
                ],
                ["Started → finished", `${r.started_at ?? "—"} → ${r.finished_at ?? "—"}`],
                ["Index built", d.builtAt],
              ]}
            />
            <div className="stats">
              {Object.entries(d.counts as Record<string, number>).map(([k, v]) => (
                <div key={k} className="stat">
                  <div className="stat-n">{n(v)}</div>
                  <div className="stat-l">{k}</div>
                </div>
              ))}
            </div>
          </Section>
          <Section title="Lexicon data groups">
            <Table
              rows={r.groups}
              cols={[
                ["Group", (g: any) => <strong>{g.group}</strong>],
                ["Properties", (g: any) => n(g.properties)],
                ["Blocks", (g: any) => n(g.blocks)],
                ["Archive root", (g: any) => <code title={g.archive_root}>{shortCid(g.archive_root)}</code>],
                ["Tables root", (g: any) => <code title={g.tables_root}>{shortCid(g.tables_root)}</code>],
                [
                  "validate / hash / CAR / export",
                  (g: any) =>
                    g.timings_ms
                      ? [
                          g.timings_ms.validate,
                          g.timings_ms.hash,
                          g.timings_ms.validateCar,
                          g.timings_ms.exportTables,
                        ]
                          .map(ms)
                          .join(" · ")
                      : "—",
                ],
              ]}
            />
            {r.deltas && (
              <p className="muted small">
                Deltas vs previous run ({r.deltas.previous_run_id ?? "none — first run"}):{" "}
                {Object.entries(r.deltas.groups ?? {})
                  .map(([g, x]: any) => `${g}: +${n(x.added)} / ~${n(x.changed)} / −${n(x.removed)}`)
                  .join("; ")}
              </p>
            )}
          </Section>
          <Section title="Lexicon tables in this run">
            <Table
              rows={r.groups.flatMap((g: any) =>
                Object.entries(g.tables).map(([t, v]: any) => ({ group: g.group, table: t, ...v })),
              )}
              cols={[
                ["Group", (x: any) => x.group],
                ["Table", (x: any) => <code>{x.table}</code>],
                ["Rows", (x: any) => n(x.rows)],
                ["Parquet parts", (x: any) => x.parts],
              ]}
            />
          </Section>
          <Section title="Coverage">
            <Kv
              rows={Object.entries(d.coverage?.groups ?? {}).map(([g, v]: any) => [
                g,
                Object.entries(v)
                  .map(([k, x]) => `${k} ${n(x as number)}`)
                  .join(" · "),
              ])}
            />
          </Section>
          <Section title="Known limitations">
            <ul className="list">
              {d.limitations.map((l: string) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </Section>
          <p className="muted small">
            Artifact sizes and digests are on the <a href={href("manifest")}>Manifest</a> page.
          </p>
        </>
      )}
    </>
  );
}

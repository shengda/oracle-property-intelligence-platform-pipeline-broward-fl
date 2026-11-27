import { Badge, ErrorBox, Loading, Section, Table } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { bytes, n } from "../lib/format.ts";

export function Sources() {
  const { data, error, loading } = useApi<any>("/api/sources");
  if (loading) return <Loading />;
  return (
    <>
      <ErrorBox error={error} />
      {data && (
        <>
          <Section title="Sources">
            <Table
              testId="sources-table"
              rows={data.sources}
              cols={[
                [
                  "Source",
                  (s: any) => (
                    <>
                      <strong>{s.title}</strong>
                      <div className="muted small">
                        <code>{s.key}</code> · {s.change_mode} · for {s.readme_need}
                      </div>
                    </>
                  ),
                ],
                ["Status", (s: any) => <Badge status={s.status} />],
                ["Records", (s: any) => n(s.records)],
                ["Transferred", (s: any) => bytes(s.bytes)],
                ["Requests", (s: any) => n(s.requests)],
                ["Retrieved", (s: any) => s.finished_at?.slice(0, 19).replace("T", " ") ?? "—"],
                [
                  "SHA-256",
                  (s: any) => (s.sha256 ? <code title={s.sha256}>{s.sha256.slice(0, 12)}</code> : "—"),
                ],
                [
                  "Limitation / reason",
                  (s: any) => (
                    <span className="small">
                      {s.limitation ?? ""}
                      {s.estimate ? ` (est. ${s.estimate.size}, ${s.estimate.time})` : ""}
                    </span>
                  ),
                ],
              ]}
            />
          </Section>
          <Section title="Permit coverage by jurisdiction">
            <Table
              rows={data.permit_coverage}
              cols={[
                ["Jurisdiction", (j: any) => j.name],
                ["Status", (j: any) => <Badge status={j.status} />],
                ["Parcels", (j: any) => n(j.parcels)],
                ["Permits", (j: any) => n(j.permits)],
                ["Roofing permits", (j: any) => n(j.roofingPermits)],
                ["Reason", (j: any) => <span className="small">{j.reason ?? ""}</span>],
              ]}
            />
          </Section>
          <Section title="Rows by Lexicon class">
            <Table
              rows={data.lexicon_classes}
              cols={[
                ["Table", (c: any) => <code>{c.table}</code>],
                ["Rows", (c: any) => n(c.rows)],
              ]}
            />
          </Section>
        </>
      )}
    </>
  );
}

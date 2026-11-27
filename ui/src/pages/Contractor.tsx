import { Badge, ErrorBox, Kv, Loading, PropertyLink, Section, Table } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { label, n } from "../lib/format.ts";
import { href } from "../lib/router.ts";

export function Contractor({ id }: { id: string }) {
  const { data, error, loading } = useApi<any>(`/api/contractor/${encodeURIComponent(id)}`);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const c = data.contractor;
  return (
    <>
      <Section title={c.contractor_name ?? c.dbpr_license_id}>
        <Kv
          rows={[
            ["DBPR license", <code>{c.dbpr_license_id}</code>],
            ["Class", c.license_class],
            ["Status", c.license_status],
            ["Expires", c.license_expiry],
            ["City / state", `${c.city ?? "—"}, ${c.state ?? ""}`],
            ["Roofing permits", n(c.permits)],
            ["Open roofing permits", n(data.open_permit_count)],
            ["BBB", data.bbb.rating ?? <span className="muted">{data.bbb.note}</span>],
            [
              "Source",
              <a href={c.source_url} target="_blank" rel="noreferrer">
                DBPR licensee extract
              </a>,
            ],
          ]}
        />
      </Section>
      <Section title="Roofing permits">
        <Table
          rows={data.permits}
          cols={[
            [
              "Permit",
              (p: any) => <a href={href("permit", p.permit_key)}>{p.permit_number ?? p.permit_key}</a>,
            ],
            [
              "Address",
              (p: any) => (
                <PropertyLink id={p.parcel_identifier}>
                  {p.address ?? p.parcel_identifier ?? "—"}
                </PropertyLink>
              ),
            ],
            ["Status", (p: any) => <Badge status={p.status} />],
            ["Work", (p: any) => label(p.roof_work_class)],
            ["Open", (p: any) => (p.open_days != null ? `${p.open_years} y` : "—")],
          ]}
        />
      </Section>
    </>
  );
}

export function Contractors() {
  const { data, error, loading } = useApi<any>("/api/contractors?limit=500");
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <Section title={`Contractors on roofing permits (${data.rows.length})`}>
      <Table
        testId="contractors"
        rows={data.rows}
        cols={[
          [
            "Contractor",
            (c: any) => (
              <a href={href("contractor", c.dbpr_license_id)}>{c.contractor_name ?? c.dbpr_license_id}</a>
            ),
          ],
          ["License", (c: any) => <code>{c.dbpr_license_id}</code>],
          ["Class", (c: any) => c.license_class],
          ["Status", (c: any) => c.license_status],
          ["Permits", (c: any) => n(c.permits)],
          ["Open", (c: any) => n(c.open_permits)],
          ["BBB", (c: any) => c.bbb_rating ?? <span className="muted">no rating</span>],
        ]}
      />
    </Section>
  );
}

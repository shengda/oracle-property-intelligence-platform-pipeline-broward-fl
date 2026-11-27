import { Badge, ErrorBox, Ext, Kv, Loading, PropertyLink, Section } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { label, money, n } from "../lib/format.ts";
import { href } from "../lib/router.ts";

export function Permit({ id }: { id: string }) {
  const { data, error, loading } = useApi<any>(`/api/permit/${encodeURIComponent(id)}`);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const p = data.permit;
  return (
    <>
      <Section
        title={`Permit ${p.permit_number ?? p.permit_key}`}
        actions={<Ext url={p.source_url}>Source record ↗</Ext>}
      >
        <Kv
          rows={[
            ["Key", <code>{p.permit_key}</code>],
            ["Type", `${p.permit_type ?? "—"}`],
            ["Description", p.description],
            [
              "Status",
              <>
                <Badge status={p.status} /> <span className="muted small">raw: {p.raw_status}</span>
              </>,
            ],
            ["Roofing", p.is_roofing ? label(p.roof_work_class) : "no"],
            ["Applied / issued", `${p.application_date ?? "—"} / ${p.issue_date ?? "—"}`],
            ["Final / completed", `${p.final_date ?? "—"} / ${p.completion_date ?? "—"}`],
            [
              "Open days",
              p.open_days != null ? `${n(p.open_days)} (${(p.open_days / 365.25).toFixed(1)} y)` : "—",
            ],
            ["Estimated value", money(p.est_value)],
            ["Contractor", p.contractor_name ?? <span className="muted">not on record</span>],
            [
              "License",
              p.dbpr_license_id ? (
                <a href={href("contractor", p.dbpr_license_id)}>
                  {p.contractor_license ?? p.dbpr_license_id}
                </a>
              ) : (
                (p.contractor_license ?? "—")
              ),
            ],
            ["License status", p.contractor_license_status ?? "—"],
            [
              "BBB",
              p.bbb_rating ?? (
                <span className="muted">no BBB rating (BBB blocked automated access this run)</span>
              ),
            ],
            ["Source system", `${p.source_system} · ${p.jurisdiction ?? ""}`],
            ["Linked to parcel by", label(p.parcel_match_method)],
            ["Retrieved", p.retrieved_at],
            [
              "Property improvement CID",
              p.property_improvement_cid ? <code>{p.property_improvement_cid}</code> : "—",
            ],
          ]}
        />
      </Section>
      <Section title="Property">
        {data.property ? (
          <p>
            <PropertyLink id={data.property.parcel_identifier}>
              {data.property.address ?? data.property.parcel_identifier}
            </PropertyLink>{" "}
            · roof {data.property.roof_age_years ?? "?"} y ({label(data.property.roof_age_basis)})
          </p>
        ) : (
          <p className="muted">Not linked to a roll parcel (no folio and no unique address match).</p>
        )}
      </Section>
    </>
  );
}

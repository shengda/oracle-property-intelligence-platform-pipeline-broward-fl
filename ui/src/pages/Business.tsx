import { ErrorBox, Kv, Loading, PropertyLink, Section, Table } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { label, money } from "../lib/format.ts";
import { href } from "../lib/router.ts";

export function Business({ id }: { id: string }) {
  const { data, error, loading } = useApi<any>(`/api/business/${encodeURIComponent(id)}`);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <>
      <Section title={data.name ?? data.business_key}>
        <Kv
          rows={[
            ["Role", label(data.role)],
            ["Key", <code>{data.business_key}</code>],
            ["Company CID", data.company_cid ? <code>{data.company_cid}</code> : "—"],
            [
              "License",
              data.license_id ? <a href={href("contractor", data.license_id)}>{data.license_id}</a> : "—",
            ],
            ["Note", data.note],
          ]}
        />
      </Section>
      {data.role === "property_owner" && (
        <Section title={`Properties owned (${data.properties.length})`}>
          <Table
            rows={data.properties}
            cols={[
              [
                "Address",
                (p: any) => (
                  <PropertyLink id={p.parcel_identifier}>{p.address ?? p.parcel_identifier}</PropertyLink>
                ),
              ],
              ["City", (p: any) => p.city],
              ["Type", (p: any) => label(p.property_type)],
              ["Roof", (p: any) => (p.roof_age_years != null ? `${p.roof_age_years} y` : "—")],
              ["Value", (p: any) => money(p.market_value)],
            ]}
          />
        </Section>
      )}
    </>
  );
}

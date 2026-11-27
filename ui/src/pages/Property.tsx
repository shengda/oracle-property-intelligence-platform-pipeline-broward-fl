import { MapView } from "../components/MapView.tsx";
import { Badge, ErrorBox, Ext, Kv, Loading, Section, Table } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { gatewayLinks, label, money, n } from "../lib/format.ts";
import { href } from "../lib/router.ts";

export function Property({ id }: { id: string }) {
  const { data, error, loading } = useApi<any>(`/api/property/${encodeURIComponent(id)}`);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const p = data.property;
  const o = data.owner;
  return (
    <>
      <Section
        title={p.address ?? p.parcel_identifier}
        actions={<Ext url={data.appraiser_url}>Broward Property Appraiser ↗</Ext>}
      >
        <div className="two">
          <Kv
            rows={[
              ["Folio", <code>{p.parcel_identifier}</code>],
              ["City / ZIP", `${p.city ?? "—"} ${p.zip ?? ""}`],
              ["Type / usage", `${label(p.property_type)} · ${label(p.property_usage_type)}`],
              ["Year built", p.year_built],
              [
                "Roof",
                p.roof_age_years != null
                  ? `${p.roof_age_years} years (since ${p.roof_date ?? "?"})`
                  : "unknown",
              ],
              [
                "Roof-age basis",
                <>
                  <Badge status={data.roof_age.basis === "permit" ? "pass" : "neutral"}>
                    {label(data.roof_age.basis)}
                  </Badge>{" "}
                  {data.roof_age.confidence ? (
                    <span className="muted small">confidence {data.roof_age.confidence}</span>
                  ) : null}
                </>,
              ],
              [
                "Roof permit",
                data.roof_age.permit_key ? (
                  <a href={href("permit", data.roof_age.permit_key)}>{data.roof_age.permit_key}</a>
                ) : (
                  "—"
                ),
              ],
              ["Permit data here", p.permit_jurisdiction_covered ? "yes" : "no (jurisdiction not covered)"],
              ["Market value", money(p.market_value)],
              [
                "Last sale",
                `${p.last_sale_date ?? "—"} · ${money(p.last_sale_price)} · ${p.years_since_transfer ?? "—"} y ago`,
              ],
              ["Roll layer", p.roll_source],
              [
                "Location",
                p.lat != null
                  ? `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)} (${label(p.geo_status)})`
                  : label(p.geo_status),
              ],
            ]}
          />
          {p.lat != null && (
            <MapView
              center={{ lat: p.lat, lon: p.lon }}
              points={[
                {
                  id: p.parcel_identifier,
                  lat: p.lat,
                  lon: p.lon,
                  kind: "property",
                  label: p.address ?? p.parcel_identifier,
                },
              ]}
              height={300}
            />
          )}
        </div>
      </Section>
      <Section title="Owner & occupancy">
        {o ? (
          <Kv
            rows={[
              ["Owner type", label(o.owner_type)],
              [
                "Owner",
                o.owner_name ?? (
                  <span className="muted">
                    {o.owner_type === "company" ? "—" : "individual (name not published)"}
                  </span>
                ),
              ],
              ["Owner location", label(o.owner_location_class)],
              ["Mailing state / ZIP5", `${o.owner_mail_state ?? "—"} / ${o.owner_mail_zip5 ?? "—"}`],
              ["Occupancy", label(o.occupancy_class)],
              ["Occupancy basis", o.occupancy_basis],
              ["Homestead", p.homestead == null ? "—" : p.homestead ? "yes" : "no"],
            ]}
          />
        ) : (
          <p className="muted">No owner record.</p>
        )}
        {o?.owner_type === "company" && o.owner_name && (
          <p className="small">
            <a href={href("business", `owner:${o.owner_name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`)}>
              Other properties of this owner →
            </a>
          </p>
        )}
      </Section>
      <Section title={`Permits on this parcel (${data.permits.length})`}>
        <Table
          rows={data.permits}
          empty={
            p.permit_jurisdiction_covered ? "No permits on record." : "No permit data for this jurisdiction."
          }
          cols={[
            [
              "Permit",
              (x: any) => <a href={href("permit", x.permit_key)}>{x.permit_number ?? x.permit_key}</a>,
            ],
            ["Type", (x: any) => x.permit_type],
            ["Description", (x: any) => <span className="small">{x.description}</span>],
            ["Status", (x: any) => <Badge status={x.status} />],
            ["Roof", (x: any) => (x.is_roofing ? label(x.roof_work_class) : "—")],
            ["Issued", (x: any) => x.issue_date ?? "—"],
            ["Open days", (x: any) => n(x.open_days)],
            ["Linked by", (x: any) => label(x.parcel_match_method)],
          ]}
        />
      </Section>
      <Section title="Sales">
        <Table
          rows={data.sales}
          cols={[
            ["Date", (s: any) => s.date],
            ["Price", (s: any) => money(s.price)],
            ["Type", (s: any) => s.sale_type ?? "—"],
          ]}
        />
      </Section>
      <Section title="Tax roll values">
        <Table
          rows={data.tax}
          cols={[
            ["Year", (t: any) => t.tax_year],
            ["Market", (t: any) => money(t.market_value)],
            ["Assessed", (t: any) => money(t.assessed_value)],
            ["Taxable", (t: any) => money(t.taxable_value)],
            ["Land", (t: any) => money(t.land_value)],
            ["Building", (t: any) => money(t.building_value)],
          ]}
        />
      </Section>
      {data.structure && (
        <Section title="Structure (Lexicon)">
          <Kv
            rows={Object.entries(data.structure)
              .filter(([k]) => k !== "cid")
              .map(([k, v]) => [label(k), String(v)])}
          />
        </Section>
      )}
      <Section title="Lexicon entities & provenance">
        <Table
          rows={data.entities}
          cols={[
            ["Class", (e: any) => e.class],
            ["CID", (e: any) => <code title={e.cid}>{e.cid.slice(0, 20)}…</code>],
            ["Source request", (e: any) => <Ext url={e.source_url}>request</Ext>],
          ]}
        />
        <p className="muted small">
          Property CID <code>{p.property_cid}</code>{" "}
          {gatewayLinks(p.property_cid).map((g) => (
            <a key={g.gateway} className="gw" href={g.url} target="_blank" rel="noreferrer">
              {g.gateway}
            </a>
          ))}{" "}
          (gateway links resolve once the run is published).
        </p>
      </Section>
    </>
  );
}

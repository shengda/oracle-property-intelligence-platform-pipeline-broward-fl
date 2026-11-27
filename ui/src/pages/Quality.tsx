import { Badge, ErrorBox, Ext, Loading, PropertyLink, Section, Table } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";

const GROUPS: Record<string, string> = {
  coverage_scale: "Coverage & scale",
  duplicates_reconciliation: "Duplicates & reconciliation",
  coordinates: "Coordinates",
  permits: "Permits",
  roof_age: "Roof age",
  contractor_bbb: "Contractor / BBB links",
  occupancy_owner: "Occupancy & owner location",
  pii: "PII",
  index: "Index & search",
};

function fmt(v: unknown): string {
  if (v == null) return "—";
  if (typeof v !== "object") return String(v);
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${k}: ${typeof x === "object" ? JSON.stringify(x) : String(x)}`)
    .join(" · ");
}

export function Quality() {
  const { data, error, loading } = useApi<any>("/api/qa/current");
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const checks: any[] = data.checks ?? [];
  const groups = [...new Set(checks.map((c) => c.group))];
  const counts = { pass: 0, warn: 0, fail: 0 } as Record<string, number>;
  for (const c of checks) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return (
    <>
      <Section title={`Data quality — run ${data.run_id}`}>
        <p data-testid="qa-summary">
          Overall <Badge status={data.status} /> · {counts.pass} pass · {counts.warn} warn · {counts.fail}{" "}
          fail · generated {data.generated_at}
        </p>
        <p className="muted small">
          {data.published
            ? data.qa_cid
              ? `qa.json CID ${data.qa_cid}`
              : ""
            : "Unpublished run: qa.json gets its CID when the run is published (M3)."}
        </p>
      </Section>
      {groups.map((g) => (
        <Section key={g} title={GROUPS[g] ?? g}>
          <Table
            testId={`qa-${g}`}
            rows={checks.filter((c) => c.group === g)}
            cols={[
              [
                "Check",
                (c: any) => (
                  <>
                    <strong>{c.title}</strong>
                    <div className="muted small">
                      <code>{c.id}</code>
                    </div>
                  </>
                ),
              ],
              ["Status", (c: any) => <Badge status={c.status} />],
              ["Value", (c: any) => <span className="small">{fmt(c.value)}</span>],
              ["Threshold", (c: any) => <span className="small">{c.threshold}</span>],
              ["Detail", (c: any) => <span className="small">{c.detail ?? ""}</span>],
            ]}
          />
        </Section>
      ))}
      <Section title="Spot check — 20 random parcels">
        <p className="muted small">Compare each record with the Broward Property Appraiser site.</p>
        <Table
          rows={data.spot_check ?? []}
          cols={[
            ["Parcel", (s: any) => <PropertyLink id={s.parcel_identifier} />],
            ["Address", (s: any) => s.address],
            ["Appraiser", (s: any) => <Ext url={s.appraiser_url}>bcpa.net</Ext>],
            ["Source request", (s: any) => <Ext url={s.source_url}>roll query</Ext>],
          ]}
        />
      </Section>
    </>
  );
}

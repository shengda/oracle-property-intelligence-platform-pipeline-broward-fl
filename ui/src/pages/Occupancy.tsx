import { useEffect, useState } from "react";
import { CenterControl, type Center } from "../components/CenterControl.tsx";
import { MapView } from "../components/MapView.tsx";
import { ErrorBox, PropertyLink, Section, Table } from "../components/ui.tsx";
import { api, qs } from "../lib/api.ts";
import { label } from "../lib/format.ts";
import { go, href, type Route } from "../lib/router.ts";

const CLASSES = [
  "likely_tenant_occupied",
  "owner_occupied",
  "commercial",
  "vacant_land",
  "government_or_exempt",
  "unknown",
];

export function Occupancy({ route }: { route: Route }) {
  const q = route.query;
  const center: Center | null =
    q.get("lat") && q.get("lon") ? { lat: Number(q.get("lat")), lon: Number(q.get("lon")) } : null;
  const radius = Number(q.get("r") ?? 3);
  const occ = (q.get("occ") ?? "likely_tenant_occupied").split(",").filter(Boolean);
  const scope = q.get("scope") ?? "";
  const minAge = q.get("age") ?? "";
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const set = (patch: Record<string, string | number | null>) => {
    const next: Record<string, string> = Object.fromEntries(q.entries());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") delete next[k];
      else next[k] = String(v);
    }
    go("occupancy", null, next);
  };

  useEffect(() => {
    if (!center || !occ.length) return;
    setError(null);
    const base = { lat: center.lat, lon: center.lon, radiusMiles: radius, limit: 500 };
    const path = scope
      ? `/api/query/out-of-area${qs({ ...base, scope })}`
      : `/api/query/occupancy${qs({ ...base, occupancy: occ.join(","), minRoofAgeYears: minAge })}`;
    api<any>(path).then(
      (r) => setRows(scope ? r.rows.filter((x: any) => occ.includes(x.occupancy_class)) : r.rows),
      (e) => setError(e),
    );
  }, [center?.lat, center?.lon, radius, occ.join(","), scope, minAge]);

  return (
    <>
      <Section title="Owner & occupancy">
        <CenterControl value={center} onChange={(c) => set({ lat: c.lat, lon: c.lon })} />
        <div className="filters">
          <label>
            Radius (mi)
            <input
              type="number"
              min={0.25}
              max={20}
              step={0.25}
              value={radius}
              onChange={(e) => set({ r: e.target.value })}
            />
          </label>
          <label>
            Roof age ≥
            <input
              type="number"
              min={0}
              value={minAge}
              onChange={(e) => set({ age: e.target.value })}
              placeholder="any"
            />
          </label>
          <label>
            Owner location
            <select value={scope} onChange={(e) => set({ scope: e.target.value })}>
              <option value="">any</option>
              <option value="out_of_county">outside Broward</option>
              <option value="out_of_state">outside Florida / abroad</option>
            </select>
          </label>
        </div>
        <div className="filters">
          {CLASSES.map((c) => (
            <label key={c} className="check">
              <input
                type="checkbox"
                checked={occ.includes(c)}
                onChange={(e) =>
                  set({ occ: (e.target.checked ? [...occ, c] : occ.filter((x) => x !== c)).join(",") })
                }
              />
              {label(c)}
            </label>
          ))}
        </div>
        <MapView
          center={center}
          radiusMiles={center ? radius : undefined}
          onPick={(c) => set({ lat: c.lat, lon: c.lon })}
          points={(rows ?? [])
            .filter((r) => r.lat != null)
            .map((r) => ({
              id: r.parcel_identifier,
              lat: r.lat,
              lon: r.lon,
              kind: "property" as const,
              label: `${r.address} · ${label(r.occupancy_class)}`,
              href: href("property", r.parcel_identifier),
            }))}
        />
        <ErrorBox error={error} />
      </Section>
      {rows && (
        <Section title={`${rows.length} properties${rows.length === 500 ? " (first 500)" : ""}`}>
          <Table
            testId="occupancy"
            rows={rows}
            cols={[
              [
                "Address",
                (r: any) => (
                  <PropertyLink id={r.parcel_identifier}>{r.address ?? r.parcel_identifier}</PropertyLink>
                ),
              ],
              ["Occupancy", (r: any) => label(r.occupancy_class)],
              ["Basis", (r: any) => <span className="small">{r.occupancy_basis ?? "—"}</span>],
              ["Owner type", (r: any) => label(r.owner_type)],
              ["Owner location", (r: any) => label(r.owner_location_class)],
              ["Years since transfer", (r: any) => r.years_since_transfer ?? "—"],
              ["Roof", (r: any) => (r.roof_age_years != null ? `${r.roof_age_years} y` : "—")],
            ]}
          />
        </Section>
      )}
    </>
  );
}

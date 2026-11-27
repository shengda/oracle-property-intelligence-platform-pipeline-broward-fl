import { useEffect, useMemo, useState } from "react";
import { CenterControl, type Center } from "../components/CenterControl.tsx";
import { MapView, type MapPoint } from "../components/MapView.tsx";
import { Badge, ErrorBox, PropertyLink, Section, Table } from "../components/ui.tsx";
import { api, qs } from "../lib/api.ts";
import { label, money, n } from "../lib/format.ts";
import { go, href, type Route } from "../lib/router.ts";
import { agentPins } from "../lib/store.ts";

type Result = { total: number; rows: any[]; uncovered: { name: string; status: string; parcels: number }[] };

export function Explorer({ route }: { route: Route }) {
  const q = route.query;
  const center: Center | null =
    q.get("lat") && q.get("lon")
      ? { lat: Number(q.get("lat")), lon: Number(q.get("lon")), name: q.get("name") ?? undefined }
      : null;
  const radius = Number(q.get("r") ?? 5);
  const minAge = Number(q.get("age") ?? 15);
  const minOpen = Number(q.get("open") ?? 0);
  const layers = (q.get("layers") ?? "roofs,permits").split(",");
  const pins = q.get("pins") === "agent" ? agentPins.get() : [];

  const [roofs, setRoofs] = useState<Result | null>(null);
  const [permits, setPermits] = useState<Result | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (patch: Record<string, string | number | null | undefined>) => {
    const next: Record<string, string> = Object.fromEntries(q.entries());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") delete next[k];
      else next[k] = String(v);
    }
    go("explorer", null, next);
  };

  useEffect(() => {
    if (!center) return;
    let stop = false;
    setBusy(true);
    setError(null);
    const base = { lat: center.lat, lon: center.lon, radiusMiles: radius, limit: 500 };
    Promise.all([
      layers.includes("roofs")
        ? api<Result>(`/api/query/aged-roofs${qs({ ...base, minRoofAgeYears: minAge })}`)
        : null,
      layers.includes("permits")
        ? api<Result>(`/api/query/open-permits${qs({ ...base, minOpenYears: minOpen })}`)
        : null,
    ])
      .then(([r, p]) => {
        if (stop) return;
        setRoofs(r);
        setPermits(p);
      })
      .catch((e) => !stop && setError(e))
      .finally(() => !stop && setBusy(false));
    return () => {
      stop = true;
    };
  }, [center?.lat, center?.lon, radius, minAge, minOpen, layers.join(",")]);

  const points = useMemo<MapPoint[]>(() => {
    const pts: MapPoint[] = [];
    for (const r of roofs?.rows ?? [])
      if (r.lat != null)
        pts.push({
          id: r.parcel_identifier,
          lat: r.lat,
          lon: r.lon,
          kind: "roof",
          label: `${r.address ?? r.parcel_identifier} · roof ${r.roof_age_years} y`,
          href: href("property", r.parcel_identifier),
        });
    for (const p of permits?.rows ?? [])
      if (p.lat != null)
        pts.push({
          id: p.permit_key,
          lat: p.lat,
          lon: p.lon,
          kind: "permit",
          label: `${p.address ?? p.permit_number} · open ${p.open_years} y`,
          href: href("permit", p.permit_key),
        });
    for (const a of pins)
      pts.push({
        id: `agent:${a.parcelId}`,
        lat: a.lat,
        lon: a.lon,
        kind: "agent",
        label: a.label,
        href: href("property", a.parcelId),
      });
    return pts;
  }, [roofs, permits, pins]);

  const uncovered = roofs?.uncovered ?? permits?.uncovered ?? [];

  return (
    <>
      <Section title="Explorer">
        <CenterControl
          value={center}
          onChange={(c) => set({ lat: c.lat, lon: c.lon, name: c.name ?? null })}
        />
        <div className="filters">
          <label>
            Radius (mi)
            <input
              type="number"
              min={0.25}
              max={50}
              step={0.25}
              value={radius}
              onChange={(e) => set({ r: e.target.value })}
              aria-label="Radius in miles"
            />
          </label>
          <label>
            Roof age ≥ (years)
            <input
              type="number"
              min={0}
              max={150}
              value={minAge}
              onChange={(e) => set({ age: e.target.value })}
              aria-label="Minimum roof age"
            />
          </label>
          <label>
            Permit open ≥ (years)
            <input
              type="number"
              min={0}
              max={30}
              step={0.5}
              value={minOpen}
              onChange={(e) => set({ open: e.target.value })}
              aria-label="Minimum years open"
            />
          </label>
          {(["roofs", "permits"] as const).map((l) => (
            <label key={l} className="check">
              <input
                type="checkbox"
                checked={layers.includes(l)}
                onChange={(e) =>
                  set({
                    layers:
                      (e.target.checked ? [...layers, l] : layers.filter((x) => x !== l)).join(",") || "none",
                  })
                }
              />
              {l === "roofs" ? "Aged roofs" : "Long-open roof permits"}
            </label>
          ))}
        </div>
        <p className="muted small">
          {center ? (
            <>
              Center {center.name ? <strong>{center.name}</strong> : null} {center.lat.toFixed(5)},{" "}
              {center.lon.toFixed(5)} · click the map to move it.
            </>
          ) : (
            "Pick a city, search an address, enter lat/lon or click the map to set the search center."
          )}
          {busy && " Loading…"}
        </p>
        <MapView
          center={center}
          radiusMiles={center ? radius : undefined}
          points={points}
          onPick={(c) => set({ lat: c.lat, lon: c.lon, name: null })}
        />
        <p className="legend small">
          <span className="dot roof" /> aged roof <span className="dot permit" /> open roof permit{" "}
          {pins.length > 0 && (
            <>
              <span className="dot agent" /> agent result
            </>
          )}
        </p>
        {uncovered.length > 0 && (
          <p className="note" data-testid="uncovered-note">
            No permit data inside this radius for{" "}
            {uncovered.map((u) => `${u.name} (${label(u.status)}, ${n(u.parcels)} parcels)`).join("; ")}. Roof
            age there comes from the year built, and open permits cannot be listed.
          </p>
        )}
        <ErrorBox error={error} />
      </Section>

      {layers.includes("roofs") && roofs && (
        <Section
          title={`Aged roofs — ${n(roofs.total)} properties with roofs ≥ ${minAge} years within ${radius} mi${roofs.total > roofs.rows.length ? ` (showing ${roofs.rows.length})` : ""}`}
        >
          <Table
            testId="aged-roofs"
            rows={roofs.rows}
            empty="No properties match. Try a larger radius or a lower roof age."
            cols={[
              [
                "Address",
                (r: any) => (
                  <PropertyLink id={r.parcel_identifier}>{r.address ?? r.parcel_identifier}</PropertyLink>
                ),
              ],
              ["Roof age", (r: any) => `${r.roof_age_years} y`],
              [
                "Basis",
                (r: any) => (
                  <Badge status={r.roof_age_basis === "permit" ? "pass" : "neutral"}>
                    {label(r.roof_age_basis)}
                  </Badge>
                ),
              ],
              ["Built", (r: any) => r.year_built ?? "—"],
              ["Type", (r: any) => label(r.property_type)],
              ["Occupancy", (r: any) => label(r.occupancy_class)],
              ["Market value", (r: any) => money(r.market_value)],
              ["Distance", (r: any) => `${r.distance_miles} mi`],
            ]}
          />
        </Section>
      )}

      {layers.includes("permits") && permits && (
        <Section
          title={`Long-open roofing permits — ${n(permits.total)} open ≥ ${minOpen} years within ${radius} mi${permits.total > permits.rows.length ? ` (showing ${permits.rows.length})` : ""}`}
        >
          <p className="note small">
            Fort Lauderdale permit statuses come from a city layer frozen in January 2021: a permit shown as
            open was open at that snapshot and may have closed since. Open duration is counted to today.
          </p>
          <Table
            testId="open-permits"
            rows={permits.rows}
            empty="No open roofing permits here (or the area has no permit data)."
            cols={[
              [
                "Address",
                (p: any) => (
                  <PropertyLink id={p.parcel_identifier}>{p.address ?? p.parcel_identifier}</PropertyLink>
                ),
              ],
              [
                "Permit",
                (p: any) => <a href={href("permit", p.permit_key)}>{p.permit_number ?? p.permit_key}</a>,
              ],
              ["Open", (p: any) => `${p.open_years} y (${n(p.open_days)} d)`],
              ["Work", (p: any) => label(p.roof_work_class)],
              ["Contractor", (p: any) => p.contractor_name ?? <span className="muted">not on record</span>],
              ["License", (p: any) => p.contractor_license ?? "—"],
              ["BBB", (p: any) => p.bbb_rating ?? <span className="muted">no rating</span>],
            ]}
          />
        </Section>
      )}
    </>
  );
}

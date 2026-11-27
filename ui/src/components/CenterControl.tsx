import { useEffect, useState } from "react";
import { api, qs } from "../lib/api.ts";

export interface Center {
  lat: number;
  lon: number;
  name?: string;
}

/** Search center without the map: city picker (resolve_place), address search, lat/lon fields. */
export function CenterControl({ value, onChange }: { value: Center | null; onChange: (c: Center) => void }) {
  const [places, setPlaces] = useState<{ name: string; lat: number; lon: number }[]>([]);
  const [lat, setLat] = useState(value ? String(value.lat) : "");
  const [lon, setLon] = useState(value ? String(value.lon) : "");
  const [addr, setAddr] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api<{ places: { name: string; lat: number; lon: number }[] }>("/api/places").then(
      (r) => setPlaces(r.places),
      () => {},
    );
  }, []);
  useEffect(() => {
    if (value) {
      setLat(String(value.lat));
      setLon(String(value.lon));
    }
  }, [value]);

  async function findAddress(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!addr.trim()) return;
    try {
      const r = await api<{ rows: any[] }>(`/api/search${qs({ q: addr, mode: "text", limit: 20 })}`);
      const hit = r.rows.find((h) => h.kind === "property" && h.parcel_identifier);
      if (!hit)
        return setMsg("No property address matched. Try the street number and name, e.g. 23 PELICAN DR.");
      const p = await api<any>(`/api/property/${hit.parcel_identifier}`);
      if (p.property.lat == null) return setMsg("That parcel has no usable location.");
      onChange({ lat: p.property.lat, lon: p.property.lon, name: p.property.address });
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  return (
    <div className="center-control">
      <label>
        City
        <select
          aria-label="City"
          data-testid="city-picker"
          value={
            places.find(
              (p) => value && Math.abs(p.lat - value.lat) < 1e-4 && Math.abs(p.lon - value.lon) < 1e-4,
            )?.name ?? ""
          }
          onChange={async (e) => {
            if (!e.target.value) return;
            const r = await api<any>(`/api/place${qs({ name: e.target.value })}`);
            onChange({ lat: r.lat, lon: r.lon, name: r.name });
          }}
        >
          <option value="">Choose a city…</option>
          {places.map((p) => (
            <option key={p.name}>{p.name}</option>
          ))}
        </select>
      </label>
      <form onSubmit={findAddress} className="inline">
        <label>
          Address
          <input
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="23 PELICAN DR"
            aria-label="Address"
          />
        </label>
        <button type="submit">Find</button>
      </form>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          const a = Number(lat);
          const o = Number(lon);
          if (!Number.isFinite(a) || !Number.isFinite(o) || !lat || !lon)
            return setMsg("Enter numeric latitude and longitude.");
          setMsg(null);
          onChange({ lat: a, lon: o });
        }}
      >
        <label>
          Lat
          <input
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            inputMode="decimal"
            aria-label="Latitude"
            size={9}
          />
        </label>
        <label>
          Lon
          <input
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            inputMode="decimal"
            aria-label="Longitude"
            size={9}
          />
        </label>
        <button type="submit">Set center</button>
      </form>
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}

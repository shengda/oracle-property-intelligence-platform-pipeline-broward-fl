import { useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export interface MapPoint {
  id: string;
  lat: number;
  lon: number;
  label: string;
  kind: "roof" | "permit" | "property" | "agent";
  href?: string;
}

const COLORS: Record<MapPoint["kind"], string> = {
  roof: "#b4532a",
  permit: "#2b6cb0",
  property: "#6b7a3a",
  agent: "#8a3ab4",
};

/** Circle polygon (64 vertices) for the search radius. */
function circle(lat: number, lon: number, miles: number) {
  const pts: [number, number][] = [];
  const dLat = miles / 69.0934;
  const dLon = miles / (69.0934 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [pts] },
  };
}

/**
 * MapLibre map with OSM raster tiles, result points and the radius ring. If WebGL is not
 * available the map shows a notice instead; pages always render their result lists too.
 */
export function MapView({
  center,
  radiusMiles,
  points,
  onPick,
  height = 420,
}: {
  center: { lat: number; lon: number } | null;
  radiusMiles?: number;
  points: MapPoint[];
  onPick?: (c: { lat: number; lon: number }) => void;
  height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const probe = document.createElement("canvas");
        if (!(probe.getContext("webgl2") || probe.getContext("webgl")))
          throw new Error("WebGL is not available in this browser");
        const ml = await import("maplibre-gl");
        // MapLibre 6 runs its tile/GeoJSON worker from a separate ES module; Vite bundles it.
        const workerUrl = (await import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url")).default;
        ml.setWorkerUrl(workerUrl);
        if (cancelled || !el.current) return;
        const m = new ml.Map({
          container: el.current,
          style: {
            version: 8,
            sources: {
              osm: {
                type: "raster",
                tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                tileSize: 256,
                maxzoom: 19,
                attribution: "© OpenStreetMap contributors",
              },
            },
            layers: [{ id: "osm", type: "raster", source: "osm" }],
          },
          center: [center?.lon ?? -80.25, center?.lat ?? 26.15],
          zoom: center ? 11 : 9,
        });
        m.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
        m.on("error", (e) => console.warn("map:", e.error?.message));
        m.on("load", () => {
          m.addSource("ring", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          m.addLayer({
            id: "ring-fill",
            type: "fill",
            source: "ring",
            paint: { "fill-color": "#b4532a", "fill-opacity": 0.06 },
          });
          m.addLayer({
            id: "ring-line",
            type: "line",
            source: "ring",
            paint: { "line-color": "#b4532a", "line-width": 1.5 },
          });
          m.addSource("pts", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          m.addLayer({
            id: "pts",
            type: "circle",
            source: "pts",
            paint: {
              "circle-radius": 5,
              "circle-color": ["get", "color"],
              "circle-stroke-color": "#fff",
              "circle-stroke-width": 1,
            },
          });
          m.on("click", "pts", (e) => {
            const f = e.features?.[0];
            if (!f) return;
            const p = f.properties as any;
            new ml.Popup({ closeButton: true })
              .setLngLat((f.geometry as any).coordinates)
              .setHTML(p.href ? `<a href="${p.href}">${escapeHtml(p.label)}</a>` : escapeHtml(p.label))
              .addTo(m);
            e.originalEvent.stopPropagation();
          });
          m.on("click", (e) => {
            if (m.queryRenderedFeatures(e.point, { layers: ["pts"] }).length) return;
            pick.current?.({ lat: +e.lngLat.lat.toFixed(5), lon: +e.lngLat.lng.toFixed(5) });
          });
          m.on("mouseenter", "pts", () => (m.getCanvas().style.cursor = "pointer"));
          m.on("mouseleave", "pts", () => (m.getCanvas().style.cursor = ""));
          setReady(true);
        });
        map.current = m;
      } catch (err) {
        if (!cancelled) setFailed((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource("pts") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: points.map((p) => ({
        type: "Feature",
        properties: { label: p.label, href: p.href ?? "", color: COLORS[p.kind] },
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      })),
    });
    (m.getSource("ring") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: center && radiusMiles ? [circle(center.lat, center.lon, radiusMiles)] : [],
    });
    if (center) {
      const zoom = radiusMiles ? Math.max(8, Math.min(15, 13.2 - Math.log2(radiusMiles))) : m.getZoom();
      m.easeTo({ center: [center.lon, center.lat], zoom, duration: 400 });
    }
  }, [points, center, radiusMiles, ready]);

  if (failed)
    return (
      <div className="map-fallback" role="note" data-testid="map-fallback" style={{ minHeight: 80 }}>
        Map unavailable ({failed}). Results are listed below; set the center with the city picker or lat/lon
        fields.
      </div>
    );
  return <div ref={el} className="map" style={{ height }} data-testid="map" />;
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

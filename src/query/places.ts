import places from "../data/broward-places.json" with { type: "json" };
import { COUNTY } from "../config.ts";

export interface ResolvedPlace {
  name: string;
  lat: number;
  lon: number;
  /** "census_place" (Gazetteer internal point) or "county" (Broward center). */
  basis: "census_place" | "county";
  source_url: string;
}

function norm(s: string): string {
  return s
    .toUpperCase()
    .replace(/[.,]/g, " ")
    .replace(/-/g, " ")
    .replace(/\b(FLORIDA|FL|CITY OF|TOWN OF|VILLAGE OF|CITY|TOWN|VILLAGE|CDP)\b/g, " ")
    .replace(/\bFT\b/g, "FORT")
    .replace(/\bPT\b/g, "POINT")
    .replace(/\s+/g, " ")
    .trim();
}

const INDEX = new Map<string, (typeof places.places)[number]>();
for (const p of places.places) INDEX.set(norm(p.name), p);

/** Broward place names the Census lists under another spelling. */
const ALIASES: Record<string, string> = {
  "LAUDERDALE BY THE SEA": "LAUDERDALE BY THE SEA",
  LBTS: "LAUDERDALE BY THE SEA",
  LAUDERDALE: "FORT LAUDERDALE",
};

/**
 * Resolve a Broward place name to a center point (Census Gazetteer internal point). Returns null
 * for names outside Broward rather than guessing coordinates.
 */
export function resolvePlace(name: string): ResolvedPlace | null {
  const n = norm(name);
  if (!n) return null;
  if (n === "BROWARD" || n === "BROWARD COUNTY" || n === "BROWARD CO") {
    return {
      name: "Broward County",
      lat: COUNTY.center.lat,
      lon: COUNTY.center.lon,
      basis: "county",
      source_url: places.source_url,
    };
  }
  const hit = INDEX.get(n) ?? INDEX.get(ALIASES[n] ?? "");
  if (!hit) return null;
  return { name: hit.name, lat: hit.lat, lon: hit.lon, basis: "census_place", source_url: places.source_url };
}

export function listPlaces(): { name: string; lat: number; lon: number }[] {
  return places.places.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon }));
}

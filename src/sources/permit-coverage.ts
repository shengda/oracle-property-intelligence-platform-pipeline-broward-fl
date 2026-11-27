import { browardPermitProfile } from "../../vendor/soofi-xyz-team-kit/skills/use-oracle/runtime/src/counties/broward/permit-profile.mjs";
import type { WorkDb } from "../work-db.ts";

export interface PermitCoverage {
  jurisdiction: string;
  name: string;
  cities: string[];
  status: "covered" | "skipped" | "blocked";
  parcels: number;
  permits: number;
  roofingPermits: number;
  source?: string;
  reason?: string;
  estimate?: { size: string; time: string };
  kitStatus?: string;
}

/** Loaded permit feeds per kit jurisdiction key → our source key. */
const LOADED: Record<string, string[]> = {
  "fort-lauderdale": ["ftl-permits"],
  weston: ["weston-permits-issued", "weston-permits-closed"],
  "unincorporated-broward": ["hced-permits"],
};

const PORTAL_ESTIMATE = {
  size: "1–3 GB of captures per large city",
  time: "20–80 h per large city at concurrency 1",
};

/**
 * Permit coverage by the 32 jurisdictions of the kit's Broward permit profile: `covered` when a
 * loaded feed has rows, `blocked` when the kit or this run hit an access boundary, otherwise
 * `skipped` by the §3.7 skip rule (portal crawl too slow), with its estimate.
 */
export async function permitCoverage(
  db: WorkDb,
  sourceStatus: Record<string, { status: string; limitation?: string; blockerType?: string }>,
): Promise<PermitCoverage[]> {
  const parcelsByCity = new Map(
    (
      await db.all<{ city: string; n: number }>(
        "select coalesce(situs_city, 'UNINCORPORATED') city, count(*)::INTEGER n from stg_parcels group by 1",
      )
    ).map((r) => [r.city, r.n]),
  );
  const permitsBySource = new Map(
    (
      await db
        .all<{ source_key: string; n: number; roof: number }>(
          "select source_key, count(*)::INTEGER n, count(*) filter (where is_roofing)::INTEGER roof from stg_permits group by 1",
        )
        .catch(() => [])
    ).map((r) => [r.source_key, r]),
  );
  const out: PermitCoverage[] = [];
  for (const j of browardPermitProfile.jurisdictions as any[]) {
    const cities: string[] = (j.routingCities ?? []).map((c: string) => c.toUpperCase());
    const parcels = cities.reduce(
      (n, c) => n + (parcelsByCity.get(c === "UNINCORPORATED BROWARD" ? "UNINCORPORATED" : c) ?? 0),
      0,
    );
    const loaded = LOADED[j.key] ?? [];
    const permits = loaded.reduce((n, k) => n + (permitsBySource.get(k)?.n ?? 0), 0);
    const roofingPermits = loaded.reduce((n, k) => n + (permitsBySource.get(k)?.roof ?? 0), 0);
    const runBlocked = loaded.find((k) => sourceStatus[k]?.status === "blocked");
    let entry: PermitCoverage;
    if (permits > 0) {
      entry = {
        jurisdiction: j.key,
        name: j.name,
        cities,
        status: "covered",
        parcels,
        permits,
        roofingPermits,
        source: loaded.join("+"),
        reason:
          loaded
            .map((k) => sourceStatus[k]?.limitation)
            .filter(Boolean)
            .join(" ") || undefined,
        kitStatus: j.status,
      };
    } else if (runBlocked) {
      entry = {
        jurisdiction: j.key,
        name: j.name,
        cities,
        status: "blocked",
        parcels,
        permits: 0,
        roofingPermits: 0,
        source: runBlocked,
        reason: sourceStatus[runBlocked]?.limitation ?? `blocked (${sourceStatus[runBlocked]?.blockerType})`,
        kitStatus: j.status,
      };
    } else if (j.status === "blocked" || j.status === "custodian-only") {
      entry = {
        jurisdiction: j.key,
        name: j.name,
        cities,
        status: "blocked",
        parcels,
        permits: 0,
        roofingPermits: 0,
        reason: `Kit Broward profile: ${j.status}${j.implementationStatus ? ` (${j.implementationStatus})` : ""}; never bypassed.`,
        kitStatus: j.status,
      };
    } else {
      entry = {
        jurisdiction: j.key,
        name: j.name,
        cities,
        status: "skipped",
        parcels,
        permits: 0,
        roofingPermits: 0,
        reason:
          "too_slow: parcel-by-parcel portal search exceeds the ~2 h unattended skip rule (architecture §3.7).",
        estimate: PORTAL_ESTIMATE,
        kitStatus: j.status,
      };
    }
    out.push(entry);
  }
  return out;
}

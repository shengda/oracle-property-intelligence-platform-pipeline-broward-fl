/**
 * Roof age via the team-kit resolver (vendor submodule, read-only). This is a thin adapter: our
 * tested classifiers turn each permit into (normalized status, roof work class); the kit's
 * estimator applies its precedence rules (completed primary replacement > new construction >
 * built year; repairs never reset roof age; built-year default is year precision).
 */
import {
  resolveCanonicalRoofAge,
  type CanonicalRoofAgeLineage,
  type RoofAgePermitRow,
} from "../../vendor/soofi-xyz-team-kit/skills/use-oracle/runtime/src/roof-age/integration.ts";
import type { RoofAgeProfile } from "../../vendor/soofi-xyz-team-kit/skills/use-oracle/runtime/src/roof-age/estimator.ts";
import type { PermitStatus, RoofWorkClass } from "../types.ts";

export const BROWARD_PERMIT_SOURCE_SYSTEMS = [
  "broward_ftl_arcgis_permits",
  "broward_weston_accela_permits",
  "broward_hced_posse_permits",
] as const;

const STATUSES: Exclude<PermitStatus, "needs_review">[] = ["completed", "open", "other"];
const WORK: RoofWorkClass[] = [
  "primary_roof_replacement",
  "primary_roof_new_construction",
  "repair_or_coating",
  "accessory_roof",
  "other",
];

/** Broward profile: maps our classifier outputs one-to-one onto the kit's classes. */
export const browardRoofAgeProfile: RoofAgeProfile = {
  version: "oracle-broward-roof-profile-v1",
  sources: BROWARD_PERMIT_SOURCE_SYSTEMS.map((sourceSystem) => ({
    sourceSystem,
    statusMappings: STATUSES.map((value) => ({ field: "improvement_status", value, status: value })),
    workMappings: WORK.map((value) => ({ field: "improvement_type", value, classification: value })),
  })),
};

export interface RoofPermitInput {
  sourceSystem: (typeof BROWARD_PERMIT_SOURCE_SYSTEMS)[number];
  permitKey: string;
  status: PermitStatus;
  roofWorkClass: RoofWorkClass;
  isRoofing: boolean;
  completionDate: string | null;
  closeDate: string | null;
  issueDate: string | null;
  applicationDate: string | null;
}

export interface RoofAgeResult {
  roofDate: string | null;
  roofAgeYears: number | null;
  basis: "permit" | "year_built" | "unknown";
  lineage: CanonicalRoofAgeLineage;
}

export function computeRoofAge(input: {
  parcelId: string;
  builtYear: number | null;
  permits: RoofPermitInput[];
  asOf: string;
  historicalCoverage: "partial" | "unavailable";
}): RoofAgeResult {
  const permits: RoofAgePermitRow[] = input.permits
    .filter((p) => p.isRoofing)
    .map((p) => ({
      sourceSystem: p.sourceSystem,
      sourceRecordId: p.permitKey,
      improvementStatus: p.status === "needs_review" ? "needs_review" : p.status,
      improvementType: p.roofWorkClass,
      completionDate: p.completionDate,
      closeDate: p.closeDate,
      issueDate: p.issueDate,
      applicationDate: p.applicationDate,
      sourcePayload: null,
    }));
  const lineage = resolveCanonicalRoofAge(
    {
      propertyId: input.parcelId,
      structureId: "structure.json",
      sourceSystem: "broward_bcpa_taxroll",
      sourceRecordId: input.parcelId,
      builtYear: input.builtYear,
      roofDate: null,
      roofAgeYears: null,
      sourcePayload: null,
      permits,
    },
    {
      asOfDate: input.asOf,
      historicalCoverage:
        input.historicalCoverage === "partial"
          ? { state: "partial", caveats: ["partial_history"] }
          : { state: "unavailable", caveats: ["history_unavailable"] },
      profile: browardRoofAgeProfile,
    },
  );
  const basis =
    lineage.source === "permit_updated"
      ? "permit"
      : lineage.source === "construction_year_default"
        ? "year_built"
        : "unknown";
  return {
    roofDate: lineage.eligibility.eligible ? lineage.roofDate : null,
    roofAgeYears: lineage.eligibility.eligible ? lineage.roofAgeYears : null,
    basis,
    lineage,
  };
}

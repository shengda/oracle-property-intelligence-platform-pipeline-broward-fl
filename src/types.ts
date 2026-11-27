/** Shared enums and record shapes for the Oracle pipeline. */

export type PermitStatus = "open" | "completed" | "other" | "needs_review";

export type RoofWorkClass =
  | "primary_roof_replacement"
  | "primary_roof_new_construction"
  | "repair_or_coating"
  | "accessory_roof"
  | "other";

export type OwnerLocationClass =
  "in_county" | "in_state_out_of_county" | "out_of_state" | "foreign" | "unknown";

export type OwnerType = "person" | "company" | "trust" | "government" | "unknown";

export type OccupancyClass =
  | "owner_occupied"
  | "likely_tenant_occupied"
  | "commercial"
  | "vacant_land"
  | "government_or_exempt"
  | "unknown";

export type GeoStatus = "parcel_centroid" | "missing_geometry" | "outside_county";

export type GroupKey = "county" | "property_improvement";

export type ChangeMode = "file_digest" | "window" | "bounded_crawl";

export type SourceStatus = "loaded" | "partial" | "blocked" | "skipped";

export type SkipReason = "too_slow" | "turnaround" | "optional_cut";

export interface SourceHttpRequest {
  method: "GET" | "POST";
  url: string;
  multiValueQueryString?: Record<string, string[]>;
}

export interface SourceDescriptor {
  key: string;
  title: string;
  kind: "arcgis" | "csv" | "zip" | "html" | "reference";
  url: string;
  changeMode: ChangeMode;
  readmeNeed: string;
  /** Default status before a run; a run result overrides it. */
  status: "active" | "skipped" | "blocked";
  skipReason?: SkipReason;
  blockerType?: string;
  limitation?: string;
  estimate?: { size: string; time: string };
}

export interface SourceRunResult {
  key: string;
  status: SourceStatus;
  records: number;
  startedAt: string;
  finishedAt: string;
  window?: { from: string; to: string };
  limitation?: string;
  skipReason?: SkipReason;
  blockerType?: string;
  estimate?: { size: string; time: string };
  requests?: number;
  avgLatencyMs?: number;
  bytes?: number;
  sha256?: string;
  rawPath?: string;
}

export interface LatLon {
  lat: number;
  lon: number;
}

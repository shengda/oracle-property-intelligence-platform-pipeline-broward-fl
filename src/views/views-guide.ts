import { ROOFING_VIEW_COLUMNS, ROOFING_VIEWS_VERSION } from "./roofing-views.ts";

const ABOUT: Record<keyof typeof ROOFING_VIEW_COLUMNS, string> = {
  v_property:
    "One row per Broward parcel (766k): address, centroid lat/lon, roof age (roof_age_basis = permit | year_built | unknown), owner type/location, occupancy, last sale, market value, open roof permit count, whether the parcel's jurisdiction has permit data, and the source request URL.",
  v_roof_permit:
    "One row per roofing permit: status (open | completed | other | needs_review), open_days/open_years, dates, roof_work_class, contractor name/license (DBPR), BBB fields (null when unpublished), linked parcel and its location.",
  v_contractor:
    "One row per DBPR-licensed contractor seen on a permit: license class/status/expiry, permit and open-permit counts, BBB fields.",
  v_business:
    "Businesses: company property owners from the appraiser roll (role property_owner) and licensed contractors (role contractor).",
  v_owner:
    "Owner & occupancy view per parcel: owner_type, owner_name (companies only — individual owner names are never published), owner_location_class, mailing state/ZIP5, occupancy_class and occupancy_basis, years since transfer.",
};

/** Markdown guide to `roofing-views.v1`, served as the `oracle://views-guide` MCP resource. */
export function viewsGuide(): string {
  const lines = [
    `# ${ROOFING_VIEWS_VERSION} — Broward County, FL roofing views`,
    "",
    "Query with `run_read_only_sql` (DuckDB SQL, one SELECT). Distances: use the find_* tools, or",
    "filter `lat`/`lon` yourself. Thresholds (roof age 15 y, long-held 10 y) are query parameters.",
    "Lexicon tables are also available as `lx_county_<class>` and `lx_property_improvement_<class>`.",
    "",
  ];
  for (const [v, cols] of Object.entries(ROOFING_VIEW_COLUMNS)) {
    lines.push(
      `## ${v}`,
      "",
      ABOUT[v as keyof typeof ABOUT],
      "",
      `Columns: ${cols.map((c) => `\`${c}\``).join(", ")}`,
      "",
    );
  }
  return lines.join("\n");
}

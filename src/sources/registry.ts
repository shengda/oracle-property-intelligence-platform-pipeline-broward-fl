import type { SourceDescriptor } from "../types.ts";

export const BCPA_TAXROLL_LAYER =
  "https://services.arcgis.com/JMAJrTsHNLrSsWf5/arcgis/rest/services/PARCEL_POLY_BCPA_TAXROLL/FeatureServer/0";
export const BCPA_TAXROLL_FULL_LAYER =
  "https://services.arcgis.com/JMAJrTsHNLrSsWf5/arcgis/rest/services/QAlertBCPA_Parcel_TaxRoll/FeatureServer/3";
export const FTL_PERMITS_LAYER =
  "https://gis.fortlauderdale.gov/arcgis/rest/services/GeneralPurpose/gisdata/MapServer/27";
export const HCED_PERMITS_LAYER =
  "https://bcgishub.broward.org/posse/rest/services/HCED/HCEDPossePermitsRef/MapServer/4";
export const WESTON_ISSUED_LAYER =
  "https://portal.westonfl.org/arcgis/rest/services/Accela/IssuedPermitReport/FeatureServer/0";
export const WESTON_CLOSED_LAYER =
  "https://portal.westonfl.org/arcgis/rest/services/Accela/Closed_Permit_Report/FeatureServer/0";
export const BROWARD_MUNICIPALITIES_LAYER =
  "https://services.arcgis.com/JMAJrTsHNLrSsWf5/arcgis/rest/services/Cities_Multipart/FeatureServer/0";
export const DBPR_CONSTRUCTION_LICENSES_URL =
  "https://www2.myfloridalicense.com/sto/file_download/extracts/CONSTRUCTIONLICENSE_1.csv";
export const CENSUS_PLACES_GAZETTEER_URL =
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_gaz_place_12.txt";
export const CENSUS_ZCTA_COUNTY_URL =
  "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt";
export const CENSUS_COUNTY_BOUNDARY_URL =
  "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip";
export const SUNBIZ_DOWNLOADS_URL = "https://dos.fl.gov/sunbiz/other-services/data-downloads/";
export const BBB_ROOFING_CATEGORY_URL =
  "https://www.bbb.org/us/fl/fort-lauderdale/category/roofing-contractors";

/**
 * Every source the README needs, with its change mode. Sources skipped by the architecture §3.7
 * skip rule appear here with their reason and estimate; they are never fetched.
 */
export const SOURCES: SourceDescriptor[] = [
  {
    key: "bcpa-taxroll",
    title: "Broward County Property Appraiser tax roll with parcel polygons (Broward County GIS)",
    kind: "arcgis",
    url: BCPA_TAXROLL_LAYER,
    changeMode: "file_digest",
    readmeNeed: "property, ownership, sales, location/coordinates, year built",
    status: "active",
  },
  {
    key: "bcpa-taxroll-full",
    title:
      "Broward County Property Appraiser tax roll incl. condominium units (Broward County GIS, QAlert layer)",
    kind: "arcgis",
    url: BCPA_TAXROLL_FULL_LAYER,
    changeMode: "file_digest",
    readmeNeed: "property records for folios missing from the primary roll layer (mostly condominium units)",
    status: "active",
    limitation:
      "Older snapshot (latest recorded sale 2020-03-26). Used only for folios absent from bcpa-taxroll; those parcels carry this layer's vintage and provenance.",
  },
  {
    key: "ftl-permits",
    title: "City of Fort Lauderdale building permits (ArcGIS, Land Use Operations)",
    kind: "arcgis",
    url: FTL_PERMITS_LAYER,
    changeMode: "file_digest",
    readmeNeed: "permits (roofing), permit status and dates",
    status: "active",
    limitation:
      "Layer is frozen: permits submitted 2018-01-08 to 2021-01-05 only; CONTRACTOR/CONTRACTID empty in every row.",
  },
  {
    key: "hced-permits",
    title: "Broward County HCED (unincorporated) POSSE permits (ArcGIS)",
    kind: "arcgis",
    url: HCED_PERMITS_LAYER,
    changeMode: "window",
    readmeNeed: "permits (unincorporated Broward)",
    status: "active",
  },
  {
    key: "weston-permits",
    title: "City of Weston issued and closed permit reports (Accela via ArcGIS)",
    kind: "arcgis",
    url: WESTON_ISSUED_LAYER,
    changeMode: "window",
    readmeNeed: "permits (rolling recent window)",
    status: "active",
    limitation: "Rolling report of recently issued/closed permits only (hundreds of rows), not full history.",
  },
  {
    key: "dbpr-licenses",
    title: "FL DBPR construction industry licensee extract",
    kind: "csv",
    url: DBPR_CONSTRUCTION_LICENSES_URL,
    changeMode: "file_digest",
    readmeNeed: "contractor records and licenses",
    status: "active",
  },
  {
    key: "census-places",
    title: "Census Gazetteer places (Florida)",
    kind: "reference",
    url: CENSUS_PLACES_GAZETTEER_URL,
    changeMode: "file_digest",
    readmeNeed: "place centers for 'near [city]'",
    status: "active",
  },
  {
    key: "census-zcta-county",
    title: "Census 2020 ZCTA-to-county relationship file",
    kind: "reference",
    url: CENSUS_ZCTA_COUNTY_URL,
    changeMode: "file_digest",
    readmeNeed: "Broward ZIPs for owner-location classification",
    status: "active",
  },
  {
    key: "census-county-boundary",
    title: "Census cartographic boundary counties 1:500k",
    kind: "zip",
    url: CENSUS_COUNTY_BOUNDARY_URL,
    changeMode: "file_digest",
    readmeNeed: "county boundary for coordinate QA",
    status: "active",
  },
  {
    key: "broward-municipalities",
    title: "Broward County municipal boundaries (Broward County GIS)",
    kind: "arcgis",
    url: BROWARD_MUNICIPALITIES_LAYER,
    changeMode: "file_digest",
    readmeNeed: "permit jurisdiction per parcel (coverage)",
    status: "active",
  },
  {
    key: "sunbiz",
    title: "Florida Sunbiz corporate data (quarterly cordata)",
    kind: "zip",
    url: SUNBIZ_DOWNLOADS_URL,
    changeMode: "file_digest",
    readmeNeed: "business records (legal entities)",
    status: "active",
  },
  {
    key: "bbb",
    title: "BBB roofing contractors, Fort Lauderdale market (bounded)",
    kind: "html",
    url: BBB_ROOFING_CATEGORY_URL,
    changeMode: "bounded_crawl",
    readmeNeed: "BBB rating scores where publicly available",
    status: "active",
  },
  {
    key: "ftl-accela-contractors",
    title: "Fort Lauderdale Accela permit detail (bounded contractor lookup for open roofing permits)",
    kind: "html",
    url: "https://aca-prod.accela.com/FTL/Cap/CapDetail.aspx",
    changeMode: "bounded_crawl",
    readmeNeed: "contractor identity on open roofing permits",
    status: "active",
  },
  {
    key: "municipal-permit-portals",
    title: "Other municipal permit portals (Accela, Tyler, Click2Gov, …) via the kit Broward profile",
    kind: "html",
    url: "vendor/soofi-xyz-team-kit/skills/use-oracle/runtime/src/counties/broward/permit-profile.mjs",
    changeMode: "bounded_crawl",
    readmeNeed: "permits outside Fort Lauderdale / unincorporated",
    status: "skipped",
    skipReason: "too_slow",
    estimate: { size: "1–3 GB of captures per large city", time: "20–80 h per large city at concurrency 1" },
    limitation:
      "Parcel-by-parcel portal search; 9 jurisdictions also blocked (captcha/login); skipped by the §3.7 rule.",
  },
  {
    key: "records-requests",
    title: "Municipal public-records requests for permit ledgers",
    kind: "html",
    url: "https://www.broward.org/CodeAppeals/Pages/BuildingContacts.aspx",
    changeMode: "bounded_crawl",
    readmeNeed: "permits (full municipal ledgers)",
    status: "skipped",
    skipReason: "turnaround",
    estimate: { size: "varies", time: "days to weeks (custodian turnaround)" },
    limitation: "Not filed: third-party turnaround exceeds the delivery window.",
  },
  {
    key: "overture-places",
    title: "Overture Maps places (Broward bbox)",
    kind: "reference",
    url: "https://docs.overturemaps.org/getting-data/",
    changeMode: "file_digest",
    readmeNeed: "business records (places/POI)",
    status: "skipped",
    skipReason: "optional_cut",
    estimate: { size: "20–60 MB", time: "5–15 min" },
    limitation:
      "First scope cut (architecture §6.1); legal-entity business records come from Sunbiz when available.",
  },
  {
    key: "dor-nal-sdf",
    title: "FL DOR NAL/SDF/PIN tax roll files (county 16)",
    kind: "zip",
    url: "https://floridarevenue.com/property/dataportal/",
    changeMode: "file_digest",
    readmeNeed: "property / sales (statewide fallback)",
    status: "skipped",
    skipReason: "optional_cut",
    limitation:
      "Not needed: the Broward Property Appraiser roll (bcpa-taxroll) is the preferred source (county-seed-data order) and carries 5 sales per parcel. DOR files sit behind a SharePoint file browser.",
  },
];

export function sourceByKey(key: string): SourceDescriptor {
  const s = SOURCES.find((x) => x.key === key);
  if (!s) throw new Error(`unknown source ${key}`);
  return s;
}

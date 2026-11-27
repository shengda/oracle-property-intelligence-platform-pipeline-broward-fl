import type { OccupancyClass, OwnerLocationClass, OwnerType } from "../types.ts";
import { landUseGroup } from "./land-use.ts";

const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP AA AE AP".split(
    " ",
  ),
);

let browardZips: Set<string> | null = null;

/** Broward ZCTAs (Census 2020 ZCTA–county relationship; written by the census-zcta-county source). */
export function setBrowardZips(zips: Iterable<string>): void {
  browardZips = new Set(zips);
}

export function getBrowardZips(): Set<string> {
  if (!browardZips) {
    // Fallback for unit tests / before the reference source is loaded: USPS 333xx Broward range.
    browardZips = new Set();
    for (let z = 33004; z <= 33099; z++) browardZips.add(String(z));
    for (let z = 33301; z <= 33394; z++) browardZips.add(String(z));
    for (let z = 33441; z <= 33443; z++) browardZips.add(String(z));
  }
  return browardZips;
}

export function classifyOwnerLocation(m: {
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}): OwnerLocationClass {
  const country = (m.country ?? "").trim().toUpperCase();
  const state = (m.state ?? "").trim().toUpperCase();
  const zip = (m.zip ?? "").trim().slice(0, 5);
  if (country && !["US", "USA", "UNITED STATES"].includes(country)) return "foreign";
  if (!state && !zip) return "unknown";
  if (state && !US_STATES.has(state)) return "foreign";
  if (state === "FL" || (!state && /^3[2-4]\d{3}$/.test(zip))) {
    if (/^\d{5}$/.test(zip) && getBrowardZips().has(zip)) return "in_county";
    if (/^\d{5}$/.test(zip)) return "in_state_out_of_county";
    return "unknown";
  }
  return "out_of_state";
}

const GOVERNMENT =
  /\b(COUNTY|CITY OF|TOWN OF|VILLAGE OF|STATE OF|SCHOOL BOARD|BOARD OF|UNITED STATES|USA|U S A|DEPT|DEPARTMENT|AUTHORITY|DISTRICT|TIITF|TRUSTEES OF THE INTERNAL|HOUSING AUTH|FDOT|FLA DEPT|BRD OF|COMMISSIONERS)\b/;
const TRUST =
  /\b(TRUST|TR|TRS|TRSTEE|TRUSTEE|TRUSTEES|REV TR|LIV TR|LIVING TRUST|FAMILY TRUST|ESTATE OF|EST OF)\b/;
const COMPANY =
  /\b(LLC|L L C|INC|CORP|CORPORATION|CO|COMPANY|LTD|LP|LLP|PLLC|PA|P A|LLLP|HOLDINGS|PROPERTIES|PROPERTY|INVESTMENTS?|PARTNERS|PARTNERSHIP|GROUP|ASSN|ASSOCIATION|ASSOC|BANK|FUND|REALTY|ENTERPRISES?|VENTURES?|DEVELOPMENT|MANAGEMENT|CONDO|CONDOMINIUM|HOMEOWNERS|CHURCH|MINISTRIES|FOUNDATION|CLUB|HOSPITAL|UNIVERSITY|SCHOOL|CAPITAL|EQUITIES|LAND|HOMES|APARTMENTS|RESIDENCES|PLAZA|CENTER|SERVICES|TRADING)\b/;

export function classifyOwnerType(name: string | null | undefined): OwnerType {
  const n = (name ?? "").toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return "unknown";
  if (GOVERNMENT.test(n)) return "government";
  if (TRUST.test(n)) return "trust";
  if (COMPANY.test(n)) return "company";
  return "person";
}

export function classifyOccupancy(p: {
  landUseCode: string | null;
  homestead: boolean | null;
  ownerType: OwnerType | string;
}): OccupancyClass {
  const g = landUseGroup(p.landUseCode);
  if (g === "unknown") return "unknown";
  if (p.ownerType === "government" || g === "government") return "government_or_exempt";
  if (g === "vacant_residential" || g === "vacant_commercial" || g === "vacant_industrial")
    return "vacant_land";
  if (g === "residential") {
    if (p.homestead === true) return "owner_occupied";
    if (p.homestead === false) return "likely_tenant_occupied";
    return "unknown";
  }
  if (g === "commercial" || g === "industrial") return "commercial";
  if (g === "institutional") return "government_or_exempt";
  return "unknown";
}

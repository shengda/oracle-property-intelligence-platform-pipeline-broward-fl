/**
 * Florida DOR land-use codes (BCPA `USE_CODE`, two digits) → Lexicon property_type /
 * property_usage_type. Code table: FL DOR "Land Use Codes" (Rule 12D-8.008, F.A.C.).
 */

export function landUseGroup(
  code: string | null | undefined,
):
  | "vacant_residential"
  | "residential"
  | "vacant_commercial"
  | "commercial"
  | "vacant_industrial"
  | "industrial"
  | "agricultural"
  | "institutional"
  | "government"
  | "miscellaneous"
  | "unknown" {
  if (!code || !/^\d{1,2}$/.test(code.trim())) return "unknown";
  const n = Number(code);
  if (n === 0) return "vacant_residential";
  if (n <= 9) return "residential";
  if (n === 10) return "vacant_commercial";
  if (n <= 39) return "commercial";
  if (n === 40) return "vacant_industrial";
  if (n <= 49) return "industrial";
  if (n <= 69) return "agricultural";
  if (n === 70) return "vacant_commercial";
  if (n <= 79) return "institutional";
  if (n <= 89) return "government";
  return "miscellaneous";
}

const PROPERTY_TYPE: Record<string, string> = {
  "00": "VacantLand",
  "01": "SingleFamily",
  "02": "MobileHome",
  "03": "MultiFamilyMoreThan10",
  "04": "Condominium",
  "05": "Cooperative",
  "06": "Retirement",
  "07": "MiscellaneousResidential",
  "08": "MultiFamilyLessThan10",
  "09": "ResidentialCommonElementsAreas",
  "10": "VacantLand",
  "40": "VacantLand",
  "70": "VacantLand",
};

export function propertyType(code: string | null | undefined): string {
  const c = (code ?? "").trim().padStart(2, "0");
  if (PROPERTY_TYPE[c]) return PROPERTY_TYPE[c];
  const g = landUseGroup(c);
  if (g === "agricultural" || g === "miscellaneous" || g === "unknown") return "LandParcel";
  return "Building";
}

const USAGE: Record<string, string> = {
  "06": "Retirement",
  "09": "ResidentialCommonElementsAreas",
  "11": "RetailStore",
  "12": "RetailStore",
  "13": "DepartmentStore",
  "14": "Supermarket",
  "15": "ShoppingCenterRegional",
  "16": "ShoppingCenterCommunity",
  "17": "OfficeBuilding",
  "18": "OfficeBuilding",
  "19": "MedicalOffice",
  "20": "TransportationTerminal",
  "21": "Restaurant",
  "22": "Restaurant",
  "23": "FinancialInstitution",
  "26": "ServiceStation",
  "27": "AutoSalesRepair",
  "28": "MobileHomePark",
  "29": "WholesaleOutlet",
  "32": "Theater",
  "33": "Entertainment",
  "34": "Entertainment",
  "35": "Entertainment",
  "37": "RaceTrack",
  "38": "GolfCourse",
  "39": "Hotel",
  "41": "LightManufacturing",
  "42": "HeavyManufacturing",
  "43": "LumberYard",
  "44": "PackingPlant",
  "45": "Cannery",
  "46": "PackingPlant",
  "47": "MineralProcessing",
  "48": "Warehouse",
  "49": "OpenStorage",
  "71": "Church",
  "72": "PrivateSchool",
  "73": "PrivateHospital",
  "74": "HomesForAged",
  "75": "NonProfitCharity",
  "76": "MortuaryCemetery",
  "77": "ClubsLodges",
  "78": "SanitariumConvalescentHome",
  "79": "CulturalOrganization",
  "81": "Military",
  "82": "ForestParkRecreation",
  "83": "PublicSchool",
  "84": "PublicSchool",
  "85": "PublicHospital",
  "91": "Utility",
  "95": "RiversLakes",
  "96": "SewageDisposal",
  "98": "Railroad",
};

export function propertyUsageType(code: string | null | undefined): string {
  const c = (code ?? "").trim().padStart(2, "0");
  if (USAGE[c]) return USAGE[c];
  switch (landUseGroup(c)) {
    case "vacant_residential":
    case "residential":
      return "Residential";
    case "vacant_commercial":
    case "commercial":
      return "Commercial";
    case "vacant_industrial":
    case "industrial":
      return "Industrial";
    case "agricultural":
      return "Agricultural";
    case "government":
      return "GovernmentProperty";
    default:
      return "Unknown";
  }
}

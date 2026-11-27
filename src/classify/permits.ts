import type { PermitStatus, RoofWorkClass } from "../types.ts";

const ROOF =
  /\b(RE-?ROOF|REROOF|ROOF(ING)?|SHINGLES?|TILE ROOF|METAL ROOF|FLAT ROOF|MOD(IFIED)? BIT|TPO|BUILT-?UP)\b/i;
const ACCESSORY =
  /\b(SCREEN ENCLOSURE|SCREEN ROOM|PATIO|PERGOLA|CARPORT|CANOPY|AWNING|GAZEBO|TIKI|SHED|PORCH|CABANA|SOLAR)\b/i;
const REPAIR = /\b(REPAIR|PATCH|COAT(ING)?|SEAL(ANT|ING)?|LEAK|MAINT(ENANCE)?|RECOAT)\b/i;
const NEW_CONSTRUCTION = /\b(NEW (SFR|SINGLE FAMILY|HOME|RESIDENCE|BUILDING|CONSTRUCTION)|NEW CONST)\b/i;
const REPLACEMENT = /\b(RE-?ROOF|REROOF|REPLACE(MENT)?|TEAR ?OFF|RE-?COVER|NEW ROOF)\b/i;

/** Classify permit work for roof-age purposes. Only primary replacements reset roof age (kit rule). */
export function classifyRoofWork(p: { type?: string | null; description?: string | null }): {
  isRoofing: boolean;
  roofWorkClass: RoofWorkClass;
} {
  const type = p.type ?? "";
  const desc = p.description ?? "";
  const text = `${type} ${desc}`;
  const typeIsRoof = /re-?roof|roof/i.test(type);
  if (!typeIsRoof && !ROOF.test(desc)) return { isRoofing: false, roofWorkClass: "other" };
  if (ACCESSORY.test(text)) return { isRoofing: true, roofWorkClass: "accessory_roof" };
  if (REPAIR.test(text) && !/RE-?ROOF|REROOF|REPLACE/i.test(desc)) {
    return { isRoofing: true, roofWorkClass: "repair_or_coating" };
  }
  if (NEW_CONSTRUCTION.test(text)) return { isRoofing: true, roofWorkClass: "primary_roof_new_construction" };
  if (REPLACEMENT.test(text) || /re-?roof/i.test(type)) {
    return { isRoofing: true, roofWorkClass: "primary_roof_replacement" };
  }
  return { isRoofing: true, roofWorkClass: "other" };
}

const OPEN = [
  "issued",
  "in process",
  "inspections in progress",
  "inspection",
  "about to expire",
  "open",
  "active",
  "awaiting client reply",
  "approved",
  "accepted",
  "revision submitted",
  "revisions submitted",
  "corrections received",
  "under review",
  "plan review",
  "pending",
  "permit issued",
  "ready to issue",
];
const COMPLETED = [
  "complete",
  "completed",
  "finaled",
  "final",
  "closed",
  "co issued",
  "cc issued",
  "certificate of occupancy",
];
const OTHER = [
  "void",
  "voided",
  "withdrawn",
  "disapproved",
  "denied",
  "cancelled",
  "canceled",
  "expired",
  "inactive",
  "closed:  rejected",
  "closed: rejected",
  "rejected",
  "revoked",
  "void-withdraw",
];

/**
 * Normalize a raw permit status. Expired/inactive permits are `other` (not counted as open);
 * an unmapped or empty status is `needs_review` and never appears in long-open results.
 */
export function normalizePermitStatus(raw: string | null | undefined): PermitStatus {
  const s = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return "needs_review";
  if (OTHER.includes(s) || OTHER.includes(raw!.trim().toLowerCase())) return "other";
  if (COMPLETED.includes(s)) return "completed";
  if (OPEN.includes(s)) return "open";
  if (/^(inspections?|in progress|in review)/.test(s) || /in progress$/.test(s)) return "open";
  if (/final(ed)?$|^closed$/.test(s)) return "completed";
  return "needs_review";
}

function dayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

/** Days a permit has been open as of `asOf` (YYYY-MM-DD); null unless status is open with a date. */
export function computeOpenDays(
  p: { status: PermitStatus; issuedDate: string | null },
  asOf: string,
): number | null {
  if (p.status !== "open" || !p.issuedDate) return null;
  const a = dayNumber(asOf);
  const b = dayNumber(p.issuedDate);
  if (a === null || b === null || b > a) return null;
  return a - b;
}

/** Lexicon `improvement_status` for a raw status (enum of property_improvement). */
export function lexiconImprovementStatus(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  const n = normalizePermitStatus(raw);
  if (n === "completed") return "Completed";
  if (n === "open") {
    if (["issued", "about to expire", "open", "approved", "permit issued", "active"].includes(s))
      return "Permitted";
    return "InProgress";
  }
  if (n === "other") {
    if (["expired", "inactive"].includes(s)) return "OnHold";
    return "Cancelled";
  }
  return null;
}

const TYPE_MAP: [RegExp, string][] = [
  [/re-?roof|roof/i, "Roofing"],
  [/plumb/i, "Plumbing"],
  [/electric|generator|alarm/i, "Electrical"],
  [/mechanic|hvac|a\/c|air cond/i, "MechanicalHVAC"],
  [/gas|fuel/i, "GasInstallation"],
  [/window|door/i, "ExteriorOpeningsAndFinishes"],
  [/fence/i, "Fencing"],
  [/^row$|right.of.way/i, "RightOfWayPermit"],
  [/fire/i, "FireProtectionSystem"],
  [/shutter|awning|canopy/i, "ShutterAwning"],
  [/solar/i, "Solar"],
  [/dock|seawall|boatlift|pile/i, "DockAndShore"],
  [/landscape|irrigation/i, "LandscapeIrrigation"],
  [/pool|spa/i, "PoolSpaInstallation"],
  [/demoli/i, "Demolition"],
  [/move house|structure move/i, "StructureMove"],
  [/screen/i, "ScreenEnclosure"],
  [/residential/i, "ResidentialConstruction"],
  [/commercial/i, "CommercialConstruction"],
  [/addition/i, "BuildingAddition"],
  [/driveway/i, "DrivewayPermit"],
];

export function lexiconImprovementType(type: string | null | undefined, description?: string | null): string {
  const t = `${type ?? ""}`;
  for (const [re, v] of TYPE_MAP) if (re.test(t)) return v;
  const d = `${description ?? ""}`;
  for (const [re, v] of TYPE_MAP) if (re.test(d)) return v;
  return "GeneralBuilding";
}

export function lexiconImprovementAction(roofWorkClass: RoofWorkClass, isRoofing: boolean): string | null {
  if (!isRoofing) return null;
  switch (roofWorkClass) {
    case "primary_roof_replacement":
      return "Replacement";
    case "primary_roof_new_construction":
      return "New";
    case "repair_or_coating":
      return "Repair";
    default:
      return "Other";
  }
}

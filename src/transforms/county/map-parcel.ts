import { COUNTY } from "../../config.ts";
import { propertyType, propertyUsageType } from "../../classify/land-use.ts";
import { classifyOwnerType } from "../../classify/owners.ts";
import type { LexiconEntity, LexiconRelationship, PropertyOutput } from "../../lexicon/output-writer.ts";
import { arcgisRecordRequest } from "../../sources/arcgis.ts";
import { BCPA_TAXROLL_FULL_LAYER, BCPA_TAXROLL_LAYER } from "../../sources/registry.ts";
import type { GeoStatus, SourceHttpRequest } from "../../types.ts";
import { isQualifiedSale } from "./stage.ts";

export interface StagedParcel {
  parcel_id: string;
  roll_source?: string | null;
  land_use_code: string | null;
  homestead: boolean | null;
  situs_number: string | null;
  situs_dir: string | null;
  situs_street: string | null;
  situs_type: string | null;
  situs_post_dir: string | null;
  situs_unit: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  legal_description: string | null;
  year_built: number | null;
  effective_year_built: number | null;
  building_sqft: number | null;
  units: number | null;
  buildings: number | null;
  lot_sqft: number | null;
  land_value: number | null;
  building_value: number | null;
  other_value: number | null;
  assessed_value: number | null;
  exemption_amount: number | null;
  county_taxable: number | null;
  school_taxable: number | null;
  city_taxable: number | null;
  lat: number | null;
  lon: number | null;
  geo_status: GeoStatus;
}

export interface StagedSale {
  sale_date: string;
  deed_type: string | null;
  price: number | null;
  qual_code: string | null;
}

export interface StagedOwner {
  name_1: string | null;
  name_2: string | null;
  mail_line_1: string | null;
  mail_line_2: string | null;
  mail_city: string | null;
  mail_state: string | null;
  mail_zip: string | null;
}

/** The decided provenance (Task 0 Step 7): the exact per-folio query of the official BCPA roll layer. */
export function parcelRequest(parcelId: string, rollSource?: string | null): SourceHttpRequest {
  const fixture = process.env.ORACLE_FIXTURE_PROVENANCE;
  if (fixture)
    return { method: "GET", url: fixture, multiValueQueryString: { where: [`FOLIO='${parcelId}'`] } };
  const layer = rollSource === "bcpa-taxroll-full" ? BCPA_TAXROLL_FULL_LAYER : BCPA_TAXROLL_LAYER;
  return arcgisRecordRequest(layer, `FOLIO='${parcelId}'`);
}

/**
 * Lexicon area fields are strings that must contain at least two digits. Single-digit areas
 * (1–9 sq ft) are roll data errors, so they are omitted rather than published.
 */
export function areaString(sqft: number | null | undefined): string | null {
  return sqft != null && Number.isFinite(sqft) && sqft >= 10 ? String(Math.round(sqft)) : null;
}

export function situsAddress(p: StagedParcel): string {
  const street = [p.situs_number, p.situs_dir, p.situs_street, p.situs_type, p.situs_post_dir]
    .filter((x) => x && String(x).trim())
    .join(" ");
  const unit = p.situs_unit ? ` #${p.situs_unit}` : "";
  const city = p.situs_city && p.situs_city !== "UNINCORPORATED" ? p.situs_city : "BROWARD COUNTY";
  const zip = p.situs_zip && /^\d{5}$/.test(p.situs_zip) && p.situs_zip !== "00000" ? ` ${p.situs_zip}` : "";
  return street ? `${street}${unit}, ${city}, FL${zip}` : `PARCEL ${p.parcel_id}, ${city}, FL${zip}`;
}

const STRUCTURE_REQUIRED_NULLS = [
  "architectural_style_type",
  "attachment_type",
  "exterior_wall_material_primary",
  "exterior_wall_material_secondary",
  "exterior_wall_condition",
  "exterior_wall_insulation_type",
  "flooring_material_primary",
  "flooring_material_secondary",
  "subfloor_material",
  "flooring_condition",
  "interior_wall_structure_material",
  "interior_wall_surface_material_primary",
  "interior_wall_surface_material_secondary",
  "interior_wall_finish_primary",
  "interior_wall_finish_secondary",
  "interior_wall_condition",
  "roof_covering_material",
  "roof_underlayment_type",
  "roof_structure_material",
  "roof_design_type",
  "roof_condition",
  "gutters_material",
  "gutters_condition",
  "roof_material_type",
  "foundation_type",
  "foundation_material",
  "foundation_waterproofing",
  "foundation_condition",
  "ceiling_structure_material",
  "ceiling_surface_material",
  "ceiling_insulation_type",
  "ceiling_height_average",
  "ceiling_condition",
  "exterior_door_material",
  "interior_door_material",
  "window_frame_material",
  "window_glazing_type",
  "window_operation_type",
  "window_screen_material",
  "primary_framing_material",
  "secondary_framing_material",
  "structural_damage_indicators",
];

function num(v: number | null | undefined): number | undefined {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? undefined : Number(v);
}

/** Lexicon money fields require a number; drop the key when the roll has no value. */
function money(data: Record<string, unknown>, key: string, v: number | null | undefined): void {
  const n = num(v);
  if (n !== undefined && n >= 0) data[key] = Math.round(n * 100) / 100;
}

/** Lexicon `property` fields from the roll (shared by every data group that links the property). */
export function propertyData(p: StagedParcel): Record<string, unknown> {
  const property: Record<string, unknown> = {
    parcel_identifier: p.parcel_id,
    property_type: propertyType(p.land_use_code),
    property_legal_description_text: p.legal_description ?? null,
    property_usage_type: propertyUsageType(p.land_use_code),
  };
  if (p.year_built) property.property_structure_built_year = p.year_built;
  if (p.effective_year_built) property.property_effective_built_year = p.effective_year_built;
  const livable = areaString(p.building_sqft);
  if (livable) property.livable_floor_area = livable;
  const lot = areaString(p.lot_sqft);
  if (lot) property.total_area = lot;
  if (p.units && p.units > 0) property.number_of_units = p.units;
  return property;
}

export interface CountyCtx {
  taxYear: number;
  roof?: { roofDate: string | null; roofAgeYears: number | null } | null;
  /** Publish company owners (business names) — individuals are never published (Open Q3 default). */
  publishCompanyOwners: boolean;
}

/** Map one staged parcel (+ sales, owner, roof age) to its `county` data-group output. */
export function toCountyOutput(
  p: StagedParcel,
  ctx: CountyCtx & { sales: StagedSale[]; owner?: StagedOwner | null },
): PropertyOutput {
  const rid = p.parcel_id;
  const req = parcelRequest(rid, p.roll_source);
  const e = (file: string, className: string, data: Record<string, unknown>): LexiconEntity => ({
    file,
    className,
    requestIdentifier: rid,
    sourceHttpRequest: req,
    data,
  });
  const entities: LexiconEntity[] = [];
  const relationships: LexiconRelationship[] = [];

  entities.push(e("parcel.json", "parcel", { parcel_identifier: rid }));
  const address: Record<string, unknown> = {
    unnormalized_address: situsAddress(p),
    county_name: COUNTY.name,
  };
  entities.push(e("address.json", "address", address));

  entities.push(e("property.json", "property", propertyData(p)));
  relationships.push({
    key: "property_has_address",
    file: "relationship_property_address.json",
    from: "property.json",
    to: "address.json",
  });
  relationships.push({
    key: "property_has_parcel",
    file: "relationship_property_parcel.json",
    from: "property.json",
    to: "parcel.json",
  });

  if (p.geo_status === "parcel_centroid" && p.lat !== null && p.lon !== null) {
    entities.push(
      e("geometry.json", "geometry", {
        latitude: Math.round(p.lat * 1e7) / 1e7,
        longitude: Math.round(p.lon * 1e7) / 1e7,
      }),
    );
    relationships.push({
      key: "address_has_geometry",
      file: "relationship_address_geometry.json",
      from: "address.json",
      to: "geometry.json",
    });
  }

  if (p.year_built || (p.building_sqft && p.building_sqft > 0)) {
    const structure: Record<string, unknown> = {};
    for (const k of STRUCTURE_REQUIRED_NULLS) structure[k] = null;
    // Lexicon requires roof_age_years >= 1: a roof replaced this year (age 0) keeps its roof_date
    // and publishes no age; the derived age (0) stays in the supplement and views.
    const age = ctx.roof?.roofAgeYears;
    structure.roof_age_years = age != null && age >= 1 ? age : null;
    if (ctx.roof?.roofDate) structure.roof_date = ctx.roof.roofDate;
    if (p.buildings && p.buildings > 0) structure.number_of_buildings = p.buildings;
    entities.push(e("structure.json", "structure", structure));
    relationships.push({
      key: "property_has_structure",
      file: "relationship_property_structure.json",
      from: "property.json",
      to: "structure.json",
    });
  }

  const tax: Record<string, unknown> = {
    tax_year: ctx.taxYear,
    property_building_amount: num(p.building_value) ?? null,
    monthly_tax_amount: null,
    period_start_date: `${ctx.taxYear}-01-01`,
    period_end_date: `${ctx.taxYear}-12-31`,
    property_land_amount: num(p.land_value) ?? null,
    property_exemption_amount: num(p.exemption_amount) ?? null,
  };
  const just = (num(p.land_value) ?? 0) + (num(p.building_value) ?? 0) + (num(p.other_value) ?? 0);
  if (just > 0) money(tax, "property_market_value_amount", just);
  money(tax, "property_assessed_value_amount", p.assessed_value);
  money(tax, "property_taxable_value_amount", p.county_taxable);
  money(tax, "county_taxable_value_amount", p.county_taxable);
  money(tax, "school_taxable_value_amount", p.school_taxable);
  money(tax, "city_taxable_value_amount", p.city_taxable);
  entities.push(e(`tax_${ctx.taxYear}.json`, "tax", tax));
  relationships.push({
    key: "property_has_tax",
    file: `relationship_property_tax_${ctx.taxYear}.json`,
    from: "property.json",
    to: `tax_${ctx.taxYear}.json`,
  });

  const sales = [...ctx.sales].sort((a, b) =>
    a.sale_date < b.sale_date ? -1 : a.sale_date > b.sale_date ? 1 : 0,
  );
  sales.forEach((s, i) => {
    const file = `sales_history_${i + 1}.json`;
    const data: Record<string, unknown> = { ownership_transfer_date: s.sale_date };
    if (s.price && s.price > 0) data.purchase_price_amount = s.price;
    if (isQualifiedSale(s.qual_code)) data.sale_type = "TypicallyMotivated";
    entities.push(e(file, "sales_history", data));
    relationships.push({
      key: "property_has_sales_history",
      file: `relationship_property_sales_history_${i + 1}.json`,
      from: "property.json",
      to: file,
    });
  });

  // Current owner = grantee of the most recent transfer. Companies only (no individual names).
  const owner = ctx.owner;
  if (ctx.publishCompanyOwners && owner?.name_1 && sales.length > 0) {
    const type = classifyOwnerType(owner.name_1);
    if (type === "company") {
      const last = sales.length;
      entities.push(e("company_owner.json", "company", { name: owner.name_1, sunbiz_document_number: null }));
      relationships.push({
        key: "sales_history_has_company",
        file: "relationship_sales_history_company.json",
        from: `sales_history_${last}.json`,
        to: "company_owner.json",
      });
      const mail = [
        owner.mail_line_1,
        [owner.mail_city, owner.mail_state, owner.mail_zip].filter(Boolean).join(" "),
      ]
        .filter((x) => x && String(x).trim())
        .join(", ");
      if (mail) {
        const mailing: Record<string, unknown> = { unnormalized_address: mail };
        if (owner.mail_state && /^[A-Z]{2}$/.test(owner.mail_state)) mailing.state_code = owner.mail_state;
        const z = (owner.mail_zip ?? "").slice(0, 5);
        if (/^\d{5}$/.test(z)) mailing.postal_code = z;
        entities.push(e("address_owner_mailing.json", "address", mailing));
        relationships.push({
          key: "company_has_mailing_address",
          file: "relationship_company_mailing_address.json",
          from: "company_owner.json",
          to: "address_owner_mailing.json",
        });
      }
    }
  }

  return { parcelId: rid, groupTitle: "County", entities, relationships };
}

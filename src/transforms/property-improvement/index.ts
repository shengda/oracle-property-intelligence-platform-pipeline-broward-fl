import { mkdir, rm } from "node:fs/promises";
import { lexiconImprovementAction, lexiconImprovementType } from "../../classify/permits.ts";
import type {
  GroupContext,
  LexiconEntity,
  LexiconRelationship,
  PropertyOutput,
} from "../../lexicon/output-writer.ts";
import { writePropertyOutput } from "../../lexicon/output-writer.ts";
import { DBPR_CONSTRUCTION_LICENSES_URL } from "../../sources/registry.ts";
import type { RoofWorkClass, SourceHttpRequest } from "../../types.ts";
import type { WorkDb } from "../../work-db.ts";
import { parcelRequest, propertyData, situsAddress, type StagedParcel } from "../county/map-parcel.ts";

export interface DrvPermit {
  permit_key: string;
  source_system: string;
  parcel_id: string;
  permit_number: string | null;
  permit_type: string | null;
  permit_subtype: string | null;
  description: string | null;
  raw_status: string | null;
  lexicon_status: string | null;
  is_roofing: boolean;
  roof_work_class: RoofWorkClass;
  application_date: string | null;
  issue_date: string | null;
  completion_date_resolved: string | null;
  close_date: string | null;
  final_date: string | null;
  est_value: number | null;
  request_json: string;
  // contractor (DBPR-resolved)
  license_id: string | null;
  class_code: string | null;
  licensee_name: string | null;
  dba_name: string | null;
}

/** "LAST, FIRST MIDDLE SUFFIX" → person name parts (DBPR licensee format). */
export function splitPersonName(name: string): { first: string; last: string; middle: string | null } | null {
  const m = /^([^,]+),\s*(\S+)(?:\s+(.+))?$/.exec(name.trim());
  if (!m) return null;
  const middle = (m[3] ?? "").replace(/\b(JR|SR|II|III|IV)\b\.?/g, "").trim();
  return { last: m[1].trim(), first: m[2].trim(), middle: middle || null };
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
}

const DBPR_REQUEST: SourceHttpRequest = { method: "GET", url: DBPR_CONSTRUCTION_LICENSES_URL };

/** Map one parcel with its permits to its `property_improvement` data-group output. */
export function toPropertyImprovementOutput(p: StagedParcel, permits: DrvPermit[]): PropertyOutput {
  const rid = p.parcel_id;
  const req = parcelRequest(rid, p.roll_source);
  const entities: LexiconEntity[] = [
    {
      file: "parcel.json",
      className: "parcel",
      requestIdentifier: rid,
      sourceHttpRequest: req,
      data: { parcel_identifier: rid },
    },
    {
      file: "address.json",
      className: "address",
      requestIdentifier: rid,
      sourceHttpRequest: req,
      data: { unnormalized_address: situsAddress(p), county_name: "Broward" },
    },
    {
      file: "property.json",
      className: "property",
      requestIdentifier: rid,
      sourceHttpRequest: req,
      data: propertyData(p),
    },
  ];
  const relationships: LexiconRelationship[] = [];
  const companies = new Map<string, string>();
  const sorted = [...permits].sort((a, b) => (a.permit_key < b.permit_key ? -1 : 1));
  sorted.forEach((pm, i) => {
    const file = `property_improvement_${i + 1}.json`;
    const data: Record<string, unknown> = {
      improvement_type: lexiconImprovementType(pm.permit_type, pm.description),
      improvement_status: pm.lexicon_status,
      completion_date: pm.completion_date_resolved ?? null,
      contractor_type: pm.license_id
        ? pm.class_code === "CCC" || pm.class_code === "CRC"
          ? "Specialist"
          : "GeneralContractor"
        : null,
      permit_number: pm.permit_number,
    };
    const action = lexiconImprovementAction(pm.roof_work_class, pm.is_roofing);
    if (action) data.improvement_action = action;
    if (pm.application_date) data.application_received_date = pm.application_date;
    if (pm.issue_date) data.permit_issue_date = pm.issue_date;
    if (pm.close_date) data.permit_close_date = pm.close_date;
    if (pm.final_date) data.final_inspection_date = pm.final_date;
    entities.push({
      file,
      className: "property_improvement",
      requestIdentifier: pm.permit_key,
      sourceHttpRequest: JSON.parse(pm.request_json) as SourceHttpRequest,
      data,
    });
    relationships.push({
      key: "property_has_property_improvement",
      file: `rel_property_pi_${i + 1}.json`,
      from: "property.json",
      to: file,
    });

    // Contractor from the DBPR record only (kit dbpr-license-ingest rule); no DBPR match → none.
    if (pm.license_id && pm.licensee_name) {
      let companyFile = companies.get(pm.license_id);
      if (!companyFile) {
        companyFile = `company_contractor_${companies.size + 1}.json`;
        companies.set(pm.license_id, companyFile);
        const companyName = (pm.dba_name || pm.licensee_name).trim();
        entities.push({
          file: companyFile,
          className: "company",
          requestIdentifier: pm.license_id,
          sourceHttpRequest: DBPR_REQUEST,
          data: { name: companyName, sunbiz_document_number: null },
        });
        const person = splitPersonName(pm.licensee_name);
        if (person) {
          const personFile = `person_qualifier_${companies.size}.json`;
          entities.push({
            file: personFile,
            className: "person",
            requestIdentifier: pm.license_id,
            sourceHttpRequest: DBPR_REQUEST,
            data: {
              first_name: titleCase(person.first),
              last_name: titleCase(person.last),
              middle_name: person.middle ? titleCase(person.middle) : null,
              birth_date: null,
              prefix_name: null,
              suffix_name: null,
              us_citizenship_status: null,
              veteran_status: null,
            },
          });
          relationships.push({
            key: "contractor_has_person",
            file: `rel_contractor_person_${companies.size}.json`,
            from: companyFile,
            to: personFile,
          });
        }
      }
      relationships.push({
        key: "property_improvement_has_contractor",
        file: `rel_pi_contractor_${i + 1}.json`,
        from: file,
        to: companyFile,
      });
    }
  });
  return { parcelId: rid, groupTitle: "Property Improvement", entities, relationships };
}

export async function buildPropertyImprovementGroup(
  db: WorkDb,
  groupDir: string,
  ctx: GroupContext,
  opts: { parcels?: string[]; log?: (m: string) => void } = {},
): Promise<{ properties: number; permits: number; unmatched: number; withContractor: number }> {
  await rm(groupDir, { recursive: true, force: true });
  await mkdir(groupDir, { recursive: true });
  const filter = opts.parcels?.length
    ? `and d.parcel_id in (${opts.parcels.map((x) => `'${x.replace(/'/g, "")}'`).join(",")})`
    : "";
  const permits = await db.all<DrvPermit>(`select d.*, c.license_id, c.class_code, c.licensee_name, c.dba_name
    from drv_permits d left join drv_contractor_links c on c.permit_key = d.permit_key and c.license_id is not null
    where d.parcel_matched ${filter} order by d.parcel_id, d.permit_key`);
  const unmatched = await db.one<{ n: number }>(
    "select count(*)::INTEGER n from drv_permits where not parcel_matched",
  );
  const byParcel = new Map<string, DrvPermit[]>();
  for (const p of permits) {
    const l = byParcel.get(p.parcel_id) ?? [];
    l.push(p);
    byParcel.set(p.parcel_id, l);
  }
  const ids = [...byParcel.keys()];
  let properties = 0;
  for (let i = 0; i < ids.length; i += 5000) {
    const chunk = ids.slice(i, i + 5000);
    const parcels = await db.all<StagedParcel>(
      `select p.*, 'parcel_centroid' as geo_status from stg_parcels p where parcel_id in (${chunk.map((x) => `'${x}'`).join(",")})`,
    );
    const writes: Promise<string>[] = [];
    for (const p of parcels) {
      writes.push(
        writePropertyOutput(groupDir, toPropertyImprovementOutput(p, byParcel.get(p.parcel_id)!), ctx),
      );
      if (writes.length >= 256) await Promise.all(writes.splice(0));
    }
    await Promise.all(writes);
    properties += parcels.length;
    opts.log?.(`property_improvement group: ${properties} properties written`);
  }
  return {
    properties,
    permits: permits.length,
    unmatched: unmatched?.n ?? 0,
    withContractor: permits.filter((p) => p.license_id).length,
  };
}

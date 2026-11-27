import { rm, mkdir } from "node:fs/promises";
import type { GroupContext } from "../../lexicon/output-writer.ts";
import { writePropertyOutput } from "../../lexicon/output-writer.ts";
import type { WorkDb } from "../../work-db.ts";
import { toCountyOutput, type StagedOwner, type StagedParcel, type StagedSale } from "./map-parcel.ts";

/**
 * Write one `county` property output (ZIP) per parcel. Keyset-paged over `stg_parcels` so memory
 * stays flat at county scale. Parcels with an invalid id never reach the staging table (counted
 * in `stageParcels`).
 */
export async function buildCountyGroup(
  db: WorkDb,
  groupDir: string,
  ctx: GroupContext,
  opts: { taxYear: number; parcels?: string[]; batch?: number; log?: (m: string) => void },
): Promise<{ properties: number; withGeometry: number; withStructure: number; companyOwners: number }> {
  await rm(groupDir, { recursive: true, force: true });
  await mkdir(groupDir, { recursive: true });
  const batch = opts.batch ?? 10_000;
  const filter = opts.parcels?.length
    ? `and p.parcel_id in (${opts.parcels.map((x) => `'${x.replace(/'/g, "")}'`).join(",")})`
    : "";
  let last = "";
  let properties = 0;
  let withGeometry = 0;
  let withStructure = 0;
  let companyOwners = 0;
  for (;;) {
    const rows = await db.all<StagedParcel & { roof_date: string | null; roof_age_years: number | null }>(
      `select p.*, g.geo_status, r.roof_date, r.roof_age_years
       from stg_parcels p join drv_geo g using (parcel_id) left join drv_roof_age r using (parcel_id)
       where p.parcel_id > ? ${filter} order by p.parcel_id limit ${batch}`,
      [last],
    );
    if (rows.length === 0) break;
    const first = rows[0].parcel_id;
    const lastId = rows[rows.length - 1].parcel_id;
    const sales = await db.all<StagedSale & { parcel_id: string }>(
      `select parcel_id, sale_date, deed_type, price, qual_code from stg_sales where parcel_id between ? and ? order by parcel_id, sale_date`,
      [first, lastId],
    );
    const owners = await db.all<StagedOwner & { parcel_id: string }>(
      `select * from stg_owner_raw where parcel_id between ? and ?`,
      [first, lastId],
    );
    const salesBy = new Map<string, StagedSale[]>();
    for (const s of sales) {
      const l = salesBy.get(s.parcel_id) ?? [];
      l.push(s);
      salesBy.set(s.parcel_id, l);
    }
    const ownerBy = new Map(owners.map((o) => [o.parcel_id, o]));
    const writes: Promise<string>[] = [];
    for (const p of rows) {
      const out = toCountyOutput(p, {
        taxYear: opts.taxYear,
        roof: { roofDate: p.roof_date, roofAgeYears: p.roof_age_years },
        publishCompanyOwners: true,
        sales: salesBy.get(p.parcel_id) ?? [],
        owner: ownerBy.get(p.parcel_id) ?? null,
      });
      if (out.entities.some((e) => e.file === "geometry.json")) withGeometry++;
      if (out.entities.some((e) => e.file === "structure.json")) withStructure++;
      if (out.entities.some((e) => e.file === "company_owner.json")) companyOwners++;
      writes.push(writePropertyOutput(groupDir, out, ctx));
      if (writes.length >= 256) await Promise.all(writes.splice(0));
    }
    await Promise.all(writes);
    properties += rows.length;
    last = lastId;
    opts.log?.(`county group: ${properties} properties written`);
    if (rows.length < batch) break;
  }
  return { properties, withGeometry, withStructure, companyOwners };
}

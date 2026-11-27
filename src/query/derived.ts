import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ROOF_AGE_YEARS } from "../config.ts";
import { ROOFING_VIEWS } from "../views/roofing-views.ts";
import { openWorkDb } from "../work-db.ts";

/**
 * Derived artifacts from the run's index: one Parquet per roofing view (`query/<view>.parquet`)
 * and capped sample extracts (`samples/*.csv`, ≤ 100 rows, no owner names).
 */
export async function writeDerived(indexPath: string, outDir: string): Promise<{ files: string[] }> {
  const queryDir = path.join(outDir, "query");
  const samplesDir = path.join(outDir, "samples");
  await rm(samplesDir, { recursive: true, force: true });
  await mkdir(queryDir, { recursive: true });
  await mkdir(samplesDir, { recursive: true });
  const db = await openWorkDb(indexPath, { readOnly: true });
  const files: string[] = [];
  try {
    await db.run("load fts; load vss;").catch(() => {});
    for (const v of ROOFING_VIEWS) {
      const f = path.join(queryDir, `${v}.parquet`);
      await rm(f, { force: true });
      const order =
        v === "v_roof_permit"
          ? "permit_key"
          : v === "v_contractor"
            ? "dbpr_license_id"
            : v === "v_business"
              ? "business_key"
              : "parcel_identifier";
      await db.run(
        `copy (select * from ${v} order by ${order}) to '${f}' (format parquet, compression zstd, row_group_size 100000)`,
      );
      files.push(f);
    }
    const samples: [string, string][] = [
      [
        "aged-roofs.csv",
        `select parcel_identifier, property_cid, address, city, lat, lon, year_built, roof_age_years, roof_age_basis, source_url
         from v_property where roof_age_years >= ${DEFAULT_ROOF_AGE_YEARS} and geo_status = 'parcel_centroid'
         order by hash(parcel_identifier) limit 100`,
      ],
      [
        "long-open-permits.csv",
        `select permit_key, parcel_identifier, address, city, permit_number, description, raw_status, issue_date, open_days, open_years,
           contractor_name, contractor_license, bbb_rating, source_url
         from v_roof_permit where status = 'open' and open_days is not null order by open_days desc, permit_key limit 100`,
      ],
      [
        "contractors.csv",
        `select dbpr_license_id, contractor_name, license_class, license_status, license_expiry, permits, open_permits, bbb_rating, source_url
         from v_contractor order by open_permits desc, permits desc, dbpr_license_id limit 100`,
      ],
    ];
    for (const [name, sql] of samples) {
      const f = path.join(samplesDir, name);
      await db.run(`copy (${sql}) to '${f}' (header, delimiter ',')`);
      files.push(f);
    }
  } finally {
    await db.close();
  }
  return { files };
}

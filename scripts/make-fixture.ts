/**
 * Build `fixtures/elephant-mini/`: ~50 synthetic, Broward-shaped properties run through the real
 * pipeline path (derive → Lexicon property outputs → elephant-cli validate → hash → validate CAR →
 * export-tables → index). Provenance URLs point at https://example.invalid/fixture/… so fixture
 * rows can never be mistaken for real records. Used by tests and by the CRM's early development.
 *
 *   npx tsx scripts/make-fixture.ts [outDir]
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildGroup } from "../src/build/build-group.ts";
import { deriveAll } from "../src/build/derive.ts";
import { writeSupplement } from "../src/build/supplement.ts";
import { PART_SIZE, REPO_ROOT } from "../src/config.ts";
import { createElephantCli } from "../src/elephant/cli.ts";
import { loadLexiconManifest } from "../src/lexicon/manifest.ts";
import { groupContext } from "../src/lexicon/output-writer.ts";
import { permitCoverage } from "../src/sources/permit-coverage.ts";
import { buildCountyGroup } from "../src/transforms/county/index.ts";
import { buildPropertyImprovementGroup } from "../src/transforms/property-improvement/index.ts";
import { openWorkDb, type WorkDb } from "../src/work-db.ts";

export const FIXTURE_AS_OF = "2026-11-25";
const FIXTURE_URL = "https://example.invalid/fixture/parcels/query";
const FIXTURE_PERMIT_URL = "https://example.invalid/fixture/permits/query";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** Seed synthetic staging tables shaped like the real ones (tests reuse this). */
export async function seedFixtureStaging(db: WorkDb, n = 50): Promise<void> {
  const r = rng(12011);
  const cities = [
    { city: "FORT LAUDERDALE", zip: "33301", lat: 26.122, lon: -80.137 },
    { city: "FORT LAUDERDALE", zip: "33312", lat: 26.095, lon: -80.17 },
    { city: "WESTON", zip: "33326", lat: 26.101, lon: -80.37 },
    { city: "HOLLYWOOD", zip: "33020", lat: 26.011, lon: -80.149 },
    { city: "CORAL SPRINGS", zip: "33065", lat: 26.271, lon: -80.27 },
  ];
  const streets = ["PELICAN DR", "SE 12 ST", "NW 7 AVE", "LAS OLAS BLVD", "BAYVIEW DR", "SW 1 CT"];
  await db.run(`create or replace table stg_parcels (parcel_id VARCHAR, roll_source VARCHAR, parcel_type VARCHAR, land_use_code VARCHAR, homestead BOOLEAN,
    situs_number VARCHAR, situs_dir VARCHAR, situs_street VARCHAR, situs_type VARCHAR, situs_post_dir VARCHAR, situs_unit VARCHAR,
    situs_city_code VARCHAR, situs_city VARCHAR, situs_zip VARCHAR, municipality VARCHAR, legal_description VARCHAR, year_built INTEGER,
    effective_year_built INTEGER, building_sqft BIGINT, building_adj_sqft BIGINT, units INTEGER, buildings INTEGER, lot_sqft BIGINT,
    land_value DOUBLE, building_value DOUBLE, other_value DOUBLE, assessed_value DOUBLE, exemption_amount DOUBLE, county_taxable DOUBLE,
    school_taxable DOUBLE, city_taxable DOUBLE, millage_code VARCHAR, lat DOUBLE, lon DOUBLE, retrieved_at VARCHAR)`);
  await db.run(
    `create or replace table stg_sales (parcel_id VARCHAR, seq INTEGER, sale_date VARCHAR, deed_type VARCHAR, stamp_amount DOUBLE, price DOUBLE, qual_code VARCHAR)`,
  );
  await db.run(
    `create or replace table stg_owner_raw (parcel_id VARCHAR, name_1 VARCHAR, name_2 VARCHAR, mail_line_1 VARCHAR, mail_line_2 VARCHAR, mail_city VARCHAR, mail_state VARCHAR, mail_zip VARCHAR)`,
  );
  await db.run(
    `create or replace table ref_broward_zips as select unnest(['33301','33312','33326','33020','33065']) as zip`,
  );
  await db.run(
    `create or replace table ref_places as select * from (values ('FORT LAUDERDALE','Fort Lauderdale city','1224000',26.1412,-80.1464), ('WESTON','Weston city','1276582',26.1008,-80.4011)) t(name, census_name, geoid, lat, lon)`,
  );
  const parcels: Record<string, unknown>[] = [];
  const sales: Record<string, unknown>[] = [];
  const owners: Record<string, unknown>[] = [];
  const ownerNames = [
    "SMITH JOHN & MARY",
    "PELICAN HOLDINGS LLC",
    "GARCIA MARIA",
    "BAYVIEW PROPERTIES INC",
    "NGUYEN FAMILY TRUST",
    "CITY OF FORT LAUDERDALE",
  ];
  const mail = [
    ["FORT LAUDERDALE", "FL", "33301"],
    ["MIAMI", "FL", "33131"],
    ["NEW YORK", "NY", "10001"],
    ["TORONTO", null, null],
  ];
  for (let i = 0; i < n; i++) {
    const c = cities[i % cities.length];
    const id = `50420${String(1000000 + i * 37).slice(0, 7)}`;
    const vacant = i % 17 === 16;
    const yb = vacant ? null : 1950 + Math.floor(r() * 70);
    parcels.push({
      parcel_id: id,
      roll_source: "bcpa-taxroll",
      parcel_type: "0",
      land_use_code: vacant ? "00" : i % 9 === 8 ? "17" : "01",
      homestead: r() > 0.45,
      situs_number: String(100 + i * 3),
      situs_dir: null,
      situs_street: streets[i % streets.length].split(" ").slice(0, -1).join(" "),
      situs_type: streets[i % streets.length].split(" ").at(-1),
      situs_post_dir: null,
      situs_unit: null,
      situs_city_code: null,
      situs_city: c.city,
      situs_zip: c.zip,
      municipality: null,
      legal_description: `FIXTURE SUBDIVISION LOT ${i + 1}`,
      year_built: yb,
      effective_year_built: yb,
      building_sqft: vacant ? null : 1200 + Math.floor(r() * 2500),
      building_adj_sqft: null,
      units: vacant ? null : 1,
      buildings: vacant ? null : 1,
      lot_sqft: 6000 + Math.floor(r() * 8000),
      land_value: 150000 + Math.floor(r() * 400000),
      building_value: vacant ? 0 : 100000 + Math.floor(r() * 600000),
      other_value: 0,
      assessed_value: 300000,
      exemption_amount: 0,
      county_taxable: 280000,
      school_taxable: 290000,
      city_taxable: 280000,
      millage_code: "0312",
      lat: c.lat + (r() - 0.5) * 0.06,
      lon: c.lon + (r() - 0.5) * 0.06,
      retrieved_at: "2026-11-25T00:00:00.000Z",
    });
    const nSales = i % 4;
    for (let s = 0; s < nSales; s++) {
      sales.push({
        parcel_id: id,
        seq: s + 1,
        sale_date: `${1995 + s * 8 + (i % 7)}-0${1 + (i % 8)}-15`,
        deed_type: "WD",
        stamp_amount: 2100,
        price: 300000 + s * 50000,
        qual_code: s % 2 ? "11" : "01",
      });
    }
    const m = mail[i % mail.length];
    owners.push({
      parcel_id: id,
      name_1: ownerNames[i % ownerNames.length],
      name_2: null,
      mail_line_1: "1 FIXTURE WAY",
      mail_line_2: m[1] ? null : "TORONTO ON M5V CANADA",
      mail_city: m[0],
      mail_state: m[1],
      mail_zip: m[2],
    });
  }
  await db.appendRows("stg_parcels", parcels);
  await db.appendRows("stg_sales", sales);
  await db.appendRows("stg_owner_raw", owners);

  // Permits: Fort Lauderdale-shaped roofing permits (open, long-open, completed), one unmatched, one needs_review.
  await db.run(`create or replace table stg_permits (permit_key VARCHAR, source_key VARCHAR, source_system VARCHAR, jurisdiction VARCHAR,
    permit_number VARCHAR, case_key VARCHAR, parcel_id VARCHAR, address VARCHAR, permit_type VARCHAR, permit_subtype VARCHAR, raw_status VARCHAR,
    description VARCHAR, application_date VARCHAR, issue_date VARCHAR, final_date VARCHAR, close_date VARCHAR, last_update_date VARCHAR,
    est_value DOUBLE, contractor_name VARCHAR, contractor_license VARCHAR, status VARCHAR, is_roofing BOOLEAN, roof_work_class VARCHAR,
    request_json VARCHAR, retrieved_at VARCHAR)`);
  const permits: Record<string, unknown>[] = [];
  const ftl = parcels.filter((p) => p.situs_city === "FORT LAUDERDALE");
  const spec: [string, string, string, string | null, string | null][] = [
    ["Re-Roof", "Issued", "REROOF SHINGLE AND FLAT 25 SQ", "2018-03-01", null],
    ["Re-Roof", "In Process", "RE-ROOF TILE 40 SQ", "2019-07-15", null],
    ["Re-Roof", "Complete", "REROOF SHINGLE 30 SQ", "2018-06-01", "2018-09-10"],
    ["Re-Roof", "Complete", "ROOF REPAIR 2 SQ", "2020-02-01", "2020-03-01"],
    ["Re-Roof", "About to Expire", "REROOF FLAT MOD BIT", "2020-11-20", null],
    ["Electrical", "Complete", "NEW SERVICE 200A", "2019-01-01", "2019-02-01"],
    ["Re-Roof", "Mystery Status", "REROOF", "2019-05-05", null],
  ];
  ftl.slice(0, 14).forEach((p, i) => {
    const [type, raw, desc, issued, final] = spec[i % spec.length];
    const key = `18HIS-00000-0F${String(100 + i)}`;
    const roof = /roof/i.test(type);
    const status =
      raw === "Complete"
        ? "completed"
        : raw === "Mystery Status"
          ? "needs_review"
          : type === "Electrical"
            ? "completed"
            : "open";
    permits.push({
      permit_key: `broward_ftl_arcgis_permits:${key}`,
      source_key: "ftl-permits",
      source_system: "broward_ftl_arcgis_permits",
      jurisdiction: "fort-lauderdale",
      permit_number: `BLD-${i}`,
      case_key: key,
      parcel_id: p.parcel_id,
      address: `${p.situs_number} ${p.situs_street}`,
      permit_type: type,
      permit_subtype: null,
      raw_status: raw,
      description: desc,
      application_date: issued,
      issue_date: issued,
      final_date: final,
      close_date: null,
      last_update_date: final,
      est_value: 15000,
      contractor_name: null,
      contractor_license: null,
      status,
      is_roofing: roof,
      roof_work_class: !roof
        ? "other"
        : /REPAIR/.test(desc)
          ? "repair_or_coating"
          : "primary_roof_replacement",
      request_json: JSON.stringify({
        method: "GET",
        url: FIXTURE_PERMIT_URL,
        multiValueQueryString: { where: [`CASEKEY='${key}'`] },
      }),
      retrieved_at: "2026-11-25T00:00:00.000Z",
    });
  });
  permits.push({
    ...permits[0],
    permit_key: "broward_ftl_arcgis_permits:UNMATCHED-1",
    case_key: "UNMATCHED-1",
    parcel_id: "999999999999",
  });
  await db.appendRows("stg_permits", permits);

  // Contractor evidence: Accela licensed professional → DBPR licensee row (fixture names).
  await db.run(`create or replace table stg_ftl_accela (case_key VARCHAR primary key, http_status INTEGER, record_status VARCHAR, licensed_professional VARCHAR,
    license_number VARCHAR, license_type VARCHAR, project_description VARCHAR, url VARCHAR, retrieved_at VARCHAR)`);
  await db.run(`insert into stg_ftl_accela values ('18HIS-00000-0F100', 200, 'Issued', 'JANE Q FIXTURE | FIXTURE ROOFING INC', 'CCC0000001', 'B - STATE - ROOF', 'REROOF SHINGLE AND FLAT 25 SQ', 'https://example.invalid/fixture/accela', '2026-11-25'),
    ('18HIS-00000-0F101', 200, 'In Process', 'JOHN FIXTURE', 'CCC0000002', 'B - STATE - ROOF', 'RE-ROOF TILE 40 SQ', 'https://example.invalid/fixture/accela', '2026-11-25')`);
  await db.run(`create or replace table stg_dbpr as select * from (values
    ('06','CCC','FIXTURE, JANE Q','FIXTURE ROOFING INC','','1 FIXTURE WAY','','','FORT LAUDERDALE','FL','33301','16','0000001','C','A','2010-01-01','2026-01-01','08/31/2028','','','CCC0000001','','2026-11-25'),
    ('06','CCC','FIXTURE, JOHN','','','2 FIXTURE WAY','','','DAVIE','FL','33314','16','0000002','C','A','2012-01-01','2026-01-01','08/31/2028','','','CCC0000002','','2026-11-25'))
    t(board, class_code, licensee_name, dba_name, unknown_5, addr_1, addr_2, addr_3, city, state, zip, county_code, license_number, primary_status,
      secondary_status, original_date, status_effective_date, expiry_date, unknown_19, unknown_20, license_id, unknown_22, retrieved_at)`);
}

/** Build the fixture run directory with the real CLI; returns the directory. */
export async function makeFixture(outDir: string, opts: { log?: (m: string) => void } = {}): Promise<string> {
  const log = opts.log ?? (() => {});
  const work = path.join(outDir, "..", ".fixture-work");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const db = await openWorkDb(":memory:");
  try {
    await seedFixtureStaging(db);
    await deriveAll(db, { asOf: FIXTURE_AS_OF, log });
    // Fixture provenance must never point at the real roll layer.
    const m = await loadLexiconManifest();
    const cli = createElephantCli();
    const runDir = path.join(work, "run");
    const county = await groupContext(m, "County");
    const pi = await groupContext(m, "Property Improvement");
    process.env.ORACLE_FIXTURE_PROVENANCE = FIXTURE_URL;
    await buildCountyGroup(db, path.join(runDir, "groups", "county"), county, { taxYear: 2025 });
    await buildPropertyImprovementGroup(db, path.join(runDir, "groups", "property_improvement"), pi);
    const groups = [];
    for (const g of ["county", "property_improvement"] as const) {
      const r = await buildGroup(g, path.join(runDir, "groups", g), path.join(runDir, "build"), cli, {
        partSize: PART_SIZE,
      });
      groups.push({
        group: g,
        archive_root: r.archiveRoot,
        tables_root: r.tablesRoot,
        properties: r.properties,
        tables: r.tables,
      });
      log(`fixture ${g}: ${r.properties} properties, archive ${r.archiveRoot}`);
    }
    await writeSupplement(db, runDir);
    const pc = await permitCoverage(db, { "ftl-permits": { status: "loaded" } });
    const geo = await db.all<{ geo_status: string; n: number }>(
      "select geo_status, count(*)::INTEGER n from drv_geo group by 1",
    );
    await mkdir(path.join(runDir, "meta"), { recursive: true });
    await writeFile(
      path.join(runDir, "meta", "coverage.json"),
      `${JSON.stringify({ schema: "oracle.coverage.v1", run_id: "fixture", fixture: true, geo_status: Object.fromEntries(geo.map((g) => [g.geo_status, g.n])), sources: [], permit_coverage: pc }, null, 2)}\n`,
    );
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    for (const d of ["tables", "supplement", "meta"])
      await cp(path.join(runDir, d), path.join(outDir, d), { recursive: true });
    await writeFile(
      path.join(outDir, "fixture-manifest.json"),
      `${JSON.stringify({ schema: "oracle.fixture.v1", synthetic: true, as_of: FIXTURE_AS_OF, elephant_cli: await cli.version(), groups, note: "Synthetic Broward-shaped records for tests and CRM development only. Never used in demos." }, null, 2)}\n`,
    );
    return outDir;
  } finally {
    await db.close();
    delete process.env.ORACLE_FIXTURE_PROVENANCE;
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const out = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, "fixtures", "elephant-mini"));
  makeFixture(out, { log: console.log }).then((d) => console.log(`fixture written to ${d}`));
}

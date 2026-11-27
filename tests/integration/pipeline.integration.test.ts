import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { computeDeltas } from "../../src/build/deltas.ts";
import { PATHS } from "../../src/config.ts";
import { writeDerived } from "../../src/query/derived.ts";
import { buildIndex } from "../../src/query/index-build.ts";
import { ROOFING_VIEW_COLUMNS } from "../../src/views/roofing-views.ts";
import { openWorkDb } from "../../src/work-db.ts";
import { makeFixture } from "../../scripts/make-fixture.ts";

const hasCli = existsSync(PATHS.elephantCli);

describe.skipIf(!hasCli)("integration: real elephant-cli on synthetic fixture", () => {
  test("fixture outputs validate with zero errors; same outputs → identical archive and tables roots; no-change deltas are zero", async () => {
    const a = await makeFixture(await mkdtemp(path.join(os.tmpdir(), "fx-a-")));
    const b = await makeFixture(await mkdtemp(path.join(os.tmpdir(), "fx-b-")));
    const ma = JSON.parse(await readFile(path.join(a, "fixture-manifest.json"), "utf8"));
    const mb = JSON.parse(await readFile(path.join(b, "fixture-manifest.json"), "utf8"));
    expect(ma.groups.map((g: any) => [g.archive_root, g.tables_root])).toEqual(
      mb.groups.map((g: any) => [g.archive_root, g.tables_root]),
    );
    expect(ma.groups.find((g: any) => g.group === "county").properties).toBe(50);
    for (const g of ["county", "property_improvement"]) {
      expect(await computeDeltas(path.join(a, "tables", g), path.join(b, "tables", g))).toMatchObject({
        added: 0,
        changed: 0,
        removed: 0,
      });
    }
    // Index + roofing views over the exported tables
    const out = await mkdtemp(path.join(os.tmpdir(), "fx-idx-"));
    const idx = await buildIndex(
      { runDir: a, asOf: "2026-11-25", runId: "fixture" },
      path.join(out, "index.duckdb"),
      { vectors: false },
    );
    expect(idx.views.v_property).toBe(50);
    const db = await openWorkDb(path.join(out, "index.duckdb"), { readOnly: true });
    for (const [view, cols] of Object.entries(ROOFING_VIEW_COLUMNS)) {
      const got = (await db.all<{ column_name: string }>(`select column_name from (describe ${view})`)).map(
        (c) => c.column_name,
      );
      expect(got).toEqual(expect.arrayContaining(cols));
    }
    // needs_review permits never get open_days; properties without geometry expose no coordinates
    expect(
      await db.one(
        "select count(*)::INTEGER n from v_roof_permit where status = 'needs_review' and open_days is not null",
      ),
    ).toEqual({ n: 0 });
    expect(
      await db.one(
        "select count(*)::INTEGER n from v_property where geo_status <> 'parcel_centroid' and lat is not null",
      ),
    ).toEqual({ n: 0 });
    // contractor comes from the DBPR record; a permit without a DBPR match has none
    const c = await db.all<any>(
      "select permit_key, contractor_name, contractor_company_cid from v_roof_permit where contractor_license is not null order by 1",
    );
    expect(c.map((r) => r.contractor_name)).toEqual(["FIXTURE ROOFING INC", "FIXTURE, JOHN"]);
    expect(c.every((r) => r.contractor_company_cid?.startsWith("bagu"))).toBe(true);
    // no individual owner names anywhere in the published tables
    expect(
      await db.one(
        "select count(*)::INTEGER n from v_owner where owner_type = 'person' and owner_name is not null",
      ),
    ).toEqual({ n: 0 });
    await db.close();
    const d = await writeDerived(path.join(out, "index.duckdb"), out);
    expect(d.files.map((f) => path.basename(f))).toEqual([
      "v_property.parquet",
      "v_roof_permit.parquet",
      "v_contractor.parquet",
      "v_business.parquet",
      "v_owner.parquet",
      "qd_structure.parquet",
      "qd_sales.parquet",
      "qd_tax.parquet",
      "qd_company.parquet",
      "aged-roofs.csv",
      "long-open-permits.csv",
      "contractors.csv",
    ]);
    const sample = await readFile(path.join(out, "samples", "long-open-permits.csv"), "utf8");
    expect(sample.split("\n")[0]).not.toMatch(/owner/);
  }, 300_000);
});

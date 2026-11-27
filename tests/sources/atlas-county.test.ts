import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { entityFromTableRow, loadAtlasCountySeed } from "../../src/sources/atlas-county.ts";
import { openWorkDb } from "../../src/work-db.ts";
import { cidFor } from "../helpers/cid.ts";

const REQ = {
  method: "GET",
  url: "https://services9.arcgis.com/x/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query",
  multiValueQueryString: { where: ["OBJECTID>=1 AND OBJECTID<3"] },
};

test("entityFromTableRow drops export-tables columns and nulls and parses the request", () => {
  const e = entityFromTableRow({
    parcel_identifier: "473725000010",
    request_identifier: "473725000010",
    source_http_request: JSON.stringify(REQ),
    city_name: null,
    cid: "baguqeera…",
    property_cid: "baguqeera…",
    data_group_cid: "bafkrei…",
  });
  expect(e).toEqual({
    requestIdentifier: "473725000010",
    sourceHttpRequest: REQ,
    data: { parcel_identifier: "473725000010" },
  });
  expect(() => entityFromTableRow({ parcel_identifier: "1" })).toThrow(/request_identifier/);
});

/** Publish two properties' Seed tables as Parquet and serve them as a fake Atlas + gateway. */
async function fakeAtlas(opts: { tamperTables?: boolean; shortPart?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-fake-"));
  const db = await openWorkDb(":memory:");
  const req = JSON.stringify(REQ).replace(/'/g, "''");
  await db.run(`copy (select * from (values
      ('111111111111', '111111111111', '${req}', 'bp1', 'P1', 'S'),
      ('222222222222', '222222222222', '${req}', 'bp2', 'P2', 'S'))
      t(parcel_identifier, request_identifier, source_http_request, cid, property_cid, data_group_cid))
    to '${dir}/parcel.parquet' (format parquet)`);
  await db.run(`copy (select * from (values
      ('1 A ST, X, FL', null, '111111111111', '${req}', 'ba1', 'P1', 'S'),
      ('2 B ST, X, FL', 'X', '222222222222', '${req}', 'ba2', 'P2', 'S'),
      ('MAILING 9 Z ST', null, '222222222222', '${req}', 'ba9', 'P2', 'S'))
      t(unnormalized_address, city_name, request_identifier, source_http_request, cid, property_cid, data_group_cid))
    to '${dir}/address.parquet' (format parquet)`);
  await db.run(`copy (select * from (values ('r1','ba1','bp1','P1','S'), ('r2','ba2','bp2','P2','S'))
      t(relationship_cid, from_cid, to_cid, property_cid, data_group_cid))
    to '${dir}/address_has_parcel.parquet' (format parquet)`);
  await db.close();
  const parts: Record<string, Buffer> = {};
  const tables: Record<string, unknown> = {};
  for (const [t, rows] of [
    ["parcel", 2],
    ["address", 3],
    ["address_has_parcel", 2],
  ] as const) {
    const body = await readFile(`${dir}/${t}.parquet`);
    const cid = `bafybei${t.replace(/_/g, "")}part`;
    parts[cid] = opts.shortPart && t === "address" ? body.subarray(1) : body;
    tables[t] = { rows, parts: [{ bytes: body.length, cid: { "/": cid }, rows }] };
  }
  const tablesBlock = Buffer.from(
    JSON.stringify({ label: "CountyTables", county_root: { "/": "bagcountyroot" }, tables }),
  );
  const tablesCid = cidFor([0xa9, 0x02], tablesBlock);
  const page = {
    county: "broward",
    state: "FL",
    fips: "12011",
    groups: { county: { cid: "bagcountyroot", schema: "bafkreischema", tables: tablesCid } },
  };
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("broward.json")) return new Response(JSON.stringify(page));
    const cid = /\/ipfs\/([a-z0-9]+)/.exec(url)?.[1] ?? "";
    if (cid === tablesCid)
      return new Response(opts.tamperTables ? Buffer.concat([tablesBlock, Buffer.from(" ")]) : tablesBlock);
    if (parts[cid]) return new Response(parts[cid]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { dir, fetchImpl };
}

test("loads one published Seed per parcel: its parcel row and the address the Seed links", async () => {
  const { dir, fetchImpl } = await fakeAtlas();
  const db = await openWorkDb(":memory:");
  const r = await loadAtlasCountySeed(db, {
    rawDir: dir,
    retrievedAt: "2026-11-27T00:00:00Z",
    pageUrl: "https://example.test/broward.json",
    gateways: ["https://gw.test"],
    fetchImpl,
  });
  expect(r.status).toBe("loaded");
  expect(r.records).toBe(2);
  expect(r.atlas.county_root).toBe("bagcountyroot");
  const rows = await db.all<{ parcel_id: string; property_cid: string; address_row: string }>(
    "select parcel_id, property_cid, address_row from ref_atlas_seed order by 1",
  );
  expect(rows.map((x) => [x.parcel_id, x.property_cid])).toEqual([
    ["111111111111", "P1"],
    ["222222222222", "P2"],
  ]);
  // The Seed address of P2 is its site address, not its mailing address.
  expect(entityFromTableRow(JSON.parse(rows[1].address_row)).data).toEqual({
    unnormalized_address: "2 B ST, X, FL",
    city_name: "X",
  });
  await db.close();
});

test("a CountyTables block that does not hash to its CID, or a short part, stops the load", async () => {
  for (const opt of [{ tamperTables: true }, { shortPart: true }]) {
    const { dir, fetchImpl } = await fakeAtlas(opt);
    const db = await openWorkDb(":memory:");
    await expect(
      loadAtlasCountySeed(db, {
        rawDir: dir,
        retrievedAt: "2026-11-27T00:00:00Z",
        pageUrl: "https://example.test/broward.json",
        gateways: ["https://gw.test"],
        fetchImpl,
      }),
    ).rejects.toThrow(opt.tamperTables ? /does not hash/ : /bytes, CountyTables records/);
    await db.close();
  }
});

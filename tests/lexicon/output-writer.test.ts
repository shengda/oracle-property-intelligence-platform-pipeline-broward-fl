import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  propertyOutputFiles,
  writePropertyOutput,
  type GroupContext,
  type PropertyOutput,
} from "../../src/lexicon/output-writer.ts";
import { readZip } from "../../src/util/zip.ts";

const ctx: GroupContext = {
  seedCid: "bafkreiseed",
  groupCid: "bafkreicounty",
  cardinality: { property_has_address: "one", property_has_sales_history: "many" },
};
const req = {
  method: "GET" as const,
  url: "https://example.invalid/fixture/query",
  multiValueQueryString: { where: ["FOLIO='1'"] },
};
const e = (file: string, className: string, data: Record<string, unknown> = {}) => ({
  file,
  className,
  requestIdentifier: "1",
  sourceHttpRequest: req,
  data,
});
const p: PropertyOutput = {
  parcelId: "000000000001",
  groupTitle: "County",
  entities: [
    e("parcel.json", "parcel"),
    e("address.json", "address"),
    e("property.json", "property"),
    e("sales_history_1.json", "sales_history"),
    e("sales_history_2.json", "sales_history"),
  ],
  relationships: [
    { key: "property_has_address", file: "rel_pa.json", from: "property.json", to: "address.json" },
    {
      key: "property_has_sales_history",
      file: "rel_s1.json",
      from: "property.json",
      to: "sales_history_1.json",
    },
    {
      key: "property_has_sales_history",
      file: "rel_s2.json",
      from: "property.json",
      to: "sales_history_2.json",
    },
  ],
};

test("writer rejects an entity without source_http_request", () => {
  expect(() =>
    propertyOutputFiles(
      {
        ...p,
        entities: [...p.entities.slice(0, 2), { ...p.entities[2], sourceHttpRequest: undefined as any }],
      },
      ctx,
    ),
  ).toThrow(/source_http_request/);
});

test("writer rejects auth headers or a query string in provenance", () => {
  const bad = { ...p.entities[2], sourceHttpRequest: { ...req, headers: { authorization: "x" } } as any };
  expect(() =>
    propertyOutputFiles({ ...p, entities: [...p.entities.slice(0, 2), bad, ...p.entities.slice(3)] }, ctx),
  ).toThrow(/headers/);
  const qs = {
    ...p.entities[2],
    sourceHttpRequest: { method: "GET", url: "https://x.invalid/a?token=1" } as any,
  };
  expect(() =>
    propertyOutputFiles({ ...p, entities: [...p.entities.slice(0, 2), qs, ...p.entities.slice(3)] }, ctx),
  ).toThrow(/query string/);
});

test("writer rejects an unreferenced entity (validate's 'Unused data JSON file')", () => {
  expect(() =>
    propertyOutputFiles({ ...p, entities: [...p.entities, e("tax_2025.json", "tax")] }, ctx),
  ).toThrow(/not referenced/);
});

test("writer output contains seed root and group root with array cardinality", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ow-"));
  const zip = await writePropertyOutput(dir, p, ctx);
  const files = Object.fromEntries(
    readZip(await readFile(zip)).map((f) => [f.name, JSON.parse(f.data.toString())]),
  );
  expect(files["bafkreiseed.json"]).toEqual({
    label: "Seed",
    relationships: { address_has_parcel: { "/": "./address_has_parcel.json" } },
  });
  expect(files["bafkreicounty.json"].label).toBe("County");
  expect(files["bafkreicounty.json"].relationships.property_has_address).toEqual({ "/": "./rel_pa.json" });
  expect(files["bafkreicounty.json"].relationships.property_has_sales_history).toHaveLength(2);
  expect(files["property.json"].source_http_request).toEqual(req);
  expect(files["property.json"].request_identifier).toBe("1");
});

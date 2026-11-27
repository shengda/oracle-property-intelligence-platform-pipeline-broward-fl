import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SourceHttpRequest } from "../types.ts";
import { buildZip } from "../util/zip.ts";
import { dataGroupCid, loadSchema, type LexiconManifest } from "./manifest.ts";

/** One Lexicon class instance, written as `<file>` inside the property output. */
export interface LexiconEntity {
  /** File name inside the property output, e.g. `property.json`, `tax_2025.json`. */
  file: string;
  className: string;
  requestIdentifier: string;
  sourceHttpRequest: SourceHttpRequest;
  data: Record<string, unknown>;
}

/** A relationship placed in a data-group root under `key`, linking two entity files. */
export interface LexiconRelationship {
  key: string;
  file: string;
  from: string;
  to: string;
}

export interface PropertyOutput {
  parcelId: string;
  /** Data-group title from the Lexicon ("County", "Property Improvement"). */
  groupTitle: string;
  entities: LexiconEntity[];
  relationships: LexiconRelationship[];
}

/** Relationship cardinality per data group, read from the live data-group schema. */
export interface GroupContext {
  seedCid: string;
  groupCid: string;
  /** relationship key → "one" | "many" */
  cardinality: Record<string, "one" | "many">;
}

export async function groupContext(m: LexiconManifest, groupTitle: string): Promise<GroupContext> {
  const schemaName = groupTitle.replace(/ /g, "_");
  const schema = await loadSchema(m, schemaName);
  const cardinality: Record<string, "one" | "many"> = {};
  for (const [k, v] of Object.entries<any>(schema.properties.relationships.properties)) {
    const t = v.type;
    cardinality[k] = t === "array" || (Array.isArray(t) && t.includes("array")) ? "many" : "one";
  }
  return { seedCid: dataGroupCid(m, "Seed"), groupCid: dataGroupCid(m, groupTitle), cardinality };
}

const FORBIDDEN_REQUEST_KEYS = ["headers", "cookies", "cookie", "authorization", "token"];

export function assertProvenance(e: LexiconEntity): void {
  const req = e.sourceHttpRequest as SourceHttpRequest | undefined;
  if (!req || typeof req !== "object" || !req.url || !req.method) {
    throw new Error(`entity ${e.file} has no source_http_request`);
  }
  for (const k of Object.keys(req)) {
    if (FORBIDDEN_REQUEST_KEYS.includes(k.toLowerCase())) {
      throw new Error(`entity ${e.file} source_http_request carries auth/header field '${k}'`);
    }
  }
  if (/[?&](token|key|apikey|access_token)=/i.test(req.url) || req.url.includes("?")) {
    throw new Error(`entity ${e.file} source_http_request.url must not carry a query string or credentials`);
  }
  for (const k of Object.keys(req.multiValueQueryString ?? {})) {
    if (/token|apikey|api_key|password|secret/i.test(k)) {
      throw new Error(`entity ${e.file} source_http_request carries credential parameter '${k}'`);
    }
  }
  if (!e.requestIdentifier) throw new Error(`entity ${e.file} has no request_identifier`);
}

/** Compact JSON; `hash` canonicalizes every file, so whitespace never changes a CID. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Build the files of one property output: seed root + group root + entities + relationships. */
export function propertyOutputFiles(p: PropertyOutput, ctx: GroupContext): { name: string; data: string }[] {
  const files = new Map<string, string>();
  const entityFiles = new Set<string>();
  for (const e of p.entities) {
    assertProvenance(e);
    if (files.has(e.file)) throw new Error(`duplicate entity file ${e.file} in ${p.parcelId}`);
    const body: Record<string, unknown> = {
      ...e.data,
      source_http_request: e.sourceHttpRequest,
      request_identifier: e.requestIdentifier,
    };
    files.set(e.file, canonicalJson(body));
    entityFiles.add(e.file);
  }
  for (const req of ["address.json", "parcel.json"]) {
    if (!entityFiles.has(req)) throw new Error(`property ${p.parcelId} lacks seed entity ${req}`);
  }
  // Seed data group: address → parcel.
  files.set(
    "address_has_parcel.json",
    canonicalJson({ from: { "/": "./address.json" }, to: { "/": "./parcel.json" } }),
  );
  files.set(
    `${ctx.seedCid}.json`,
    canonicalJson({
      label: "Seed",
      relationships: { address_has_parcel: { "/": "./address_has_parcel.json" } },
    }),
  );
  const used = new Set<string>(["address.json", "parcel.json"]);
  const rels: Record<string, unknown> = {};
  for (const r of p.relationships) {
    if (!entityFiles.has(r.from) || !entityFiles.has(r.to)) {
      throw new Error(`relationship ${r.file} in ${p.parcelId} links a missing entity (${r.from} → ${r.to})`);
    }
    const card = ctx.cardinality[r.key];
    if (!card) throw new Error(`relationship key ${r.key} is not in the ${p.groupTitle} data group`);
    if (files.has(r.file)) throw new Error(`duplicate relationship file ${r.file}`);
    files.set(r.file, canonicalJson({ from: { "/": `./${r.from}` }, to: { "/": `./${r.to}` } }));
    const link = { "/": `./${r.file}` };
    if (card === "many") {
      const arr = (rels[r.key] as unknown[]) ?? [];
      arr.push(link);
      rels[r.key] = arr;
    } else {
      if (rels[r.key]) throw new Error(`relationship ${r.key} allows one link in ${p.parcelId}`);
      rels[r.key] = link;
    }
    used.add(r.from);
    used.add(r.to);
  }
  for (const f of entityFiles) {
    if (!used.has(f)) throw new Error(`entity ${f} in ${p.parcelId} is not referenced by any relationship`);
  }
  // Stable key order inside the root.
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(rels).sort()) ordered[k] = rels[k];
  files.set(`${ctx.groupCid}.json`, canonicalJson({ label: p.groupTitle, relationships: ordered }));
  return [...files.entries()].map(([name, data]) => ({ name, data }));
}

/** Write one property output as `<groupDir>/<parcelId>.zip` (flat layout, deterministic bytes). */
export async function writePropertyOutput(
  groupDir: string,
  p: PropertyOutput,
  ctx: GroupContext,
): Promise<string> {
  const files = propertyOutputFiles(p, ctx);
  await mkdir(groupDir, { recursive: true });
  const out = path.join(groupDir, `${p.parcelId}.zip`);
  await writeFile(out, buildZip(files));
  return out;
}

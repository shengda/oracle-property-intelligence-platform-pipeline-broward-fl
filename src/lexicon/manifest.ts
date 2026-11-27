import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LEXICON_MANIFEST_URL, PATHS } from "../config.ts";
import { fetchJson } from "../util/http.ts";

export type LexiconManifest = Record<
  string,
  { ipfsCid: string; type: "class" | "relationship" | "dataGroup" }
>;

const SCHEMA_GATEWAYS = ["https://ipfs.filebase.io", "https://ipfs.io", "https://dweb.link"];

export async function loadLexiconManifest(url = LEXICON_MANIFEST_URL): Promise<LexiconManifest> {
  const cachePath = path.join(PATHS.cache, "lexicon", "manifest.json");
  try {
    const m = await fetchJson<LexiconManifest>(url, { retries: 2, timeoutMs: 30_000 });
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(m));
    return m;
  } catch (err) {
    try {
      return JSON.parse(await readFile(cachePath, "utf8")) as LexiconManifest;
    } catch {
      throw err;
    }
  }
}

/** Data-group schema CID by its title ("Seed", "County", "Property Improvement"). */
export function dataGroupCid(m: LexiconManifest, title: string): string {
  const key = title.replace(/ /g, "_");
  const entry = m[key];
  if (!entry || entry.type !== "dataGroup") throw new Error(`data group ${title} not in Lexicon manifest`);
  return entry.ipfsCid;
}

export async function loadSchema(m: LexiconManifest, name: string): Promise<any> {
  const entry = m[name];
  if (!entry) throw new Error(`${name} not in Lexicon manifest`);
  const cachePath = path.join(PATHS.cache, "lexicon", `${entry.ipfsCid}.json`);
  try {
    return JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    /* fetch below */
  }
  let lastErr: unknown;
  for (const gw of SCHEMA_GATEWAYS) {
    try {
      const schema = await fetchJson(`${gw}/ipfs/${entry.ipfsCid}`, { retries: 1, timeoutMs: 30_000 });
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(schema));
      return schema;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Field names of a Lexicon class (for the address class: the union of its `oneOf` branches). */
export async function classFields(m: LexiconManifest, className: string): Promise<string[]> {
  const s = await loadSchema(m, className);
  const props = new Set<string>(Object.keys(s.properties ?? {}));
  for (const branch of s.oneOf ?? []) for (const k of Object.keys(branch.properties ?? {})) props.add(k);
  return [...props].sort();
}

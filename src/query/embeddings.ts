import path from "node:path";
import { PATHS } from "../config.ts";
import type { WorkDb } from "../work-db.ts";
import type { Queryable } from "./sql-guard.ts";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

type Embedder = (texts: string[]) => Promise<number[][]>;

let cached: Embedder | null = null;

/** Local sentence embeddings (transformers.js, quantized MiniLM); the model is cached under cache/models. */
export async function getEmbedder(): Promise<Embedder> {
  if (cached) return cached;
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = path.join(PATHS.cache, "models");
  const fe = await pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" });
  cached = async (texts: string[]) => {
    const out = await fe(texts, { pooling: "mean", normalize: true });
    return out.tolist() as number[][];
  };
  return cached;
}

/**
 * Vector index over permit descriptions and contractor/business summaries only (keeps the file
 * small). Distinct texts are embedded once; documents point at their text. HNSW (cosine) via vss.
 */
export async function buildVectorIndex(
  db: WorkDb,
  opts: { log?: (m: string) => void; embedder?: Embedder } = {},
): Promise<{ docs: number; model: string | null; status: "built" | "skipped"; reason?: string }> {
  let embed: Embedder;
  try {
    embed = opts.embedder ?? (await getEmbedder());
  } catch (err) {
    return {
      docs: 0,
      model: null,
      status: "skipped",
      reason: `embedding model unavailable: ${(err as Error).message}`,
    };
  }
  await db.run(`create or replace table vec_docs as
    select 'permit:' || permit_key as doc_id, 'permit' as kind, permit_key as ref, parcel_identifier,
      trim(concat_ws(' — ', permit_type, description)) as text
    from sp_permit_details where coalesce(description, permit_type) is not null
    union all
    select 'contractor:' || dbpr_license_id, 'contractor', dbpr_license_id, null,
      concat_ws(' — ', contractor_name, 'licensed contractor', license_class, city) from sp_contractors`);
  const texts = await db.all<{ text: string }>(
    "select distinct text from vec_docs where text is not null and text <> '' order by text",
  );
  await db.run(
    `create or replace table vec_texts (text VARCHAR primary key, embedding FLOAT[${EMBEDDING_DIM}])`,
  );
  const batch = 64;
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch).map((t) => t.text);
    const vecs = await embed(slice);
    const values: unknown[] = [];
    const ph: string[] = [];
    slice.forEach((t, j) => {
      values.push(t);
      ph.push(`(?, [${vecs[j].map((x) => x.toFixed(6)).join(",")}]::FLOAT[${EMBEDDING_DIM}])`);
    });
    await db.run(`insert into vec_texts values ${ph.join(",")}`, values as never);
    if ((i / batch) % 50 === 0)
      opts.log?.(`index: embedded ${Math.min(i + batch, texts.length)}/${texts.length} distinct texts`);
  }
  await db.run("set hnsw_enable_experimental_persistence = true");
  await db.run(
    "create index if not exists vec_texts_hnsw on vec_texts using hnsw (embedding) with (metric = 'cosine')",
  );
  const n = await db.one<{ n: number }>("select count(*)::INTEGER n from vec_docs");
  opts.log?.(`index: vector index over ${n?.n ?? 0} documents (${texts.length} distinct texts)`);
  return { docs: n?.n ?? 0, model: EMBEDDING_MODEL, status: "built" };
}

/** Cosine-nearest documents for a query text (used by searchRecords in M2 and by the QA check). */
export async function semanticSearch(
  db: Queryable,
  query: string,
  limit = 10,
  embedder?: Embedder,
): Promise<{ doc_id: string; kind: string; ref: string; text: string; score: number }[]> {
  const embed = embedder ?? (await getEmbedder());
  const [v] = await embed([query]);
  const vec = `[${v.map((x) => x.toFixed(6)).join(",")}]::FLOAT[${EMBEDDING_DIM}]`;
  return db.all(`with t as (
      select text, array_cosine_similarity(embedding, ${vec}) as score from vec_texts
      order by array_cosine_distance(embedding, ${vec}) limit ${Math.max(1, limit * 5)})
    select d.doc_id, d.kind, d.ref, d.text, t.score from t join vec_docs d using (text)
    order by t.score desc, d.doc_id limit ${limit}`);
}

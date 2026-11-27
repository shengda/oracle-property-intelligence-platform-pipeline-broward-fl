import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

/** An IPFS pinning provider that stores files as UnixFS (CIDv1, raw leaves, 256 KiB chunks). */
export interface Pinner {
  readonly provider: string;
  /** Adds and pins one file; returns its CID. Idempotent: the same bytes give the same CID. */
  addFile(file: string, name: string): Promise<{ cid: string; size: number }>;
  /** True when the provider already pins `cid` (lets a later run skip re-uploading a file). */
  has?(cid: string): Promise<boolean>;
}

type FetchImpl = typeof fetch;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Retries transient failures (network, 429, 5xx) with exponential backoff; 4xx otherwise fail. */
async function withRetry<T>(
  what: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const status = (err as ProviderError).status;
      const transient = status === undefined || status === 429 || status >= 500;
      if (!transient || i === attempts) break;
      await sleep(1000 * 2 ** (i - 1));
    }
  }
  throw new ProviderError(`${what}: ${(last as Error).message}`, (last as ProviderError).status);
}

async function fileForm(file: string, name: string): Promise<FormData> {
  const form = new FormData();
  form.append("file", await openAsBlob(file), name);
  return form;
}

/** Bearer token of Filebase's Kubo RPC: base64("<key>:<secret>:<bucket>"). */
export function filebaseToken(env: Record<string, string | undefined>): string {
  const { FILEBASE_ACCESS_KEY: k, FILEBASE_SECRET_KEY: s, FILEBASE_BUCKET: b } = env;
  if (!k || !s || !b) {
    throw new Error("FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY and FILEBASE_BUCKET must be set in .env");
  }
  return Buffer.from(`${k}:${s}:${b}`).toString("base64");
}

export const FILEBASE_RPC = "https://rpc.filebase.io";

/**
 * Filebase through its Kubo RPC (`/api/v0/add`, which pins every upload). The same RPC is what
 * `elephant-cli upload --api https://rpc.filebase.io` imports archives and tables into.
 */
export function filebasePinner(
  env: Record<string, string | undefined>,
  opts: { api?: string; fetchImpl?: FetchImpl; sleep?: (ms: number) => Promise<void> } = {},
): Pinner {
  const token = filebaseToken(env);
  const api = opts.api ?? FILEBASE_RPC;
  const f = opts.fetchImpl ?? fetch;
  return {
    provider: "filebase",
    async addFile(file, name) {
      const size = (await stat(file)).size;
      return withRetry(
        `filebase add ${name}`,
        async () => {
          const res = await f(`${api}/api/v0/add?cid-version=1&raw-leaves=true`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: await fileForm(file, path.basename(name)),
            signal: AbortSignal.timeout(30 * 60_000),
          });
          const text = await res.text();
          if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
          const last = text.trim().split("\n").at(-1) ?? "";
          const cid = (JSON.parse(last) as { Hash?: string }).Hash;
          if (!cid) throw new ProviderError(`no CID in response: ${text.slice(0, 300)}`);
          return { cid, size };
        },
        { sleep: opts.sleep },
      );
    },
  };
}

export const PINATA_API = "https://api.pinata.cloud";
export const PINATA_UPLOADS = "https://uploads.pinata.cloud";

/**
 * Pinata (free plan): files only. Pin-by-CID and CAR imports are paid features (refused with
 * 403 on 2026-11-27), so the second copy of each Lexicon DAG is its `.car` file, which anyone can
 * re-import. A file already on the account (same CID) is not uploaded again.
 */
export function pinataPinner(
  env: Record<string, string | undefined>,
  opts: { fetchImpl?: FetchImpl; sleep?: (ms: number) => Promise<void> } = {},
): Pinner {
  const token = env.SECOND_PINNER_TOKEN;
  if (!token) throw new Error("SECOND_PINNER_TOKEN must be set in .env");
  const f = opts.fetchImpl ?? fetch;
  const auth = { authorization: `Bearer ${token}` };
  async function has(cid: string): Promise<boolean> {
    const res = await f(`${PINATA_API}/v3/files/public?cid=${cid}&limit=1`, {
      headers: auth,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status} listing files`, res.status);
    const body = (await res.json()) as { data?: { files?: { cid: string }[] } };
    return (body.data?.files ?? []).some((x) => x.cid === cid);
  }
  return {
    provider: "pinata",
    async addFile(file, name) {
      const size = (await stat(file)).size;
      return withRetry(
        `pinata upload ${name}`,
        async () => {
          const form = await fileForm(file, path.basename(name));
          form.append("network", "public");
          form.append("name", name);
          const res = await f(`${PINATA_UPLOADS}/v3/files`, {
            method: "POST",
            headers: auth,
            body: form,
            signal: AbortSignal.timeout(30 * 60_000),
          });
          const text = await res.text();
          if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
          const cid = (JSON.parse(text) as { data?: { cid?: string } }).data?.cid;
          if (!cid) throw new ProviderError(`no CID in response: ${text.slice(0, 300)}`);
          return { cid, size };
        },
        { sleep: opts.sleep },
      );
    },
    has,
  };
}

/** The second provider named by `SECOND_PINNER` (only `pinata` is implemented). */
export function secondPinnerFromEnv(
  env: Record<string, string | undefined>,
  opts: { fetchImpl?: FetchImpl; sleep?: (ms: number) => Promise<void> } = {},
): Pinner {
  const name = (env.SECOND_PINNER ?? "").trim().toLowerCase();
  if (name === "pinata") return pinataPinner(env, opts);
  throw new Error(`SECOND_PINNER '${env.SECOND_PINNER ?? ""}' is not supported (use 'pinata')`);
}

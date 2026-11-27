import { USER_AGENT } from "../config.ts";

export class SourceBlockedError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly blockerType: string,
  ) {
    super(`source blocked (${blockerType}, HTTP ${status}) at ${url}`);
  }
}

export interface FetchStats {
  requests: number;
  totalMs: number;
  bytes: number;
}

export function newStats(): FetchStats {
  return { requests: 0, totalMs: 0, bytes: 0 };
}

const lastRequestAt = new Map<string, number>();

/** Enforce a minimum delay between requests to the same host. */
async function politeWait(url: string, minDelayMs: number): Promise<void> {
  const host = new URL(url).host;
  const last = lastRequestAt.get(host) ?? 0;
  const wait = last + minDelayMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt.set(host, Date.now());
}

function looksChallenged(status: number, body: string): string | null {
  if (status === 403) return "http_403";
  if (status === 429) return null; // retryable
  if (/cf-chl|challenge-platform|Just a moment\.\.\./i.test(body)) return "cloudflare_challenge";
  if (/g-recaptcha|hcaptcha/i.test(body)) return "captcha";
  return null;
}

/**
 * GET with retries, backoff and per-host politeness. Stops (throws SourceBlockedError) on 403,
 * captcha or challenge pages — never retries around an access boundary.
 */
export async function politeFetch(
  url: string,
  opts: {
    minDelayMs?: number;
    retries?: number;
    timeoutMs?: number;
    stats?: FetchStats;
    accept?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ status: number; body: Buffer; contentType: string | null }> {
  const { minDelayMs = 500, retries = 4, timeoutMs = 120_000, stats, fetchImpl = fetch } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await politeWait(url, minDelayMs);
    const started = Date.now();
    try {
      const res = await fetchImpl(url, {
        headers: { "user-agent": USER_AGENT, accept: opts.accept ?? "*/*" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      const body = Buffer.from(await res.arrayBuffer());
      if (stats) {
        stats.requests++;
        stats.totalMs += Date.now() - started;
        stats.bytes += body.length;
      }
      const blocker = looksChallenged(res.status, body.subarray(0, 4096).toString("utf8"));
      if (blocker) throw new SourceBlockedError(url, res.status, blocker);
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status} at ${url}`);
      } else {
        return { status: res.status, body, contentType: res.headers.get("content-type") };
      }
    } catch (err) {
      if (err instanceof SourceBlockedError) throw err;
      lastErr = err;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T = any>(
  url: string,
  opts: Parameters<typeof politeFetch>[1] = {},
): Promise<T> {
  const res = await politeFetch(url, { ...opts, accept: "application/json" });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} at ${url}`);
  return JSON.parse(res.body.toString("utf8")) as T;
}

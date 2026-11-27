import type { SourceRunResult } from "../types.ts";
import { newStats, politeFetch, SourceBlockedError } from "../util/http.ts";
import { BBB_ROOFING_CATEGORY_URL } from "./registry.ts";

/**
 * Bounded BBB probe (kit `bbb-harvest` step 2): one category request. HTTP 403 is a source-access
 * boundary: stop, record it, never retry around it.
 */
export async function probeBbb(): Promise<SourceRunResult> {
  const startedAt = new Date().toISOString();
  const stats = newStats();
  try {
    const res = await politeFetch(BBB_ROOFING_CATEGORY_URL, { retries: 0, stats, minDelayMs: 2000 });
    return {
      key: "bbb",
      status: "partial",
      records: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      requests: stats.requests,
      limitation: `Category page answered HTTP ${res.status}; profile harvest not run (bounded probe only).`,
    };
  } catch (err) {
    const b = err instanceof SourceBlockedError ? err : null;
    return {
      key: "bbb",
      status: "blocked",
      records: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      requests: stats.requests || 1,
      blockerType: b?.blockerType ?? "network_error",
      limitation: `BBB returned ${b ? `HTTP ${b.status} (${b.blockerType})` : (err as Error).message} on the first category request; stopped per the kit rule. No BBB ratings in this run; use the official BBB API for scores.`,
    };
  }
}

/**
 * Sunbiz quarterly corporate data sits behind the Division of Corporations SFTP portal (login)
 * and a Cloudflare-challenged web host; the expanded archive is ~18 GB. Probe only.
 */
export async function probeSunbiz(opts: { freeDiskGb: number }): Promise<SourceRunResult> {
  const startedAt = new Date().toISOString();
  const stats = newStats();
  let status = 0;
  try {
    const res = await politeFetch("https://sftp.floridados.gov", { retries: 0, stats, minDelayMs: 0 });
    status = res.status;
  } catch (err) {
    status = err instanceof SourceBlockedError ? err.status : -1;
  }
  return {
    key: "sunbiz",
    status: "blocked",
    records: 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    requests: stats.requests || 1,
    blockerType: status === 401 ? "login_required" : `http_${status}`,
    estimate: { size: "~1.7 GB zipped, ~18 GB expanded", time: "5–30 min download + expand" },
    limitation: `Sunbiz cordata.zip is served from the SFTP portal (HTTP ${status} without a login) and needs ~20 GB of free disk (operator machine: ${opts.freeDiskGb} GB free). Not loaded this run; business records come from BCPA company owners and DBPR contractor companies.`,
  };
}

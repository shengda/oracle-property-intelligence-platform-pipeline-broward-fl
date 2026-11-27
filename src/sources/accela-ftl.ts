import type { SourceRunResult } from "../types.ts";
import { newStats, politeFetch, SourceBlockedError } from "../util/http.ts";
import type { WorkDb } from "../work-db.ts";

export const FTL_ACCELA_DETAIL = "https://aca-prod.accela.com/FTL/Cap/CapDetail.aspx";

function decode(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ");
}

export interface AccelaDetail {
  recordStatus: string | null;
  licensedProfessional: string | null;
  licenseNumber: string | null;
  licenseType: string | null;
  projectDescription: string | null;
}

/** Parse the public Accela CapDetail page: licensed professional block, license number and status. */
export function parseAccelaDetail(html: string): AccelaDetail {
  let status: string | null = null;
  const si = html.indexOf("Record Status:");
  if (si >= 0) {
    const t = decode(html.slice(si + "Record Status:".length, si + 600))
      .replace(/\s+/g, " ")
      .trim();
    status = t.split(/ Expiration Date:| Record Type| Opened| Licensed| \|/)[0].trim() || null;
  }
  let lp: string | null = null;
  let licenseNumber: string | null = null;
  let licenseType: string | null = null;
  const i = html.indexOf("Licensed Professional:");
  if (i >= 0) {
    const end = html.indexOf("Project Description:", i);
    const block = decode(html.slice(i + "Licensed Professional:".length, end > i ? end : i + 3000));
    const text = block.replace(/\s*\n\s*/g, "\n").trim();
    lp =
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" | ") || null;
    const m = /\b([A-Z]{2,4}\d{5,8})\b/.exec(text.replace(/\s+/g, " "));
    if (m) licenseNumber = m[1];
    const t = /([A-Z] - [A-Z ]+ - [A-Z ]+?)\s+[A-Z]{2,4}\d{5,8}/.exec(text.replace(/\s+/g, " "));
    if (t) licenseType = t[1].trim();
  }
  let desc: string | null = null;
  const j = html.indexOf("Project Description:");
  if (j >= 0) {
    const block = decode(html.slice(j + "Project Description:".length, j + 1500));
    desc =
      block
        .split(/Owner:|More Details/)[0]
        .replace(/\s+/g, " ")
        .trim() || null;
  }
  return {
    recordStatus: status,
    licensedProfessional: lp,
    licenseNumber,
    licenseType,
    projectDescription: desc,
  };
}

/**
 * Bounded Fort Lauderdale contractor lookup (architecture §3.7 exception): only open roofing
 * permits without a contractor, one request at a time with a 1.5 s per-host delay, stops at
 * `maxRequests` and on any 403/captcha. Resumable: permits already looked up are skipped.
 */
export async function enrichFtlContractors(
  db: WorkDb,
  opts: { maxRequests: number; retrievedAt: string; minDelayMs?: number; log?: (m: string) => void },
): Promise<SourceRunResult> {
  const startedAt = new Date().toISOString();
  await db.run(`create table if not exists stg_ftl_accela (case_key VARCHAR primary key, http_status INTEGER,
    record_status VARCHAR, licensed_professional VARCHAR, license_number VARCHAR, license_type VARCHAR,
    project_description VARCHAR, url VARCHAR, retrieved_at VARCHAR)`);
  const todo = await db.all<{ case_key: string }>(`select distinct p.case_key from stg_permits p
    left join stg_ftl_accela a on a.case_key = p.case_key
    where p.source_key = 'ftl-permits' and p.is_roofing and p.status = 'open' and p.contractor_name is null
      and p.case_key is not null and a.case_key is null
    order by p.case_key limit ${Math.max(0, opts.maxRequests)}`);
  const stats = newStats();
  let done = 0;
  let blocker: string | undefined;
  for (const { case_key } of todo) {
    const parts = case_key.split("-");
    if (parts.length !== 3) continue;
    const url = `${FTL_ACCELA_DETAIL}?Module=Permits&TabName=Permits&capID1=${parts[0]}&capID2=${parts[1]}&capID3=${parts[2]}&agencyCode=FTL`;
    try {
      const res = await politeFetch(url, {
        minDelayMs: opts.minDelayMs ?? 1500,
        retries: 2,
        stats,
        timeoutMs: 60_000,
      });
      const d = res.status === 200 ? parseAccelaDetail(res.body.toString("utf8")) : null;
      await db.run(`insert or replace into stg_ftl_accela values (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        case_key,
        res.status,
        d?.recordStatus ?? null,
        d?.licensedProfessional ?? null,
        d?.licenseNumber ?? null,
        d?.licenseType ?? null,
        d?.projectDescription ?? null,
        url,
        opts.retrievedAt,
      ]);
      done++;
      if (done % 100 === 0) opts.log?.(`ftl-accela-contractors: ${done}/${todo.length}`);
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        blocker = err.blockerType;
        break;
      }
      // transient failure for one permit: record and continue
      await db.run(
        `insert or replace into stg_ftl_accela (case_key, http_status, url, retrieved_at) values (?, ?, ?, ?)`,
        [case_key, -1, url, opts.retrievedAt],
      );
    }
  }
  const total = await db.one<{ n: number; lic: number }>(
    `select count(*)::INTEGER n, count(license_number)::INTEGER lic from stg_ftl_accela`,
  );
  return {
    key: "ftl-accela-contractors",
    status: blocker ? "blocked" : todo.length >= opts.maxRequests ? "partial" : "loaded",
    records: total?.n ?? 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    requests: stats.requests,
    avgLatencyMs: stats.requests ? Math.round(stats.totalMs / stats.requests) : undefined,
    blockerType: blocker,
    limitation: blocker
      ? `Stopped on ${blocker}; remaining permits not looked up.`
      : `Bounded to open Fort Lauderdale roofing permits (${total?.lic ?? 0} with a license number).`,
  };
}

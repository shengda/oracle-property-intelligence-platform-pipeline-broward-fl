import path from "node:path";
import { classifyRoofWork, normalizePermitStatus } from "../classify/permits.ts";
import type { SourceRunResult } from "../types.ts";
import { newStats, SourceBlockedError } from "../util/http.ts";
import type { WorkDb } from "../work-db.ts";
import { arcgisCount, arcgisRecordRequest, downloadArcgisLayer } from "./arcgis.ts";
import {
  FTL_PERMITS_LAYER,
  HCED_PERMITS_LAYER,
  WESTON_CLOSED_LAYER,
  WESTON_ISSUED_LAYER,
} from "./registry.ts";

/** Field map from a permit layer onto the unified `stg_permits` columns. */
export interface PermitFieldMap {
  oid: string;
  permitNumber: string;
  caseKey?: string;
  parcelId?: string;
  address?: string;
  type: string;
  subType?: string;
  status: string;
  description?: string;
  applicationDate?: string;
  issueDate?: string;
  finalDate?: string;
  closeDate?: string;
  lastUpdate?: string;
  value?: string;
  contractorName?: string;
  contractorLicense?: string;
}

export interface PermitFeed {
  key: string;
  sourceSystem: string;
  jurisdiction: string;
  layerUrl: string;
  fieldMap: PermitFieldMap;
  /** Field used for the per-record provenance filter. */
  idField: string;
}

export const PERMIT_FEEDS: PermitFeed[] = [
  {
    key: "ftl-permits",
    sourceSystem: "broward_ftl_arcgis_permits",
    jurisdiction: "fort-lauderdale",
    layerUrl: FTL_PERMITS_LAYER,
    idField: "CASEKEY",
    fieldMap: {
      oid: "OBJECTID",
      permitNumber: "PERMITID",
      caseKey: "CASEKEY",
      parcelId: "PARCELID",
      address: "FULLADDR",
      type: "PERMITTYPE",
      status: "PERMITSTAT",
      description: "PERMITDESC",
      applicationDate: "SUBMITDT",
      issueDate: "APPROVEDT",
      finalDate: "COISSUE",
      lastUpdate: "LASTUPDATEDATE",
      value: "ESTCOST",
      contractorName: "CONTRACTOR",
      contractorLicense: "CONTRACTID",
    },
  },
  {
    key: "weston-permits-issued",
    sourceSystem: "broward_weston_accela_permits",
    jurisdiction: "weston",
    layerUrl: WESTON_ISSUED_LAYER,
    idField: "PermitNo",
    fieldMap: {
      oid: "OBJECTID",
      permitNumber: "PermitNo",
      parcelId: "ParcelNo",
      address: "JobAddress",
      type: "JobType",
      subType: "JobSubCategory",
      status: "CurrentStatus",
      description: "JobDesc",
      issueDate: "IssuedDate",
      value: "JobValue",
    },
  },
  {
    key: "weston-permits-closed",
    sourceSystem: "broward_weston_accela_permits",
    jurisdiction: "weston",
    layerUrl: WESTON_CLOSED_LAYER,
    idField: "PermitNo",
    fieldMap: {
      oid: "OBJECTID",
      permitNumber: "PermitNo",
      parcelId: "ParcelNo",
      address: "JobAddress",
      type: "JobType",
      subType: "JobSubCategory",
      status: "CurrentStatus",
      description: "JobDesc",
      closeDate: "ClosedDate",
      value: "JobValue",
    },
  },
  {
    key: "hced-permits",
    sourceSystem: "broward_hced_posse_permits",
    jurisdiction: "unincorporated-broward",
    layerUrl: HCED_PERMITS_LAYER,
    idField: "OBJECTID",
    fieldMap: { oid: "OBJECTID", permitNumber: "PERMITNO", type: "PERMITTYPE", status: "STATUS" },
  },
];

const PERMIT_COLUMNS = `permit_key VARCHAR, source_key VARCHAR, source_system VARCHAR, jurisdiction VARCHAR,
  permit_number VARCHAR, case_key VARCHAR, parcel_id VARCHAR, address VARCHAR, permit_type VARCHAR,
  permit_subtype VARCHAR, raw_status VARCHAR, description VARCHAR, application_date VARCHAR, issue_date VARCHAR,
  final_date VARCHAR, close_date VARCHAR, last_update_date VARCHAR, est_value DOUBLE, contractor_name VARCHAR,
  contractor_license VARCHAR, status VARCHAR, is_roofing BOOLEAN, roof_work_class VARCHAR, request_json VARCHAR,
  retrieved_at VARCHAR`;

export async function ensurePermitTable(db: WorkDb): Promise<void> {
  await db.run(`create table if not exists stg_permits (${PERMIT_COLUMNS})`);
}

function isoDate(ms: unknown): string | null {
  if (ms === null || ms === undefined || ms === "") return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1900) return null;
  return d.toISOString().slice(0, 10);
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s : null;
}

/** Download one permit feed and replace its rows in `stg_permits`. A 403 stops the source. */
export async function loadPermitFeed(
  db: WorkDb,
  feed: PermitFeed,
  opts: { rawDir: string; retrievedAt: string; log?: (m: string) => void },
): Promise<SourceRunResult> {
  const startedAt = new Date().toISOString();
  const stats = newStats();
  await ensurePermitTable(db);
  const rawPath = path.join(
    opts.rawDir,
    feed.key,
    opts.retrievedAt.replace(/[:.]/g, "-"),
    "features.ndjson.gz",
  );
  try {
    await arcgisCount(feed.layerUrl, "1=1", stats);
    const fm = feed.fieldMap;
    const outFields = Object.values(fm).filter(Boolean) as string[];
    const res = await downloadArcgisLayer({
      layerUrl: feed.layerUrl,
      oidField: fm.oid,
      outFields,
      pageSize: 1000,
      outPath: rawPath,
      minDelayMs: 500,
      stats,
    });
    // Stage: parse NDJSON in Node (small feeds) and apply the field map + classifiers.
    const { createReadStream } = await import("node:fs");
    const { createGunzip } = await import("node:zlib");
    const readline = await import("node:readline");
    const rows: Record<string, unknown>[] = [];
    const rl = readline.createInterface({ input: createReadStream(rawPath).pipe(createGunzip()) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const a = JSON.parse(line).attributes as Record<string, unknown>;
      const permitNumber = str(a[fm.permitNumber]);
      const caseKey = fm.caseKey ? str(a[fm.caseKey]) : null;
      const idValue = str(a[feed.idField]);
      const type = str(a[fm.type]);
      const description = fm.description ? str(a[fm.description]) : null;
      const subType = fm.subType ? str(a[fm.subType]) : null;
      const rawStatus = str(a[fm.status]);
      const roof = classifyRoofWork({ type: `${type ?? ""} ${subType ?? ""}`.trim(), description });
      const parcel = fm.parcelId
        ? str(a[fm.parcelId])
            ?.replace(/[^0-9A-Z]/gi, "")
            .toUpperCase()
        : null;
      rows.push({
        permit_key: `${feed.sourceSystem}:${caseKey ?? permitNumber ?? idValue}`,
        source_key: feed.key,
        source_system: feed.sourceSystem,
        jurisdiction: feed.jurisdiction,
        permit_number: permitNumber,
        case_key: caseKey,
        parcel_id: parcel && parcel.length === 12 ? parcel : null,
        address: fm.address ? str(a[fm.address]) : null,
        permit_type: type,
        permit_subtype: subType,
        raw_status: rawStatus,
        description,
        application_date: fm.applicationDate ? isoDate(a[fm.applicationDate]) : null,
        issue_date: fm.issueDate ? isoDate(a[fm.issueDate]) : null,
        final_date: fm.finalDate ? isoDate(a[fm.finalDate]) : null,
        close_date: fm.closeDate ? isoDate(a[fm.closeDate]) : null,
        last_update_date: fm.lastUpdate ? isoDate(a[fm.lastUpdate]) : null,
        est_value: fm.value && a[fm.value] !== null && a[fm.value] !== undefined ? Number(a[fm.value]) : null,
        contractor_name: fm.contractorName ? str(a[fm.contractorName]) : null,
        contractor_license: fm.contractorLicense ? str(a[fm.contractorLicense]) : null,
        status: normalizePermitStatus(rawStatus),
        is_roofing: roof.isRoofing,
        roof_work_class: roof.roofWorkClass,
        request_json: JSON.stringify(arcgisRecordRequest(feed.layerUrl, `${feed.idField}='${idValue}'`)),
        retrieved_at: opts.retrievedAt,
      });
    }
    await db.run(`delete from stg_permits where source_key = ?`, [feed.key]);
    await db.appendRows("stg_permits", rows);
    opts.log?.(`${feed.key}: ${rows.length} permits`);
    return {
      key: feed.key,
      status: "loaded",
      records: res.records,
      startedAt,
      finishedAt: new Date().toISOString(),
      requests: stats.requests,
      avgLatencyMs: stats.requests ? Math.round(stats.totalMs / stats.requests) : undefined,
      bytes: stats.bytes,
      sha256: res.sha256,
      rawPath,
    };
  } catch (err) {
    const blocked = err instanceof SourceBlockedError;
    return {
      key: feed.key,
      status: "blocked",
      records: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      requests: stats.requests,
      blockerType: blocked ? (err as SourceBlockedError).blockerType : "server_error",
      limitation: `Not loaded: ${(err as Error).message.slice(0, 240)}. Stopped without retrying around the boundary.`,
    };
  }
}

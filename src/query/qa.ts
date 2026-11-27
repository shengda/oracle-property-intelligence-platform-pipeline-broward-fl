import { readFile } from "node:fs/promises";
import path from "node:path";
import { openWorkDb, type WorkDb } from "../work-db.ts";
import { semanticSearch } from "./embeddings.ts";

export type QaStatus = "pass" | "warn" | "fail";

export interface QaCheck {
  id: string;
  group:
    | "coverage_scale"
    | "duplicates_reconciliation"
    | "coordinates"
    | "permits"
    | "roof_age"
    | "contractor_bbb"
    | "occupancy_owner"
    | "pii"
    | "identity"
    | "index";
  title: string;
  value: unknown;
  threshold: string;
  status: QaStatus;
  detail?: string;
}

export interface QaReport {
  schema: "oracle.qa.v1";
  run_id: string;
  generated_at: string;
  status: QaStatus;
  counts: Record<QaStatus, number>;
  checks: QaCheck[];
  spot_check: {
    parcel_identifier: string;
    address: string | null;
    source_url: string | null;
    appraiser_url: string;
  }[];
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10000) / 100 : 0);
function grade(value: number, passAt: number, warnAt: number, higherIsBetter = true): QaStatus {
  if (higherIsBetter) return value >= passAt ? "pass" : value >= warnAt ? "warn" : "fail";
  return value <= passAt ? "pass" : value <= warnAt ? "warn" : "fail";
}

async function scalar(db: WorkDb, sql: string): Promise<number> {
  const r = await db.one<{ n: number }>(sql);
  return Number(r?.n ?? 0);
}

/**
 * Data-quality report: the M2 review input, the publish gate and a published `kind: meta` artifact.
 * The PII check reports counts and status only, never the values found.
 */
export async function qaReport(opts: {
  indexPath: string;
  runDir: string;
  runId: string;
  workDbPath: string;
}): Promise<QaReport> {
  const checks: QaCheck[] = [];
  const add = (c: QaCheck) => checks.push(c);
  const coverage = JSON.parse(await readFile(path.join(opts.runDir, "meta", "coverage.json"), "utf8"));
  const db = await openWorkDb(opts.indexPath, { readOnly: true });
  const work = await openWorkDb(opts.workDbPath, { readOnly: true });
  try {
    await db.run("load fts; load vss;").catch(() => {});
    // --- coverage & scale
    const props = await scalar(db, "select count(*)::INTEGER n from lx_county_property");
    const rollParcels = await scalar(work, "select count(*)::INTEGER n from stg_parcels");
    // The raw roll table exists for real runs; the synthetic fixture stages parcels directly.
    const hasRaw =
      (await scalar(
        work,
        "select count(*)::INTEGER n from information_schema.tables where table_name = 'stg_bcpa_raw'",
      )) > 0;
    const rollRows = hasRaw
      ? await scalar(work, "select count(*)::INTEGER n from stg_bcpa_raw")
      : rollParcels;
    const diff = rollParcels ? Math.abs(props - rollParcels) / rollParcels : 1;
    add({
      id: "property_count_vs_roll",
      group: "coverage_scale",
      title: "County properties vs distinct valid folios in the BCPA roll",
      value: {
        properties: props,
        roll_parcels: rollParcels,
        roll_rows: rollRows,
        diff_pct: Math.round(diff * 10000) / 100,
      },
      threshold: "pass ≤ 0.5 % difference, warn ≤ 2 %, else fail",
      status: diff <= 0.005 ? "pass" : diff <= 0.02 ? "warn" : "fail",
      detail: `${rollRows - rollParcels} roll rows merged (polygon parts sharing one folio) or skipped (invalid id).`,
    });
    const invalid = hasRaw
      ? await scalar(
          work,
          "select count(*)::INTEGER n from stg_bcpa_raw where not regexp_full_match(trim(coalesce(FOLIO,'')), '[0-9A-Z]{12}')",
        )
      : 0;
    add({
      id: "invalid_parcel_ids",
      group: "coverage_scale",
      title: "Roll rows without a valid 12-character folio (skipped, reason invalid_parcel_id)",
      value: invalid,
      threshold: "pass ≤ 0.5 % of roll rows, warn ≤ 2 %",
      status: grade(pct(invalid, rollRows), 0.5, 2, false),
    });

    // --- duplicates & reconciliation
    const dupParcels = await scalar(
      db,
      "select (count(*) - count(distinct parcel_identifier))::INTEGER n from lx_county_property",
    );
    add({
      id: "duplicate_parcel_keys",
      group: "duplicates_reconciliation",
      title: "Duplicate parcel_identifier in the county group",
      value: dupParcels,
      threshold: "0",
      status: dupParcels === 0 ? "pass" : "fail",
    });
    const dupPermits = await scalar(
      db,
      "select (count(*) - count(distinct permit_key))::INTEGER n from sp_permit_details",
    );
    add({
      id: "duplicate_permit_keys",
      group: "duplicates_reconciliation",
      title: "Duplicate permit keys after source reconciliation",
      value: dupPermits,
      threshold: "0",
      status: dupPermits === 0 ? "pass" : "fail",
    });
    const dupPi = await scalar(
      db,
      "select (count(*) - count(distinct request_identifier))::INTEGER n from lx_property_improvement_property_improvement",
    );
    add({
      id: "duplicate_property_improvements",
      group: "duplicates_reconciliation",
      title: "Permits published more than once in property_improvement",
      value: dupPi,
      threshold: "0",
      status: dupPi === 0 ? "pass" : "fail",
    });
    const companyNames = await scalar(db, "select count(distinct name)::INTEGER n from lx_county_company");
    const companyCids = await scalar(db, "select count(distinct cid)::INTEGER n from lx_county_company");
    add({
      id: "company_owner_dedupe",
      group: "duplicates_reconciliation",
      title: "Company owners: distinct names vs distinct company CIDs (same name + mailing → one CID)",
      value: { names: companyNames, cids: companyCids },
      threshold: "informational; CIDs ≥ names (same name with different mailing addresses stays distinct)",
      status: "pass",
    });

    // --- coordinates
    const geo = coverage.geo_status ?? {};
    const total = Object.values<number>(geo).reduce((a, b) => a + b, 0);
    const withGeo = Number(geo.parcel_centroid ?? 0);
    add({
      id: "geometry_share",
      group: "coordinates",
      title: "Parcels with a centroid inside the Census county polygon",
      value: {
        parcel_centroid: withGeo,
        missing_geometry: geo.missing_geometry ?? 0,
        outside_county: geo.outside_county ?? 0,
        share_pct: pct(withGeo, total),
      },
      threshold: "pass ≥ 99 %, warn ≥ 95 %",
      status: grade(pct(withGeo, total), 99, 95),
    });
    const radiusRows = await scalar(
      db,
      "select count(*)::INTEGER n from v_property where lat is not null and geo_status <> 'parcel_centroid'",
    );
    add({
      id: "radius_excludes_missing_geometry",
      group: "coordinates",
      title: "Properties without usable geometry exposing coordinates",
      value: radiusRows,
      threshold: "0",
      status: radiusRows === 0 ? "pass" : "fail",
    });

    // --- permits
    const permitTotal = await scalar(db, "select count(*)::INTEGER n from sp_permit_details");
    const statusDist = await db.all<{ status: string; n: number }>(
      "select status, count(*)::INTEGER n from sp_permit_details group by 1 order by 2 desc",
    );
    const needsReview = statusDist.find((s) => s.status === "needs_review")?.n ?? 0;
    add({
      id: "permit_status_distribution",
      group: "permits",
      title: "Normalized permit status distribution (needs_review never appears in long-open results)",
      value: Object.fromEntries(statusDist.map((s) => [s.status, s.n])),
      threshold: "needs_review: pass ≤ 2 %, warn ≤ 5 %",
      status: grade(pct(needsReview, permitTotal), 2, 5, false),
    });
    const openDist =
      await db.one<any>(`select count(*) filter (where open_days is not null)::INTEGER with_open_days,
      count(*) filter (where status = 'open' and open_days is null)::INTEGER open_without_date,
      count(*) filter (where status <> 'open' and open_days is not null)::INTEGER non_open_with_days,
      quantile_cont(open_days, 0.5) filter (where open_days is not null) median_open_days,
      count(*) filter (where open_days >= 5 * 365)::INTEGER open_5y_plus
      from sp_permit_details`);
    add({
      id: "permit_open_days",
      group: "permits",
      title: "open_days set only for open permits with an issue/application date",
      value: openDist,
      threshold: "non_open_with_days = 0",
      status: Number(openDist?.non_open_with_days ?? 0) === 0 ? "pass" : "fail",
    });
    const matched = await scalar(
      db,
      "select count(*)::INTEGER n from sp_permit_details where parcel_matched",
    );
    const byMethod = Object.fromEntries(
      (
        await db.all<{ m: string; n: number }>(
          `select coalesce(parcel_match_method, 'unmatched') m, count(*)::INTEGER n
             from sp_permit_details where parcel_matched or parcel_match_method is null group by 1 order by 1`,
        )
      ).map((r) => [r.m, r.n]),
    );
    add({
      id: "permit_parcel_match_rate",
      group: "permits",
      title:
        "Permits linked to a roll parcel by folio, else by a unique street address (unmatched are counted, not published)",
      value: { matched, total: permitTotal, share_pct: pct(matched, permitTotal), by_method: byMethod },
      threshold: "pass ≥ 95 %, warn ≥ 85 %",
      status: grade(pct(matched, permitTotal), 95, 85),
    });
    const pc = (coverage.permit_coverage ?? []) as any[];
    const coveredParcels = pc.filter((j) => j.status === "covered").reduce((n, j) => n + j.parcels, 0);
    const allParcels = pc.reduce((n, j) => n + j.parcels, 0);
    add({
      id: "permit_jurisdiction_coverage",
      group: "permits",
      title: "Share of parcels in jurisdictions with loaded permit data",
      value: {
        covered: pc.filter((j) => j.status === "covered").map((j) => j.jurisdiction),
        blocked: pc.filter((j) => j.status === "blocked").length,
        skipped: pc.filter((j) => j.status === "skipped").length,
        parcels_covered_pct: pct(coveredParcels, allParcels),
      },
      threshold: "warn (documented limitation, architecture §3.7 skip rule), never fail",
      status: "warn",
      detail:
        "Municipal portals skipped (too_slow) or blocked; elsewhere roof age falls back to year built and open-permit queries return nothing.",
    });
    const pi = coverage.groups?.property_improvement;
    if (pi) {
      const ids = pi.published_property_cids as { properties: number; missing: number } | undefined;
      const atlas = pi.seed_source === "atlas";
      add({
        id: "permit_group_extends_published_county",
        group: "permits",
        title:
          "property_improvement properties carry the Seed of the published Atlas county archive (same property CIDs)",
        value: {
          seed_source: pi.seed_source ?? "own",
          atlas_county_root: pi.atlas_county_root ?? null,
          properties: ids?.properties ?? pi.properties,
          not_in_published_archive: ids?.missing ?? null,
          left_out: pi.without_published_seed ?? null,
        },
        threshold: "pass: seed_source atlas and 0 property CIDs outside the published archive; else fail",
        status: atlas && ids && ids.missing === 0 ? "pass" : "fail",
        detail: atlas
          ? `${pi.without_published_seed?.parcels ?? 0} permitted parcels (${pi.without_published_seed?.permits ?? 0} permits) are not in the published county archive and are left out of the group; they stay in the query views.`
          : "Built with our own Seeds (atlas-county not ingested): the group cannot be registered next to the published county archive.",
      });
    }

    // Every CID the Oracle hands out must resolve: property CIDs come from the published archive.
    const ident = await db.one<{ prop_identity: string | null; total: number; with_cid: number }>(
      `select (select any_value(property_identity) from index_meta) prop_identity, count(*)::INTEGER total,
         count(property_cid)::INTEGER with_cid from v_property`,
    );
    if (ident) {
      add({
        id: "property_cids_published",
        group: "identity",
        title: "Property CIDs in the views are those of the published county archive",
        value: {
          property_identity: ident.prop_identity,
          properties: ident.total,
          with_published_cid: ident.with_cid,
          without_cid: ident.total - ident.with_cid,
        },
        threshold:
          "pass: identity atlas (CIDs of the published archive; parcels it lacks get none); warn: local identity (CIDs of this run's unpublished county archive)",
        status: ident.prop_identity === "atlas" ? "pass" : "warn",
        detail:
          ident.prop_identity === "atlas"
            ? `${ident.total - ident.with_cid} parcels of this run's roll are not in the published county archive; their property_cid is null.`
            : "No published Seed loaded (oracle ingest --source atlas-county): property CIDs are this run's own and resolve only if its county archive is published.",
      });
    }

    // --- roof age
    const basis = await db.all<{ b: string; n: number }>(
      "select coalesce(roof_age_basis, 'unknown') b, count(*)::INTEGER n from v_property group by 1 order by 2 desc",
    );
    const unknownRoof = basis.find((b) => b.b === "unknown")?.n ?? 0;
    add({
      id: "roof_age_basis_mix",
      group: "roof_age",
      title: "Roof-age basis mix (permit vs year built vs unknown)",
      value: Object.fromEntries(basis.map((b) => [b.b, b.n])),
      threshold: "unknown: pass ≤ 15 %, warn ≤ 30 %",
      status: grade(pct(unknownRoof, props), 15, 30, false),
      detail:
        "Unknown = no building on the roll (vacant land, common elements) and no completed roof permit.",
    });
    const repairReset = await scalar(
      db,
      `select count(*)::INTEGER n from sp_property_signals s join sp_permit_details d on d.permit_key = s.roof_age_permit_key
       where d.roof_work_class not in ('primary_roof_replacement', 'primary_roof_new_construction')`,
    );
    add({
      id: "roof_age_repairs_never_reset",
      group: "roof_age",
      title: "Roof ages anchored on a repair/coating/accessory permit",
      value: repairReset,
      threshold: "0",
      status: repairReset === 0 ? "pass" : "fail",
    });

    // --- contractor / BBB
    const openFtlRoof = await scalar(
      db,
      "select count(*)::INTEGER n from sp_permit_details where source_system = 'broward_ftl_arcgis_permits' and is_roofing and status = 'open'",
    );
    const withLicense = await scalar(
      db,
      "select count(*)::INTEGER n from sp_permit_details where source_system = 'broward_ftl_arcgis_permits' and is_roofing and status = 'open' and contractor_license is not null",
    );
    const withDbpr = await scalar(
      db,
      "select count(*)::INTEGER n from sp_permit_details where source_system = 'broward_ftl_arcgis_permits' and is_roofing and status = 'open' and dbpr_license_id is not null",
    );
    add({
      id: "contractor_link_rate",
      group: "contractor_bbb",
      title:
        "Open Fort Lauderdale roofing permits with a licensed contractor (Accela) resolved to a DBPR record",
      value: {
        open_roofing_permits: openFtlRoof,
        with_license_number: withLicense,
        dbpr_resolved: withDbpr,
        dbpr_share_pct: pct(withDbpr, openFtlRoof),
      },
      threshold: "pass ≥ 60 %, warn ≥ 25 %",
      status: grade(pct(withDbpr, openFtlRoof), 60, 25),
    });
    const bbbLinked = await scalar(
      db,
      "select count(*)::INTEGER n from v_contractor where bbb_rating is not null",
    );
    const bbbSource = (coverage.sources as any[]).find((s) => s.key === "bbb");
    add({
      id: "bbb_link_rate",
      group: "contractor_bbb",
      title: "Contractors with a BBB rating",
      value: { linked: bbbLinked, source_status: bbbSource?.status ?? "not_run" },
      threshold: "warn when the BBB source is blocked (documented); never fail",
      status: bbbLinked > 0 ? "pass" : "warn",
      detail: bbbSource?.limitation ?? undefined,
    });

    // --- occupancy / owner
    const occ = await db.all<{ c: string; n: number }>(
      "select coalesce(occupancy_class, 'unknown') c, count(*)::INTEGER n from v_property group by 1 order by 2 desc",
    );
    const occUnknown = occ.find((o) => o.c === "unknown")?.n ?? 0;
    add({
      id: "occupancy_mix",
      group: "occupancy_owner",
      title: "Occupancy class mix",
      value: Object.fromEntries(occ.map((o) => [o.c, o.n])),
      threshold: "unknown: pass ≤ 10 %, warn ≤ 25 %",
      status: grade(pct(occUnknown, props), 10, 25, false),
    });
    const loc = await db.all<{ c: string; n: number }>(
      "select coalesce(owner_location_class, 'unknown') c, count(*)::INTEGER n from v_property group by 1 order by 2 desc",
    );
    const locUnknown = loc.find((o) => o.c === "unknown")?.n ?? 0;
    add({
      id: "owner_location_mix",
      group: "occupancy_owner",
      title: "Owner mailing-location class mix",
      value: Object.fromEntries(loc.map((o) => [o.c, o.n])),
      threshold: "unknown: pass ≤ 10 %, warn ≤ 25 %",
      status: grade(pct(locUnknown, props), 10, 25, false),
    });

    // --- PII (counts and status only)
    const personTables = await scalar(
      db,
      "select count(*)::INTEGER n from information_schema.tables where table_name = 'lx_county_person'",
    );
    const personRows = personTables
      ? await scalar(db, "select count(*)::INTEGER n from lx_county_person")
      : 0;
    const names = await work.all<{ name: string }>(`select distinct name_1 as name from stg_owner_raw
      where name_1 is not null and length(name_1) >= 8 order by hash(name_1) limit 20000`);
    const { classifyOwnerType } = await import("../classify/owners.ts");
    const personNames = names
      .map((n) => n.name)
      .filter((n) => classifyOwnerType(n) === "person")
      .slice(0, 5000);
    let hits = 0;
    const probed = personNames.length;
    if (probed) {
      // The index is opened read-only (no temp tables): probe with a VALUES list.
      const values = personNames.map((n) => `('${n.replace(/'/g, "''")}')`).join(",");
      hits = await scalar(
        db,
        `with probe(name) as (values ${values})
         select count(*)::INTEGER n from probe
         where name in (select name from lx_county_company)
            or name in (select upper(unnormalized_address) from lx_county_address)
            or name in (select upper(coalesce(owner_name, '')) from v_owner)
            or name in (select upper(coalesce(text, '')) from fts_docs)`,
      );
    }
    add({
      id: "pii_owner_names",
      group: "pii",
      title: "Individual owner names in published columns (Open Q3 default: none)",
      value: {
        person_entities_in_county_group: personRows,
        probed_person_owner_names: probed,
        matches: hits,
      },
      threshold: "0 person entities and 0 matches",
      status: personRows === 0 && hits === 0 ? "pass" : "fail",
      detail: "Counts only; matched values are never written to this report.",
    });

    // --- index
    const vec = await scalar(
      db,
      "select count(*)::INTEGER n from information_schema.tables where table_name = 'vec_texts'",
    );
    let semantic: QaStatus = "warn";
    let semanticDetail = "vector index not built";
    if (vec) {
      try {
        const hitsSem = await semanticSearch(db, "replace roof shingles", 5);
        const roofHit = hitsSem.some((h) => /roof/i.test(h.text));
        semantic = roofHit ? "pass" : "warn";
        semanticDetail = `top hit: ${hitsSem[0]?.text ?? "none"}`;
      } catch (err) {
        semanticDetail = (err as Error).message;
      }
    }
    add({
      id: "semantic_search_smoke",
      group: "index",
      title: "Semantic search finds re-roof permits for 'replace roof shingles'",
      value: semanticDetail,
      threshold: "a roofing permit in the top 5",
      status: semantic,
    });

    const spot = await db.all<{
      parcel_identifier: string;
      address: string | null;
      source_url: string | null;
    }>(
      "select parcel_identifier, address, source_url from v_property order by hash(parcel_identifier || 'spot') limit 20",
    );
    const counts = { pass: 0, warn: 0, fail: 0 } as Record<QaStatus, number>;
    for (const c of checks) counts[c.status]++;
    return {
      schema: "oracle.qa.v1",
      run_id: opts.runId,
      generated_at: new Date().toISOString(),
      status: counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass",
      counts,
      checks,
      spot_check: spot.map((s) => ({
        ...s,
        appraiser_url: `https://web.bcpa.net/BcpaClient/#/Record-Search?folio=${s.parcel_identifier}`,
      })),
    };
  } finally {
    await db.close();
    await work.close();
  }
}

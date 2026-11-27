import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { runDir } from "../config.ts";
import { createElephantCli } from "../elephant/cli.ts";
import { fetchManifest } from "../query/sync.ts";
import {
  type Manifest,
  ManifestSchema,
  type RunHistory,
  RunHistorySchema,
  type VerificationReport,
} from "./manifest.ts";
import { FILEBASE_RPC, filebasePinner, filebaseToken, secondPinnerFromEnv } from "./providers.ts";
import { importCar } from "./tables-dag.ts";
import { historyEntry, publishHistory, publishRun, type PublishRecord } from "./publish-run.ts";
import { gatewaysFromEnv, verifyManifest } from "./verify.ts";

async function readJsonIf<T>(file: string): Promise<T | null> {
  return existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as T) : null;
}

/** The publish record of a local run (`runs/<id>/publish/publish.json`), or null. */
export function readPublishRecord(dir: string): Promise<PublishRecord | null> {
  return readJsonIf<PublishRecord>(path.join(dir, "publish", "publish.json"));
}

/**
 * The run this one chains onto: the nearest earlier run in `previous_run_id` order that was
 * published (an unpublished run in between is skipped, it has no manifest).
 */
async function previousPublished(dir: string): Promise<{ runDir: string; record: PublishRecord } | null> {
  let state = await readJsonIf<{ previous_run_id: string | null }>(path.join(dir, "meta", "state.json"));
  const seen = new Set<string>();
  while (state?.previous_run_id && !seen.has(state.previous_run_id)) {
    seen.add(state.previous_run_id);
    const prev = runDir(state.previous_run_id);
    const record = await readPublishRecord(prev);
    if (record) return { runDir: prev, record };
    state = await readJsonIf(path.join(prev, "meta", "state.json"));
  }
  return null;
}

/**
 * `oracle publish --run <id>`: publish (both providers), verify on public gateways, append the run
 * to the run history and publish that. The verification result is recorded even when it fails.
 */
export async function publishCommand(opts: {
  runId: string;
  force?: boolean;
  /** Reuse a manifest an interrupted publish of this run already pinned (skip the uploads). */
  resume?: boolean;
  gateways?: string[];
  log?: (m: string) => void;
}): Promise<{ record: PublishRecord; manifest: Manifest; verification: VerificationReport }> {
  const log = opts.log ?? console.log;
  const dir = runDir(opts.runId);
  const env = process.env;
  const primary = filebasePinner(env);
  const second = secondPinnerFromEnv(env);
  const prev = await previousPublished(dir);
  const previousManifestCid = prev?.record.manifest_cid ?? null;
  log(`publish ${opts.runId}: chains to ${previousManifestCid ?? "nothing (first published run)"}`);

  const resumed = opts.resume ? await existingManifest(dir, previousManifestCid) : null;
  if (opts.resume && !resumed) log(`publish ${opts.runId}: nothing to resume; publishing from the start`);
  const { manifest, manifestCid } =
    resumed ??
    (await publishRun(
      { runDir: dir, previousManifestCid, force: opts.force },
      {
        cli: createElephantCli(),
        primary,
        second,
        log,
        dagImport: (car) => importCar(car, { api: FILEBASE_RPC, token: filebaseToken(env) }),
        primaryGateway: "https://ipfs.filebase.io",
      },
    ));
  log(`publish ${opts.runId}: manifest ${manifestCid}${resumed ? " (resumed: already published)" : ""}`);

  const state = JSON.parse(await readFile(path.join(dir, "meta", "state.json"), "utf8"));
  const dagBlocks = Object.fromEntries(
    (state.groups ?? []).map((g: any) => [g.archiveRoot, g.blocks] as [string, number]),
  );
  const gateways = opts.gateways ?? gatewaysFromEnv();
  log(`publish ${opts.runId}: verifying on ${gateways.join(", ")}`);
  const verification = await verifyManifest(manifest, { manifestCid, dagBlocks, gateways, log });
  await writeFile(
    path.join(dir, "publish", "verification.json"),
    `${JSON.stringify(verification, null, 2)}\n`,
  );

  const prior = prev
    ? await readJsonIf<RunHistory>(path.join(prev.runDir, "publish", "run-history.json"))
    : null;
  const entry = await historyEntry(dir, manifest, manifestCid, verification);
  const { historyCid } = await publishHistory(dir, prior ? RunHistorySchema.parse(prior) : null, entry, {
    primary,
    second,
    log,
  });
  const record: PublishRecord = {
    run_id: opts.runId,
    manifest_cid: manifestCid,
    history_cid: historyCid,
    published_at: manifest.created_at,
    verification_ok: verification.ok,
    qa_overridden: manifest.qa.overridden,
  };
  await writeFile(path.join(dir, "publish", "publish.json"), `${JSON.stringify(record, null, 2)}\n`);
  return { record, manifest, verification };
}

/**
 * The manifest an interrupted publish of this run already wrote and pinned (it is pinned last,
 * after every DAG and file). Its CID is computed from its bytes; verification then fetches it by
 * that CID, so a manifest that never reached the providers fails there.
 */
async function existingManifest(
  dir: string,
  previousManifestCid: string | null,
): Promise<{ manifest: Manifest; manifestCid: string } | null> {
  const file = path.join(dir, "publish", "manifest.json");
  if (!existsSync(file)) return null;
  const bytes = await readFile(file);
  const manifest = ManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (manifest.previous_manifest_cid !== previousManifestCid) {
    throw new Error(
      `publish/manifest.json chains to ${manifest.previous_manifest_cid}, the previous published run is ${previousManifestCid}; publish without --resume`,
    );
  }
  const manifestCid = CID.create(1, 0x55, await sha256.digest(bytes)).toString();
  return { manifest, manifestCid };
}

/** `oracle verify`: a manifest by CID (fetched and checked) or a local published run. */
export async function verifyCommand(opts: {
  manifestCid?: string;
  runId?: string;
  quick?: boolean;
  gateways?: string[];
  log?: (m: string) => void;
}): Promise<VerificationReport> {
  const gateways = opts.gateways ?? gatewaysFromEnv();
  let manifestCid = opts.manifestCid;
  let manifest: Manifest;
  let dagBlocks: Record<string, number> | undefined;
  if (!manifestCid) {
    if (!opts.runId) throw new Error("verify needs --manifest <cid> or --run <id>");
    const dir = runDir(opts.runId);
    const rec = await readPublishRecord(dir);
    if (!rec) throw new Error(`run ${opts.runId} is not published`);
    manifestCid = rec.manifest_cid;
    manifest = ManifestSchema.parse(
      JSON.parse(await readFile(path.join(dir, "publish", "manifest.json"), "utf8")),
    );
    const state = JSON.parse(await readFile(path.join(dir, "meta", "state.json"), "utf8"));
    dagBlocks = Object.fromEntries((state.groups ?? []).map((g: any) => [g.archiveRoot, g.blocks]));
  } else {
    manifest = await fetchManifest(manifestCid, { gateways });
  }
  return verifyManifest(manifest, { manifestCid, dagBlocks, gateways, quick: opts.quick, log: opts.log });
}

export function formatVerification(r: VerificationReport): string {
  const lines = [
    `verification ${r.ok ? "OK" : "FAILED"} at ${r.checkedAt}${r.quick ? " (quick: root blocks only)" : ""} on ${r.gateways.join(", ")}`,
  ];
  const width = Math.max(...r.results.map((x) => x.name.length), 10);
  for (const x of r.results) {
    const what = x.ok
      ? x.mode === "car"
        ? `${x.blocks} blocks`
        : x.mode === "bytes"
          ? `${x.size} bytes, sha256 ok`
          : x.mode === "sample"
            ? `${x.blocks} sampled blocks ok (every byte via the CAR file)`
            : x.mode === "links"
              ? `root block ok, links the archive + ${(x.blocks ?? 1) - 1} parts`
              : "root block ok"
      : x.error;
    lines.push(
      `  ${x.ok ? "ok  " : "FAIL"} ${x.name.padEnd(width)} ${new URL(x.gateway).host.padEnd(20)} ${what} (${x.attempts} attempt${x.attempts > 1 ? "s" : ""}, ${Math.round((x.ms ?? 0) / 100) / 10} s)`,
    );
  }
  return lines.join("\n");
}

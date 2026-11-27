import { useState } from "react";
import { Badge, ErrorBox, Loading, Section, Table } from "../components/ui.tsx";
import { api, useApi } from "../lib/api.ts";
import { bytes, gatewayLinks, shortCid } from "../lib/format.ts";

function VerifyReport({ report }: { report: any }) {
  const failed = report.results.filter((r: any) => !r.ok);
  return (
    <div data-testid="verify-report">
      <p>
        <Badge status={report.ok ? "pass" : "fail"}>{report.ok ? "verified" : "failed"}</Badge>{" "}
        {report.results.length} checks on {report.gateways.map((g: string) => new URL(g).host).join(" and ")}{" "}
        at {report.checkedAt}
        {report.quick ? " (quick: root blocks, files ≤ 5 MB byte for byte)" : " (full: every byte and block)"}
      </p>
      <Table
        rows={failed.length ? failed : report.results}
        cols={[
          ["Artifact", (r: any) => <code>{r.name}</code>],
          ["Gateway", (r: any) => new URL(r.gateway).host],
          ["Check", (r: any) => r.mode],
          [
            "Result",
            (r: any) =>
              r.ok ? (
                <Badge status="pass">
                  {r.mode === "car"
                    ? `${r.blocks} blocks`
                    : r.mode === "bytes"
                      ? "size + sha256"
                      : r.mode === "sample"
                        ? `${r.blocks} sampled blocks + CAR file`
                        : r.mode === "links"
                          ? `root block + ${r.blocks - 1} links match`
                          : "block hash"}
                </Badge>
              ) : (
                <Badge status="fail">{r.error}</Badge>
              ),
          ],
          ["Attempts", (r: any) => r.attempts],
          ["Time", (r: any) => `${((r.ms ?? 0) / 1000).toFixed(1)} s`],
        ]}
      />
    </div>
  );
}

export function Manifest() {
  const { data, error, loading } = useApi<any>("/api/manifest/current");
  const stored = useApi<any>("/api/verify/current");
  const [live, setLive] = useState<{ busy: boolean; report?: any; error?: string }>({ busy: false });
  const [prev, setPrev] = useState<{ busy: boolean; data?: any; error?: string }>({ busy: false });
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const verifyNow = async () => {
    setLive({ busy: true });
    try {
      const r = await api<any>("/api/verify/current", { method: "POST", body: "{}" });
      setLive({ busy: false, report: r.report });
    } catch (e) {
      setLive({ busy: false, error: (e as Error).message });
    }
  };
  const checkPrevious = async () => {
    setPrev({ busy: true });
    try {
      setPrev({ busy: false, data: await api<any>("/api/manifest/previous") });
    } catch (e) {
      setPrev({ busy: false, error: (e as Error).message });
    }
  };
  const report = live.report ?? stored.data?.report ?? null;

  return (
    <>
      <Section
        title="Manifest"
        actions={
          <div className="row">
            <button
              disabled={!data.verify.available || live.busy}
              title={data.verify.reason ?? "Re-check every CID on two public gateways"}
              onClick={verifyNow}
              data-testid="verify-now"
            >
              {live.busy ? "Verifying…" : "Verify now"}
            </button>
            <button
              disabled={!data.published || prev.busy}
              title={data.published ? "Fetch the previous run's manifest by CID" : "Needs a published run"}
              onClick={checkPrevious}
              data-testid="check-previous"
            >
              {prev.busy ? "Fetching…" : "Check previous run"}
            </button>
          </div>
        }
      >
        <p>
          <Badge status={data.published ? "pass" : "warn"}>
            {data.published ? "published" : "unpublished"}
          </Badge>{" "}
          {data.note}
        </p>
        {!data.verify.available && <p className="muted small">{data.verify.reason}</p>}
        <p className="small">
          Manifest CID:{" "}
          {data.manifest_cid ? (
            <code data-testid="manifest-cid">{data.manifest_cid}</code>
          ) : (
            "— (assigned at publish)"
          )}
          {data.manifest_cid &&
            gatewayLinks(data.manifest_cid).map((g) => (
              <a key={g.gateway} href={g.url} target="_blank" rel="noreferrer" className="gw">
                {g.gateway}
              </a>
            ))}
        </p>
        {data.published && (
          <p className="muted small">
            Previous run:{" "}
            {data.previous_manifest_cid ? (
              <code>{data.previous_manifest_cid}</code>
            ) : (
              "none (first published run)"
            )}
            {data.extends && (
              <>
                {" "}
                · extends the Atlas county archive{" "}
                <code title={data.extends.county_root}>{shortCid(data.extends.county_root)}</code> (
                {data.extends.atlas_page})
              </>
            )}
          </p>
        )}
        {data.derived_index && (
          <p className="muted small">
            The DuckDB index is not published;{" "}
            <code>oracle sync --manifest {shortCid(data.manifest_cid)}</code> rebuilds it from the artifacts
            below and checks the view row counts (
            {Object.entries(data.derived_index.views)
              .map(([k, v]) => `${k} ${v}`)
              .join(", ")}
            ).
          </p>
        )}
      </Section>

      {(live.error || report) && (
        <Section title={live.report ? "Verification (just now)" : "Verification (at publish)"}>
          {live.error && <ErrorBox error={new Error(live.error)} />}
          {report && <VerifyReport report={report} />}
        </Section>
      )}

      {(prev.data || prev.error) && (
        <Section title="Previous run">
          {prev.error && <ErrorBox error={new Error(prev.error)} />}
          {prev.data?.reason && <p>{prev.data.reason}</p>}
          {prev.data?.run_id && (
            <div data-testid="previous-run">
              <p>
                <Badge status="pass">resolves</Badge> run <strong>{prev.data.run_id}</strong> (manifest{" "}
                <code>{prev.data.previous_manifest_cid}</code>, published {prev.data.created_at}) fetched by
                CID in {(prev.data.resolved_in_ms / 1000).toFixed(1)} s · {prev.data.unchanged} artifacts
                unchanged, {prev.data.changed.length} changed
              </p>
              <Table
                rows={prev.data.changed}
                empty="Nothing changed: every CID is the same."
                cols={[
                  ["Artifact", (c: any) => <code>{c.name}</code>],
                  [
                    "Previous run",
                    (c: any) => (c.before ? <code title={c.before}>{shortCid(c.before)}</code> : "—"),
                  ],
                  [
                    "This run",
                    (c: any) => (c.after ? <code title={c.after}>{shortCid(c.after)}</code> : "—"),
                  ],
                ]}
              />
            </div>
          )}
        </Section>
      )}

      <Section title="Artifacts">
        <Table
          testId="manifest-files"
          rows={data.files}
          cols={[
            [
              "Name",
              (f: any) => (
                <>
                  <code>{f.name}</code>
                  {f.note && <div className="muted small">{f.note}</div>}
                </>
              ),
            ],
            ["Kind", (f: any) => f.kind],
            ["Codec", (f: any) => f.codec],
            ["Size", (f: any) => bytes(f.size)],
            [
              "SHA-256",
              (f: any) => (f.sha256 ? <code title={f.sha256}>{f.sha256.slice(0, 16)}…</code> : "—"),
            ],
            [
              "CID",
              (f: any) => (f.cid ? <code title={f.cid}>{f.cid.slice(0, 16)}…</code> : "— (at publish)"),
            ],
            [
              "Gateways",
              (f: any) =>
                f.cid ? (
                  <span className="small">
                    {gatewayLinks(f.cid).map((g) => (
                      <a key={g.gateway} href={g.url} target="_blank" rel="noreferrer" className="gw">
                        {g.gateway}
                      </a>
                    ))}
                    {!data.published && <span className="muted"> (resolves after publish)</span>}
                  </span>
                ) : (
                  "—"
                ),
            ],
          ]}
        />
      </Section>
    </>
  );
}

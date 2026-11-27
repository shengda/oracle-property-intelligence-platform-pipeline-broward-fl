import { Badge, ErrorBox, Loading, Section, Table } from "../components/ui.tsx";
import { useApi } from "../lib/api.ts";
import { bytes, gatewayLinks } from "../lib/format.ts";

export function Manifest() {
  const { data, error, loading } = useApi<any>("/api/manifest/current");
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <>
      <Section
        title="Manifest"
        actions={
          <div className="row">
            <button
              disabled={!data.verify.available}
              title={data.verify.reason ?? ""}
              data-testid="verify-now"
            >
              Verify now
            </button>
            <button disabled={!data.published} title="Needs a published previous run (M3)">
              Check previous run
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
        <p className="muted small">Manifest CID: {data.manifest_cid ?? "— (assigned at publish)"}</p>
      </Section>
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

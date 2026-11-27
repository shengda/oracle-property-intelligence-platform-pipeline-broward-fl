import { useEffect, useState } from "react";
import { ErrorBox, Section, Table } from "../components/ui.tsx";
import { api, qs, useApi } from "../lib/api.ts";
import { GATEWAYS } from "../lib/format.ts";

const FTL = { lat: 26.14123, lon: -80.14673 };

/** Same haversine + ordering as the server's findAgedRoofs, so the rows must match exactly. */
function proofSql(url: string, lat: number, lon: number, miles: number, minAge: number, limit: number) {
  const d = `(3958.7613 * 2 * asin(sqrt(power(sin(radians(lat - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(lat)) * power(sin(radians(lon - ${lon}) / 2), 2))))`;
  const dLat = miles / 69.0;
  const dLon = miles / (69.172 * Math.cos((lat * Math.PI) / 180));
  const where = `lat is not null and lon is not null and lat between ${lat - dLat} and ${lat + dLat} and lon between ${lon - dLon} and ${lon + dLon} and ${d} <= ${miles} and roof_age_years >= ${minAge}`;
  return {
    rows: `select parcel_identifier, address, roof_age_years, round(${d}, 2) as distance_miles from read_parquet('${url}') where ${where} order by roof_age_years desc, ${d}, parcel_identifier limit ${limit}`,
    count: `select count(*)::INTEGER as n from read_parquet('${url}') where ${where}`,
  };
}

export function WasmProof() {
  const health = useApi<any>("/api/health");
  const manifest = useApi<any>("/api/manifest/current");
  const [url, setUrl] = useState(`${window.location.origin}/files/query/v_property.parquet`);
  // A published run reads the Parquet by CID from a public gateway (CORS + range reads verified).
  const publishedCid: string | null =
    manifest.data?.published &&
    manifest.data.files?.find((f: any) => f.name === "query/v_property.parquet")?.cid;
  useEffect(() => {
    if (publishedCid) setUrl(`${GATEWAYS[0]}/ipfs/${publishedCid}`);
  }, [publishedCid]);
  const [state, setState] = useState<any>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    setState(null);
    try {
      const t0 = performance.now();
      const duckdb = await import("@duckdb/duckdb-wasm");
      const bundles = {
        mvp: {
          mainModule: (await import("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url")).default,
          mainWorker: (await import("@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url")).default,
        },
        eh: {
          mainModule: (await import("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url")).default,
          mainWorker: (await import("@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url")).default,
        },
      };
      const bundle = await duckdb.selectBundle(bundles);
      const worker = new Worker(bundle.mainWorker!);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      const conn = await db.connect();
      const q = proofSql(url, FTL.lat, FTL.lon, 5, 15, 20);
      const t1 = performance.now();
      const rows = (await conn.query(q.rows)).toArray().map((r: any) => ({
        ...r.toJSON(),
        roof_age_years: Number(r.roof_age_years),
        distance_miles: Number(r.distance_miles),
      }));
      const total = Number((await conn.query(q.count)).toArray()[0].n);
      const t2 = performance.now();
      await conn.close();
      await db.terminate();
      worker.terminate();
      const apiRes = await api<any>(
        `/api/query/aged-roofs${qs({ lat: FTL.lat, lon: FTL.lon, radiusMiles: 5, minRoofAgeYears: 15, limit: 20 })}`,
      );
      const same =
        apiRes.total === total &&
        apiRes.rows.length === rows.length &&
        apiRes.rows.every((r: any, i: number) => r.parcel_identifier === rows[i].parcel_identifier);
      setState({
        rows,
        total,
        apiTotal: apiRes.total,
        apiRows: apiRes.rows,
        same,
        loadMs: Math.round(t1 - t0),
        queryMs: Math.round(t2 - t1),
      });
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section title="DuckDB-WASM proof — the query runs in this browser">
        <p>
          DuckDB compiled to WebAssembly reads <code>v_property.parquet</code> straight over HTTP (range
          requests) and runs the aged-roofs query (5 miles of Fort Lauderdale, roofs ≥ 15 years). The page
          then asks the API for the same query and compares.
        </p>
        {health.data && !health.data.published && (
          <p className="note">
            Unpublished run: the Parquet comes from this server's <code>/files/</code>. Once the run is
            published the page reads it by CID from a public gateway instead.
          </p>
        )}
        {publishedCid && (
          <p className="note" data-testid="wasm-published-source">
            Published run: the browser reads <code>query/v_property.parquet</code> by its CID{" "}
            <code>{publishedCid}</code> from {new URL(GATEWAYS[0]).host} (range requests, no server in
            between).
          </p>
        )}
        <div className="inline">
          <input
            className="grow"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="Parquet URL"
          />
          <button onClick={run} disabled={busy} data-testid="wasm-run">
            {busy ? "Running in the browser…" : "Run in browser"}
          </button>
        </div>
        <ErrorBox error={error} />
        {state && (
          <p data-testid="wasm-result" className={state.same ? "ok" : "error"}>
            {state.same ? "✓ Same rows as the API" : "✗ Rows differ from the API"} — browser:{" "}
            {state.total.toLocaleString()} matching ({state.rows.length} shown) · API:{" "}
            {state.apiTotal.toLocaleString()} · engine load {state.loadMs} ms · query {state.queryMs} ms
          </p>
        )}
      </Section>
      {state && (
        <Section title="Rows computed in the browser">
          <Table
            testId="wasm-rows"
            rows={state.rows}
            cols={[
              ["Folio", (r: any) => r.parcel_identifier],
              ["Address", (r: any) => r.address],
              ["Roof age", (r: any) => r.roof_age_years],
              ["Distance", (r: any) => `${r.distance_miles} mi`],
            ]}
          />
        </Section>
      )}
    </>
  );
}

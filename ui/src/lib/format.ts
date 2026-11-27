export const n = (x: number | null | undefined) => (x == null ? "—" : x.toLocaleString("en-US"));
export const money = (x: number | null | undefined) =>
  x == null
    ? "—"
    : x.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const bytes = (b: number | null | undefined) =>
  b == null
    ? "—"
    : b >= 1e9
      ? `${(b / 1e9).toFixed(2)} GB`
      : b >= 1e6
        ? `${(b / 1e6).toFixed(1)} MB`
        : b >= 1e3
          ? `${(b / 1e3).toFixed(1)} KB`
          : `${b} B`;
export const pct = (x: number | null | undefined) => (x == null ? "—" : `${x.toFixed(1)} %`);
export const shortCid = (c: string | null | undefined) => (c ? `${c.slice(0, 12)}…${c.slice(-6)}` : "—");
export const ms = (x: number | null | undefined) =>
  x == null
    ? "—"
    : x >= 60_000
      ? `${Math.floor(x / 60_000)} min ${Math.round((x % 60_000) / 1000)} s`
      : `${(x / 1000).toFixed(1)} s`;
export const label = (s: string | null | undefined) => (s ? s.replace(/_/g, " ") : "—");
/** The gateways `oracle verify` checks on (src/publish/verify.ts PUBLIC_GATEWAYS). */
export const GATEWAYS = ["https://ipfs.filebase.io", "https://gw.ipfs-lens.dev"] as const;
export const gatewayLinks = (cid: string) =>
  GATEWAYS.map((g) => ({ gateway: new URL(g).host, url: `${g}/ipfs/${cid}` }));

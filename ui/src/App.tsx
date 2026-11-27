import { lazy, Suspense } from "react";
import { Loading } from "./components/ui.tsx";
import { useApi } from "./lib/api.ts";
import { href, useRoute } from "./lib/router.ts";
import { Agent } from "./pages/Agent.tsx";
import { Business } from "./pages/Business.tsx";
import { Contractor, Contractors } from "./pages/Contractor.tsx";
import { Cost } from "./pages/Cost.tsx";
import { Explorer } from "./pages/Explorer.tsx";
import { Manifest } from "./pages/Manifest.tsx";
import { Occupancy } from "./pages/Occupancy.tsx";
import { Permit } from "./pages/Permit.tsx";
import { Property } from "./pages/Property.tsx";
import { Quality } from "./pages/Quality.tsx";
import { Runs } from "./pages/Runs.tsx";
import { Search } from "./pages/Search.tsx";
import { Sources } from "./pages/Sources.tsx";
import { Sql } from "./pages/Sql.tsx";

const Mcp = lazy(() => import("./pages/Mcp.tsx").then((m) => ({ default: m.Mcp })));
const WasmProof = lazy(() => import("./pages/WasmProof.tsx").then((m) => ({ default: m.WasmProof })));

const NAV: [string, string][] = [
  ["runs", "Runs"],
  ["sources", "Sources"],
  ["quality", "Quality"],
  ["manifest", "Manifest"],
  ["explorer", "Explorer"],
  ["occupancy", "Occupancy"],
  ["contractors", "Contractors"],
  ["search", "Search"],
  ["sql", "SQL"],
  ["agent", "Agent"],
  ["mcp", "MCP"],
  ["wasm", "WASM proof"],
  ["cost", "Cost"],
];

export function App() {
  const route = useRoute();
  const health = useApi<any>("/api/health");
  const h = health.data;
  const page = (() => {
    switch (route.page) {
      case "runs":
        return <Runs />;
      case "sources":
        return <Sources />;
      case "quality":
        return <Quality />;
      case "manifest":
        return <Manifest />;
      case "explorer":
        return <Explorer route={route} />;
      case "occupancy":
        return <Occupancy route={route} />;
      case "property":
        return route.param ? <Property key={route.param} id={route.param} /> : null;
      case "permit":
        return route.param ? <Permit key={route.param} id={route.param} /> : null;
      case "contractor":
        return route.param ? <Contractor key={route.param} id={route.param} /> : null;
      case "contractors":
        return <Contractors />;
      case "business":
        return route.param ? <Business key={route.param} id={route.param} /> : null;
      case "search":
        return <Search />;
      case "sql":
        return <Sql />;
      case "agent":
        return <Agent />;
      case "mcp":
        return <Mcp />;
      case "wasm":
        return <WasmProof />;
      case "cost":
        return <Cost />;
      default:
        return (
          <p>
            Page not found. <a href={href("runs")}>Back to runs</a>
          </p>
        );
    }
  })();
  return (
    <div className="app">
      {h && !h.published && (
        <div className="banner" role="status" data-testid="unpublished-banner">
          UNPUBLISHED local run <strong>{h.runId}</strong> (as of {h.asOf}) — inspection only; nothing here is
          on IPFS yet.
        </div>
      )}
      <header className="top">
        <a className="brand" href={href("runs")}>
          Broward Oracle
        </a>
        <nav>
          {NAV.map(([p, t]) => (
            <a key={p} href={href(p)} className={route.page === p ? "active" : ""}>
              {t}
            </a>
          ))}
        </nav>
      </header>
      <main>
        {health.error && <div className="error">API not reachable: {health.error.message}</div>}
        <Suspense fallback={<Loading />}>{page}</Suspense>
      </main>
      <footer className="muted small">
        Broward County, FL · roofing-views.v1 · data from public sources with per-record provenance
      </footer>
    </div>
  );
}

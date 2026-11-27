import { useEffect, useState } from "react";

/** Hash routes: #/page/param?query — works from any static host and in headless browsers. */
export interface Route {
  page: string;
  param: string | null;
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const [p, q = ""] = h.split("?");
  const [page = "", ...rest] = p.split("/");
  return {
    page: page || "runs",
    param: rest.length ? decodeURIComponent(rest.join("/")) : null,
    query: new URLSearchParams(q),
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function href(
  page: string,
  param?: string | null,
  query?: Record<string, string | number | undefined | null>,
): string {
  const qs = query
    ? new URLSearchParams(
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : "";
  return `#/${page}${param ? `/${encodeURIComponent(param)}` : ""}${qs ? `?${qs}` : ""}`;
}

export function go(
  page: string,
  param?: string | null,
  query?: Record<string, string | number | undefined | null>,
) {
  window.location.hash = href(page, param, query);
}

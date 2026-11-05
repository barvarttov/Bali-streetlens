// Route planner data: types for GET /api/route, the request hook, and small helpers (distance text,
// a Google Maps link that follows the chosen route, where to put a route's label on the map).

import { useEffect, useState } from "react";
import type { LngLat } from "../lib/liveSchema.ts";

/** One end of a route, as the visitor chose it. */
export interface Endpoint {
  name: string;
  lnglat: LngLat;
  kind: "place" | "junction" | "me" | "map";
}

export interface RoutePassedJunction {
  id: string;
  /** The approach the route enters by (arm id), when it could be told. */
  arm: string | null;
}

export interface RouteOption {
  distance_m: number;
  geometry: LngLat[];
  /** Longest roads first. */
  roads: string[];
  /** The road that sets this route apart from the others. */
  via: string | null;
  junctions: RoutePassedJunction[];
  waypoints: LngLat[];
}

export interface RouteResult {
  from: { lnglat: LngLat; snapped: LngLat; offset_m: number };
  to: { lnglat: LngLat; snapped: LngLat; offset_m: number };
  routes: RouteOption[];
  source: string;
}

export type RouteErrorCode = "no_road" | "no_route" | "far_from_road" | "same_place" | "outside_bali" | "no_graph" | "network" | "other";

export type RouteRequest =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; result: RouteResult; at: number }
  | { status: "error"; code: RouteErrorCode; message: string };

const key = (e: Endpoint | null) => (e ? `${e.lnglat[0].toFixed(6)},${e.lnglat[1].toFixed(6)}` : "");

/** Fetches routes whenever both ends are set; `attempt` forces a fresh request (recalculate, retry). */
export function useRoutes(from: Endpoint | null, to: Endpoint | null, attempt: number): RouteRequest {
  const [state, setState] = useState<RouteRequest>({ status: "idle" });
  const a = key(from);
  const b = key(to);
  useEffect(() => {
    if (!a || !b) {
      setState({ status: "idle" });
      return;
    }
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetch(`/api/route?from=${a}&to=${b}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (res.ok) return setState({ status: "ok", result: (await res.json()) as RouteResult, at: Date.now() });
        let code: RouteErrorCode = "other";
        let message = `HTTP ${res.status}`;
        try {
          const detail = ((await res.json()) as { detail?: { code?: RouteErrorCode; message?: string } }).detail;
          code = detail?.code ?? code;
          message = detail?.message ?? message;
        } catch {
          /* not JSON */
        }
        setState({ status: "error", code, message });
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setState({ status: "error", code: "network", message: err.message });
      });
    return () => ctrl.abort();
  }, [a, b, attempt]);
  return state;
}

/** "850 m", "8,4 km", "23 km". */
export function formatDistance(m: number, lang: "id" | "en"): string {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  const km = m / 1000;
  const n = new Intl.NumberFormat(lang === "id" ? "id-ID" : "en-GB", { maximumFractionDigits: km < 10 ? 1 : 0 }).format(km);
  return `${n} km`;
}

/** Google Maps directions that follow this route (through its waypoints) for turn-by-turn guidance. */
export function googleMapsUrl(from: LngLat, to: LngLat, route: RouteOption): string {
  const ll = (p: LngLat) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`;
  const params = new URLSearchParams({ api: "1", origin: ll(from), destination: ll(to), travelmode: "driving" });
  if (route.waypoints.length) params.set("waypoints", route.waypoints.map(ll).join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

const meters = (a: LngLat, b: LngLat) => {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 110540);
};

/**
 * Where to pin a route's label on the map: the point of this route farthest from every other route
 * (so labels never sit on a shared stretch), kept away from both ends.
 */
export function labelPoint(route: RouteOption, others: RouteOption[]): LngLat {
  const g = route.geometry;
  const step = Math.max(1, Math.floor(g.length / 60));
  const sample = (r: RouteOption) => r.geometry.filter((_, i) => i % Math.max(1, Math.floor(r.geometry.length / 120)) === 0);
  const otherPts = others.flatMap(sample);
  let best = g[Math.floor(g.length / 2)];
  let bestScore = -1;
  for (let i = Math.floor(g.length * 0.2); i < g.length * 0.8; i += step) {
    const p = g[i];
    const away = otherPts.length ? Math.min(...otherPts.map((q) => meters(p, q))) : 0;
    // Without other routes, prefer the middle.
    const score = otherPts.length ? away : -Math.abs(i - g.length / 2);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** Bounds of every route and both ends, for framing the map. */
export function routeBounds(result: RouteResult): [[number, number], [number, number]] {
  const pts = [result.from.lnglat, result.to.lnglat, ...result.routes.flatMap((r) => r.geometry)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
}

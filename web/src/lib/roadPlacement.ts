// Lays an uncalibrated camera's picture along the OSM road nearest to it (backend: /api/cameras/<id>/road).
// Pure (no DOM), runs in the browser and in Node tests. Erasable syntax only.

import { fromLocalMeters, toLocalMeters } from "./geo.ts";
import type { LngLat } from "./geo.ts";

/** The OSM road nearest to an uncalibrated camera (GET /api/cameras/<id>/road). */
export interface CameraRoad {
  name: string | null;
  width_m: number;
  snap: LngLat;
  snap_index: number;
  line: LngLat[];
}


export interface RoadFrame {
  origin: LngLat;
  /** Local meters (east, north) from the road point nearest the camera, in the viewing direction. */
  pts: [number, number][];
  cum: number[];
  width: number;
}

const polylineLength = (pts: [number, number][]) =>
  pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

/** The road from its point nearest the camera toward its longer side (where the camera most likely looks). */
export function roadFrame(road: CameraRoad): RoadFrame | null {
  const origin = road.snap;
  const local = road.line.map((p) => toLocalMeters(origin, p) as [number, number]);
  const ahead = local.slice(road.snap_index);
  const behind = local.slice(0, road.snap_index + 1).reverse();
  const pts = polylineLength(ahead) >= polylineLength(behind) ? ahead : behind;
  if (pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  if (cum[cum.length - 1] < 5) return null;
  return { origin, pts, cum, width: road.width_m };
}

/** The point `s` meters along the road and `lateral` meters to its right, facing along the road
 *  (heading in radians as atan2(north, east)). */
export function alongRoad(f: RoadFrame, s: number, lateral: number): { lnglat: LngLat; heading: number } {
  const total = f.cum[f.cum.length - 1];
  const d = Math.max(0, Math.min(total, s));
  let i = 1;
  while (i < f.cum.length - 1 && f.cum[i] < d) i++;
  const a = f.pts[i - 1];
  const b = f.pts[i];
  const seg = f.cum[i] - f.cum[i - 1] || 1;
  const t = (d - f.cum[i - 1]) / seg;
  const tx = (b[0] - a[0]) / seg;
  const ty = (b[1] - a[1]) / seg;
  // Right of the direction (tx, ty) is (ty, -tx).
  const x = a[0] + (b[0] - a[0]) * t + ty * lateral;
  const y = a[1] + (b[1] - a[1]) * t - tx * lateral;
  return { lnglat: fromLocalMeters(f.origin, [x, y]), heading: Math.atan2(ty, tx) };
}

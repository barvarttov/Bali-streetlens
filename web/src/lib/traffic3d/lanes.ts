// Turns the corridor's OpenStreetMap road arms into drivable lanes, in local meters, for the 3D
// vehicle layer. Pure (no DOM, no MapLibre), so it runs in Node tests too.
//
// Local frame (docs/schema.md): x = east, z = south (Three.js x = X, z = -Y), meters, measured in
// Web Mercator around one origin. The renderer places the same origin with MapLibre's
// MercatorCoordinate, so a point here lands exactly on the map.
// Bali drives on the LEFT: every lane sits to the left of its direction of travel.

import type { Arm, Corridor, LngLat } from "../liveSchema.ts";

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6371008.8; // the value MapLibre uses

export interface Mercator {
  x: number;
  y: number;
}

export function toMercator([lng, lat]: LngLat): Mercator {
  const x = (180 + lng) / 360;
  const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  return { x, y };
}

/** Mercator units per meter at a latitude (same as MapLibre's meterInMercatorCoordinateUnits). */
export function mercatorPerMeter(lat: number): number {
  return 1 / EARTH_CIRCUMFERENCE / Math.cos((lat * Math.PI) / 180);
}

export interface LocalFrame {
  origin: LngLat;
  originMerc: Mercator;
  unit: number;
}

export function localFrame(origin: LngLat): LocalFrame {
  return { origin, originMerc: toMercator(origin), unit: mercatorPerMeter(origin[1]) };
}

export type Vec = [number, number]; // [x, z]

export function toLocal(frame: LocalFrame, p: LngLat): Vec {
  const m = toMercator(p);
  return [(m.x - frame.originMerc.x) / frame.unit, (m.y - frame.originMerc.y) / frame.unit];
}

// ---------------------------------------------------------------------------------------------
// Paths

export interface Path {
  pts: Vec[];
  /** Cumulative length at each point. */
  cum: number[];
  length: number;
}

export function makePath(pts: Vec[]): Path {
  const clean: Vec[] = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.05) clean.push(p);
  }
  const cum = [0];
  for (let i = 1; i < clean.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]));
  }
  return { pts: clean, cum, length: cum[cum.length - 1] ?? 0 };
}

export interface PathPoint {
  x: number;
  z: number;
  /** Unit tangent (direction of travel). */
  dx: number;
  dz: number;
}

/** Position and direction at distance `s` along the path (clamped to its ends). */
export function pointAt(path: Path, s: number): PathPoint {
  const { pts, cum } = path;
  if (pts.length < 2) return { x: pts[0]?.[0] ?? 0, z: pts[0]?.[1] ?? 0, dx: 1, dz: 0 };
  const d = Math.max(0, Math.min(path.length, s));
  let i = 1;
  while (i < pts.length - 1 && cum[i] < d) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const seg = cum[i] - cum[i - 1] || 1;
  const t = (d - cum[i - 1]) / seg;
  return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: (b[0] - a[0]) / seg, dz: (b[1] - a[1]) / seg };
}

/** Left normal of a travel direction in the x-east / z-south frame. */
export const leftOf = (dx: number, dz: number): Vec => [dz, -dx];

/** The polyline moved sideways: positive `offset` moves it to the left of travel. */
export function offsetPath(path: Path, offset: number): Path {
  const { pts } = path;
  if (pts.length < 2 || offset === 0) return path;
  const out: Vec[] = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const [nx, nz] = leftOf((b[0] - a[0]) / len, (b[1] - a[1]) / len);
    return [p[0] + nx * offset, p[1] + nz * offset];
  });
  return makePath(out);
}

/** Quadratic Bezier from `a` through the pull of `c` to `b`, as a path. */
export function curvePath(a: Vec, c: Vec, b: Vec, steps = 10): Path {
  const pts: Vec[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return makePath(pts);
}

// ---------------------------------------------------------------------------------------------
// Junction lanes

/** Lateral slots: two side by side, because Bali's motorbikes ride two (or more) abreast. */
export const SLOTS = 2;
/** Where vehicles wait, in meters from the junction centre along the approach. */
export const STOP_BACK_M = 13;
/** Where exiting vehicles join their outbound lane, in meters from the centre. */
export const EXIT_START_M = 11;

export interface ArmLanes {
  id: string;
  /** Toward the junction: one path per slot, plus index SLOTS = the middle (wide vehicles). */
  inbound: Path[] | null;
  /** Away from the junction, same layout. */
  outbound: Path[] | null;
  /** Distance along an inbound path where the stop line is. */
  stopS: number;
}

export interface JunctionLanes {
  id: string;
  center: Vec;
  arms: ArmLanes[];
}

/** Width of one traffic lane on Bali's roads, in meters. */
export const LANE_W = 3.1;

/**
 * Paved width of one OSM line of an arm, in meters: its lane count (OSM `lanes`, else 2) times a lane.
 * The map paints watched approaches at exactly this width, so vehicles and road surface agree.
 */
export function carriagewayWidth(arm: Arm, line: number): number {
  const lanes = arm.lanes?.[line] ?? null;
  return Math.max(1, lanes ?? 2) * LANE_W;
}

/**
 * Lane centre offsets (left of travel) for each slot and the middle (wide vehicles), sized to the
 * carriageway so every vehicle stays on the paved surface:
 * - two-way road: this direction owns the left half, from the centreline to the left edge;
 * - one-way carriageway: centred on the line.
 */
export function slotOffsets(twoWay: boolean, width: number): number[] {
  if (twoWay) {
    const half = width / 2;
    return [half * 0.3, half * 0.72, half * 0.5];
  }
  return [-width * 0.2, width * 0.2, 0];
}

function lanesFor(line: Path, twoWay: boolean, width: number): Path[] {
  return slotOffsets(twoWay, width).map((o) => offsetPath(line, o));
}

export function buildArmLanes(frame: LocalFrame, arm: Arm): ArmLanes {
  const flows = arm.flows ?? arm.lines.map(() => "both" as const);
  const paths = arm.lines.map((l) => makePath(l.map((p) => toLocal(frame, p)))); // centre -> outward
  const longest = (pick: number[]) => pick.sort((a, b) => paths[b].length - paths[a].length)[0];
  const idx = (want: string) => longest(flows.map((f, i) => (f === want ? i : -1)).filter((i) => i >= 0));

  const inIdx = idx("in") ?? idx("both");
  const outIdx = idx("out") ?? idx("both");
  const reverse = (p: Path) => makePath([...p.pts].reverse());

  const inbound = inIdx === undefined ? null : lanesFor(reverse(paths[inIdx]), flows[inIdx] === "both", carriagewayWidth(arm, inIdx));
  const outbound = outIdx === undefined ? null : lanesFor(paths[outIdx], flows[outIdx] === "both", carriagewayWidth(arm, outIdx));
  const inLen = inbound ? inbound[SLOTS].length : 0;
  return { id: arm.id, inbound, outbound, stopS: Math.max(inLen * 0.4, inLen - STOP_BACK_M) };
}

export function buildCorridorLanes(corridor: Corridor): { frame: LocalFrame; junctions: JunctionLanes[] } {
  const lng = corridor.junctions.reduce((s, j) => s + j.center[0], 0) / corridor.junctions.length;
  const lat = corridor.junctions.reduce((s, j) => s + j.center[1], 0) / corridor.junctions.length;
  const frame = localFrame([lng, lat]);
  const junctions = corridor.junctions.map((j) => ({
    id: j.id,
    center: toLocal(frame, j.center),
    arms: j.arms.map((a) => buildArmLanes(frame, a)),
  }));
  return { frame, junctions };
}

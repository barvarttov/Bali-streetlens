// Camera pixels -> road-plane meters (PLAN.md section 7, docs/schema.md).
//
// A flat road seen by a fixed camera is related to a top-down map by one 3x3 matrix, the homography.
// We fit it from the hand-picked pairs in config/<camera>.yaml (calibration.image_points_px <->
// world_points_m), check it on the hold-out pairs that were NOT used for fitting, and report both
// errors in meters so nobody has to trust the 3D blindly.
//
// Fit: normalized DLT (Hartley): move both point sets to their centroid and scale them to a mean
// distance of sqrt(2), solve the 8 unknowns (h33 = 1) by linear least squares, then undo the
// normalization. h33 = 1 is safe after normalization because the image origin is then the centroid
// of the picked points, which lies on the road and so maps to a finite place.
//
// Pure (no DOM), runs in the browser and in Node 24 tests. Erasable syntax only.

import type { Meters, Px } from "./schema.ts";

/** Row-major 3x3 matrix: [h11, h12, h13, h21, h22, h23, h31, h32, h33]. */
export type Mat3 = readonly number[];

export interface Calibration {
  /** Image pixels -> world meters. */
  H: Mat3;
  /** World meters -> image pixels. */
  Hinv: Mat3;
  /** Sign of w on the road side of the horizon; points with the other sign are in the sky. */
  roadSide: 1 | -1;
  /** Distance between each fit point's projection and its world point, meters (same order as the config). */
  fitErrors: number[];
  fitRms: number;
  /** Same for the hold-out points; empty when the config has none. */
  holdoutErrors: number[];
  holdoutMean: number | null;
  holdoutMax: number | null;
  /** World bounding box of the calibration points: positions far outside it are extrapolation. */
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

export type CalibrationResult = { ok: true; calibration: Calibration } | { ok: false; reason: string };

export const MIN_POINTS = 4;

export function applyHomography(H: Mat3, [x, y]: readonly [number, number]): [number, number] {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** The w term alone, to tell which side of the horizon an image point is on. */
function wOf(H: Mat3, [x, y]: readonly [number, number]): number {
  return H[6] * x + H[7] * y + H[8];
}

export function multiply3(a: Mat3, b: Mat3): number[] {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function invert3(m: Mat3): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error("Matrix is not invertible.");
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

/** Similarity transform that moves points to their centroid and scales them to mean distance sqrt(2). */
function normalizer(points: readonly (readonly [number, number])[]): number[] {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) {
    cx += x;
    cy += y;
  }
  cx /= points.length;
  cy /= points.length;
  let mean = 0;
  for (const [x, y] of points) mean += Math.hypot(x - cx, y - cy);
  mean /= points.length;
  const s = mean > 0 ? Math.SQRT2 / mean : 1;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/** Solves the square system M x = v (Gaussian elimination, partial pivoting). Null when singular. */
function solve(M: number[][], v: number[]): number[] | null {
  const n = v.length;
  const a = M.map((row, r) => [...row, v[r]]);
  let scale = 0;
  for (const row of M) for (const x of row) scale = Math.max(scale, Math.abs(x));
  const tiny = Math.max(scale, 1) * 1e-10;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < tiny) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = col + 1; r < n; r++) {
      const k = a[r][col] / a[col][col];
      if (k === 0) continue;
      for (let c = col; c <= n; c++) a[r][c] -= k * a[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = a[r][n];
    for (let c = r + 1; c < n; c++) sum -= a[r][c] * x[c];
    x[r] = sum / a[r][r];
  }
  return x;
}

/**
 * Least-squares homography mapping `from` onto `to` (at least 4 pairs, no three of the first four
 * on one line). Throws with a readable message when the points can't define one.
 */
export function fitHomography(from: readonly Px[], to: readonly Meters[]): number[] {
  if (from.length !== to.length) {
    throw new Error(`image_points_px has ${from.length} points but world_points_m has ${to.length}; they must pair up.`);
  }
  if (from.length < MIN_POINTS) {
    throw new Error(`Need at least ${MIN_POINTS} point pairs (8-10 recommended), got ${from.length}.`);
  }
  for (const p of [...from, ...to]) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      throw new Error(`Every calibration point must be [x, y] numbers, got ${JSON.stringify(p)}.`);
    }
  }

  const Ti = normalizer(from);
  const Tw = normalizer(to);
  const src = from.map((p) => applyHomography(Ti, p));
  const dst = to.map((p) => applyHomography(Tw, p));

  // Normal equations (A^T A) h = A^T b for the 2n x 8 system, accumulated row by row.
  const AtA = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const Atb = new Array<number>(8).fill(0);
  const addRow = (row: number[], rhs: number) => {
    for (let r = 0; r < 8; r++) {
      if (row[r] === 0) continue;
      Atb[r] += row[r] * rhs;
      for (let c = 0; c < 8; c++) AtA[r][c] += row[r] * row[c];
    }
  };
  for (let k = 0; k < src.length; k++) {
    const [x, y] = src[k];
    const [u, v] = dst[k];
    addRow([x, y, 1, 0, 0, 0, -x * u, -y * u], u);
    addRow([0, 0, 0, x, y, 1, -x * v, -y * v], v);
  }
  const h = solve(AtA, Atb);
  if (!h || h.some((x) => !Number.isFinite(x))) {
    throw new Error("The calibration points don't define a road plane: some are repeated or (nearly) on one straight line. Spread them over the whole road.");
  }
  const Hn = [...h, 1];
  const H = multiply3(invert3(Tw), multiply3(Hn, Ti));
  const scale = H[8] !== 0 ? H[8] : 1;
  return H.map((x) => x / scale);
}

function worldBounds(points: readonly Meters[]): Calibration["bounds"] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, maxX, minY, maxY };
}

const dist = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Fits and checks a camera's calibration block. Never throws: a bad config becomes `{ ok: false, reason }`. */
export function calibrate(c: {
  image_points_px: readonly Px[];
  world_points_m: readonly Meters[];
  holdout_image_px: readonly Px[];
  holdout_world_m: readonly Meters[];
}): CalibrationResult {
  if (c.image_points_px.length === 0 && c.world_points_m.length === 0) {
    return { ok: false, reason: "No calibration points yet." };
  }
  let H: number[];
  let Hinv: number[];
  try {
    H = fitHomography(c.image_points_px, c.world_points_m);
    Hinv = invert3(H);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (c.holdout_image_px.length !== c.holdout_world_m.length) {
    return {
      ok: false,
      reason: `holdout_image_px has ${c.holdout_image_px.length} points but holdout_world_m has ${c.holdout_world_m.length}; they must pair up.`,
    };
  }

  // All picked points lie on the road, so their w sign marks the road side of the horizon.
  let wSum = 0;
  for (const p of c.image_points_px) wSum += Math.sign(wOf(H, p));
  const roadSide: 1 | -1 = wSum >= 0 ? 1 : -1;

  const fitErrors = c.image_points_px.map((p, i) => dist(applyHomography(H, p), c.world_points_m[i]));
  const fitRms = Math.sqrt(fitErrors.reduce((s, e) => s + e * e, 0) / fitErrors.length);
  const holdoutErrors = c.holdout_image_px.map((p, i) => dist(applyHomography(H, p), c.holdout_world_m[i]));
  const holdoutMean = holdoutErrors.length ? holdoutErrors.reduce((s, e) => s + e, 0) / holdoutErrors.length : null;
  const holdoutMax = holdoutErrors.length ? Math.max(...holdoutErrors) : null;

  return {
    ok: true,
    calibration: {
      H,
      Hinv,
      roadSide,
      fitErrors,
      fitRms,
      holdoutErrors,
      holdoutMean,
      holdoutMax,
      bounds: worldBounds([...c.world_points_m, ...c.holdout_world_m]),
    },
  };
}

/**
 * Projects an image point onto the road plane. Null when the pixel is at or above the horizon
 * (it is sky, not road), where the homography would return a point behind the camera or at infinity.
 */
export function imageToWorld(cal: Calibration, p: readonly [number, number]): Meters | null {
  const w = wOf(cal.H, p);
  if (!(w * cal.roadSide > 1e-12)) return null;
  const out = applyHomography(cal.H, p);
  return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? out : null;
}

/** Road-plane meters -> image pixels (for checks and for drawing world geometry on the video). */
export function worldToImage(cal: Calibration, p: readonly [number, number]): Px | null {
  const out = applyHomography(cal.Hinv, p);
  return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? out : null;
}

/**
 * True when a world point is within `margin` meters of the calibrated area. Beyond that the
 * homography extrapolates, and the error per pixel grows fast with distance from the camera.
 */
export function insideCalibratedArea(cal: Calibration, [x, y]: readonly [number, number], margin: number): boolean {
  const b = cal.bounds;
  return x >= b.minX - margin && x <= b.maxX + margin && y >= b.minY - margin && y <= b.maxY + margin;
}

/** Default extrapolation margin: a quarter of the calibrated area's diagonal, at least 5 m. */
export function defaultMargin(cal: Calibration): number {
  const b = cal.bounds;
  return Math.max(5, 0.25 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY));
}

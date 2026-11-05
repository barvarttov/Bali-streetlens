// observations.json tracks -> vehicle positions on the road plane, for the 3D twin.
//
// Each observed `ground_px` (bottom-centre of the box, where the vehicle touches the road) goes
// through the camera's homography to meters (X east, Y north, docs/schema.md). The replay knows the
// whole clip, so it can smooth each track over a few frames on both sides; heading comes from the
// track's own movement (PLAN.md section 7: "Heading can come from the last few track positions").
//
// At a time t the twin shows, per track:
//   observed  the tracker saw it at (or within a frame of) t: interpolated between those frames
//   gap       the tracker lost it for a moment (up to MAX_INTERP_S): position interpolated, shown as such
//   lost      after the last sighting it stays MAX_HOLD_S where it was last seen, then disappears
//             (PLAN.md Day 4: no ghosts)
// Positions are approximate: the flat-road assumption, box shifts from occlusion and the larger
// per-pixel error far from the camera all show up here. The UI says so.
//
// Pure (no DOM, no Three.js), runs in Node 24 tests. Erasable syntax only.

import { defaultMargin, imageToWorld, insideCalibratedArea } from "./homography.ts";
import type { Calibration } from "./homography.ts";
import type { ObservationIndex } from "./observations.ts";
import type { VehicleClass } from "./schema.ts";

/** Centered moving average over this many frames on each side (0.08 s at 25 fps). */
export const SMOOTH_FRAMES = 2;
/** Heading and speed are measured over this much time on each side of a sample. */
export const MOTION_WINDOW_S = 0.4;
/** Below this displacement over the motion window the vehicle counts as standing: keep the last heading. */
export const MIN_HEADING_MOVE_M = 0.6;
/** Gaps up to this long are bridged by interpolation; longer ones split the track's visibility. */
export const MAX_INTERP_S = 1.0;
/** After the last sighting (or before a long gap), a vehicle is held this long, then removed. */
export const MAX_HOLD_S = 1.0;
/** A sample counts as "observed" when the neighbouring observations are at most this many frames apart. */
export const OBSERVED_MAX_STEP = 2;

export interface WorldSample {
  frame: number;
  t: number;
  x: number; // meters east
  y: number; // meters north
  /** Direction of travel, radians, counter-clockwise from east (atan2(dY, dX)). */
  heading: number;
  /** Meters per second over the motion window. */
  speed: number;
}

export interface WorldTrack {
  id: number;
  cls: VehicleClass;
  samples: WorldSample[];
  start: number;
  end: number;
}

export interface WorldTracks {
  tracks: WorldTrack[];
  fps: number;
  /** Per class, the number of tracks: an exact upper bound on how many can be on screen at once. */
  perClass: Record<VehicleClass, number>;
  /** Observations that could not be placed, so problems stay visible. */
  dropped: { aboveHorizon: number; outsideArea: number };
}

export type TwinState = "observed" | "gap" | "lost";

export interface TwinVehicle {
  trackId: number;
  cls: VehicleClass;
  x: number;
  y: number;
  heading: number;
  speed: number;
  state: TwinState;
}

function emptyPerClass(): Record<VehicleClass, number> {
  return { motorcycle: 0, car: 0, bus: 0, truck: 0 };
}

/** Shortest signed angle from a to b. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Smooths, then derives heading and speed, for one track's raw world points (sorted by frame). */
function buildSamples(raw: { frame: number; x: number; y: number }[], fps: number): WorldSample[] {
  const n = raw.length;
  // The window is kept symmetric (shrunk at track ends and next to gaps), so steady motion isn't
  // dragged behind or ahead of where the vehicle really is.
  const smooth: { frame: number; x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    let left = 0;
    for (let j = i - 1; j >= 0 && raw[i].frame - raw[j].frame <= SMOOTH_FRAMES; j--) left = raw[i].frame - raw[j].frame;
    let right = 0;
    for (let j = i + 1; j < n && raw[j].frame - raw[i].frame <= SMOOTH_FRAMES; j++) right = raw[j].frame - raw[i].frame;
    const half = Math.min(left, right);
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (let j = i; j >= 0 && raw[i].frame - raw[j].frame <= half; j--) {
      sx += raw[j].x;
      sy += raw[j].y;
      count++;
    }
    for (let j = i + 1; j < n && raw[j].frame - raw[i].frame <= half; j++) {
      sx += raw[j].x;
      sy += raw[j].y;
      count++;
    }
    smooth.push({ frame: raw[i].frame, x: sx / count, y: sy / count });
  }

  const window = Math.max(1, Math.round(MOTION_WINDOW_S * fps));
  const headings = new Array<number>(n).fill(Number.NaN);
  const speeds = new Array<number>(n).fill(0);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (smooth[i].frame - smooth[lo].frame > window) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && smooth[hi + 1].frame - smooth[i].frame <= window) hi++;
    const a = smooth[lo];
    const b = smooth[hi];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dt = (b.frame - a.frame) / fps;
    const moved = Math.hypot(dx, dy);
    speeds[i] = dt > 0 ? moved / dt : 0;
    if (moved >= MIN_HEADING_MOVE_M) headings[i] = Math.atan2(dy, dx);
  }
  // A standing vehicle keeps the heading it had (or, at the start of a track, the one it gets next).
  let last = Number.NaN;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(headings[i])) headings[i] = last;
    else last = headings[i];
  }
  last = Number.NaN;
  for (let i = n - 1; i >= 0; i--) {
    if (Number.isNaN(headings[i])) headings[i] = last;
    else last = headings[i];
  }

  return smooth.map((p, i) => ({
    frame: p.frame,
    t: p.frame / fps,
    x: p.x,
    y: p.y,
    heading: Number.isNaN(headings[i]) ? Math.PI / 2 : headings[i], // never moved: face north
    speed: speeds[i],
  }));
}

/** Projects every track of a clip onto the road plane. */
export function buildWorldTracks(index: ObservationIndex, cal: Calibration, margin = defaultMargin(cal)): WorldTracks {
  const fps = index.data.fps;
  const tracks: WorldTrack[] = [];
  const perClass = emptyPerClass();
  const dropped = { aboveHorizon: 0, outsideArea: 0 };

  for (const [id, points] of index.tracks) {
    const raw: { frame: number; x: number; y: number }[] = [];
    for (const p of points) {
      const w = imageToWorld(cal, p.obj.ground_px);
      if (!w) {
        dropped.aboveHorizon++;
        continue;
      }
      if (!insideCalibratedArea(cal, w, margin)) {
        dropped.outsideArea++;
        continue;
      }
      raw.push({ frame: p.frame, x: w[0], y: w[1] });
    }
    if (raw.length === 0) continue;
    const samples = buildSamples(raw, fps);
    // A tracker can flip a class between frames; the most frequent one wins.
    const votes = emptyPerClass();
    for (const p of points) votes[p.obj.cls]++;
    const cls = (Object.keys(votes) as VehicleClass[]).reduce((a, b) => (votes[b] > votes[a] ? b : a));
    perClass[cls]++;
    tracks.push({ id, cls, samples, start: samples[0].t, end: samples[samples.length - 1].t });
  }
  tracks.sort((a, b) => a.start - b.start || a.id - b.id);
  return { tracks, fps, perClass, dropped };
}

/** Index of the last sample with t <= time (binary search); -1 when time is before the first. */
function sampleBefore(samples: WorldSample[], time: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  if (time < samples[0].t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].t <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Fills `out` with the vehicles to draw at media time `time` (seconds, the shared clock) and returns
 * it. Reuses the array so the 60 fps render loop doesn't allocate a new one each frame.
 */
export function vehiclesAt(world: WorldTracks, time: number, out: TwinVehicle[] = []): TwinVehicle[] {
  out.length = 0;
  const eps = 1e-6;
  for (const track of world.tracks) {
    if (track.start > time + eps) break; // sorted by start: nothing later has begun
    if (time > track.end + MAX_HOLD_S) continue;
    const s = track.samples;
    const i = sampleBefore(s, time + eps);
    if (i < 0) continue;
    const a = s[i];
    const b = s[i + 1];

    if (!b) {
      // After the last sighting: hold briefly, then the vehicle is gone.
      const exact = time - a.t <= eps;
      out.push({ trackId: track.id, cls: track.cls, x: a.x, y: a.y, heading: a.heading, speed: 0, state: exact ? "observed" : "lost" });
      continue;
    }
    const span = b.t - a.t;
    if (span > MAX_INTERP_S + eps) {
      // A long gap: hold at the last sighting for a moment, then hide until the tracker finds it again.
      if (time - a.t > MAX_HOLD_S) continue;
      const exact = time - a.t <= eps;
      out.push({ trackId: track.id, cls: track.cls, x: a.x, y: a.y, heading: a.heading, speed: 0, state: exact ? "observed" : "lost" });
      continue;
    }
    const k = span > 0 ? Math.min(Math.max((time - a.t) / span, 0), 1) : 0;
    out.push({
      trackId: track.id,
      cls: track.cls,
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
      heading: a.heading + angleDelta(a.heading, b.heading) * k,
      speed: a.speed + (b.speed - a.speed) * k,
      state: b.frame - a.frame <= OBSERVED_MAX_STEP ? "observed" : "gap",
    });
  }
  return out;
}

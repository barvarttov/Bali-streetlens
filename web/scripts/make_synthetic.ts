// Generates FAKE observations for development:
//   fixtures/synthetic.json        observations in the real schema, with "source": "synthetic"
//   fixtures/synthetic.truth.json  the known right answers (crossings, excluded tracks, queue interval)
//
// The truth is computed from noise-free positions; the observations get detector-like noise.
// That makes the fixture a test oracle for metrics.ts. It matches config/synthetic.yaml.
// Run: npm run fixture   (deterministic: same output on every machine)

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION } from "../src/lib/schema.ts";
import type { BBox, FrameRecord, ObservedObject, Observations, VehicleClass } from "../src/lib/schema.ts";

const FPS = 25;
const DURATION_S = 40;
const FRAME_COUNT = FPS * DURATION_S;
const [W, H] = [1280, 720];
const LINE_Y = 430; // both count lines in config/synthetic.yaml sit on y = 430
const NB_LINE_X: [number, number] = [390, 650]; // nb_stop
const SB_LINE_X: [number, number] = [660, 900]; // sb_lane
const QUEUE_REGION = { x: [400, 640], y: [432, 720] }; // northbound_queue (a rectangle)
const RED_S: [number, number] = [6, 24]; // northbound red phase
const STOP_Y = 442; // where the first northbound vehicle waits during red
const MIN_TRACK_FRAMES = 5;
const STOP_SPEED_PX_S = 8;
const MIN_VEHICLES = 5;
const MIN_STOPPED_S = 10;

// Deterministic PRNG (mulberry32).
let seed = 20261102;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
}
function gauss(sigma: number): number {
  return sigma * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

interface Lane {
  x: number;
  dir: -1 | 1; // -1 = moving up the image (northbound)
  cls: VehicleClass;
  speed: number; // px/s
  headwayS: number;
  gap: number; // px between queued vehicles
  stopsOnRed: boolean;
  nextSpawnT: number;
}

const lanes: Lane[] = [
  { x: 470, dir: -1, cls: "motorcycle", speed: 150, headwayS: 1.6, gap: 46, stopsOnRed: true, nextSpawnT: 0.3 },
  { x: 585, dir: -1, cls: "car", speed: 120, headwayS: 3.5, gap: 80, stopsOnRed: true, nextSpawnT: 1.0 },
  { x: 715, dir: 1, cls: "car", speed: 125, headwayS: 4.0, gap: 80, stopsOnRed: false, nextSpawnT: 0.6 },
  { x: 830, dir: 1, cls: "motorcycle", speed: 160, headwayS: 1.9, gap: 46, stopsOnRed: false, nextSpawnT: 0.1 },
];

interface Vehicle {
  id: number;
  cls: VehicleClass;
  lane: Lane | null; // null = scripted special track
  speedFactor: number;
  x: number;
  y: number; // true ground point
  noise: number; // detector noise sigma for this vehicle, px
  history: { frame: number; x: number; y: number }[]; // true positions while visible
}

let nextId = 1;
const active: Vehicle[] = [];
const finished: Vehicle[] = [];
const frames: FrameRecord[] = [];

const isRed = (t: number) => t >= RED_S[0] && t < RED_S[1];

// Special tracks that test the counting rules.
const FLICKER_START = Math.round(30 * FPS); // 3 noisy frames crossing nb_stop: must NOT count
const flickerYs = [437, 431, 425];
const HESITATE_START_T = 31; // a rider who waits 1.2 s right at nb_stop: must count exactly once
const HOLD_Y = 431;
const HOLD_S = 1.2;
let flicker: Vehicle | null = null;
let hesitant: Vehicle | null = null;
let hesitantHoldUntil = Infinity;

function boxFor(cls: VehicleClass, gx: number, gy: number): BBox {
  const s = 0.55 + 0.45 * (gy / H); // farther (higher up) = smaller
  const [w, h] = cls === "motorcycle" ? [30 * s, 58 * s] : [80 * s, 66 * s];
  const clampX = (v: number) => Math.min(Math.max(v, 0), W);
  const clampY = (v: number) => Math.min(Math.max(v, 0), H);
  return [clampX(gx - w / 2), clampY(gy - h), clampX(gx + w / 2), clampY(gy)];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

for (let frame = 0; frame < FRAME_COUNT; frame++) {
  const t = frame / FPS;
  const dt = 1 / FPS;

  // Spawn lane traffic (delayed while the entry point is still occupied by a queue).
  for (const lane of lanes) {
    if (t < lane.nextSpawnT) continue;
    const spawnY = lane.dir < 0 ? H + 40 : -40;
    const tail = active.filter((v) => v.lane === lane).sort((a, b) => lane.dir * (a.y - b.y))[0];
    if (tail && Math.abs(tail.y - spawnY) < lane.gap) continue;
    active.push({
      id: nextId++, cls: lane.cls, lane, speedFactor: 0.85 + 0.3 * rand(),
      x: lane.x + gauss(4), y: spawnY, noise: 1.0, history: [],
    });
    lane.nextSpawnT = t + lane.headwayS * (0.6 + 0.8 * rand());
  }
  if (frame === FLICKER_START) {
    flicker = { id: nextId++, cls: "motorcycle", lane: null, speedFactor: 1, x: 520, y: flickerYs[0], noise: 0, history: [] };
    active.push(flicker);
  }
  if (!hesitant && t >= HESITATE_START_T) {
    hesitant = { id: nextId++, cls: "motorcycle", lane: null, speedFactor: 1, x: 520, y: H + 10, noise: 1.0, history: [] };
    active.push(hesitant);
  }

  // Move lane traffic, front vehicle first, with simple car-following and the red light.
  for (const lane of lanes) {
    const inLane = active.filter((v) => v.lane === lane).sort((a, b) => lane.dir * (b.y - a.y));
    for (let i = 0; i < inLane.length; i++) {
      const v = inLane[i];
      let y = v.y + lane.dir * lane.speed * v.speedFactor * dt;
      if (lane.dir < 0) {
        if (lane.stopsOnRed && isRed(t) && v.y >= STOP_Y) y = Math.max(y, STOP_Y);
        if (i > 0) y = Math.max(y, Math.min(v.y, inLane[i - 1].y + lane.gap));
      } else if (i > 0) {
        y = Math.min(y, Math.max(v.y, inLane[i - 1].y - lane.gap));
      }
      v.y = y;
    }
  }
  if (flicker) {
    const k = frame - FLICKER_START;
    if (k < flickerYs.length) flicker.y = flickerYs[k];
    else flicker.y = -1000; // gone
  }
  if (hesitant && hesitant.y > -100) {
    if (hesitant.y > HOLD_Y || t >= hesitantHoldUntil) {
      hesitant.y -= 150 * dt;
      if (hesitant.y <= HOLD_Y && hesitantHoldUntil === Infinity) {
        hesitant.y = HOLD_Y;
        hesitantHoldUntil = t + HOLD_S;
        hesitant.noise = 2.5; // a jittery box while waiting: the observed point wobbles across the line
      }
    }
    if (t >= hesitantHoldUntil) hesitant.noise = 1.0;
  }

  // Emit observations for visible vehicles; retire vehicles that have left.
  const objects: ObservedObject[] = [];
  for (const v of [...active]) {
    const visible = v.y >= 0 && v.y <= H;
    if (visible) {
      v.history.push({ frame, x: v.x, y: v.y });
      const bbox = boxFor(v.cls, v.x + gauss(v.noise), v.y + gauss(v.noise));
      objects.push({
        track_id: v.id, cls: v.cls, conf: Math.round((0.5 + 0.45 * rand()) * 100) / 100,
        bbox_px: bbox.map(r1) as BBox, ground_px: [r1((bbox[0] + bbox[2]) / 2), r1(bbox[3])],
      });
    } else if (v.y < -60 || v.y > H + 60) {
      active.splice(active.indexOf(v), 1);
      finished.push(v);
    }
  }
  if (objects.length > 0) frames.push({ frame, t: Math.round(t * 1000) / 1000, objects });
}
finished.push(...active);

// ---- Ground truth from noise-free positions ----
type Dir = "in" | "out";
const counts: Record<string, Record<Dir, Partial<Record<VehicleClass, number>>>> = {
  nb_stop: { in: {}, out: {} },
  sb_lane: { in: {}, out: {} },
};
const crossingEvents: { track_id: number; cls: VehicleClass; line: string; dir: Dir; frame: number }[] = [];
const excluded: { track_id: number; reason: string }[] = [];

for (const v of finished.sort((a, b) => a.id - b.id)) {
  const h = v.history;
  if (h.length === 0) continue; // spawned but never entered the frame before the clip ended
  if (h.length < MIN_TRACK_FRAMES) {
    excluded.push({ track_id: v.id, reason: `visible ${h.length} frames < min_track_frames ${MIN_TRACK_FRAMES}` });
    continue;
  }
  for (let i = 1; i < h.length; i++) {
    const [a, b] = [h[i - 1], h[i]];
    const movingUp = a.y > LINE_Y && b.y <= LINE_Y;
    const movingDown = a.y < LINE_Y && b.y >= LINE_Y;
    if (!movingUp && !movingDown) continue;
    const x = b.x;
    // nb_stop is drawn left->right, so moving up = "in"; sb_lane is drawn right->left, so moving down = "in".
    let line: string | null = null;
    let dir: Dir = "in";
    if (x >= NB_LINE_X[0] && x <= NB_LINE_X[1]) [line, dir] = ["nb_stop", movingUp ? "in" : "out"];
    else if (x >= SB_LINE_X[0] && x <= SB_LINE_X[1]) [line, dir] = ["sb_lane", movingDown ? "in" : "out"];
    if (!line) continue;
    const bucket = counts[line][dir];
    bucket[v.cls] = (bucket[v.cls] ?? 0) + 1;
    crossingEvents.push({ track_id: v.id, cls: v.cls, line, dir, frame: b.frame });
    break; // a real vehicle crosses once
  }
}

// Queue truth: >= MIN_VEHICLES vehicles in the region, each stopped for >= MIN_STOPPED_S.
const stoppedSince = new Map<number, number>();
const queueFrames: boolean[] = [];
const byFrame = new Map<number, { id: number; x: number; y: number; prevY?: number }[]>();
for (const v of finished) {
  v.history.forEach((p, i) => {
    const list = byFrame.get(p.frame) ?? [];
    list.push({ id: v.id, x: p.x, y: p.y, prevY: i > 0 && v.history[i - 1].frame === p.frame - 1 ? v.history[i - 1].y : undefined });
    byFrame.set(p.frame, list);
  });
}
for (let frame = 0; frame < FRAME_COUNT; frame++) {
  let longStopped = 0;
  for (const p of byFrame.get(frame) ?? []) {
    const inRegion = p.x >= QUEUE_REGION.x[0] && p.x <= QUEUE_REGION.x[1] && p.y >= QUEUE_REGION.y[0] && p.y <= QUEUE_REGION.y[1];
    const stopped = p.prevY !== undefined && Math.abs(p.y - p.prevY) * FPS < STOP_SPEED_PX_S;
    if (!inRegion || !stopped) {
      stoppedSince.delete(p.id);
      continue;
    }
    if (!stoppedSince.has(p.id)) stoppedSince.set(p.id, frame);
    if ((frame - stoppedSince.get(p.id)!) / FPS >= MIN_STOPPED_S) longStopped++;
  }
  queueFrames.push(longStopped >= MIN_VEHICLES);
}
const queueIntervals: { region: string; start_t: number; end_t: number; expected_label: string }[] = [];
for (let f = 0; f < FRAME_COUNT; f++) {
  if (!queueFrames[f] || (f > 0 && queueFrames[f - 1])) continue;
  let end = f;
  while (end + 1 < FRAME_COUNT && queueFrames[end + 1]) end++;
  queueIntervals.push({ region: "northbound_queue", start_t: f / FPS, end_t: (end + 1) / FPS, expected_label: "stopped_no_flow" });
}

// ---- Write files ----
const observations: Observations = {
  schema_version: SCHEMA_VERSION,
  camera_id: "synthetic",
  source: "synthetic",
  video_file: "synthetic_sync.mp4",
  video_start_time: null,
  fps: FPS,
  frame_size: [W, H],
  frame_count: FRAME_COUNT,
  model: "none (synthetic)",
  tracker: "none (synthetic)",
  frames,
};
const truth = {
  note: "Ground truth for fixtures/synthetic.json, computed from noise-free positions. NOT real traffic.",
  fps: FPS,
  frame_count: FRAME_COUNT,
  counts,
  crossing_events: crossingEvents,
  excluded_tracks: excluded,
  debounce_tracks: hesitant
    ? [{ track_id: hesitant.id, note: `waits ${HOLD_S} s at nb_stop with a jittery box; must count exactly once` }]
    : [],
  signal_truth: { nb_stop: { red_intervals_s: [RED_S] } },
  queue_intervals: queueIntervals,
};

const fixturesDir = join(import.meta.dirname, "..", "..", "fixtures");
writeFileSync(join(fixturesDir, "synthetic.json"), JSON.stringify(observations));
writeFileSync(join(fixturesDir, "synthetic.truth.json"), JSON.stringify(truth, null, 2) + "\n");

const total = (line: string, dir: Dir) => Object.values(counts[line][dir]).reduce((a, b) => a + (b ?? 0), 0);
console.log(`synthetic.json: ${frames.length} frames with objects, ${finished.length} tracks`);
console.log(`truth: nb_stop in=${total("nb_stop", "in")}, sb_lane in=${total("sb_lane", "in")}, ` +
  `excluded=${excluded.length}, queue intervals=${JSON.stringify(queueIntervals.map((q) => [q.start_t, q.end_t]))}`);

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calibrate } from "./homography.ts";
import type { Calibration } from "./homography.ts";
import { indexObservations, validateObservations } from "./observations.ts";
import type { FrameRecord, Observations, ObservedObject, Px, VehicleClass } from "./schema.ts";
import { MAX_HOLD_S, buildWorldTracks, vehiclesAt } from "./worldTracks.ts";

// Simple top-down camera: 0.1 m per pixel, y down in the image = south in the world.
function topDown(): Calibration {
  const img: Px[] = [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [500, 500]];
  const r = calibrate({
    image_points_px: img,
    world_points_m: img.map(([x, y]) => [x / 10, (1000 - y) / 10]),
    holdout_image_px: [],
    holdout_world_m: [],
  });
  if (!r.ok) throw new Error(r.reason);
  return r.calibration;
}

function obj(track_id: number, ground: Px, cls: VehicleClass = "car"): ObservedObject {
  return { track_id, cls, conf: 0.9, bbox_px: [ground[0] - 10, ground[1] - 20, ground[0] + 10, ground[1]], ground_px: ground };
}

function clip(frames: FrameRecord[], frameCount = 200): Observations {
  return {
    schema_version: 1, camera_id: "test", source: "synthetic", video_file: "x.mp4", video_start_time: null,
    fps: 25, frame_size: [1000, 1000], frame_count: frameCount, model: "test", tracker: "test", frames,
  };
}

/** Track 1 drives north (up the image) 5 px per frame = 12.5 m/s, frames 0-49, missing 20-29. */
function northbound(): Observations {
  const frames: FrameRecord[] = [];
  for (let f = 0; f < 50; f++) {
    if (f >= 20 && f < 30) continue;
    frames.push({ frame: f, t: f / 25, objects: [obj(1, [500, 900 - 5 * f])] });
  }
  return clip(frames);
}

test("a pixel track becomes meters, heading north, at the right speed", () => {
  const world = buildWorldTracks(indexObservations(northbound()), topDown());
  assert.equal(world.tracks.length, 1);
  const v = vehiclesAt(world, 10 / 25)[0];
  assert.equal(v.state, "observed");
  assert.ok(Math.abs(v.x - 50) < 1e-6, `x ${v.x}`);
  assert.ok(Math.abs(v.y - (100 - 90 + 5)) < 1e-6, `y ${v.y}`); // pixel y 850 -> 15 m north
  assert.ok(Math.abs(v.heading - Math.PI / 2) < 1e-6, `heading ${v.heading}`);
  assert.ok(Math.abs(v.speed - 12.5) < 1e-6, `speed ${v.speed}`);
});

test("between video frames the position is interpolated, so 60 fps rendering is smooth", () => {
  const world = buildWorldTracks(indexObservations(northbound()), topDown());
  const a = vehiclesAt(world, 10 / 25)[0].y;
  const b = vehiclesAt(world, 11 / 25)[0].y;
  const mid = vehiclesAt(world, 10.5 / 25)[0].y;
  assert.ok(Math.abs(mid - (a + b) / 2) < 1e-9);
});

test("a short tracking gap is bridged and marked as a gap", () => {
  const world = buildWorldTracks(indexObservations(northbound()), topDown());
  const v = vehiclesAt(world, 25 / 25)[0];
  assert.equal(v.state, "gap");
  assert.ok(v.y > vehiclesAt(world, 19 / 25)[0].y && v.y < vehiclesAt(world, 30 / 25)[0].y);
  assert.equal(vehiclesAt(world, 31 / 25)[0].state, "observed");
});

test("a lost track lingers about a second, then is gone (no ghosts)", () => {
  const world = buildWorldTracks(indexObservations(northbound()), topDown());
  const last = 49 / 25;
  assert.equal(vehiclesAt(world, last)[0].state, "observed");
  assert.equal(vehiclesAt(world, last + 0.5)[0].state, "lost");
  assert.equal(vehiclesAt(world, last + MAX_HOLD_S + 0.05).length, 0);
  assert.equal(vehiclesAt(world, -0.1).length, 0);
});

test("a gap longer than a second is not invented: held briefly, then hidden until found again", () => {
  const frames: FrameRecord[] = [];
  for (let f = 0; f < 10; f++) frames.push({ frame: f, t: f / 25, objects: [obj(1, [500, 900 - 5 * f])] });
  for (let f = 100; f < 110; f++) frames.push({ frame: f, t: f / 25, objects: [obj(1, [500, 400 - 5 * f + 500])] });
  const world = buildWorldTracks(indexObservations(clip(frames)), topDown());
  assert.equal(vehiclesAt(world, 9 / 25 + 0.5)[0].state, "lost");
  assert.equal(vehiclesAt(world, 60 / 25).length, 0);
  assert.equal(vehiclesAt(world, 100 / 25)[0].state, "observed");
});

test("a waiting vehicle keeps its heading instead of spinning on detector noise", () => {
  const frames: FrameRecord[] = [];
  for (let f = 0; f < 60; f++) {
    const moving = f < 20;
    const y = moving ? 900 - 5 * f : 805 + (f % 2 ? 1.5 : -1.5); // stops, box jitters +-1.5 px
    frames.push({ frame: f, t: f / 25, objects: [obj(1, [500 + (f % 3) - 1, y])] });
  }
  const world = buildWorldTracks(indexObservations(clip(frames)), topDown());
  const stopped = vehiclesAt(world, 50 / 25)[0];
  assert.ok(Math.abs(stopped.heading - Math.PI / 2) < 0.2, `heading ${stopped.heading}`);
  assert.ok(stopped.speed < 1, `speed ${stopped.speed}`);
});

test("class votes: a track that flickers to another class keeps its majority class", () => {
  const frames: FrameRecord[] = [];
  for (let f = 0; f < 10; f++) frames.push({ frame: f, t: f / 25, objects: [obj(1, [500, 500], f === 4 ? "truck" : "motorcycle")] });
  const world = buildWorldTracks(indexObservations(clip(frames)), topDown());
  assert.equal(world.tracks[0].cls, "motorcycle");
  assert.equal(world.perClass.motorcycle, 1);
});

// ---------------------------------------------------------------------------------------------
// The synthetic fixture with the synthetic camera's calibration from config/synthetic.yaml.

function yamlList(yaml: string, key: string): [number, number][] {
  const m = new RegExp(`^\\s*${key}:\\s*(\\[.*\\])\\s*$`, "m").exec(yaml);
  if (!m) throw new Error(`${key} not found in config/synthetic.yaml`);
  return JSON.parse(m[1]) as [number, number][]; // a YAML flow list of numbers is valid JSON
}

test("fixture: every synthetic vehicle lands on the 16 m road, in its own lane, at street speeds", () => {
  const yaml = readFileSync(new URL("../../../config/synthetic.yaml", import.meta.url), "utf8");
  const r = calibrate({
    image_points_px: yamlList(yaml, "image_points_px"),
    world_points_m: yamlList(yaml, "world_points_m"),
    holdout_image_px: yamlList(yaml, "holdout_image_px"),
    holdout_world_m: yamlList(yaml, "holdout_world_m"),
  });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(r.calibration.holdoutMax! < 0.25, `holdout max ${r.calibration.holdoutMax} m`);

  const raw = JSON.parse(readFileSync(new URL("../../../fixtures/synthetic.json", import.meta.url), "utf8"));
  const world = buildWorldTracks(indexObservations(validateObservations(raw)), r.calibration);
  assert.ok(world.tracks.length > 50, `${world.tracks.length} tracks`);
  assert.equal(world.dropped.aboveHorizon + world.dropped.outsideArea, 0);

  for (const track of world.tracks) {
    for (const s of track.samples) {
      assert.ok(Math.abs(s.x) < 8.5 && s.y > -1 && s.y < 44, `track ${track.id} off the road at ${s.x}, ${s.y}`);
      assert.ok(s.speed < 20, `track ${track.id} at ${s.speed} m/s`);
    }
    const moving = track.samples.filter((s) => s.speed > 2);
    if (moving.length === 0) continue;
    // Left-hand traffic: northbound (heading ~ +90 deg) on the west half, southbound on the east half.
    const s = moving[Math.floor(moving.length / 2)];
    const north = Math.sin(s.heading) > 0.9;
    const south = Math.sin(s.heading) < -0.9;
    assert.ok(north || south, `track ${track.id} heading ${s.heading}`);
    if (north) assert.ok(s.x < 0, `northbound track ${track.id} at x ${s.x}`);
    if (south) assert.ok(s.x > 0, `southbound track ${track.id} at x ${s.x}`);
  }

  // At any time, the drawn vehicles fit the per-class capacity the renderer allocates.
  for (let t = 0; t < 40; t += 0.37) {
    const counts: Record<VehicleClass, number> = { motorcycle: 0, car: 0, bus: 0, truck: 0 };
    for (const v of vehiclesAt(world, t)) counts[v.cls]++;
    for (const cls of Object.keys(counts) as VehicleClass[]) assert.ok(counts[cls] <= world.perClass[cls]);
  }
});

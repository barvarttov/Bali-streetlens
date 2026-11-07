import { test } from "node:test";
import assert from "node:assert/strict";
import { fromLocalMeters, toLocalMeters } from "./geo.ts";
import type { LngLat } from "./geo.ts";
import { alongRoad, roadFrame } from "./roadPlacement.ts";
import type { CameraRoad } from "./roadPlacement.ts";

const O: LngLat = [115.4037, -8.5355];
const at = (e: number, n: number) => fromLocalMeters(O, [e, n]);

// A straight east-west road: 20 m west of the snap point, 60 m east of it.
const road: CameraRoad = { name: "Jl. Uji", width_m: 8, snap: at(0, 0), snap_index: 1, line: [at(-20, 0), at(0, 0), at(60, 0)] };

test("the camera looks along the longer side of the road", () => {
  const f = roadFrame(road)!;
  assert.ok(f);
  assert.ok(Math.abs(f.cum[f.cum.length - 1] - 60) < 0.05);
  const p = alongRoad(f, 30, 0);
  const [e, n] = toLocalMeters(O, p.lnglat);
  assert.ok(Math.abs(e - 30) < 0.05 && Math.abs(n) < 0.05, `${e}, ${n}`);
  assert.ok(Math.abs(p.heading) < 1e-6); // facing east
});

test("lateral offset goes to the right of the viewing direction", () => {
  const f = roadFrame(road)!;
  const [, n] = toLocalMeters(O, alongRoad(f, 10, 3).lnglat);
  assert.ok(Math.abs(n + 3) < 0.05, `right of east is south, got ${n}`);
});

test("positions stay on the road ends and follow a bend", () => {
  const bend: CameraRoad = { name: null, width_m: 6, snap: at(0, 0), snap_index: 0, line: [at(0, 0), at(10, 0), at(10, 30)] };
  const f = roadFrame(bend)!;
  const [e, n] = toLocalMeters(O, alongRoad(f, 25, 0).lnglat);
  assert.ok(Math.abs(e - 10) < 0.05 && Math.abs(n - 15) < 0.05, `${e}, ${n}`);
  const [e2, n2] = toLocalMeters(O, alongRoad(f, 999, 0).lnglat);
  assert.ok(Math.abs(e2 - 10) < 0.05 && Math.abs(n2 - 30) < 0.05, "clamped to the end");
});

test("a road stub shorter than 5 m is not used", () => {
  assert.equal(roadFrame({ name: null, width_m: 6, snap: at(0, 0), snap_index: 0, line: [at(0, 0), at(3, 0)] }), null);
});

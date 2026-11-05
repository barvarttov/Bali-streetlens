import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHomography, calibrate, fitHomography, imageToWorld, invert3, multiply3, worldToImage } from "./homography.ts";
import type { Meters, Px } from "./schema.ts";

// A plausible perspective camera: road plane seen from above and behind, horizon near the top.
const TRUE_H = [0.02, -0.004, -12.5, 0.0005, -0.09, 70, 0.000002, 0.0021, 0.35];
const project = (p: Px): Meters => applyHomography(TRUE_H, p);

const IMAGE: Px[] = [
  [100, 700], [1180, 700], [300, 300], [980, 300], [640, 500], [200, 520], [1080, 520], [640, 250],
];
const HOLDOUT: Px[] = [[420, 600], [860, 400], [640, 350]];

const close = (a: readonly number[], b: readonly number[], tol: number) =>
  a.every((v, i) => Math.abs(v - b[i]) <= tol * Math.max(1, Math.abs(b[i])));

test("exact points: the fit recovers the homography and hold-out error is ~0", () => {
  const r = calibrate({
    image_points_px: IMAGE,
    world_points_m: IMAGE.map(project),
    holdout_image_px: HOLDOUT,
    holdout_world_m: HOLDOUT.map(project),
  });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const { calibration: cal } = r;
  const scale = TRUE_H[8] / cal.H[8];
  assert.ok(close(cal.H.map((v) => v * scale), TRUE_H, 1e-6), `H ${cal.H}`);
  assert.ok(cal.fitRms < 1e-6, `fit rms ${cal.fitRms}`);
  assert.ok(cal.holdoutMax !== null && cal.holdoutMax < 1e-6, `holdout ${cal.holdoutMax}`);
});

test("four points are enough; more points average out measurement noise", () => {
  const four = IMAGE.slice(0, 4);
  const H4 = fitHomography(four, four.map(project));
  for (const p of IMAGE) assert.ok(close(applyHomography(H4, p), project(p), 1e-6));

  // +-10 cm noise on the world points: hold-out error stays in the same range, not meters.
  const noise = [0.1, -0.08, 0.05, -0.1, 0.07, -0.04, 0.09, -0.06];
  const r = calibrate({
    image_points_px: IMAGE,
    world_points_m: IMAGE.map((p, i) => {
      const [x, y] = project(p);
      return [x + noise[i], y - noise[(i + 3) % 8]];
    }),
    holdout_image_px: HOLDOUT,
    holdout_world_m: HOLDOUT.map(project),
  });
  assert.ok(r.ok);
  assert.ok(r.calibration.holdoutMax! < 0.3, `holdout max ${r.calibration.holdoutMax}`);
  assert.equal(r.calibration.fitErrors.length, IMAGE.length);
});

test("world -> image is the inverse of image -> world", () => {
  const r = calibrate({ image_points_px: IMAGE, world_points_m: IMAGE.map(project), holdout_image_px: [], holdout_world_m: [] });
  assert.ok(r.ok);
  const I = multiply3(r.calibration.H, invert3(r.calibration.H));
  assert.ok(close(I.map((v) => v / I[8]), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-9));
  for (const p of HOLDOUT) assert.ok(close(worldToImage(r.calibration, imageToWorld(r.calibration, p)!)!, p, 1e-6));
  assert.equal(r.calibration.holdoutMean, null);
});

test("pixels above the horizon are sky, not road", () => {
  const r = calibrate({ image_points_px: IMAGE, world_points_m: IMAGE.map(project), holdout_image_px: [], holdout_world_m: [] });
  assert.ok(r.ok);
  // TRUE_H's horizon: w = 0 at y = -(0.35 + 0.000002 x) / 0.0021, about y = -167 (above the frame).
  assert.equal(imageToWorld(r.calibration, [640, -400]), null);
  assert.notEqual(imageToWorld(r.calibration, [640, 100]), null);
});

test("bad calibration blocks give a readable reason instead of a wrong 3D", () => {
  const empty = calibrate({ image_points_px: [], world_points_m: [], holdout_image_px: [], holdout_world_m: [] });
  assert.equal(empty.ok, false);

  const three = calibrate({ image_points_px: IMAGE.slice(0, 3), world_points_m: IMAGE.slice(0, 3).map(project), holdout_image_px: [], holdout_world_m: [] });
  assert.ok(!three.ok && /at least 4/.test(three.reason));

  const unpaired = calibrate({ image_points_px: IMAGE, world_points_m: IMAGE.slice(1).map(project), holdout_image_px: [], holdout_world_m: [] });
  assert.ok(!unpaired.ok && /pair up/.test(unpaired.reason));

  const line: Px[] = [[0, 0], [100, 100], [200, 200], [300, 300], [400, 400]];
  const collinear = calibrate({ image_points_px: line, world_points_m: line.map(([x, y]) => [x / 10, y / 10]), holdout_image_px: [], holdout_world_m: [] });
  assert.ok(!collinear.ok && /straight line/.test(collinear.reason), collinear.ok ? "fitted" : collinear.reason);

  const holdout = calibrate({ image_points_px: IMAGE, world_points_m: IMAGE.map(project), holdout_image_px: HOLDOUT, holdout_world_m: [] });
  assert.ok(!holdout.ok && /holdout/.test(holdout.reason));
});

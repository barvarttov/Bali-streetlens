import { test } from "node:test";
import assert from "node:assert/strict";
import { fromLocalMeters, metersPerDegree, parseCoordinate, toLocalMeters } from "./geo.ts";
import { configToYaml } from "./configYaml.ts";
import { normalizeConfig } from "./config.ts";
import type { LngLat } from "./geo.ts";

const PATUNG_KUDA: LngLat = [115.179105, -8.744676];

test("meters per degree at Bali's latitude match the WGS84 ellipsoid", () => {
  // Closed forms: meridian and prime-vertical radii of curvature, a = 6378137 m, e² = 0.00669438.
  const a = 6378137;
  const e2 = 0.00669437999014;
  const p = (-8.74 * Math.PI) / 180;
  const w = 1 - e2 * Math.sin(p) ** 2;
  const lat = ((a * (1 - e2)) / w ** 1.5) * (Math.PI / 180);
  const lng = ((a * Math.cos(p)) / Math.sqrt(w)) * (Math.PI / 180);
  const k = metersPerDegree(-8.74);
  assert.ok(Math.abs(k.lat - lat) < 0.05, `lat ${k.lat} vs ${lat}`);
  assert.ok(Math.abs(k.lng - lng) < 0.05, `lng ${k.lng} vs ${lng}`);
});

test("local meters: X east, Y north, and back again", () => {
  const east = toLocalMeters(PATUNG_KUDA, [PATUNG_KUDA[0] + 0.0001, PATUNG_KUDA[1]]);
  assert.ok(east[0] > 10.9 && east[0] < 11.1 && Math.abs(east[1]) < 1e-9);
  const north = toLocalMeters(PATUNG_KUDA, [PATUNG_KUDA[0], PATUNG_KUDA[1] + 0.0001]);
  assert.ok(north[1] > 11 && north[1] < 11.1 && Math.abs(north[0]) < 1e-9);
  const back = fromLocalMeters(PATUNG_KUDA, toLocalMeters(PATUNG_KUDA, [115.1802, -8.7439]));
  assert.ok(Math.abs(back[0] - 115.1802) < 1e-9 && Math.abs(back[1] + 8.7439) < 1e-9);
});

test("parses what people paste from Google Maps", () => {
  assert.deepEqual(parseCoordinate("-8.744676, 115.179105"), { kind: "lnglat", value: [115.179105, -8.744676] });
  assert.deepEqual(parseCoordinate("115.179105, -8.744676"), { kind: "lnglat", value: [115.179105, -8.744676] });
  assert.deepEqual(parseCoordinate("https://www.google.com/maps/@-8.7446761,115.1791052,20z"), {
    kind: "lnglat",
    value: [115.1791052, -8.7446761],
  });
  assert.deepEqual(parseCoordinate("  −8.7446 ,115.1791 "), { kind: "lnglat", value: [115.1791, -8.7446] });
});

test("parses meters, with dot or Indonesian comma decimals", () => {
  assert.deepEqual(parseCoordinate("3.5 m, 12 m"), { kind: "meters", value: [3.5, 12] });
  assert.deepEqual(parseCoordinate("-3,5 m; 12,25 m"), { kind: "meters", value: [-3.5, 12.25] });
});

test("rejects typos and places outside Bali", () => {
  assert.equal(parseCoordinate(""), null);
  assert.equal(parseCoordinate("abc"), null);
  assert.equal(parseCoordinate("-8.74"), null);
  assert.equal(parseCoordinate("-6.2, 106.8"), null); // Jakarta
  assert.equal(parseCoordinate("8.74, 115.17"), null); // north of the equator: sign dropped
});

test("config YAML has the schema's keys and survives the loader", () => {
  const config = normalizeConfig({
    camera_id: "simpang-patung-kuda",
    name: "Simpang \"Patung\" Kuda",
    road_polygon_px: [[0, 700], [1280, 700], [700.04, 200]],
    count_lines: [{ id: "kangin_in", px: [[100, 500], [600, 520]], approach: "kangin" }],
    queue_regions: [{ id: "kangin_q", polygon_px: [[100, 520], [600, 540], [600, 700]], stop_line: "kangin_in" }],
    calibration: {
      image_points_px: [[1, 2], [3, 4], [5, 6], [7, 8]],
      world_points_m: [[0.123, -0.004], [1, 2], [3, 4], [5, 6]],
      holdout_image_px: [],
      holdout_world_m: [],
    },
  });
  const yaml = configToYaml(config, { world_origin_lnglat: PATUNG_KUDA, image_size_px: [1280, 720], notes: ["made by a test"] });
  assert.match(yaml, /^# made by a test\ncamera_id: "simpang-patung-kuda"\n/);
  assert.match(yaml, /name: "Simpang \\"Patung\\" Kuda"/);
  assert.match(yaml, /world_origin_lnglat: \[115\.179105, -8\.744676\]/);
  assert.match(yaml, /image_size_px: \[1280, 720\]/);
  assert.match(yaml, /road_polygon_px: \[\[0, 700\], \[1280, 700\], \[700, 200\]\]/);
  assert.match(yaml, /  - id: "kangin_in"\n    px: \[\[100, 500\], \[600, 520\]\]\n    approach: "kangin"/);
  assert.match(yaml, /    stop_line: "kangin_in"/);
  assert.match(yaml, /  world_points_m: \[\[0\.12, 0\], \[1, 2\]/);
  assert.match(yaml, /  holdout_image_px: \[\]/);
  assert.match(yaml, /  stop_speed_m_s: 1\n/);
  assert.match(yaml, /counting:\n  min_track_frames: 5\n$/);
});

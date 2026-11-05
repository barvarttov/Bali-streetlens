// Writes a camera config as config/<camera_id>.yaml, in the layout of docs/schema.md, for the
// calibration tool (/tim/kalibrasi). The backend reads it with PyYAML's safe_load.
//
// Only what the schema needs: mappings, flow sequences of numbers, and strings in double quotes
// (JSON string syntax is valid YAML). Pure, runs in the browser and in Node 24 tests.

import type { CameraConfig, Px } from "./schema.ts";
import type { LngLat } from "./geo.ts";

export interface ConfigExtras {
  /** [lng, lat] of world (0, 0), so meters can be turned back into map positions. */
  world_origin_lnglat: LngLat | null;
  /** Size of the camera image the pixels were picked on; the analysed video must match it. */
  image_size_px: [number, number] | null;
  /** Shown as comments at the top of the file. */
  notes: string[];
}

const str = (s: string | null | undefined) => (s == null ? "null" : JSON.stringify(s));

/** Rounds so files stay readable: pixels to 0.1 px, meters to 1 cm, degrees to ~1 cm. */
const r = (n: number, digits: number) => {
  const v = Number(n.toFixed(digits));
  return Object.is(v, -0) ? 0 : v;
};
const pt = (p: readonly number[], digits: number) => `[${r(p[0], digits)}, ${r(p[1], digits)}]`;
const pts = (list: readonly (readonly number[])[], digits: number) => `[${list.map((p) => pt(p, digits)).join(", ")}]`;
const px = (list: readonly Px[]) => pts(list, 1);

export function configToYaml(c: CameraConfig, extras: ConfigExtras): string {
  const out: string[] = [];
  for (const note of extras.notes) out.push(`# ${note.replace(/\s*\n\s*/g, " ")}`);
  out.push(`camera_id: ${str(c.camera_id)}`);
  out.push(`name: ${str(c.name)}`);
  out.push(`google_maps_url: ${str(c.google_maps_url)}`);
  out.push(`world_origin: ${str(c.world_origin ?? null)}`);
  out.push(`world_origin_lnglat: ${extras.world_origin_lnglat ? pt(extras.world_origin_lnglat, 7) : "null"}`);
  out.push(`image_size_px: ${extras.image_size_px ? `[${extras.image_size_px[0]}, ${extras.image_size_px[1]}]` : "null"}`);
  out.push(`road_polygon_px: ${px(c.road_polygon_px)}`);

  if (c.count_lines.length === 0) out.push("count_lines: []");
  else {
    out.push("count_lines:");
    out.push("  # Each line is an arrow p1 -> p2; \"in\" = crossing to the left of the arrow on screen.");
    for (const line of c.count_lines) {
      out.push(`  - id: ${str(line.id)}`);
      out.push(`    px: ${px(line.px)}`);
      if (line.approach) out.push(`    approach: ${str(line.approach)}`);
    }
  }

  if (c.queue_regions.length === 0) out.push("queue_regions: []");
  else {
    out.push("queue_regions:");
    for (const q of c.queue_regions) {
      out.push(`  - id: ${str(q.id)}`);
      out.push(`    polygon_px: ${px(q.polygon_px)}`);
      out.push(`    stop_line: ${str(q.stop_line)}`);
    }
  }

  const cal = c.calibration;
  out.push("calibration:");
  out.push(`  image_points_px: ${px(cal.image_points_px)}`);
  out.push(`  world_points_m: ${pts(cal.world_points_m, 2)}`);
  out.push(`  holdout_image_px: ${px(cal.holdout_image_px)}`);
  out.push(`  holdout_world_m: ${pts(cal.holdout_world_m, 2)}`);

  out.push("signal:");
  out.push(`  mode: ${c.signal.mode}`);
  out.push(`  red_intervals_s: ${pts(c.signal.red_intervals_s, 2)}`);
  out.push("queue:");
  for (const [k, v] of Object.entries(c.queue)) out.push(`  ${k}: ${v}`);
  out.push("counting:");
  out.push(`  min_track_frames: ${c.counting.min_track_frames}`);
  return `${out.join("\n")}\n`;
}

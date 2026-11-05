// Fills defaults into a camera config (config/<camera_id>.yaml, served as JSON) so the UI and
// metrics never have to null-check sections. Runs in the browser and in Node 24.

import type { CameraConfig, Px } from "./schema.ts";

const DEFAULT_QUEUE: CameraConfig["queue"] = {
  stop_speed_m_s: 1.0,
  stop_speed_px_s: 8,
  min_vehicles: 5,
  min_stopped_s: 10,
  flow_window_s: 20,
  sustained_after_s: 30,
};

export function normalizeConfig(raw: unknown): CameraConfig {
  if (typeof raw !== "object" || raw === null) throw new Error("Camera config is not a YAML mapping.");
  const c = raw as Partial<CameraConfig> & { count_line_px?: [Px, Px] };
  if (typeof c.camera_id !== "string") throw new Error("Camera config needs a camera_id.");

  // PLAN.md's original single `count_line_px` still works; it becomes one line called "count_line".
  const countLines = c.count_lines ?? (c.count_line_px ? [{ id: "count_line", px: c.count_line_px }] : []);

  return {
    camera_id: c.camera_id,
    name: c.name ?? c.camera_id,
    google_maps_url: c.google_maps_url ?? null,
    world_origin: c.world_origin,
    road_polygon_px: c.road_polygon_px ?? [],
    count_lines: countLines,
    queue_regions: c.queue_regions ?? [],
    calibration: {
      image_points_px: c.calibration?.image_points_px ?? [],
      world_points_m: c.calibration?.world_points_m ?? [],
      holdout_image_px: c.calibration?.holdout_image_px ?? [],
      holdout_world_m: c.calibration?.holdout_world_m ?? [],
    },
    signal: {
      mode: c.signal?.mode ?? "inferred",
      red_intervals_s: c.signal?.red_intervals_s ?? [],
    },
    queue: { ...DEFAULT_QUEUE, ...c.queue },
    counting: { min_track_frames: c.counting?.min_track_frames ?? 5 },
  };
}

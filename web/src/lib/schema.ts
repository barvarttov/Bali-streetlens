// TypeScript mirror of docs/schema.md. Keep the two in sync; bump SCHEMA_VERSION together.
// Runs in the browser and in Node 24 (type stripping), so: erasable syntax only, no DOM APIs.

export const SCHEMA_VERSION = 1;

export const VEHICLE_CLASSES = ["motorcycle", "car", "bus", "truck"] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

/** Image point in pixels: [x, y], origin top-left, y down. */
export type Px = [number, number];
/** World point in meters: [X east, Y north]. */
export type Meters = [number, number];
/** [x1, y1, x2, y2] in pixels. */
export type BBox = [number, number, number, number];

export type DataSource = "recorded" | "synthetic" | "live";

export interface ObservedObject {
  track_id: number;
  cls: VehicleClass;
  conf: number;
  bbox_px: BBox;
  ground_px: Px;
}

export interface FrameRecord {
  frame: number;
  t: number;
  objects: ObservedObject[];
}

export interface Observations {
  schema_version: number;
  camera_id: string;
  source: DataSource;
  video_file: string;
  video_start_time: string | null;
  fps: number;
  frame_size: [number, number];
  frame_count: number;
  model: string;
  tracker: string;
  frames: FrameRecord[];
}

export interface CountLine {
  id: string;
  /** Directed p1 -> p2. "in" = crossing to the left of the arrow as seen on screen. */
  px: [Px, Px];
  approach?: string;
}

export interface QueueRegion {
  id: string;
  polygon_px: Px[];
  stop_line: string;
}

export type SignalMode = "inferred" | "annotated" | "none";

export interface CameraConfig {
  camera_id: string;
  name: string;
  google_maps_url: string | null;
  world_origin?: string;
  road_polygon_px: Px[];
  count_lines: CountLine[];
  queue_regions: QueueRegion[];
  calibration: {
    image_points_px: Px[];
    world_points_m: Meters[];
    holdout_image_px: Px[];
    holdout_world_m: Meters[];
  };
  signal: { mode: SignalMode; red_intervals_s: [number, number][] };
  queue: {
    stop_speed_m_s: number;
    stop_speed_px_s: number;
    min_vehicles: number;
    min_stopped_s: number;
    flow_window_s: number;
    sustained_after_s: number;
  };
  counting: { min_track_frames: number };
}

export type ClipStatus = "analyzed" | "synthetic" | "stale" | "unavailable";

/** One entry of GET /api/clips. Fields other than id/status/reason are missing when the file is unreadable. */
export interface ClipInfo {
  id: string;
  status: ClipStatus;
  reason: string;
  camera_id?: string;
  source?: DataSource;
  video_file?: string;
  video_url?: string | null;
  fps?: number;
  frame_size?: [number, number];
  frame_count?: number;
  model?: string;
  tracker?: string;
}

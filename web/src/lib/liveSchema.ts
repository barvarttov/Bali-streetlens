// Types for the corridor geometry (GET /api/corridor), the camera list (GET /api/cameras) and the
// live junction state (GET /api/live/snapshot, SSE /api/live/stream). Mirrors docs/schema.md.
// Runs in the browser and in Node 24, so: erasable syntax only.

export type LngLat = [number, number];

export interface Arm {
  id: string;
  /** Stable data id of the arm's direction (legacy names); the UI names it by compass from `bearing`. */
  dir: string;
  road: string;
  bearing: number;
  lines: LngLat[][];
  /** Per line, from OSM's oneway tag: traffic runs toward the junction, away from it, or both. */
  flows?: ("in" | "out" | "both")[];
  /** Per line, OSM's lanes tag when mapped. */
  lanes?: (number | null)[];
}

export interface Junction {
  id: string;
  name: string;
  cameras: { id: string; lnglat: LngLat }[];
  center: LngLat;
  roads: string[];
  arms: Arm[];
}

export interface Corridor {
  generated: string;
  source: string;
  /** Legacy, unused by the app: the map is north-up. */
  kaja_bearing: number;
  junctions: Junction[];
}

export interface Camera {
  id: string;
  name: string;
  lnglat: LngLat;
  analyzed: boolean;
  /** The point in the middle of the camera's picture, when the team has located it (config/cameras.json). */
  look_at?: LngLat;
  /** The team checked this camera's position on a satellite map (the portal's are often far off). */
  position_checked?: boolean;
  /** Moved from the portal's position to the junction it shows, from the road map and satellite; not checked. */
  position_estimated?: boolean;
}

export type TrafficLabel = "lancar" | "padat" | "macet" | "unknown";
export type CameraState = "live" | "delayed" | "replay" | "offline";
export type QueueKind = "sustained_queue" | "red_light_stop" | "flowing";

export interface ApproachState {
  arm: string;
  label: TrafficLabel;
  kind: QueueKind;
  stopped: number;
  stopped_for_s: number;
  flow_per_min: number;
}

export interface WhyNumbers {
  mode: "inferred" | "annotated" | "none";
  arm: string;
  kind: QueueKind;
  stopped: number;
  min_vehicles: number;
  stopped_for_s: number;
  min_stopped_s: number;
  flow_per_min: number;
  sustained_after_s: number;
}

export interface JunctionState {
  id: string;
  camera_state: CameraState;
  /** When the camera's data was last updated (ISO, UTC). */
  updated_at: string;
  label: TrafficLabel;
  volume_per_min: number | null;
  approaches: ApproachState[];
  why: WhyNumbers | null;
  classes_15min: Record<"motorcycle" | "car" | "bus" | "truck", number> | null;
  /** One entry per minute, oldest first, the last one is now. "none" = no data that minute. */
  history: (TrafficLabel | "none")[];
}

export interface LiveSnapshot {
  source: "live" | "synthetic" | "replay";
  generated_at: string;
  junctions: JunctionState[];
}

export const LABEL_RANK: Record<TrafficLabel, number> = { unknown: -1, lancar: 0, padat: 1, macet: 2 };

/** Marker size step on one fixed volume ramp: under 60, 60–120, over 120 vehicles per minute. */
export function volumeStep(volume: number | null): 0 | 1 | 2 {
  if (volume === null || volume < 60) return 0;
  return volume <= 120 ? 1 : 2;
}

// Validates and indexes an observations file so lookups by frame and by track are O(1).
// Runs in the browser and in Node 24, so: erasable syntax only, no DOM APIs.

import { SCHEMA_VERSION, VEHICLE_CLASSES } from "./schema.ts";
import type { Observations, ObservedObject } from "./schema.ts";

export interface TrackPoint {
  frame: number;
  t: number;
  obj: ObservedObject;
}

export interface ObservationIndex {
  data: Observations;
  frameCount: number;
  /** byFrame[frame] = objects in that frame (empty array when none). */
  byFrame: ObservedObject[][];
  /** Track id -> its observations, sorted by frame. */
  tracks: Map<number, TrackPoint[]>;
  /** Objects whose class is not a vehicle class; dropped, but counted so problems are visible. */
  droppedObjects: number;
}

const vehicleClasses: ReadonlySet<string> = new Set(VEHICLE_CLASSES);

/** Throws an Error with a human-readable message if the document doesn't match docs/schema.md. */
export function validateObservations(raw: unknown): Observations {
  if (typeof raw !== "object" || raw === null) throw new Error("Observations file is not a JSON object.");
  const doc = raw as Partial<Observations>;
  if (doc.schema_version !== SCHEMA_VERSION) {
    throw new Error(`schema_version is ${String(doc.schema_version)}, this app expects ${SCHEMA_VERSION}.`);
  }
  if (typeof doc.fps !== "number" || !(doc.fps > 0)) throw new Error("fps must be a positive number.");
  const size = doc.frame_size;
  if (!Array.isArray(size) || size.length !== 2 || !(size[0] > 0) || !(size[1] > 0)) {
    throw new Error("frame_size must be [width, height] in pixels.");
  }
  if (!Array.isArray(doc.frames)) throw new Error("frames must be an array.");
  for (const f of doc.frames) {
    if (!Number.isInteger(f?.frame) || f.frame < 0 || !Array.isArray(f.objects)) {
      throw new Error(`Malformed frame record: ${JSON.stringify(f).slice(0, 120)}`);
    }
  }
  if (doc.frame_count !== undefined && (!Number.isInteger(doc.frame_count) || doc.frame_count <= 0)) {
    throw new Error("frame_count must be a positive integer.");
  }
  return doc as Observations;
}

export function indexObservations(data: Observations): ObservationIndex {
  const lastFrame = data.frames.reduce((max, f) => Math.max(max, f.frame), -1);
  const frameCount = Math.max(data.frame_count ?? 0, lastFrame + 1);

  const byFrame: ObservedObject[][] = Array.from({ length: frameCount }, () => []);
  const tracks = new Map<number, TrackPoint[]>();
  let droppedObjects = 0;

  for (const f of data.frames) {
    const t = f.frame / data.fps; // the single clock: t is derived from the frame index, not read from the file
    for (const obj of f.objects) {
      if (!vehicleClasses.has(obj.cls)) {
        droppedObjects++;
        continue;
      }
      byFrame[f.frame].push(obj);
      let points = tracks.get(obj.track_id);
      if (!points) {
        points = [];
        tracks.set(obj.track_id, points);
      }
      points.push({ frame: f.frame, t, obj });
    }
  }
  for (const points of tracks.values()) points.sort((a, b) => a.frame - b.frame);

  return { data, frameCount, byFrame, tracks, droppedObjects };
}

export function objectsAt(index: ObservationIndex, frame: number): ObservedObject[] {
  return index.byFrame[frame] ?? [];
}

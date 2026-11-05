import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { indexObservations, validateObservations } from "./observations.ts";

const fixturesDir = join(import.meta.dirname, "..", "..", "..", "fixtures");
const readJson = (name: string): unknown => JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));

interface Truth {
  frame_count: number;
  crossing_events: { track_id: number }[];
  excluded_tracks: { track_id: number }[];
}

test("synthetic fixture validates and indexes", () => {
  const index = indexObservations(validateObservations(readJson("synthetic.json")));
  const truth = readJson("synthetic.truth.json") as Truth;

  assert.equal(index.data.source, "synthetic");
  assert.equal(index.frameCount, truth.frame_count);
  assert.equal(index.byFrame.length, truth.frame_count);
  assert.equal(index.droppedObjects, 0);
  for (const e of [...truth.crossing_events, ...truth.excluded_tracks]) {
    assert.ok(index.tracks.has(e.track_id), `track ${e.track_id} missing from index`);
  }
  for (const points of index.tracks.values()) {
    for (let i = 1; i < points.length; i++) assert.ok(points[i].frame > points[i - 1].frame);
  }
});

test("rejects an unsupported schema version", () => {
  assert.throws(
    () => validateObservations({ schema_version: 2, fps: 25, frame_size: [1280, 720], frames: [] }),
    /schema_version is 2/,
  );
});

test("drops non-vehicle classes but counts them", () => {
  const person = { track_id: 1, cls: "person", conf: 0.9, bbox_px: [0, 0, 10, 10], ground_px: [5, 10] };
  const bike = { track_id: 2, cls: "motorcycle", conf: 0.9, bbox_px: [0, 0, 10, 10], ground_px: [5, 10] };
  const index = indexObservations(
    validateObservations({
      schema_version: 1, fps: 25, frame_size: [100, 100], frame_count: 3,
      frames: [{ frame: 2, t: 0.08, objects: [person, bike] }],
    }),
  );
  assert.equal(index.droppedObjects, 1);
  assert.deepEqual(index.byFrame[0], []); // omitted frames exist and are empty
  assert.equal(index.byFrame[2].length, 1);
  assert.equal(index.tracks.get(2)?.[0].t, 2 / 25);
});

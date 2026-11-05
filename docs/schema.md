# Data contract (schema_version 1)

Frozen on Day 1. Change it only with the whole team, and bump `schema_version` when you do.
Everything below follows PLAN.md section 5, plus the amendments agreed on 2026-11-02.

## Units, coordinates, clock

| Thing | Rule |
|---|---|
| Image coords | Pixels, origin top-left, x right, y down, in the **normalized** video's resolution (`frame_size`). |
| World coords | Meters on the road plane. **X = east, Y = north.** The origin is a landmark named in the camera config. |
| Three.js | `x = X`, `y = up`, `z = -Y`. Do not mirror. |
| Time | `t = frame / fps`, seconds from the start of the normalized video. This is the **only** clock. |

## Clip normalization (always, before inference)

Raw CCTV or phone clips are often variable-frame-rate or have a start offset. Normalize every clip once, then use the
same output file for inference **and** for playback in the browser:

```bash
ffmpeg -i raw.ts -vf fps=25 -c:v libx264 -crf 20 -pix_fmt yuv420p \
  -g 25 -keyint_min 25 -sc_threshold 0 -an -movflags +faststart data/clip01.mp4
```

This gives a keyframe every second (fast seeking), `faststart` (playback starts before the full download), and no audio.

## `results/<clip>.observations.json`, written by `vision/analyze.py` (Person A)

```json
{
  "schema_version": 1,
  "camera_id": "cam01",
  "source": "recorded",
  "video_file": "clip01.mp4",
  "video_start_time": null,
  "fps": 25,
  "frame_size": [1920, 1080],
  "frame_count": 2250,
  "model": "yolo11s.pt",
  "tracker": "bytetrack",
  "frames": [
    { "frame": 0, "t": 0.0,
      "objects": [
        { "track_id": 7, "cls": "motorcycle", "conf": 0.81,
          "bbox_px": [100.0, 200.0, 140.0, 280.0], "ground_px": [120.0, 280.0] }
      ] }
  ]
}
```

- `frame_count` (added) is the total number of frames in the normalized video. The timeline length comes from it.
- Frames with no objects may be omitted. Consumers index by `frame`, never by array position.
- `ground_px` is the bottom-center of the bbox: `[(x1+x2)/2, y2]`.
- `cls` is one of `motorcycle | car | bus | truck`. Everything else is dropped. `person` is never written.
- `track_id` is temporary and per-clip. No plates, no faces, no identity.
- `source`: `recorded` (real clip), `synthetic` (fake dev data; the UI shows a red banner), or `live` (stretch).
- `video_file` is a bare file name. The backend looks for it in `data/`, then next to the JSON file.

## `config/<camera_id>.yaml`, written by hand and by the calibration tool (Person B)

```yaml
camera_id: cam01
name: "TODO"
google_maps_url: "TODO"
world_origin: "TODO: which landmark is (0, 0)"
road_polygon_px: []
count_lines:                       # one per approach; directed p1 -> p2 (see below)
  - id: north_in
    px: [[x1, y1], [x2, y2]]
    approach: north
queue_regions:                     # area where a queue forms, behind a stop line
  - id: north_q
    polygon_px: [[x, y], ...]
    stop_line: north_in            # id of a count line
calibration:
  image_points_px: []              # 8-10 points spread over the road
  world_points_m: []               # same points, meters (X east, Y north)
  holdout_image_px: []             # 3 points NOT used for fitting
  holdout_world_m: []
signal:
  mode: inferred                   # inferred | annotated | none
  red_intervals_s: []              # only for mode "annotated": [[start, end], ...]
queue:
  stop_speed_m_s: 1.0              # "stopped" when slower than this (needs calibration)
  stop_speed_px_s: 8               # fallback only when calibration is empty
  min_vehicles: 5
  min_stopped_s: 10
  flow_window_s: 20
  sustained_after_s: 30
counting:
  min_track_frames: 5              # tracks seen for fewer frames never count
```

### Count line direction

Each count line is an arrow from `p1` to `p2` as drawn on the image.
A crossing is **`in`** when the vehicle moves to the **left** of that arrow as seen on screen, and **`out`** when it moves to the right.
In math terms, with `s(p) = (x2-x1)(py-y1) - (y2-y1)(px-x1)` in image coords (y down), `in` means `s` goes from positive to negative.
Example: for a horizontal line drawn left to right, `in` = moving **up** the image.

### Queue label rules (implemented in `web/src/lib/metrics.ts`, Day 4)

A **queue is present** when at least `min_vehicles` vehicles inside a queue region have each been continuously stopped for at least `min_stopped_s`.
How it's labeled depends on `signal.mode`:

| Mode | Label |
|---|---|
| `inferred` (default) | Queue present **while vehicles keep crossing the stop line** (flow in the last `flow_window_s`) for at least `sustained_after_s` gives **sustained queue**. Queue with no flow gives **stopped, likely red light**. |
| `annotated` | Queue inside a typed-in red interval that clears soon after green gives **red-light stop**. A queue that survives past `sustained_after_s` of green gives **sustained queue**. |
| `none` | **Slow or stopped traffic.** |

The "Why" panel always shows the mode, stopped count, stopped durations, stop-line flow and every threshold used.

## `results/<clip>.events.json`, written by `web/src/lib/metrics.cli.ts` (Person C, Day 3)

This is the single output of the counting logic. The UI computes the same thing in the browser, and `vision/evaluate.py`
(Person A) reads this file and compares it with the manual counts. The final shape is fixed on Day 3. It will contain line
crossings `{track_id, cls, line, dir, frame, t}`, counts per line/direction/class, and queue intervals with their "why" numbers.

## Public app data (added 2026-11-02)

### `config/corridor.json`, built by `npm run corridor` (OpenStreetMap via Overpass)

```json
{ "kaja_bearing": 0,
  "junctions": [ { "id": "patung-kuda", "name": "Simpang Patung Kuda",
    "cameras": [ { "id": "simpang-patung-kuda", "lnglat": [115.179105, -8.744676] } ],
    "center": [115.179119, -8.744694], "roads": ["Jl. Bandara Ngurah Rai", "Jl. Raya Tuban"],
    "arms": [ { "id": "kaja", "dir": "kaja", "road": "Jl. Raya Tuban", "bearing": 355, "lines": [[[lng, lat], ...]],
               "flows": ["both"], "lanes": [2] } ] } ] }
```

- Each camera location is snapped to the nearest intersection of differently named roads.
- An **arm** is a road leaving that intersection. Its `lines` cover about the first 160 m: the observed approach, painted by state on the map.
  - Each line starts at the intersection and runs outward.
  - `flows` (optional, one per line) comes from OSM's `oneway` tag: `"in"` (traffic runs toward the intersection), `"out"` (away from it), or `"both"`.
  - `lanes` (optional, one per line) is OSM's `lanes` tag, or `null` when it isn't mapped.
  - The 3D vehicle layer builds its lanes from these. Bali drives on the left, so each lane sits left of its direction of travel.
- Direction words:
  - `kaja` and `kelod` follow `kaja_bearing`: toward the mountains, which is north in the south Bali corridor.
  - `kangin` (east) and `kauh` (west) are fixed.
  - Combinations name the in-betweens, e.g. "kaja kangin". See `web/src/lib/direction.ts`.

### `config/cameras.json`

A dated snapshot of every camera on the provincial CCTV map (Bali Satu Data) with `analyzed: true|false`. Un-analysed cameras are shown honestly as "belum dianalisis", never with traffic data.

### Live junction state: `GET /api/live/snapshot`, SSE `GET /api/live/stream` (one message per second)

```json
{ "source": "live | synthetic | replay", "generated_at": "2026-11-02T03:20:05Z",
  "junctions": [ {
    "id": "patung-kuda",
    "camera_state": "live | delayed | replay | offline",
    "updated_at": "2026-11-02T03:20:03Z",
    "label": "lancar | padat | macet | unknown",
    "volume_per_min": 96,
    "approaches": [ { "arm": "kaja", "label": "macet", "kind": "sustained_queue",
                      "stopped": 23, "stopped_for_s": 840, "flow_per_min": 6 } ],
    "why": { "mode": "inferred", "arm": "kaja", "kind": "sustained_queue", "stopped": 23, "min_vehicles": 5,
             "stopped_for_s": 840, "min_stopped_s": 10, "flow_per_min": 6, "sustained_after_s": 30 },
    "classes_15min": { "motorcycle": 1020, "car": 291, "bus": 18, "truck": 55 },
    "history": ["lancar", "padat", "macet", "none", "..."] } ] }
```

- **Labels.** `macet` = sustained queue: a queue persists while vehicles keep crossing the stop line. `padat` = a queue that is discharging (likely a red light) or heavy volume. The junction label is its worst approach.
- **`history`:** 30 entries, one per minute, oldest first. `"none"` means no data that minute.
- **Freshness is the client's job.** Data older than 10 s is shown as delayed, whatever `camera_state` says. Offline cameras keep their history and show `label: "unknown"`.
- **Synthetic source.** Until real streams exist, `backend/live.py` produces this shape from a deterministic synthetic scenario with `"source": "synthetic"`, and the app shows a banner. The real pipeline replaces that module, not the app.

## Backend API (`backend/main.py`, Person C)

| Route | Returns |
|---|---|
| `GET /api/health` | `{"ok": true}` |
| `GET /api/clips` | Every clip with `status` + `reason` (see below) |
| `GET /api/clips/{id}/observations` | The observations JSON (gzip when the browser accepts it) |
| `GET /api/clips/{id}/config` | `config/<camera_id>.yaml` as JSON |
| `GET /video/{id}` | The clip's video, with HTTP Range support (needed for seeking) |
| `GET /api/corridor` | `config/corridor.json` |
| `GET /api/cameras` | `config/cameras.json` |
| `GET /api/live/snapshot` | Live junction state (above) |
| `GET /api/live/stream` | The same as server-sent events, once per second |
| `GET /tiles/{z}/{x}/{y}.mvt` | Self-hosted OpenStreetMap vector tiles from `data/tiles` (204 for empty sea tiles) |
| any other path | The built app (`web/dist`), with `index.html` for deep links such as `/simpang/patung-kuda` |

Clip id = the file name without `.observations.json` (in `results/`) or without `.json` (in `fixtures/`).
`/video/{id}` takes a clip id rather than a file name, so no path from the URL ever touches the disk.

### Status

| Status | Badge text | When |
|---|---|---|
| `analyzed` | Analyzed replay | Real recorded clip, video present, analysis newer than the video |
| `synthetic` | Synthetic data | `source == "synthetic"` (always with the red banner) |
| `stale` | Stale analysis | `schema_version` mismatch, or the video file is newer than its analysis |
| `unavailable` | Unavailable | Observations unreadable, video missing, or the video fails to play |

Changing the config never makes a clip stale, because world coordinates are computed from the config at view time and
no re-inference is needed.

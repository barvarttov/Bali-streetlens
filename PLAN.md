# Bali StreetLens: Winning Plan

Team of 3, about 7 days, theme "Build with AI, solve for Bali".
Status labels used below: **[VERIFIED]** I checked it, **[ASSUMPTION]** needs your confirmation, **[TARGET]** a goal, not a result.

---

> **Amended 2026-11-02:** see Section 16 at the end. Repo: `C:\dev\bali-streetlens`, contract in `docs/schema.md`.

## 0. Verified facts about your setup (checked 2026-11-01 on the teammate's RTX 5060 laptop, the inference + demo machine)

| Item | Result |
|---|---|
| GPU | NVIDIA GeForce RTX 5060 Laptop, **8 GB VRAM**, driver 591.97 [VERIFIED] |
| PyTorch | 2.11.0+cu128, `cuda.is_available() == True` [VERIFIED] |
| Python / Node | 3.12.10 / 24.18 [VERIFIED] |
| ffmpeg | **Not installed** (install it, Day 1) [VERIFIED] |
| TrafficLab 3D license | **MIT** [VERIFIED]. Reuse is allowed if you keep the copyright notice. |
| TrafficLab 3D stack | PyQt5 desktop app, YOLO + swappable tracker, homography between CCTV and satellite, results saved as `.json.gz` [VERIFIED] |
| Real inference speed | **Unknown until you benchmark** |

The RTX 5060 (Blackwell) needs a CUDA 12.8+ PyTorch build. Your PyTorch is already that, which is the usual trap, so you are ahead.
An 8 GB GPU is plenty for YOLO small/medium at 1080p.

Licensing warning: **Ultralytics YOLO is AGPL-3.0.** Fine for a hackathon demo. Say so in your README. If you ever want a closed product, switch to RT-DETR (Apache-2.0) or buy their enterprise license.

---

## 1. Honest scope review

**Verdict: realistic for 3 people in 7 days, only if you cut live CCTV and treat it as a stretch goal.** The recorded-replay path is the product. Live is a bonus.

### The winning idea (what judges remember)
Not "we detect cars". Everyone does that. Your differentiators:
1. **Motorcycle-first** analysis, because Bali traffic is mostly bikes and generic tools handle them badly.
2. **Synced 3D digital twin** of a real Bali intersection, rotatable, tied to the video clock.
3. **Honest traffic labels**: "sustained queue" vs "red-light stop", with the numbers shown behind every label.
4. **Measured accuracy** against a manual count. Almost no hackathon team does this, and it makes you look credible.

### Biggest technical risks (ranked)

| # | Risk | Why it bites | Mitigation |
|---|---|---|---|
| 1 | Motorcycles: rider+bike counted twice, ID switches, occlusion in dense traffic | The core of your pitch | Use `motorcycle` class only, ignore `person`; count line crossings; **report your error rate honestly** |
| 2 | Calibration looks wrong in 3D | Perspective, non-flat road, bad point picks | Pick 8+ points, hold out 3 for checking, show the error in meters |
| 3 | No usable footage / permission | Whole project blocked | Decide footage on Day 1 (see Section 7). Fallback: any permitted fixed-camera clip |
| 4 | Queue label false alarms at red lights | Judges will ask | Require stopped for N seconds AND region occupancy; show the numbers |
| 5 | Time sink on live CCTV | Streams are flaky, rights unclear | Stretch only, decide by Day 5 |
| 6 | Integration hell on Day 6 | Three people, three pieces | Shared JSON schema on Day 1, integrate **every day** |
| 7 | 3D scene eats time | Polish is endless | Boxes and simple low-poly bikes only. No textures. |

---

## 2. Success criteria (what "winning" looks like)

Priority order. Do not start #5 before #1-#3 work.

1. One real Bali clip, detections + tracks cached to JSON. [MUST]
2. 3D scene where vehicles visibly follow real road movement, synced to the video. [MUST]
3. Counts by class + line-crossing flow + queue indicator with explanations. [MUST]
4. A measured accuracy slide: automated vs manual count. [MUST, this is your credibility]
5. Status badge (Analyzed replay / Stale / Unavailable) and failure handling. [SHOULD]
6. Live CCTV. [STRETCH]

**[TARGETS] (proposed, not results):** line-crossing count within 15% of manual for motorcycles on moderate traffic; calibration error under 1.5 m on hold-out points; playback seek stays in sync within one frame; analysis at 15+ FPS on the RTX 5060. Replace with measured numbers before presenting.

---

## 3. Team split

| Person | Owns | Day-1 deliverable |
|---|---|---|
| **A: Vision** | GPU check, ffmpeg, detector, tracker, benchmark, accuracy eval, `observations.json` | Real detections on 1 clip |
| **B: Geometry + 3D** | Calibration tool, homography, Three.js scene, vehicle meshes, shared clock | Empty road scene + a hard-coded fake car moving |
| **C: App + Demo** | FastAPI, React dashboard, playback, metrics panel, status badge, demo script, slides | Dashboard that loads video + a stub JSON |

Rule: nobody blocks anybody. B and C develop against a **clearly labeled synthetic fixture** (`fixtures/synthetic.json`, flagged `"source": "synthetic"`) until A ships real data on Day 2.

---

## 4. Repository structure

```
bali-streetlens/
  README.md                 # run steps, attributions, honest limitations
  LICENSES.md               # TrafficLab (MIT), Ultralytics (AGPL), Three.js, etc.
  docs/
    schema.md               # the contract below
  data/                     # gitignored: raw videos
  results/                  # analyzed output: <clip>.observations.json
  fixtures/
    synthetic.json          # LABELED fake data for dev only
  config/
    cam01.yaml              # road polygon, count line, calibration points, thresholds
  vision/                   # Person A (Python)
    analyze.py              # video -> observations.json
    benchmark.py
    evaluate.py             # automated vs manual counts
    requirements.txt
  backend/                  # Person C (FastAPI)
    main.py                 # serves video, results, config, metrics
  web/                      # React + TS + Vite
    src/
      components/           # VideoPane, Scene3D, Timeline, MetricsPanel, StatusBadge
      lib/
        clock.ts            # shared playback clock (Person B + C)
        homography.ts       # Person B
        metrics.ts          # counts, line crossing, queues
  tools/
    calibrate.html          # Person B: click image points + map points
  eval/
    manual_counts.csv       # hand-labeled ground truth
```

Keep it a simple monorepo. Frontend plays the cached JSON; **inference never runs during playback**.

---

## 5. Shared data contract (agree on Day 1, freeze it)

### `results/<clip>.observations.json`

```json
{
  "schema_version": 1,
  "camera_id": "cam01",
  "source": "recorded",
  "video_file": "clip01.mp4",
  "video_start_time": null,
  "fps": 25,
  "frame_size": [1920, 1080],
  "model": "yolo11s.pt",
  "tracker": "bytetrack",
  "frames": [
    {
      "frame": 0,
      "t": 0.0,
      "objects": [
        {
          "track_id": 7,
          "cls": "motorcycle",
          "conf": 0.81,
          "bbox_px": [x1, y1, x2, y2],
          "ground_px": [cx, y2]
        }
      ]
    }
  ]
}
```

Rules:
- `t` is seconds from video start, derived from frame index / fps. This is the **single clock** for everything.
- `ground_px` is bottom-center of the bbox, pixel units. World coordinates are **computed in the browser** from calibration, so recalibrating never needs re-inference.
- `cls` in `motorcycle | car | bus | truck`. Everything else dropped.
- `track_id` is temporary and per-clip. No plates, no faces, no person identity.
- Synthetic fixtures must set `"source": "synthetic"` and the UI shows a visible banner.
- Pin units: pixels in the image, meters in world coords.

### `config/cam01.yaml`

```yaml
camera_id: cam01
name: "TODO"
google_maps_url: "TODO"
road_polygon_px: []          # operator-drawn
count_line_px: [[x1,y1],[x2,y2]]
calibration:
  image_points_px: []        # 8-10 points
  world_points_m: []         # same points on the 3D ground plane, meters
  holdout_image_px: []       # 3 points NOT used for fitting
  holdout_world_m: []
queue:
  speed_thresh_px_per_s: 8   # tune on a separate clip
  min_stopped_seconds: 10
  min_vehicles: 5
```

### Backend API (small)

| Route | Returns |
|---|---|
| `GET /api/clips` | list of clips + status |
| `GET /api/clips/{id}/observations` | the JSON above |
| `GET /api/clips/{id}/config` | the YAML as JSON |
| `GET /video/{file}` | video with HTTP range support (needed for seeking) |

The frontend can read static files directly if FastAPI becomes a bottleneck. Do not over-engineer this.

---

## 6. Day-by-day plan

### Day 1: Foundations (everyone)
**A**
```bash
winget install Gyan.FFmpeg
python -m venv .venv && .venv\Scripts\activate
pip install ultralytics opencv-python
nvidia-smi
python -c "import torch;print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
yolo track model=yolo11s.pt source=data/clip01.mp4 tracker=bytetrack.yaml device=0 save=True
```
Pass: annotated video appears, FPS printed. Write `vision/analyze.py` to dump the JSON schema.
**B**: Vite+React+TS app, Three.js ground plane with a dummy car driven by `clock.ts`.
**C**: FastAPI skeleton, video player with play/pause/seek, status badge, loads synthetic fixture.
**All**: commit `docs/schema.md`, pick footage, confirm permission.

### Day 2: Real data flows
- A: `observations.json` for the real clip; try yolo11s vs yolo11m, log FPS and VRAM.
- B: calibration tool (click image point, then click map point) and homography in the browser.
- C: timeline, metrics panel, video + JSON loaded together.
- **Integration check at end of day:** real tracks overlaid on video.

### Day 3: Calibration + 3D sync
- B: fit homography (OpenCV `findHomography` with RANSAC, or compute in JS), project `ground_px` to meters, render vehicles. Report hold-out error.
- A: tune motorcycle handling (see Section 8); start manual counts.
- C: line-crossing counter and region occupancy.

### Day 4: Honest traffic indicators
- Queue logic: vehicles in region with speed below threshold for at least N seconds, and count at or above M. Show "why" panel with the values.
- Remove lost tracks from 3D after ~1 s (no ghosts). Show "tracking gap" visually.
- Complete recorded-video demo end-to-end.

### Day 5: Measure, then decide live
- A: run `evaluate.py` on held-out clips, produce the accuracy table.
- Decision gate at noon: is live worth trying? Only if replay is stable AND the feed is authorized.
- C: failure states (missing video, stale, unavailable).

### Day 6: Hardening
- Full-flow test, UI cleanup, backup demo recording (screen capture of the working app), rehearsal #1.

### Day 7: Freeze
- No new features. Final checks, attribution/README, slides, 3 rehearsals, time them.

**Cut order if behind:** live feed, then cosmetics, then bus/truck polish, then Google Maps link. Never cut: calibrated 3D playback, honest labels, accuracy table.

---

## 7. How camera pixels become 3D positions (plain language)

1. A road is roughly a flat plane. A camera photo of a flat plane is related to a top-down map by one 3x3 matrix, the **homography**.
2. You find it by pairing points: "this crosswalk corner in the video = this corner at (x, y) meters on my 3D map". You need at least 4 pairs. Use **8-10**, spread across the whole road, not clustered.
3. For each vehicle, use the **bottom-center of its bounding box**, because that is where the vehicle touches the ground. The box center is above the road and would map to the wrong place.
4. Multiply that pixel through the matrix to get road coordinates in meters, then place the 3D vehicle there.
5. **Verify** with 3 hold-out points not used for fitting: project them and measure the distance to where they should be. Report that error in meters. Also overlay the projected road polygon on the video, which is a quick visual check.

Where it breaks (say these out loud in the demo):
- Occluded vehicles have shifted boxes, so the position is off.
- Hills or a curved road violate the flat-plane assumption.
- Wide lenses bend lines; undistort first if curved edges are visible.
- If the camera pans/tilts/zooms, the calibration is invalid.
- Far-away vehicles have large position error per pixel.

Vehicle size and heading are approximations, so draw them as simple boxes. Heading can come from the last few track positions.

### How to place the 3D street
Measure real distances on Google Maps (the ruler tool) between your calibration landmarks, such as lane edges and crosswalk corners. Use those as `world_points_m`. This is accurate enough for a demo, and you can state the source.

---

## 8. Motorcycle accuracy tricks (your differentiator)

- Count the `motorcycle` class; ignore `person`. The model's rider box usually merges into the motorcycle box, but check.
- Tune `conf` (start 0.25) and `imgsz` (try 960 or 1280). Small far bikes need higher resolution.
- Use tracker `botsort` as an alternative to ByteTrack if IDs switch a lot. Compare both on one clip.
- Count only when a track crosses the line and was seen for at least N frames. This cuts flicker.
- Debounce: one ID counts once per direction.
- Always compare to a manual count and report the miss and double-count categories.
- Stretch: fine-tune on a few hundred labeled Bali frames. Only if Day 5 shows a big gap, and label honestly.

---

## 9. Fallbacks for every dependency

| Dependency | If it fails | Fallback |
|---|---|---|
| Feed access / permission | No authorized CCTV | Record your own fixed-camera clip from a rooftop or bridge (phone on a tripod), or use a licensed dataset clip. Say what it is. |
| Live streaming | Flaky, unauthorized, slow | Present replay only; show "Live" as designed future work. Do not fake it. |
| GPU inference | Driver/CUDA issues, slow | Use `yolo11n` (smaller), lower `imgsz`, process every 2nd frame, or run on free Colab/Kaggle GPU and download the JSON. |
| Calibration | Error too high | Add points, undistort, restrict to the flat road section, show the error openly. |
| Tracker | ID switches | Switch ByteTrack to BoT-SORT; accept and report the error. |
| 3D library | Three.js trouble | Render a 2D top-down canvas of the same data (the math is identical). |
| Google Maps API | No billing/API project | Plain Google Maps link plus custom Three.js layout (already the plan). |
| Backend | FastAPI issues | Serve static JSON and video from Vite's public folder. |

---

## 10. Choosing a Bali CCTV recording (checklist)

- [ ] **Permission confirmed in writing** (owner/operator or terms of use). Record the source URL and date.
- [ ] Fixed camera, no PTZ movement during the clip.
- [ ] Intersection visible, with lane lines, crosswalks, or curbs for calibration points.
- [ ] Camera elevated enough that vehicles do not hide each other completely.
- [ ] Motorcycles clearly visible and at least about 40 px tall.
- [ ] Daylight, no heavy rain or glare for the main demo clip.
- [ ] Contains a traffic-light cycle or a natural stop, so you can show queue vs free flow.
- [ ] Timestamp visible or recorded (keep file metadata).
- [ ] 720p or better, 15+ FPS.
- [ ] Faces and plates unreadable at this resolution; do not store or process them.
- [ ] 4-5 short clips (30-90 s): light, dense, stopped, motorcycle-heavy, plus one held out for testing only.

---

## 11. Fair manual evaluation plan

1. Split clips into **tuning** (set thresholds) and **test** (never touched until the end).
2. Two people count independently, by class, for vehicles crossing the line (use the video slowed to 0.5x). Resolve differences and record both counts in `eval/manual_counts.csv`.
3. Run the pipeline on the test clips **once** with frozen settings.
4. Report per class: manual, automated, absolute error, percent error, sample size.
5. Review the errors: misses, double counts, ID switches. Show 2-3 failure screenshots in your slides. This builds trust.
6. Queue labels: a person marks the time ranges where a queue exists; compare with automatic labels and count false alarms at traffic lights.
7. Sync test: seek to 5 timestamps; confirm video frame, 3D scene, and metrics show the same `t`.
8. Calibration: report hold-out error in meters.

Never state accuracy you did not measure.

---

## 12. Three-minute demo script

| Time | Show | Say |
|---|---|---|
| 0:00-0:20 | Google Maps link + source clip | The real intersection, why motorcycles dominate here |
| 0:20-1:00 | Video with boxes beside the 3D twin | Same moment, approximate positions |
| 1:00-1:30 | Seek to a queue; open the "why" panel | The numbers behind the label; red-light stop vs sustained queue |
| 1:30-1:50 | Rotate the 3D view | What is observed vs not observed |
| 1:50-2:30 | Accuracy slide | Automated vs manual, error types, limits |
| 2:30-3:00 | Impact + roadmap | Who uses it, what is needed for more cameras |

Always have a pre-recorded backup video of the app. Label the status "Analyzed replay" on screen.

---

## 13. Pitch framing (do not fabricate impact numbers)

- Intended users (ASSUMPTION, to validate): traffic planners, local transport office (Dishub), event organizers, tourism area managers.
- Value claim: a clearer view of where vehicles accumulate and how traffic moves, from cameras that already exist, with no new hardware.
- Do not claim time saved, emissions reduced, or accuracy percentages until measured.
- Be upfront: single camera, approximate 3D, not a full-city model.
- Roadmap: more cameras, per-camera auto-calibration, live feeds, historical trends.

---

## 14. Open questions (answer these first)

| # | Question | Why it matters |
|---|---|---|
| 1 | Do you have an actual MP4 or CCTV source, and is it authorized for you to process and show? | Blocks Day 1 |
| 2 | Which intersection (name or Maps link)? | Calibration and the pitch story |
| 3 | Exact deadline, and is judging in person or remote? | Adjusts the 7-day plan |
| 4 | Team skills: who knows Python / React / Three.js? | Role assignment |
| 5 | Will you demo on this laptop? | Decides whether live inference is possible |
| 6 | Judging criteria or rubric, if published | Adjust emphasis (impact vs technical vs design) |

Assumptions I made: replay-first, one camera, no Maps Platform billing, YOLO11 + ByteTrack baseline, AGPL acceptable for a demo.

---

## 15. Attribution (keep in `LICENSES.md`)

- TrafficLab 3D (MIT) by duy-phamduc68: **inspiration only unless you copy code**. If you copy any, keep its copyright notice.
- Ultralytics YOLO (AGPL-3.0), OpenCV (Apache-2.0), Three.js (MIT), FastAPI (MIT), React (MIT).
- Model weights: note the source and license of whatever weights you download.

---

## 16. Amendments (2026-11-02)

Agreed decisions: the teammate's RTX 5060 laptop runs inference and the in-person demo; Person C's laptop (RTX 4050, 6 GB) is dev only. Footage is a gov CCTV stream whose permission is still unconfirmed. There is no required AI tooling. Counting and queue logic live in one TypeScript module.

1. **Day-1 install trap.** On Windows, `pip install ultralytics` in a fresh venv installs CPU-only torch. Install torch from `https://download.pytorch.org/whl/cu128` first (see the repo README).
2. **Repo outside OneDrive:** `C:\dev\bali-streetlens`. Syncing `node_modules`, `.venv` and videos causes file locks.
3. **Normalize every clip with ffmpeg before inference** (constant fps, keyframe every 1 s, faststart). Analyze and play the same file. Command in `docs/schema.md`.
4. **Config:** `count_lines` (one per approach, directed; "in" = crossing to the left of the arrow) and `queue_regions` (each tied to a stop line) replace the single `count_line_px`. A `signal` section is added. Observations gain `frame_count`.
5. **Queue labels in 3 modes.** `inferred` (default: a queue while vehicles keep crossing the stop line = sustained queue; a queue with no flow = likely red light), `annotated` (red times typed in), `none` (roundabout). The speed threshold is in m/s once calibrated (px/s is perspective-biased).
6. **One source of truth for counting.** `web/src/lib/metrics.ts` is used by the UI and run by Node for eval, and it writes `results/<clip>.events.json`. `vision/evaluate.py` compares that file with the manual counts.
7. **Event-level evaluation.** Match manual crossing timestamps to automated ones within ±1 s and report precision/recall per class plus agreement between the two human counters. Totals alone hide misses that cancel double counts.
8. **Coordinates:** world X = east, Y = north (m); Three.js x = X, z = −Y.
9. **Footage:** ask the CCTV operator for written permission now. Record a backup phone-on-tripod clip by Day 2.
10. **Status:** C's Day 1 is done. The FastAPI backend serves Range-enabled video, the dashboard has a video-driven clock and overlay, there's a status badge plus synthetic banner, and a synthetic fixture with known ground truth exists. Sync was verified in Chrome on 5 seek points, frame stepping and play.

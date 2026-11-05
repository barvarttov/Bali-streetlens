# Bali StreetLens

A public 3D map of Bali, navigated like Google Maps. At junctions watched by the provincial CCTV
network, it shows what traffic is doing right now (motorcycles first), labels it honestly with the
numbers behind each label, and suggests a detour around a jam. It shows no raw video: cameras are input,
and the anonymous 3D scene is output.

- Design & product plan (the only design file): [`RANCANGAN-DESAIN.md`](RANCANGAN-DESAIN.md)
- Data contract: [`docs/schema.md`](docs/schema.md)
- Team plan: [`PLAN.md`](PLAN.md)

| Route | What |
|---|---|
| `/` | Public map of all of Bali: search "Mau ke mana?", fly there, read the card (bottom sheet on phones, left card on desktop) |
| `/simpang/<id>` | One junction: state, freshness, approaches named kaja/kelod/kangin/kauh, 30-minute history. Shareable. |
| `/rute` | Route planner: from A to B, up to 3 options ranked around jammed junctions, then Google Maps for turn-by-turn |
| `/simpang/<id>/kenapa` | Why it has that label: the numbers against their thresholds |
| `/tim` | Team tools (not linked publicly): analysis player and manual-count logger. Raw video appears only here. |

Inference never runs in the browser. The vision pipeline writes observations, the backend serves them, and the app renders them.

## Layout

| Path | Owner | What |
|---|---|---|
| `vision/` | A | Video to `observations.json`, benchmark, evaluate |
| `web/src/components/Scene3D.tsx`, `web/src/lib/homography.ts`, `tools/calibrate.html` | B | 3D twin, calibration |
| `backend/`, the rest of `web/` | C | API, dashboard, clock, metrics, status |
| `web/src/lib/clock.ts` | B + C | The single playback clock |
| `config/<camera_id>.yaml` | B | Lines, regions, calibration, thresholds |
| `fixtures/` | C | **Synthetic** dev data (`synthetic.json`) + its ground truth. Never present it. |
| `data/` | A | Normalized videos (not in git) |

## Setup (Windows, Python 3.12, Node 24, ffmpeg)

```powershell
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r backend\requirements.txt
cd web
npm install
npm run tiles            # data/tiles: the whole island to zoom 15 (~112 MB, ~12 500 tiles), so the demo works offline
npm run places           # web/public/places.json: places for "Mau ke mana?" (already committed; rerun to refresh)
npm run outline          # web/src/public/bali-outline.json: Bali province outline; the map shows only Bali (committed)
npm run corridor         # config/corridor.json: junction arms from OpenStreetMap (already committed; rerun to refresh)
npm run bathymetry       # web/public/bathymetry.json: sea depth around Bali for the blue depth bands (committed)
npm run roads            # config/roads.json.gz: every road in Bali as a routable graph for /rute (committed; rerun to refresh)
npm run fixture          # fixtures/synthetic.json + synthetic.truth.json
npm run fixture:video    # fixtures/synthetic_sync.mp4 (needs ffmpeg; or set FFMPEG=<path to ffmpeg.exe>)
```

**Assistant ("Tanya", free only).** Copy `.env.example` to `.env` and paste a free Groq key
(console.groq.com) and, optionally, a free NVIDIA Build key (build.nvidia.com) as backup. Never add a credit card to
either account: then nothing can be charged. The app can only call these two free APIs. Without a key the rest of the
app works and the chat panel says how to switch it on.

Until real camera streams exist, the backend serves a **synthetic** live feed (`backend/live.py`), and the app
shows a "DATA SINTETIS" banner for as long as it does.

**Vision machine only (Person A).** Install CUDA PyTorch **before** ultralytics. On Windows, plain
`pip install ultralytics` pulls a CPU-only torch and `device=0` fails:

```powershell
.venv\Scripts\python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
.venv\Scripts\python -m pip install ultralytics opencv-python
.venv\Scripts\python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

## Run

Dev (one command, from the repo root; Ctrl+C stops both):

```powershell
npm run dev      # starts uvicorn --reload on :8000 + Vite on :5173 and opens http://localhost:5173
```

If a backend is already running on :8000 it is reused. `$env:BACKEND="off"; npm run dev` starts Vite only.

Demo (one process, works offline):

```powershell
npm run demo     # builds web/dist, then serves everything at http://127.0.0.1:8000
```

Team-tool keys: Space = play/pause, ←/→ = one frame, Shift+←/→ = one second. Count logger: M/C/B/T log a
motorcycle/car/bus/truck crossing (Shift = outbound), 1–9 pick the count line, Z undoes the last one.

## Checks

- `cd web; npm test`: schema, fixture and Balinese-direction tests (Node runs the TypeScript directly).
- `cd web; npm run typecheck`
- `.venv\Scripts\python -m unittest backend.test_live backend.test_routing backend.test_assistant` (the assistant tests use a fake API: no network, no cost)
- Sync: open the synthetic clip and seek anywhere. The "frame N" burned into the video must equal the timeline readout.

## Honest limits and privacy

- One fixed camera. Positions in 3D are approximate (flat-road homography).
- Every number shown must come from a measured run. The synthetic clip is always badged and bannered.
- No plates, faces or identities are stored. Track IDs are temporary and per clip (in the spirit of Indonesia's PDP law, UU 27/2022).
- Footage needs written permission from its operator. Record it in `LICENSES.md`.

Licenses and attribution: [`LICENSES.md`](LICENSES.md).

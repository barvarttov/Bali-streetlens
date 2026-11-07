# Licenses and attribution

| Component | License | Notes |
|---|---|---|
| Ultralytics YOLO | AGPL-3.0 | Fine for a hackathon demo. A closed product would need RT-DETR (Apache-2.0) or an Ultralytics enterprise license. |
| Model weights | see source | Record where each downloaded weight file comes from, and its license. |
| TrafficLab 3D (duy-phamduc68) | MIT | Inspiration only, unless code is copied. If any is copied, keep its copyright notice here and in the file. |
| OpenCV | Apache-2.0 | |
| Three.js | MIT | |
| React | MIT | |
| Vite | MIT | |
| FastAPI / Starlette | MIT / BSD-3-Clause | |
| PyYAML | MIT | |
| MapLibre GL JS | BSD-3-Clause | Map renderer |
| OpenStreetMap data | ODbL 1.0 | Basemap tiles and junction geometry. Attribution "© OpenStreetMap contributors" is shown on the map. |
| Protomaps basemap build | BSD-3-Clause (schema/code), ODbL (data) | Tiles copied from build.protomaps.com by `npm run tiles` |
| pmtiles (JS) | BSD-3-Clause | Used only by the tile-fetch script |
| Hanken Grotesk | SIL OFL 1.1 | UI typeface, self-hosted via @fontsource |
| Noto Sans (map label glyphs) | SIL OFL 1.1 | From protomaps/basemaps-assets |
| Phosphor Icons | MIT | |
| three.js | MIT | 3D vehicles inside the map |
| Camera list and locations | Bali Satu Data, Diskominfos Provinsi Bali | The competition rules state that these CCTV streams are public and need no separate permission (team statement, 2026-11-07). The portal page itself still says "All Rights Reserved". |
| Live CCTV streams | Diskominfos Provinsi Bali (public HLS, `transcode.baliprov.go.id`) | Read live and analysed in memory only. No frame or video is stored or shown; the site publishes only anonymous 3D shapes, counts and temporary track ids. |
| ONNX Runtime | MIT | Runs AGA on the hosted site without torch |
| jsDelivr | Free public CDN | Serves the committed OpenStreetMap tiles (`data/tiles`) to the hosted site |

Footage: record the source URL, the operator and the date recorded for every clip in `data/`. Clips stay local and are not published.

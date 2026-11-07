import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Map as MlMap, Marker, MercatorCoordinate, setWorkerUrl } from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource, LngLatBoundsLike } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { Feature, FeatureCollection } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { useLang } from "../i18n.tsx";
import { COMPASS_LETTER, compassDirection } from "../lib/direction.ts";
import type { Camera, Corridor, JunctionState, LngLat, TrafficLabel } from "../lib/liveSchema.ts";
import { COLORS as c } from "../lib/palette.ts";
import { carriagewayWidth } from "../lib/traffic3d/lanes.ts";
import { FIRST_LABEL_LAYER, MAP_FONT, mapStyle, pxPerMeter } from "./mapStyle.ts";
import { JunctionMarker } from "./JunctionMarker.tsx";
import { StateMark } from "./parts.tsx";
import type { VehicleLayer } from "./VehicleLayer.ts";
import type { LiveVehicleLayer, MapVehicle } from "../live/LiveVehicleLayer.ts";
import { formatDistance, labelPoint } from "./route.ts";
import type { RouteResult } from "./route.ts";
import { ROUTE_LETTERS } from "./RouteView.tsx";

// MapLibre parses tiles in a module worker; the bundler has to be told where that file ends up.
setWorkerUrl(workerUrl);

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface MapViewProps {
  corridor: Corridor;
  cameras: Camera[];
  states: Map<string, JunctionState>;
  nowServer: number;
  selectedId: string | null;
  showAllCameras: boolean;
  mode3d: boolean;
  /** Map pixels covered by the search bar, the card or the sheet, so focus stays in the open part. */
  insets: Insets;
  synthetic: boolean;
  onSelect: (id: string) => void;
  onSelectCorridor: () => void;
  onSelectCamera: (id: string) => void;
  onMap: (map: MlMap | null) => void;
  onError: (message: string) => void;
  /** Route planner: the routes to draw (null outside the planner) and the chosen one. */
  route: RouteResult | null;
  selectedRoute: number;
  onSelectRoute: (index: number) => void;
  /** Provincial cameras that stream right now (always shown); null until the server answers. */
  liveCameraIds: Set<string> | null;
  /** The open camera card, if any: the map flies to it and rings it. */
  selectedCameraId: string | null;
  /** AGA's vehicles around the open camera, drawn in 3D on this map. */
  liveVehicles: LiveVehicles | null;
}

export interface LiveVehicles {
  cameraId: string;
  center: LngLat;
  vehicles: MapVehicle[];
}

/** Close enough that AGA's vehicles around a camera read in 3D. */
export const CAMERA_ZOOM = 18.3;

/** The provincial cameras (not the analysed corridor ones), with live = 1 when they stream right now. */
function cameraFeatures(cameras: Camera[], liveIds: Set<string> | null): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: cameras
      .filter((cam) => !cam.analyzed)
      .map((cam) => ({
        type: "Feature" as const,
        properties: { id: cam.id, name: cam.name, live: liveIds?.has(cam.id) ? 1 : 0 },
        geometry: { type: "Point" as const, coordinates: cam.lnglat },
      })),
  };
}

export const JUNCTION_ZOOM = 18; // the 160 m arms fill a phone screen and the 3D vehicles read
/** Below this zoom the six corridor junctions merge into one labelled group mark. */
const GROUP_BELOW_ZOOM = 11.6;
// The focus dim is feathered: rings of rising opacity around the chosen junction, so the rest of the
// map fades toward the paper without a hard-edged disc. [outer radius in meters, opacity of that ring]
const FEATHER: [number, number][] = [[200, 0], [260, 0.16], [320, 0.3], [390, 0.44], [470, 0.56]];
const DIM_MAX = 0.66;
/** The island itself (Nusa Penida included), for the first view and the zoom-out limit. */
export const BALI_LAND: [[number, number], [number, number]] = [[114.42, -8.86], [115.72, -8.05]];

/**
 * Zoom-out stops where the whole island just fits this screen, and panning stops at the edges of that
 * view (plus a little play), so the map never shows anything but Bali. Recomputed on resize, because a
 * portrait phone and a wide laptop fit the island at different zooms.
 */
function limitToBali(map: MlMap): void {
  const canvas = map.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const cam = map.cameraForBounds(BALI_LAND, { padding: Math.min(40, w * 0.05) });
  if (!cam?.center || cam.zoom === undefined) return;
  const zoom = cam.zoom;
  const world = 512 * 2 ** zoom;
  const c = MercatorCoordinate.fromLngLat(cam.center);
  const play = 1.12; // a little room to slide the island off-centre
  const dx = ((w / 2) * play) / world;
  const dy = ((h / 2) * play) / world;
  const sw = new MercatorCoordinate(c.x - dx, c.y + dy).toLngLat();
  const ne = new MercatorCoordinate(c.x + dx, c.y - dy).toLngLat();
  map.setMaxBounds(null);
  map.setMinZoom(Math.max(0, zoom - 0.15));
  map.setMaxBounds([[sw.lng, sw.lat], [ne.lng, ne.lat]]);
}

/** Road colour from the live label (feature-state). */
function stateExpr(fill: Record<TrafficLabel, string>): ExpressionSpecification {
  return ["match", ["coalesce", ["feature-state", "label"], "unknown"], "macet", fill.macet, "padat", fill.padat, "lancar", fill.lancar, fill.unknown];
}
const STATE_INK = stateExpr({ lancar: c.lancar, padat: c.padat, macet: c.macet, unknown: c.unknown });
const STATE_TINT = stateExpr({ lancar: c.lancarTint, padat: c.padatTint, macet: c.macetTint, unknown: c.unknownTint });

/** Width of a watched approach: cartographic far out, its true paved width (`w`, meters) up close. */
function surfaceWidth(extraPx: number): ExpressionSpecification {
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    12, 3 + extraPx * 0.3,
    15, ["max", 5 + extraPx, ["+", ["*", ["get", "w"], pxPerMeter(15)], extraPx]],
    22, ["+", ["*", ["get", "w"], pxPerMeter(22)], extraPx],
  ] as unknown as ExpressionSpecification;
}

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function corridorBounds(corridor: Corridor): LngLatBoundsLike {
  const xs = corridor.junctions.map((j) => j.center[0]);
  const ys = corridor.junctions.map((j) => j.center[1]);
  return [[Math.min(...xs) - 0.006, Math.min(...ys) - 0.006], [Math.max(...xs) + 0.006, Math.max(...ys) + 0.006]];
}

export function corridorCenter(corridor: Corridor): LngLat {
  const n = corridor.junctions.length;
  return [corridor.junctions.reduce((s, j) => s + j.center[0], 0) / n, corridor.junctions.reduce((s, j) => s + j.center[1], 0) / n];
}

function circle(center: LngLat, radiusM: number): LngLat[] {
  const kx = radiusM / (111320 * Math.cos((center[1] * Math.PI) / 180));
  const ky = radiusM / 110540;
  const ring: LngLat[] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    ring.push([center[0] + Math.cos(a) * kx, center[1] + Math.sin(a) * ky]);
  }
  return ring;
}

/** Feathered rings around `center`, then the rest of the world at full dim. Each feature carries its opacity `o`. */
function focusMask(center: LngLat | null): FeatureCollection {
  const world: LngLat[] = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  if (!center) return { type: "FeatureCollection", features: [] };
  const features: Feature[] = [];
  for (let i = 1; i < FEATHER.length; i++) {
    features.push({
      type: "Feature",
      properties: { o: FEATHER[i][1] },
      geometry: { type: "Polygon", coordinates: [circle(center, FEATHER[i][0]), circle(center, FEATHER[i - 1][0])] },
    });
  }
  features.push({
    type: "Feature",
    properties: { o: DIM_MAX },
    geometry: { type: "Polygon", coordinates: [world, circle(center, FEATHER[FEATHER.length - 1][0])] },
  });
  return { type: "FeatureCollection", features };
}

/** Fades the dim in or out over 200 ms by scaling every ring's opacity together. */
function fadeDim(map: MlMap, to: 0 | 1): void {
  const set = (k: number) => {
    map.setPaintProperty("focus-dim", "fill-opacity", ["*", ["get", "o"], k]);
  };
  if (prefersReducedMotion()) {
    set(to);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / 200);
    const eased = 1 - Math.pow(1 - p, 3);
    set(to === 1 ? eased : 1 - eased);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function MapView(props: MapViewProps) {
  const { corridor, cameras, states, selectedId, mode3d, insets, showAllCameras } = props;
  const { t, lang } = useLang();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const approachIds = useRef(new Map<string, number[]>());
  const vehiclesRef = useRef<VehicleLayer | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [ready, setReady] = useState(false);
  const [markerEls, setMarkerEls] = useState<Map<string, HTMLElement>>(new Map());
  const [groupEl, setGroupEl] = useState<HTMLElement | null>(null);
  const endMarkers = useRef<{ from: Marker; to: Marker } | null>(null);

  // Create the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let map: MlMap;
    try {
      const start = corridor.junctions.find((j) => j.id === selectedId);
      map = new MlMap({
        container,
        style: mapStyle(window.location.origin),
        maxPitch: 70,
        attributionControl: false,
        dragRotate: true,
        ...(start
          ? { center: start.center, zoom: JUNCTION_ZOOM, pitch: 58, bearing: 0 }
          : { bounds: BALI_LAND, fitBoundsOptions: { padding: 48 }, pitch: 0, bearing: 0 }),
      });
    } catch (err) {
      callbacks.current.onError((err as Error).message);
      return;
    }
    mapRef.current = map;
    limitToBali(map);
    map.on("resize", () => limitToBali(map));
    // Dev-only handle for debugging the camera from the console (and for Person B's layer work).
    if (import.meta.env.DEV) (window as unknown as { __streetlensMap?: MlMap }).__streetlensMap = map;

    map.on("load", () => {
      map.addSource("focus", { type: "geojson", data: focusMask(null) });
      map.addLayer({ id: "focus-dim", type: "fill", source: "focus", paint: { "fill-color": c.dim, "fill-opacity": ["*", ["get", "o"], 0] } });

      // One feature per observed arm line, with its true paved width; feature-state carries the label.
      let nextId = 1;
      const features: Feature[] = [];
      for (const j of corridor.junctions) {
        for (const arm of j.arms) {
          const ids: number[] = [];
          arm.lines.forEach((line, li) => {
            ids.push(nextId);
            features.push({
              type: "Feature",
              id: nextId++,
              properties: { jid: j.id, arm: arm.id, w: carriagewayWidth(arm, li) },
              geometry: { type: "LineString", coordinates: line },
            });
          });
          approachIds.current.set(`${j.id}/${arm.id}`, ids);
        }
      }
      map.addSource("approaches", { type: "geojson", data: { type: "FeatureCollection", features } });
      const near = (from: number, to: number) => ["interpolate", ["linear"], ["zoom"], 15, from, 16, to] as ExpressionSpecification;
      // Up close the watched road IS the coloured band: its paved width in a pale state tint between
      // two edges in the state ink. Vehicles drive on it. Far out it is a plain line in the state ink.
      map.addLayer(
        {
          id: "approach-edge",
          type: "line",
          source: "approaches",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": STATE_INK, "line-width": surfaceWidth(4) },
        },
        FIRST_LABEL_LAYER,
      );
      map.addLayer(
        {
          id: "approach-surface",
          type: "line",
          source: "approaches",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": STATE_TINT, "line-width": surfaceWidth(0), "line-opacity": near(0, 1) },
        },
        FIRST_LABEL_LAYER,
      );
      // The dim sits above the basemap and labels but below the observed approaches.
      map.moveLayer("focus-dim", "approach-edge");

      // Live vehicles in 3D (Three.js in the map's own WebGL context), on the coloured approaches.
      // Three.js loads after the map is up, so the first view stays fast on a phone.
      import("./VehicleLayer.ts")
        .then(({ createVehicleLayer }) => {
          if (mapRef.current !== map) return; // unmounted meanwhile
          const vehicles = createVehicleLayer(corridor);
          map.addLayer(vehicles.layer, FIRST_LABEL_LAYER);
          vehicles.setStates(callbacks.current.states);
          vehiclesRef.current = vehicles;
        })
        .catch((err) => {
          // The map stays useful without vehicles; the marks and colours still tell the state.
          if (import.meta.env.DEV) console.warn("3D vehicles unavailable", err);
        });

      // Direction plates (U, T, S, B ...) at the outer end of each approach of the selected junction.
      map.addImage("plate", { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(255) }, {
        sdf: true,
        stretchX: [[0, 4]],
        stretchY: [[0, 4]],
        content: [0, 0, 4, 4],
      });
      map.addSource("arm-tips", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: corridor.junctions.flatMap((j) =>
            j.arms.map((arm) => {
              const line = arm.lines[0];
              const dir = compassDirection(arm.bearing);
              return {
                type: "Feature" as const,
                properties: { jid: j.id, id: COMPASS_LETTER.id[dir], en: COMPASS_LETTER.en[dir] },
                geometry: { type: "Point" as const, coordinates: line[line.length - 1] },
              };
            }),
          ),
        },
      });
      map.addLayer({
        id: "arm-plates",
        type: "symbol",
        source: "arm-tips",
        minzoom: 15,
        filter: ["==", ["get", "jid"], ""],
        layout: {
          "text-field": ["get", "id"],
          "text-font": [MAP_FONT.strong],
          "text-size": 15,
          "text-letter-spacing": 0.04,
          "icon-image": "plate",
          "icon-text-fit": "both",
          "icon-text-fit-padding": [5, 8, 4, 8],
          "text-allow-overlap": true,
          "icon-allow-overlap": true,
        },
        paint: { "text-color": c.plateText, "icon-color": c.plate },
      });

      // Invisible footprints at every watched junction: basemap place names give way to the marks.
      map.addImage("marker-space", { width: 56, height: 40, data: new Uint8Array(56 * 40 * 4) });
      map.addSource("junction-points", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: corridor.junctions.map((j) => ({ type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: j.center } })),
        },
      });
      // Far out, basemap place names also give way to the "KORIDOR BANDARA 6" group label below its mark.
      map.addImage("group-space", { width: 230, height: 64, data: new Uint8Array(230 * 64 * 4) });
      map.addSource("corridor-point", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: corridorCenter(corridor) } },
      });
      map.addLayer({
        id: "group-space",
        type: "symbol",
        source: "corridor-point",
        maxzoom: GROUP_BELOW_ZOOM,
        layout: { "icon-image": "group-space", "icon-anchor": "top", "icon-offset": [0, -14], "icon-allow-overlap": true, "icon-ignore-placement": false },
        paint: { "icon-opacity": 0 },
      });
      map.addLayer({
        id: "marker-space",
        type: "symbol",
        source: "junction-points",
        minzoom: GROUP_BELOW_ZOOM,
        layout: { "icon-image": "marker-space", "icon-allow-overlap": true, "icon-ignore-placement": false },
        paint: { "icon-opacity": 0 },
      });

      map.addSource("cameras", { type: "geojson", data: cameraFeatures(cameras, callbacks.current.liveCameraIds) });
      // Cameras that stream right now are always on the map, filled; the rest only with "Kamera provinsi".
      map.addLayer({
        id: "cameras",
        type: "circle",
        source: "cameras",
        filter: ["!=", ["get", "live"], 1],
        layout: { visibility: "none" },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3, 15, 6],
          "circle-color": c.camera,
          "circle-stroke-color": c.cameraStroke,
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "camera-selected",
        type: "circle",
        source: "cameras",
        filter: ["==", ["get", "id"], ""],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 9, 15, 13, 18, 16],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": c.cameraLive,
          "circle-stroke-width": 2.5,
        },
      });
      map.addLayer({
        id: "cameras-live",
        type: "circle",
        source: "cameras",
        filter: ["==", ["get", "live"], 1],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 4.5, 15, 7.5],
          "circle-color": c.cameraLive,
          "circle-stroke-color": c.cameraLiveStroke,
          "circle-stroke-width": 2,
        },
      });
      for (const layer of ["cameras", "cameras-live"]) {
        map.on("click", layer, (e) => {
          const id = e.features?.[0]?.properties?.id;
          if (typeof id === "string") callbacks.current.onSelectCamera(id);
        });
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
      }

      // Junction marks are real buttons (focusable, labelled), rendered by React through portals.
      const els = new Map<string, HTMLElement>();
      for (const j of corridor.junctions) {
        const el = document.createElement("div");
        el.className = "marker-host";
        new Marker({ element: el, anchor: "center" }).setLngLat(j.center).addTo(map);
        els.set(j.id, el);
      }
      setMarkerEls(els);
      const group = document.createElement("div");
      group.className = "marker-host group-host";
      new Marker({ element: group, anchor: "top", offset: [0, -13] }).setLngLat(corridorCenter(corridor)).addTo(map);
      setGroupEl(group);

      // Routes: alternatives in grey, the chosen one in black (your selection's ink), both on a white
      // casing. They sit under the watched approaches, so a jam's colour stays visible on the route.
      const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
      map.addSource("routes", { type: "geojson", data: empty });
      map.addSource("route-links", { type: "geojson", data: empty });
      map.addSource("route-labels", { type: "geojson", data: empty });
      const isSel = ["==", ["get", "sel"], 1] as ExpressionSpecification;
      const notSel = ["!=", ["get", "sel"], 1] as ExpressionSpecification;
      const routeWidth = (z8: number, z12: number, z16: number) =>
        ["interpolate", ["exponential", 1.5], ["zoom"], 8, z8, 12, z12, 16, z16, 19, z16 * 1.8] as ExpressionSpecification;
      const lineLayout = { "line-cap": "round", "line-join": "round" } as const;
      map.addLayer({ id: "route-alt-case", type: "line", source: "routes", filter: notSel, layout: lineLayout, paint: { "line-color": c.paper, "line-width": routeWidth(5, 8, 13) } }, "approach-edge");
      map.addLayer({ id: "route-alt", type: "line", source: "routes", filter: notSel, layout: lineLayout, paint: { "line-color": c.routeAlt, "line-width": routeWidth(3, 5, 8) } }, "approach-edge");
      map.addLayer({ id: "route-sel-case", type: "line", source: "routes", filter: isSel, layout: lineLayout, paint: { "line-color": c.paper, "line-width": routeWidth(7, 11, 17) } }, "approach-edge");
      map.addLayer({ id: "route-sel", type: "line", source: "routes", filter: isSel, layout: lineLayout, paint: { "line-color": c.route, "line-width": routeWidth(4, 6.5, 10) } }, "approach-edge");
      map.addLayer({ id: "route-link", type: "line", source: "route-links", layout: { "line-cap": "round" }, paint: { "line-color": c.route, "line-width": 2.5, "line-dasharray": [0.5, 2] } }, "approach-edge");
      // A wide invisible line over the alternatives, so a finger can pick one on the map.
      map.addLayer({ id: "route-hit", type: "line", source: "routes", filter: notSel, paint: { "line-color": c.ink, "line-opacity": 0, "line-width": 24 } });
      map.addLayer({
        id: "route-labels",
        type: "symbol",
        source: "route-labels",
        layout: {
          "text-field": ["get", "t"],
          "text-font": [MAP_FONT.strong],
          "text-size": 14,
          "text-letter-spacing": 0.02,
          "icon-image": "plate",
          "icon-text-fit": "both",
          "icon-text-fit-padding": [6, 9, 5, 9],
          "text-allow-overlap": true,
          "icon-allow-overlap": true,
          "symbol-sort-key": ["get", "sel"],
          "symbol-z-order": "source",
        },
        paint: {
          "text-color": ["case", isSel, c.plateText, c.ink],
          "icon-color": ["case", isSel, c.plate, c.paper],
          "icon-halo-color": c.accent,
          "icon-halo-width": 1.5,
        },
      });
      for (const layer of ["route-hit", "route-labels"]) {
        map.on("click", layer, (e) => {
          const i = e.features?.[0]?.properties?.i;
          if (typeof i === "number") callbacks.current.onSelectRoute(i);
        });
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
      }
      setReady(true);
      callbacks.current.onMap(map);
    });

    const updateZoomClass = () => container.classList.toggle("is-far", map.getZoom() < GROUP_BELOW_ZOOM);
    map.on("zoom", updateZoomClass);
    updateZoomClass();

    // Names never cover another mark. Worse states are placed first and sit on top; each name goes
    // right, or left when a mark (or an already placed name) is in the way, or hides when both sides
    // are taken. The selected junction always keeps its name.
    const RANK: Record<string, number> = { unknown: -1, lancar: 0, padat: 1, macet: 2 };
    const placeLabels = () => {
      const points = [...container.querySelectorAll<HTMLElement>(".junction-marker")]
        .map((el) => {
          const j = corridor.junctions.find((x) => x.id === el.dataset.junction);
          const name = el.querySelector<HTMLElement>(".marker-name");
          return {
            el,
            p: j ? map.project(j.center) : null,
            rank: RANK[el.dataset.label ?? "unknown"] ?? -1,
            selected: el.classList.contains("is-selected"),
            width: (name?.offsetWidth ?? 110) + 8,
          };
        })
        .sort((a, b) => Number(b.selected) - Number(a.selected) || b.rank - a.rank);
      const placed: { x0: number; x1: number; y: number }[] = [];
      const blocked = (x0: number, x1: number, y: number, self: HTMLElement) =>
        points.some((o) => o.el !== self && o.p && o.p.x > x0 - 14 && o.p.x < x1 + 14 && Math.abs(o.p.y - y) < 24) ||
        placed.some((r) => r.x0 < x1 && x0 < r.x1 && Math.abs(r.y - y) < 22);
      for (const pt of points) {
        if (!pt.p) continue;
        const half = 18;
        const right = { x0: pt.p.x + half, x1: pt.p.x + half + pt.width, y: pt.p.y };
        const left = { x0: pt.p.x - half - pt.width, x1: pt.p.x - half, y: pt.p.y };
        let side: "right" | "left" | "none" = "right";
        if (blocked(right.x0, right.x1, right.y, pt.el)) side = blocked(left.x0, left.x1, left.y, pt.el) ? "none" : "left";
        if (side === "none" && pt.selected) side = "right";
        if (side !== "none") placed.push(side === "right" ? right : left);
        pt.el.classList.toggle("label-left", side === "left");
        pt.el.classList.toggle("label-hidden", side === "none");
        (pt.el.parentElement as HTMLElement).style.zIndex = String(4 + pt.rank + (pt.selected ? 10 : 0));
      }
    };
    map.on("moveend", placeLabels);
    map.on("idle", placeLabels);
    map.on("error", (e) => {
      // Missing sea tiles answer 204 and never reach here; anything else is worth surfacing in dev.
      if (import.meta.env.DEV) console.warn("map error", e.error);
    });

    return () => {
      callbacks.current.onMap(null);
      vehiclesRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // The map is created once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live labels onto the observed approach segments.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    vehiclesRef.current?.setStates(states);
    for (const j of corridor.junctions) {
      const state = states.get(j.id);
      for (const arm of j.arms) {
        const label: TrafficLabel =
          !state || state.camera_state === "offline" ? "unknown" : (state.approaches.find((a) => a.arm === arm.id)?.label ?? "unknown");
        for (const id of approachIds.current.get(`${j.id}/${arm.id}`) ?? []) map.setFeatureState({ source: "approaches", id }, { label });
      }
    }
  }, [states, corridor, ready]);

  // Plates follow the language (U/T/S/B or N/E/S/W).
  useEffect(() => {
    const map = mapRef.current;
    if (map && ready) map.setLayoutProperty("arm-plates", "text-field", ["get", lang]);
  }, [lang, ready]);

  // Selection: fly in and dim the rest.
  const firstSelection = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const junction = corridor.junctions.find((j) => j.id === selectedId) ?? null;
    if (junction) (map.getSource("focus") as GeoJSONSource).setData(focusMask(junction.center));
    fadeDim(map, junction ? 1 : 0);
    map.setFilter("arm-plates", ["==", ["get", "jid"], junction?.id ?? ""]);
    const isFirst = firstSelection.current;
    firstSelection.current = false;
    if (isFirst || !junction) return; // the constructor framed the first view; leaving is PublicApp's flight
    map.flyTo({
      center: junction.center,
      zoom: JUNCTION_ZOOM,
      pitch: mode3d ? 58 : 0,
      duration: prefersReducedMotion() ? 0 : 900,
      padding: callbacks.current.insets,
      essential: true,
    });
    // insets change as the sheet moves; that shouldn't re-trigger a flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, ready]);

  // Keep the selected junction in the open part of the map when the card or sheet changes size
  // (including a shared link, where the sheet opens after the map has framed the junction).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const junction = corridor.junctions.find((j) => j.id === selectedId);
    if (!junction) return;
    map.easeTo({ center: junction.center, padding: insets, duration: prefersReducedMotion() ? 0 : 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insets.bottom, insets.left, ready]);

  // 2D / 3D.
  const firstMode = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setLayoutProperty("buildings-3d", "visibility", mode3d ? "visible" : "none");
    map.setLayoutProperty("buildings-flat", "visibility", mode3d ? "none" : "visible");
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    const pitch = !mode3d ? 0 : map.getZoom() >= 16 ? 58 : map.getZoom() >= 12 ? 45 : 30;
    map.easeTo({ pitch, duration: prefersReducedMotion() ? 0 : 400 });
  }, [mode3d, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setLayoutProperty("cameras", "visibility", showAllCameras ? "visible" : "none");
  }, [showAllCameras, ready]);

  // Which provincial cameras stream right now.
  const { liveCameraIds, selectedCameraId, liveVehicles } = props;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("cameras") as GeoJSONSource).setData(cameraFeatures(cameras, liveCameraIds));
  }, [cameras, liveCameraIds, ready]);

  // An opened camera: ring it and fly close enough for its vehicles to read in 3D.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setFilter("camera-selected", ["==", ["get", "id"], selectedCameraId ?? ""]);
    const cam = cameras.find((x) => x.id === selectedCameraId);
    if (!cam) return;
    map.flyTo({
      center: cam.lnglat,
      zoom: CAMERA_ZOOM,
      pitch: callbacks.current.mode3d ? 58 : 0,
      bearing: 0,
      duration: prefersReducedMotion() ? 0 : 1100,
      padding: callbacks.current.insets,
      essential: true,
    });
  }, [selectedCameraId, cameras, ready]);

  // AGA's vehicles: one Three.js layer around the open camera, replaced when another camera opens.
  const liveLayer = useRef<{ cameraId: string; layer: LiveVehicleLayer } | null>(null);
  const liveCameraId = liveVehicles?.cameraId ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !liveCameraId) return;
    let cancelled = false;
    const center = liveVehicles!.center;
    import("../live/LiveVehicleLayer.ts")
      .then(({ createLiveVehicleLayer }) => {
        if (cancelled || mapRef.current !== map) return;
        const layer = createLiveVehicleLayer(center);
        map.addLayer(layer.layer, FIRST_LABEL_LAYER);
        liveLayer.current = { cameraId: liveCameraId, layer };
        const now = callbacks.current.liveVehicles;
        if (now?.cameraId === liveCameraId) layer.setVehicles(now.vehicles);
      })
      .catch((err) => {
        if (import.meta.env.DEV) console.warn("live 3D vehicles unavailable", err);
      });
    return () => {
      cancelled = true;
      const current = liveLayer.current;
      liveLayer.current = null;
      if (current && mapRef.current === map && map.getLayer(current.layer.layer.id)) map.removeLayer(current.layer.layer.id);
    };
    // the layer is rebuilt only when another camera opens; vehicles are fed by the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCameraId, ready]);
  useEffect(() => {
    const current = liveLayer.current;
    if (!current || !liveVehicles || current.cameraId !== liveVehicles.cameraId) return;
    current.layer.setVehicles(liveVehicles.vehicles);
  }, [liveVehicles]);

  // Routes, their labels ("A · 8,4 km") and the two ends.
  const { route, selectedRoute } = props;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const routes = route?.routes ?? [];
    const lines: Feature[] = routes.map((r, i) => ({
      type: "Feature",
      properties: { i, sel: i === selectedRoute ? 1 : 0 },
      geometry: { type: "LineString", coordinates: r.geometry },
    }));
    // The chosen route last, so it draws over shared stretches.
    lines.sort((a, b) => Number(a.properties?.sel) - Number(b.properties?.sel));
    (map.getSource("routes") as GeoJSONSource).setData({ type: "FeatureCollection", features: lines });
    (map.getSource("route-labels") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features:
        routes.length > 1
          ? routes.map((r, i) => ({
              type: "Feature" as const,
              properties: { i, sel: i === selectedRoute ? 1 : 0, t: `${ROUTE_LETTERS[i]} · ${formatDistance(r.distance_m, lang)}` },
              geometry: { type: "Point" as const, coordinates: labelPoint(r, routes.filter((o) => o !== r)) },
            }))
          : [],
    });
    // Dotted links from where the visitor's points are to where the road starts, when that's a walk.
    const links: Feature[] = [];
    if (route) {
      for (const end of [route.from, route.to]) {
        if (end.offset_m > 15) links.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [end.lnglat, end.snapped] } });
      }
    }
    (map.getSource("route-links") as GeoJSONSource).setData({ type: "FeatureCollection", features: links });

    if (!route) {
      endMarkers.current?.from.remove();
      endMarkers.current?.to.remove();
      endMarkers.current = null;
      return;
    }
    if (!endMarkers.current) {
      const make = (cls: string) => {
        const el = document.createElement("div");
        el.className = cls;
        return new Marker({ element: el, anchor: "center" });
      };
      endMarkers.current = { from: make("route-end-mark is-from"), to: make("route-end-mark is-to") };
    }
    endMarkers.current.from.setLngLat(route.from.lnglat).addTo(map);
    endMarkers.current.to.setLngLat(route.to.lnglat).addTo(map);
  }, [route, selectedRoute, ready, lang]);

  const worst = corridor.junctions
    .map((j) => states.get(j.id)?.label ?? "unknown")
    .reduce<TrafficLabel>((w, l) => (({ unknown: -1, lancar: 0, padat: 1, macet: 2 })[l] > ({ unknown: -1, lancar: 0, padat: 1, macet: 2 })[w] ? l : w), "unknown");
  return (
    <div ref={containerRef} className="map-canvas" aria-label={t("mapRegion")} role="region">
      {corridor.junctions.map((j) => {
        const el = markerEls.get(j.id);
        if (!el) return null;
        return createPortal(
          <JunctionMarker
            junction={j}
            state={states.get(j.id)}
            nowServer={props.nowServer}
            synthetic={props.synthetic}
            selected={j.id === selectedId}
            dimmed={selectedId !== null && j.id !== selectedId}
            onSelect={() => props.onSelect(j.id)}
          />,
          el,
          j.id,
        );
      })}
      {groupEl &&
        createPortal(
          <button
            type="button"
            className="corridor-marker"
            onClick={props.onSelectCorridor}
            aria-label={t("corridorMarker", { name: t("corridorTitle"), n: corridor.junctions.length })}
          >
            <StateMark label={worst} size={22} />
            <span className="corridor-name">{t("corridorTitle")}</span>
            <span className="corridor-count">{corridor.junctions.length}</span>
          </button>,
          groupEl,
        )}
    </div>
  );
}

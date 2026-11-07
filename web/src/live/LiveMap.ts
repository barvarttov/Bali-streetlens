import {
  Camera,
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { Map as MlMap, Marker, setWorkerUrl } from "maplibre-gl";
import type { CustomLayerInterface } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LngLat } from "../lib/geo.ts";
import { COLORS, hex, vehicleColor } from "../lib/palette.ts";
import { shapeGeometry, SHAPES } from "../lib/traffic3d/shapes.ts";
import { localFrame, toLocal } from "../lib/traffic3d/lanes.ts";
import type { VehicleClass } from "../lib/schema.ts";
import { mapStyle } from "../public/mapStyle.ts";

// The live camera on the team's own 3D map (OSM roads and extruded buildings): AGA's vehicles are drawn as
// Three.js meshes inside the map's WebGL context, so they hide behind buildings like real ones.
// Positions arrive as longitude/latitude. Whether they are measured (a calibrated camera) or a rough guess is
// decided by the caller and said in words on the page. The look is the main map's: graphite, true size, solid,
// the class told apart by shape only (lib/palette.ts vehicleColor).

setWorkerUrl(workerUrl);

export interface MapVehicle {
  id: number;
  cls: VehicleClass;
  lnglat: LngLat;
}

const VEHICLE_COLOR = vehicleColor(false, "unknown", false);
const MAX_PER_CLASS = 200;
const LAYER_ID = "live-vehicles";

interface Entry {
  cls: VehicleClass;
  x: number;
  z: number;
  tx: number;
  tz: number;
  heading: number;
}

function angleToward(from: number, to: number, k: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return from + d * k;
}

export class LiveMap {
  private readonly map: MlMap;
  private readonly entries = new Map<number, Entry>();
  private readonly frame;
  private disposed = false;
  private readonly pin: Marker;
  private repaint: () => void = () => undefined;

  constructor(host: HTMLElement, center: LngLat, onError: (message: string) => void) {
    this.frame = localFrame(center);
    this.map = new MlMap({
      container: host,
      style: mapStyle(window.location.origin),
      center,
      zoom: 19.2,
      pitch: 58,
      bearing: 0,
      maxPitch: 70,
      attributionControl: false,
    });
    this.map.on("error", (e) => {
      // A sea tile the CDN does not have answers 404: that square is simply blank, not an error.
      const status = (e.error as { status?: number } | undefined)?.status;
      if (!this.map.loaded() && status !== 404) onError(e.error?.message ?? "map error");
    });

    const dot = document.createElement("div");
    dot.className = "live-cam-pin";
    dot.title = "Lokasi kamera";
    this.pin = new Marker({ element: dot }).setLngLat(center).addTo(this.map);

    this.map.on("load", () => {
      if (!this.disposed) this.map.addLayer(this.buildLayer());
    });
  }

  setVehicles(vehicles: readonly MapVehicle[]): void {
    const seen = new Set<number>();
    for (const v of vehicles) {
      if (!Number.isFinite(v.lnglat[0]) || !Number.isFinite(v.lnglat[1])) continue;
      const [x, z] = toLocal(this.frame, v.lnglat);
      seen.add(v.id);
      const e = this.entries.get(v.id);
      if (!e) {
        this.entries.set(v.id, { cls: v.cls, x, z, tx: x, tz: z, heading: 0 });
        continue;
      }
      e.cls = v.cls;
      const dx = x - e.tx;
      const dz = z - e.tz;
      if (Math.hypot(dx, dz) > 0.6) e.heading = angleToward(e.heading, Math.atan2(-dz, dx), 0.5);
      e.tx = x;
      e.tz = z;
    }
    for (const id of this.entries.keys()) if (!seen.has(id)) this.entries.delete(id);
    this.repaint();
  }

  dispose(): void {
    this.disposed = true;
    this.pin.remove();
    this.map.remove();
  }

  private buildLayer(): CustomLayerInterface {
    const f = this.frame;
    const model = new Matrix4()
      .makeTranslation(f.originMerc.x, f.originMerc.y, 0)
      .scale(new Vector3(f.unit, -f.unit, f.unit))
      .multiply(new Matrix4().makeRotationX(Math.PI / 2));

    const scene = new Scene();
    const hemi = new HemisphereLight(hex(COLORS.skyLight), hex(COLORS.groundLight), COLORS.hemiIntensity);
    scene.add(hemi);
    const sun = new DirectionalLight(0xffffff, COLORS.sunIntensity);
    sun.position.set(-0.4, 1, -0.6);
    scene.add(sun);

    const material = new MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
    const meshes = {} as Record<VehicleClass, InstancedMesh>;
    for (const cls of Object.keys(SHAPES) as VehicleClass[]) {
      const mesh = new InstancedMesh(shapeGeometry(cls), material, MAX_PER_CLASS);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.setColorAt(0, new Color(0xffffff));
      meshes[cls] = mesh;
      scene.add(mesh);
    }

    const camera = new Camera();
    const mvp = new Matrix4();
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const pos = new Vector3();
    const scale = new Vector3();
    const color = new Color();
    let renderer: WebGLRenderer | null = null;
    const map = this.map;

    return {
      id: LAYER_ID,
      type: "custom",
      renderingMode: "3d",
      onAdd: (_map, gl) => {
        renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
        renderer.autoClear = false;
        this.repaint = () => map.triggerRepaint();
      },
      onRemove: () => {
        renderer?.dispose();
        renderer = null;
        this.repaint = () => undefined;
      },
      render: (_gl, options) => {
        if (!renderer) return;
        const counts: Record<VehicleClass, number> = { motorcycle: 0, car: 0, bus: 0, truck: 0 };
        let moving = false;
        for (const e of this.entries.values()) {
          // Glide to the newest position instead of jumping.
          e.x += (e.tx - e.x) * 0.2;
          e.z += (e.tz - e.z) * 0.2;
          if (Math.abs(e.tx - e.x) + Math.abs(e.tz - e.z) > 0.02) moving = true;
          const i = counts[e.cls]++;
          if (i >= MAX_PER_CLASS) continue;
          q.setFromAxisAngle(up, e.heading);
          meshes[e.cls].setMatrixAt(i, m.compose(pos.set(e.x, 0, e.z), q, scale.set(1, 1, 1)));
          meshes[e.cls].setColorAt(i, color.setHex(VEHICLE_COLOR));
        }
        for (const cls of Object.keys(meshes) as VehicleClass[]) {
          const mesh = meshes[cls];
          mesh.count = Math.min(counts[cls], MAX_PER_CLASS);
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
        camera.projectionMatrix = mvp
          .fromArray(options.defaultProjectionData.mainMatrix as unknown as number[])
          .multiply(model);
        renderer.resetState();
        renderer.render(scene, camera);
        if (moving) map.triggerRepaint();
      },
    };
  }
}

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
import type { CustomLayerInterface, Map as MlMap } from "maplibre-gl";
import type { LngLat } from "../lib/geo.ts";
import { COLORS, hex, vehicleColor } from "../lib/palette.ts";
import { shapeGeometry, SHAPES } from "../lib/traffic3d/shapes.ts";
import { localFrame, toLocal } from "../lib/traffic3d/lanes.ts";
import { glideDuration, glideFraction, lerp } from "./glide.ts";
import type { VehicleClass } from "../lib/schema.ts";

// AGA's vehicles for one live camera, drawn as Three.js meshes inside the public map's WebGL context, so
// they hide behind the extruded OSM buildings like real ones. Positions arrive as longitude/latitude;
// whether they are measured (a calibrated camera) or a rough guess is decided by the caller and said in
// words on the card. The look is the corridor's: graphite, true size, solid, the class told apart by shape.

export interface MapVehicle {
  id: number;
  cls: VehicleClass;
  lnglat: LngLat;
}

export interface LiveVehicleLayer {
  layer: CustomLayerInterface;
  setVehicles(vehicles: readonly MapVehicle[]): void;
}

export const LIVE_VEHICLE_LAYER_ID = "live-vehicles";

const VEHICLE_COLOR = vehicleColor(false, "unknown", false);
const MAX_PER_CLASS = 200;

interface Entry {
  cls: VehicleClass;
  /** Where it is drawn now. */
  x: number;
  z: number;
  /** Where the current glide started and where it ends (local meters). */
  sx: number;
  sz: number;
  tx: number;
  tz: number;
  /** When the glide started and how long it lasts (ms, performance.now clock). */
  t0: number;
  dur: number;
  heading: number;
  /** The way it is travelling; `heading` turns toward it a little each frame. */
  th: number;
}

/** Shortest signed turn from one heading to another (-PI..PI). */
function angleDiff(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function angleToward(from: number, to: number, k: number): number {
  return from + angleDiff(from, to) * k;
}

/** A custom layer centred on one camera. Make a new one when another camera is opened. */
export function createLiveVehicleLayer(center: LngLat): LiveVehicleLayer {
  const frame = localFrame(center);
  const entries = new Map<number, Entry>();
  let lastChange = 0; // when a vehicle last got a NEW position (an unchanged poll must not restart the glide)
  let map: MlMap | null = null;
  let renderer: WebGLRenderer | null = null;
  const repaint = () => map?.triggerRepaint();

  const model = new Matrix4()
    .makeTranslation(frame.originMerc.x, frame.originMerc.y, 0)
    .scale(new Vector3(frame.unit, -frame.unit, frame.unit))
    .multiply(new Matrix4().makeRotationX(Math.PI / 2));

  const scene = new Scene();
  scene.add(new HemisphereLight(hex(COLORS.skyLight), hex(COLORS.groundLight), COLORS.hemiIntensity));
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

  const layer: CustomLayerInterface = {
    id: LIVE_VEHICLE_LAYER_ID,
    type: "custom",
    renderingMode: "3d",
    onAdd: (m2, gl) => {
      map = m2;
      renderer = new WebGLRenderer({ canvas: m2.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    onRemove: () => {
      renderer?.dispose();
      renderer = null;
      map = null;
    },
    render: (_gl, options) => {
      if (!renderer || !map) return;
      const counts: Record<VehicleClass, number> = { motorcycle: 0, car: 0, bus: 0, truck: 0 };
      let moving = false;
      const now = performance.now();
      for (const e of entries.values()) {
        // Constant-speed glide from the old place to the new one, arriving as the next update lands.
        const u = glideFraction(e.t0, e.dur, now);
        e.x = lerp(e.sx, e.tx, u);
        e.z = lerp(e.sz, e.tz, u);
        e.heading = angleToward(e.heading, e.th, 0.15);
        if (u < 1 || Math.abs(angleDiff(e.heading, e.th)) > 0.02) moving = true;
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
      camera.projectionMatrix = mvp.fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]).multiply(model);
      renderer.resetState();
      renderer.render(scene, camera);
      if (moving) map.triggerRepaint();
    },
  };

  return {
    layer,
    setVehicles(vehicles) {
      const now = performance.now();
      const seen = new Set<number>();
      const fresh: { id: number; cls: VehicleClass; x: number; z: number }[] = [];
      let changed = false;
      for (const v of vehicles) {
        if (!Number.isFinite(v.lnglat[0]) || !Number.isFinite(v.lnglat[1])) continue;
        const [x, z] = toLocal(frame, v.lnglat);
        seen.add(v.id);
        fresh.push({ id: v.id, cls: v.cls, x, z });
        const e = entries.get(v.id);
        if (!e || Math.abs(e.tx - x) + Math.abs(e.tz - z) > 0.05) changed = true;
      }
      // One duration for every vehicle: the time since the feed last moved anything.
      const dur = glideDuration(lastChange ? now - lastChange : 0);
      if (changed) lastChange = now;
      for (const v of fresh) {
        const e = entries.get(v.id);
        if (!e) {
          entries.set(v.id, { cls: v.cls, x: v.x, z: v.z, sx: v.x, sz: v.z, tx: v.x, tz: v.z, t0: now, dur: 0, heading: 0, th: 0 });
          continue;
        }
        e.cls = v.cls;
        const dx = v.x - e.tx;
        const dz = v.z - e.tz;
        if (Math.abs(dx) + Math.abs(dz) <= 0.05) continue; // same answer as before: keep gliding
        if (Math.hypot(dx, dz) > 0.6) e.th = Math.atan2(-dz, dx);
        e.sx = e.x; // continue from where it is drawn, not from where the last glide was meant to end
        e.sz = e.z;
        e.tx = v.x;
        e.tz = v.z;
        e.t0 = now;
        e.dur = dur;
      }
      for (const id of entries.keys()) if (!seen.has(id)) entries.delete(id);
      repaint();
    },
  };
}

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
import { COLORS, hex } from "../lib/palette.ts";
import { shapeGeometry, SHAPES } from "../lib/traffic3d/shapes.ts";
import { localFrame, toLocal } from "../lib/traffic3d/lanes.ts";
import type { VehicleClass } from "../lib/schema.ts";

// AGA's vehicles for one live camera, drawn as Three.js meshes inside the public map's WebGL context, so
// they hide behind the extruded OSM buildings like real ones. Positions arrive as longitude/latitude;
// whether they are measured (a calibrated camera) or a rough guess is decided by the caller, and
// `setApproximate` only changes how they are drawn (faded and enlarged, never solid).

export interface MapVehicle {
  id: number;
  cls: VehicleClass;
  lnglat: LngLat;
}

export interface LiveVehicleLayer {
  layer: CustomLayerInterface;
  setVehicles(vehicles: readonly MapVehicle[]): void;
  setApproximate(approximate: boolean): void;
}

export const LIVE_VEHICLE_LAYER_ID = "live-vehicles";

const CLASS_COLOR: Record<VehicleClass, number> = {
  motorcycle: 0x606c38,
  car: 0x3d5a80,
  bus: 0xb7791f,
  truck: 0x8c3a3a,
};
const MAX_PER_CLASS = 200;
const APPROX_SCALE = 2.5;

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

/** A custom layer centred on one camera. Make a new one when another camera is opened. */
export function createLiveVehicleLayer(center: LngLat): LiveVehicleLayer {
  const frame = localFrame(center);
  const entries = new Map<number, Entry>();
  let approximate = true;
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
      const k = approximate ? APPROX_SCALE : 1;
      for (const e of entries.values()) {
        // Glide to the newest position instead of jumping.
        e.x += (e.tx - e.x) * 0.2;
        e.z += (e.tz - e.z) * 0.2;
        if (Math.abs(e.tx - e.x) + Math.abs(e.tz - e.z) > 0.02) moving = true;
        const i = counts[e.cls]++;
        if (i >= MAX_PER_CLASS) continue;
        q.setFromAxisAngle(up, e.heading);
        meshes[e.cls].setMatrixAt(i, m.compose(pos.set(e.x, 0, e.z), q, scale.set(k, k, k)));
        meshes[e.cls].setColorAt(i, color.setHex(CLASS_COLOR[e.cls]));
      }
      material.transparent = approximate;
      material.opacity = approximate ? 0.6 : 1;
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
    setApproximate(next) {
      approximate = next;
      repaint();
    },
    setVehicles(vehicles) {
      const seen = new Set<number>();
      for (const v of vehicles) {
        if (!Number.isFinite(v.lnglat[0]) || !Number.isFinite(v.lnglat[1])) continue;
        const [x, z] = toLocal(frame, v.lnglat);
        seen.add(v.id);
        const e = entries.get(v.id);
        if (!e) {
          entries.set(v.id, { cls: v.cls, x, z, tx: x, tz: z, heading: 0 });
          continue;
        }
        e.cls = v.cls;
        const dx = x - e.tx;
        const dz = z - e.tz;
        if (Math.hypot(dx, dz) > 0.6) e.heading = angleToward(e.heading, Math.atan2(-dz, dx), 0.5);
        e.tx = x;
        e.tz = z;
      }
      for (const id of entries.keys()) if (!seen.has(id)) entries.delete(id);
      repaint();
    },
  };
}

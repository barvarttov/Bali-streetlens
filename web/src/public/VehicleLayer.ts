// The live 3D vehicles, drawn by Three.js inside the MapLibre map: one WebGL context, sharing the
// map's depth buffer, so vehicles hide behind the extruded OSM buildings like real ones.
// Colours come from lib/palette.ts. Vehicle class is told apart by shape and size.
//
// The layer only draws VehicleFrame entries. Today they come from TrafficSim (an illustration of the
// live numbers on real OSM lanes); when the camera pipeline sends tracked world positions, feed
// those frames instead and keep everything else.

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
import type { Corridor, JunctionState } from "../lib/liveSchema.ts";
import { COLORS, hex } from "../lib/palette.ts";
import { buildCorridorLanes } from "../lib/traffic3d/lanes.ts";
import { shapeGeometry, SHAPES } from "../lib/traffic3d/shapes.ts";
import { MAX_PER_JUNCTION, TrafficSim } from "../lib/traffic3d/sim.ts";
import type { VehicleClass, VehicleFrame } from "../lib/traffic3d/sim.ts";

export const VEHICLE_LAYER_ID = "vehicles-3d";
/** Below this zoom a 2 m motorbike is under a pixel: skip drawing and stop asking for frames. */
const MIN_ZOOM = 15;

export interface VehicleLayer {
  layer: CustomLayerInterface;
  setStates(states: Map<string, JunctionState>): void;
}

export function createVehicleLayer(corridor: Corridor): VehicleLayer {
  const { frame, junctions } = buildCorridorLanes(corridor);
  const sim = new TrafficSim(junctions);
  const capacity = MAX_PER_JUNCTION * junctions.length;

  // Local meters -> Mercator: translate to the origin, scale meters to Mercator units (y flipped:
  // Mercator y grows south, as our z does), and stand Three's y-up on the map's z-up.
  const model = new Matrix4()
    .makeTranslation(frame.originMerc.x, frame.originMerc.y, 0)
    .scale(new Vector3(frame.unit, -frame.unit, frame.unit))
    .multiply(new Matrix4().makeRotationX(Math.PI / 2));

  const scene = new Scene();
  const hemi = new HemisphereLight();
  scene.add(hemi);
  const sun = new DirectionalLight(0xffffff);
  sun.position.set(-0.4, 1, -0.6); // high, from the north-west: tops bright, sides readable
  scene.add(sun);

  const material = new MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  const meshes = {} as Record<VehicleClass, InstancedMesh>;
  for (const cls of Object.keys(SHAPES) as VehicleClass[]) {
    const mesh = new InstancedMesh(shapeGeometry(cls), material, capacity);
    mesh.frustumCulled = false; // instances span the corridor; the bounding sphere would be wrong
    mesh.count = 0;
    mesh.setColorAt(0, new Color(0xffffff)); // allocates instanceColor
    meshes[cls] = mesh;
    scene.add(mesh);
  }

  const camera = new Camera();
  const mvp = new Matrix4();
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const pos = new Vector3();
  const one = new Vector3(1, 1, 1);
  const color = new Color();
  const frames: VehicleFrame[] = [];
  const counts: Record<VehicleClass, number> = { motorcycle: 0, car: 0, bus: 0, truck: 0 };

  let map: MlMap | null = null;
  let renderer: WebGLRenderer | null = null;
  let last = 0;

  const layer: CustomLayerInterface = {
    id: VEHICLE_LAYER_ID,
    type: "custom",
    renderingMode: "3d",
    onAdd(m0, gl) {
      map = m0;
      renderer = new WebGLRenderer({ canvas: m0.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    onRemove() {
      renderer?.dispose();
      renderer = null;
      map = null;
    },
    render(_gl, options) {
      if (!map || !renderer) return;
      const now = performance.now();
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      if (map.getZoom() < MIN_ZOOM) {
        last = 0; // resume without a jump when zooming back in
        return;
      }
      sim.step(dt);
      sim.frame(frames);

      counts.motorcycle = counts.car = counts.bus = counts.truck = 0;
      for (const v of frames) {
        const mesh = meshes[v.cls];
        const i = counts[v.cls]++;
        q.setFromAxisAngle(up, Math.atan2(-v.dz, v.dx));
        mesh.setMatrixAt(i, m.compose(pos.set(v.x, 0, v.z), q, one));
        mesh.setColorAt(i, color.setHex(v.color));
      }
      for (const cls of Object.keys(meshes) as VehicleClass[]) {
        const mesh = meshes[cls];
        mesh.count = counts[cls];
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }

      // mainMatrix maps Web Mercator 0..1 (z in the same units) to clip space.
      camera.projectionMatrix = mvp.fromArray(options.defaultProjectionData.mainMatrix as unknown as number[]).multiply(model);
      renderer.resetState();
      renderer.render(scene, camera);
      if (frames.length) map.triggerRepaint(); // keep moving only while there is something to move
    },
  };

  hemi.color.setHex(hex(COLORS.skyLight));
  hemi.groundColor.setHex(hex(COLORS.groundLight));
  hemi.intensity = COLORS.hemiIntensity;
  sun.intensity = COLORS.sunIntensity;

  if (import.meta.env.DEV) (window as unknown as { __streetlensVehicles?: unknown }).__streetlensVehicles = { sim, frames };

  return {
    layer,
    setStates(states) {
      sim.setStates(states);
      map?.triggerRepaint();
    },
  };
}

// The team tool's 3D twin: the calibrated road plane and every tracked vehicle, in meters, synced
// to the video through the shared clock. Plain Three.js (no React): Scene3D.tsx mounts it once per
// clip and the render loop reads clock.timeAt() itself, so React never re-renders per frame.
//
// World frame (docs/schema.md): X east, Y north, meters. Three.js: x = X, y = up, z = -Y.

import {
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  HemisphereLight,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Scene,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  BufferGeometry,
  Float32BufferAttribute,
} from "three";
import type { Material, Object3D } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { clock } from "../lib/clock.ts";
import { defaultMargin, imageToWorld } from "../lib/homography.ts";
import type { Calibration } from "../lib/homography.ts";
import { COLORS, hex } from "../lib/palette.ts";
import type { CameraConfig, Meters, Px, VehicleClass } from "../lib/schema.ts";
import { VEHICLE_CLASSES } from "../lib/schema.ts";
import { shapeGeometry } from "../lib/traffic3d/shapes.ts";
import { vehiclesAt } from "../lib/worldTracks.ts";
import type { TwinVehicle, WorldTracks } from "../lib/worldTracks.ts";

export type TwinView = "camera" | "top";

export interface TwinScene {
  setView(view: TwinView): void;
  dispose(): void;
}

export interface TwinSceneOptions {
  /** Called when the view turns, with the camera's azimuth in radians (0 = looking north). */
  onAzimuth?: (radians: number) => void;
}

/** Road-plane point -> Three.js position. */
const v3 = ([x, y]: readonly [number, number], up = 0) => new Vector3(x, up, -y);

/** Projects a pixel polygon onto the road; null when any corner is above the horizon. */
function projectPolygon(cal: Calibration, px: readonly Px[]): Meters[] | null {
  const out: Meters[] = [];
  for (const p of px) {
    const w = imageToWorld(cal, p);
    if (!w) return null;
    out.push(w);
  }
  return out;
}

/** A flat polygon lying on the road at height `up`. */
function flatPolygon(points: readonly Meters[], color: string, up: number, opacity = 1): Mesh {
  const shape = new Shape(points.map(([x, y]) => new Vector2(x, y)));
  const geo = new ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2); // shape (X, Y) -> (X, 0, -Y)
  geo.translate(0, up, 0);
  const mat = new MeshBasicMaterial({ color: hex(color), transparent: opacity < 1, opacity, side: DoubleSide, depthWrite: opacity >= 1 });
  return new Mesh(geo, mat);
}

function outline(points: readonly Meters[], color: string, up: number, closed: boolean): Line {
  const pts = points.map((p) => v3(p, up));
  if (closed && pts.length) pts.push(pts[0].clone());
  return new Line(new BufferGeometry().setFromPoints(pts), new LineBasicMaterial({ color: hex(color) }));
}

/** A painted stripe from a to b, `width` meters wide (WebGL lines are always 1 px). */
function stripe(a: Meters, b: Meters, width: number, color: string, up: number): Mesh | null {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(len > 0.01)) return null;
  const mesh = new Mesh(new PlaneGeometry(len, width), new MeshBasicMaterial({ color: hex(color), side: DoubleSide }));
  mesh.rotation.order = "YXZ";
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.y = Math.atan2(b[1] - a[1], b[0] - a[0]);
  mesh.position.copy(v3([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], up));
  return mesh;
}

/**
 * Chevron on a count line, pointing to its "in" side. docs/schema.md defines "in" on screen (to the
 * left of the arrow p1 -> p2, image y down), so the side is found in the image and then projected:
 * that stays right for any camera orientation.
 */
function chevron(cal: Calibration, [p1, p2]: readonly [Px, Px], color: string, up: number): Mesh | null {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const lenPx = Math.hypot(dx, dy);
  if (!(lenPx > 0)) return null;
  const midPx: Px = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const inPx: Px = [midPx[0] + (dy / lenPx) * 10, midPx[1] - (dx / lenPx) * 10];
  const a = imageToWorld(cal, p1);
  const b = imageToWorld(cal, p2);
  const m = imageToWorld(cal, midPx);
  const towards = imageToWorld(cal, inPx);
  if (!a || !b || !m || !towards) return null;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let nx = towards[0] - m[0];
  let ny = towards[1] - m[1];
  const nlen = Math.hypot(nx, ny);
  if (!(len > 0.01) || !(nlen > 0)) return null;
  nx /= nlen;
  ny /= nlen;
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  const s = Math.min(1.2, len / 4);
  const tip: Meters = [m[0] + nx * s, m[1] + ny * s];
  const l: Meters = [m[0] - ux * s * 0.6, m[1] - uy * s * 0.6];
  const r: Meters = [m[0] + ux * s * 0.6, m[1] + uy * s * 0.6];
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute([...v3(l, up).toArray(), ...v3(r, up).toArray(), ...v3(tip, up).toArray()], 3));
  return new Mesh(geo, new MeshBasicMaterial({ color: hex(color), side: DoubleSide }));
}

function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material as Material | Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}

export function createTwinScene(
  container: HTMLElement,
  world: WorldTracks,
  cal: Calibration,
  config: CameraConfig,
  frameSize: [number, number],
  options: TwinSceneOptions = {},
): TwinScene {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.className = "scene-canvas";
  container.prepend(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(hex(COLORS.land));
  const hemi = new HemisphereLight(hex(COLORS.skyLight), hex(COLORS.groundLight), COLORS.hemiIntensity);
  scene.add(hemi);
  const sun = new DirectionalLight(0xffffff, COLORS.sunIntensity);
  sun.position.set(-0.4, 1, -0.6); // high, from the north-west, as on the public map
  scene.add(sun);

  // Extent: the calibrated area plus the margin the tracks were allowed to extrapolate into.
  const margin = defaultMargin(cal);
  const b = cal.bounds;
  const center: Meters = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  const diag = Math.max(10, Math.hypot(b.maxX - b.minX, b.maxY - b.minY));
  const size = Math.ceil((Math.max(b.maxX - b.minX, b.maxY - b.minY) + 2 * margin) / 10) * 10;

  const statics: Object3D[] = [];
  const add = (o: Object3D | null) => {
    if (!o) return;
    statics.push(o);
    scene.add(o);
  };

  const ground = new Mesh(new PlaneGeometry(size, size), new MeshLambertMaterial({ color: hex(COLORS.urban) }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.copy(v3(center, -0.02));
  add(ground);
  const grid = new GridHelper(size, size / 5, hex(COLORS.roadCase), hex(COLORS.rule)); // 5 m squares
  grid.position.copy(v3(center, -0.01));
  add(grid);

  const road = projectPolygon(cal, config.road_polygon_px);
  if (road && road.length >= 3) {
    add(flatPolygon(road, COLORS.road, 0));
    add(outline(road, COLORS.roadCaseMajor, 0.02, true));
  }
  for (const region of config.queue_regions) {
    const poly = projectPolygon(cal, region.polygon_px);
    if (poly && poly.length >= 3) {
      // Neutral: amber/red mean a traffic state, and the twin doesn't label queues (metrics.ts does).
      add(flatPolygon(poly, COLORS.unknownTint, 0.01, 0.9));
      add(outline(poly, COLORS.ink2, 0.03, true));
    }
  }
  for (const line of config.count_lines) {
    const a = imageToWorld(cal, line.px[0]);
    const c = imageToWorld(cal, line.px[1]);
    if (!a || !c) continue;
    add(stripe(a, c, 0.3, COLORS.accent, 0.04));
    add(chevron(cal, line.px, COLORS.accent, 0.05));
  }
  // Calibration points: filled = used for the fit, ring = hold-out check.
  const dot = new CircleGeometry(0.35, 20);
  const ring = new RingGeometry(0.3, 0.45, 24);
  for (const p of config.calibration.world_points_m) {
    const m = new Mesh(dot.clone(), new MeshBasicMaterial({ color: hex(COLORS.ink) }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(v3(p, 0.06));
    add(m);
  }
  for (const p of config.calibration.holdout_world_m) {
    const m = new Mesh(ring.clone(), new MeshBasicMaterial({ color: hex(COLORS.accent), side: DoubleSide }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(v3(p, 0.06));
    add(m);
  }
  dot.dispose();
  ring.dispose();

  // Vehicles: one instanced mesh per class, sized for every track of that class (an exact upper bound).
  const material = new MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  const meshes = {} as Record<VehicleClass, InstancedMesh>;
  for (const cls of VEHICLE_CLASSES) {
    const mesh = new InstancedMesh(shapeGeometry(cls), material, Math.max(1, world.perClass[cls]));
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.setColorAt(0, new Color(0xffffff)); // allocates instanceColor
    meshes[cls] = mesh;
    scene.add(mesh);
  }

  const camera = new PerspectiveCamera(45, 1, 0.5, Math.max(2000, diag * 20));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.screenSpacePanning = false; // pan along the road, not up into the sky
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.minDistance = 3;
  controls.maxDistance = diag * 6;

  // "Camera" view: look the way the CCTV looks, so the twin and the video read the same way round.
  // The bottom-centre of the frame is near the camera; the middle of the frame is further away.
  const [fw, fh] = frameSize;
  const near = imageToWorld(cal, [fw / 2, fh * 0.98]);
  const mid = imageToWorld(cal, [fw / 2, fh * 0.5]) ?? center;
  let back: Meters = [0, -1]; // fallback: from the south, looking north
  if (near) {
    const dx = near[0] - mid[0];
    const dy = near[1] - mid[1];
    const len = Math.hypot(dx, dy);
    if (len > 0.5) back = [dx / len, dy / len];
  }

  function setView(view: TwinView): void {
    controls.target.copy(v3(center));
    if (view === "top") {
      // Straight down, north up (a hair south of vertical so the orbit has a defined "up").
      camera.position.copy(v3([center[0], center[1] - diag * 0.001], diag * 1.5));
    } else {
      const d = diag * 1.05;
      camera.position.copy(v3([center[0] + back[0] * d, center[1] + back[1] * d], d * 0.7));
    }
    camera.lookAt(controls.target);
    controls.update();
    dirty = true;
  }

  // Render loop: draw only when the clock or the view changed.
  const frames: TwinVehicle[] = [];
  const counts: Record<VehicleClass, number> = { motorcycle: 0, car: 0, bus: 0, truck: 0 };
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const pos = new Vector3();
  const one = new Vector3(1, 1, 1);
  const color = new Color();
  const seen = hex(COLORS.vehicleMoving);
  const unseen = hex(COLORS.vehicleStale);
  let dirty = true;
  let lastT = Number.NaN;
  let lastAzimuth = Number.NaN;
  let raf = 0;

  function updateVehicles(t: number): void {
    vehiclesAt(world, t, frames);
    counts.motorcycle = counts.car = counts.bus = counts.truck = 0;
    for (const v of frames) {
      const mesh = meshes[v.cls];
      const i = counts[v.cls]++;
      q.setFromAxisAngle(up, v.heading); // +x (built direction) turned to (cos h, -sin h) in x/z = heading on the road
      mesh.setMatrixAt(i, m.compose(pos.set(v.x, 0, -v.y), q, one));
      mesh.setColorAt(i, color.setHex(v.state === "observed" ? seen : unseen));
    }
    for (const cls of VEHICLE_CLASSES) {
      const mesh = meshes[cls];
      mesh.count = counts[cls];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  function tick(): void {
    raf = requestAnimationFrame(tick);
    const moved = controls.update();
    const t = clock.timeAt(performance.now());
    if (t !== lastT) {
      lastT = t;
      updateVehicles(t);
      dirty = true;
    }
    if (!moved && !dirty) return;
    dirty = false;
    renderer.render(scene, camera);
    const azimuth = controls.getAzimuthalAngle();
    if (options.onAzimuth && !(Math.abs(azimuth - lastAzimuth) < 0.01)) {
      lastAzimuth = azimuth;
      options.onAzimuth(azimuth);
    }
  }

  const resize = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  setView("camera");
  raf = requestAnimationFrame(tick);

  return {
    setView,
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      for (const o of statics) disposeTree(o);
      for (const cls of VEHICLE_CLASSES) meshes[cls].geometry.dispose();
      for (const cls of VEHICLE_CLASSES) meshes[cls].dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

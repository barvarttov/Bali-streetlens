import * as THREE from "three";

// A small Three.js scene for one live camera: a ground plane and one box per tracked vehicle.
// x = east, z = -north (docs/schema.md). Vehicles glide to their newest position instead of jumping, and a
// vehicle that is missing from the newest update is removed at once (no ghosts, as in PLAN.md).

export interface LiveObject {
  id: number;
  cls: "motorcycle" | "car" | "bus" | "truck";
  x: number;
  z: number;
}

// width, length, height in meters, and a colour per class (olive ink family of the app).
const DIMS: Record<LiveObject["cls"], { w: number; l: number; h: number; color: number }> = {
  motorcycle: { w: 0.8, l: 1.9, h: 1.3, color: 0x606c38 },
  car: { w: 1.8, l: 4.3, h: 1.5, color: 0x3d5a80 },
  bus: { w: 2.5, l: 11, h: 3.1, color: 0xb7791f },
  truck: { w: 2.4, l: 7.5, h: 3, color: 0x8c3a3a },
};

interface Entry {
  mesh: THREE.Mesh;
  target: THREE.Vector3;
}

export class LiveScene {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.5, 400);
  private readonly entries = new Map<number, Entry>();
  private readonly geometries = new Map<string, THREE.BoxGeometry>();
  private readonly materials = new Map<string, THREE.MeshLambertMaterial>();
  private readonly resize: ResizeObserver;
  private frame = 0;
  private yaw = 0;
  private distance = 55;
  private drag: { x: number; yaw: number } | null = null;
  private disposed = false;

  private readonly host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.scene.background = new THREE.Color(0xf3f5f6);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(20, 40, 10);
    this.scene.add(sun);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshLambertMaterial({ color: 0xe7eaec }));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(200, 100, 0x606c38, 0xd5d9dc);
    grid.position.y = 0.02;
    this.scene.add(grid);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    const el = this.renderer.domElement;
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.loop();
  }

  setVehicles(objects: readonly LiveObject[]): void {
    const seen = new Set<number>();
    for (const o of objects) {
      if (!Number.isFinite(o.x) || !Number.isFinite(o.z)) continue;
      seen.add(o.id);
      const d = DIMS[o.cls];
      let e = this.entries.get(o.id);
      if (!e) {
        const mesh = new THREE.Mesh(this.geometry(o.cls), this.material(o.cls));
        mesh.position.set(o.x, d.h / 2, o.z);
        this.scene.add(mesh);
        e = { mesh, target: new THREE.Vector3() };
        this.entries.set(o.id, e);
      }
      e.target.set(o.x, d.h / 2, o.z);
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        this.scene.remove(e.mesh);
        this.entries.delete(id);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onDown);
    el.removeEventListener("pointermove", this.onMove);
    el.removeEventListener("pointerup", this.onUp);
    el.removeEventListener("wheel", this.onWheel);
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
    this.renderer.dispose();
    el.remove();
  }

  private geometry(cls: LiveObject["cls"]): THREE.BoxGeometry {
    let g = this.geometries.get(cls);
    if (!g) {
      const d = DIMS[cls];
      g = new THREE.BoxGeometry(d.w, d.h, d.l);
      this.geometries.set(cls, g);
    }
    return g;
  }

  private material(cls: LiveObject["cls"]): THREE.MeshLambertMaterial {
    let m = this.materials.get(cls);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: DIMS[cls].color });
      this.materials.set(cls, m);
    }
    return m;
  }

  private fit(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = (): void => {
    if (this.disposed) return;
    for (const e of this.entries.values()) e.mesh.position.lerp(e.target, 0.25);
    // Orbit around a point in front of the camera; drag to turn, wheel to zoom.
    const focus = new THREE.Vector3(0, 0, -15);
    this.camera.position.set(
      focus.x + Math.sin(this.yaw) * this.distance * 0.6,
      this.distance * 0.7,
      focus.z + Math.cos(this.yaw) * this.distance * 0.7,
    );
    this.camera.lookAt(focus);
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.loop);
  };

  private onDown = (e: PointerEvent): void => {
    this.drag = { x: e.clientX, yaw: this.yaw };
    this.renderer.domElement.setPointerCapture(e.pointerId);
  };
  private onMove = (e: PointerEvent): void => {
    if (this.drag) this.yaw = this.drag.yaw - (e.clientX - this.drag.x) * 0.006;
  };
  private onUp = (): void => {
    this.drag = null;
  };
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.distance = Math.min(120, Math.max(18, this.distance * (1 + Math.sign(e.deltaY) * 0.08)));
  };
}

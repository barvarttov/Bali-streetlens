// Stand-in vehicle motion for the 3D layer, driven by the live junction state.
//
// HONESTY: until the camera pipeline sends tracked positions, the server only knows per-approach
// numbers (label, vehicles stopped, flow per minute, class mix). This simulator animates those
// numbers on the real OSM lanes: the queue it shows holds `stopped` vehicles, cars arrive at the
// measured flow, and stopped vehicles take the queue's colour. Positions are an illustration, not
// observations, and the UI says so. When real tracks arrive, the renderer reads them instead
// through the same VehicleFrame shape; this file is then only the fallback.
//
// Pure (no DOM, no Three.js) and deterministic for a seed, so it is unit-tested in Node.

import type { JunctionState, TrafficLabel } from "../liveSchema.ts";
import { vehicleColor } from "../palette.ts";
import { EXIT_START_M, SLOTS, curvePath, pointAt } from "./lanes.ts";
import type { JunctionLanes, Path, Vec } from "./lanes.ts";

export type VehicleClass = "motorcycle" | "car" | "bus" | "truck";

export const CLASS_DIMS: Record<VehicleClass, { length: number; width: number; vmax: number; wide: boolean }> = {
  motorcycle: { length: 1.9, width: 0.75, vmax: 9, wide: false },
  car: { length: 4.3, width: 1.8, vmax: 8, wide: true },
  bus: { length: 11, width: 2.5, vmax: 6.5, wide: true },
  truck: { length: 7.5, width: 2.4, vmax: 6.5, wide: true },
};

/** What the renderer draws: one entry per vehicle, in local meters. */
export interface VehicleFrame {
  cls: VehicleClass;
  x: number;
  z: number;
  /** Direction of travel, unit vector. */
  dx: number;
  dz: number;
  color: number;
}

export const MAX_PER_JUNCTION = 200;
const MIN_GAP_M = 1.2;
const ACCEL = 2.5;
const BRAKE = 7;
const COMFORT_DECEL = 3;
const TURN_SPEED = 5.5;
/** At or below this speed (m/s, ~7 km/h) a vehicle before the stop line counts as queued. */
const QUEUE_SPEED = 2;
/** A metered approach lets one vehicle over the stop line per this many seconds. */
const RELEASE_EVERY_S = 1;
/** The feed's volume_per_min is sum(flow_per_min) x 3 (all lanes, both directions), so each
 *  approach brings flow x 3 vehicles a minute; arrivals match the volume the sheet shows. */
const RATE_SCALE = 3;

type Phase = "in" | "turn" | "out";

interface Vehicle {
  id: number;
  cls: VehicleClass;
  slot: number; // 0..SLOTS-1, or SLOTS for wide vehicles (middle)
  phase: Phase;
  arm: number; // inbound arm while "in", exit arm afterwards
  path: Path;
  s: number;
  v: number;
}

interface ArmRuntime {
  label: TrafficLabel;
  target: number; // vehicles stopped, from the feed
  ratePerS: number;
  gateOpen: boolean;
  /** Seconds until a metered approach may release its next vehicle. */
  hold: number;
  spawnAcc: number;
}

interface JunctionRuntime {
  lanes: JunctionLanes;
  arms: ArmRuntime[];
  vehicles: Vehicle[];
  active: boolean; // false while offline or unknown: no vehicles at all
  stale: boolean; // camera delayed: vehicles turn grey
  seeded: boolean;
  mix: Record<VehicleClass, number>;
}

/** mulberry32: small, fast, deterministic. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_MIX: Record<VehicleClass, number> = { motorcycle: 0.75, car: 0.2, bus: 0.015, truck: 0.035 };

export class TrafficSim {
  private readonly junctions: JunctionRuntime[];
  private readonly random: () => number;
  private nextId = 1;

  constructor(lanes: JunctionLanes[], seed = 7) {
    this.random = rng(seed);
    this.junctions = lanes.map((l) => ({
      lanes: l,
      arms: l.arms.map(() => ({ label: "unknown", target: 0, ratePerS: 0, gateOpen: true, hold: 0, spawnAcc: 0 })),
      vehicles: [],
      active: false,
      stale: false,
      seeded: false,
      mix: { ...DEFAULT_MIX },
    }));
  }

  /** Feed the latest live state. Junctions without state (or offline) empty out. */
  setStates(states: Map<string, JunctionState>): void {
    for (const j of this.junctions) {
      const st = states.get(j.lanes.id);
      const active = !!st && st.camera_state !== "offline" && st.approaches.length > 0;
      if (!active) {
        j.active = false;
        j.vehicles = [];
        j.seeded = false;
        continue;
      }
      j.active = true;
      j.stale = st.camera_state === "delayed";
      if (st.classes_15min) {
        const total = Object.values(st.classes_15min).reduce((a, b) => a + b, 0);
        if (total > 0) for (const c of Object.keys(j.mix) as VehicleClass[]) j.mix[c] = st.classes_15min[c] / total;
      }
      j.lanes.arms.forEach((armLanes, i) => {
        const a = st.approaches.find((x) => x.arm === armLanes.id);
        const rt = j.arms[i];
        rt.label = a?.label ?? "unknown";
        rt.target = a?.stopped ?? 0;
        rt.ratePerS = a ? (a.flow_per_min / 60) * RATE_SCALE : 0;
      });
      if (!j.seeded) this.seed(j);
    }
  }

  /** Advance by `dt` seconds (clamped, so a background tab doesn't teleport traffic). */
  step(dt: number): void {
    const h = Math.min(0.1, Math.max(0, dt));
    if (h === 0) return;
    for (const j of this.junctions) if (j.active) this.stepJunction(j, h);
  }

  /** Every vehicle, ready to draw. */
  frame(out: VehicleFrame[] = []): VehicleFrame[] {
    out.length = 0;
    for (const j of this.junctions) {
      for (const v of j.vehicles) {
        const p = pointAt(v.path, v.s);
        const stopped = v.phase === "in" && v.v <= QUEUE_SPEED;
        const label = v.phase === "in" ? j.arms[v.arm].label : "lancar";
        out.push({ cls: v.cls, x: p.x, z: p.z, dx: p.dx, dz: p.dz, color: vehicleColor(stopped, label, j.stale) });
      }
    }
    return out;
  }

  count(junctionId?: string): number {
    return this.junctions.filter((j) => !junctionId || j.lanes.id === junctionId).reduce((n, j) => n + j.vehicles.length, 0);
  }

  /** Vehicles currently waiting (stopped before the stop line) on one arm. Used by tests. */
  queued(junctionId: string, armId: string): number {
    const j = this.junctions.find((x) => x.lanes.id === junctionId);
    const i = j?.lanes.arms.findIndex((a) => a.id === armId) ?? -1;
    if (!j || i < 0) return 0;
    return this.queuedOn(j, i);
  }

  // -------------------------------------------------------------------------------------------

  private pickClass(j: JunctionRuntime): VehicleClass {
    let r = this.random();
    for (const c of ["motorcycle", "car", "bus", "truck"] as VehicleClass[]) {
      r -= j.mix[c];
      if (r <= 0) return c;
    }
    return "motorcycle";
  }

  private slotFor(cls: VehicleClass): number {
    return CLASS_DIMS[cls].wide ? SLOTS : Math.floor(this.random() * SLOTS);
  }

  /** Vehicles still before the stop line on an arm, moving or not: what the gate meters. */
  private waitingOn(j: JunctionRuntime, arm: number): number {
    const stopS = j.lanes.arms[arm].stopS;
    return j.vehicles.filter((v) => v.phase === "in" && v.arm === arm && v.s <= stopS + 0.5).length;
  }

  private queuedOn(j: JunctionRuntime, arm: number): number {
    const stopS = j.lanes.arms[arm].stopS;
    return j.vehicles.filter((v) => v.phase === "in" && v.arm === arm && v.v <= QUEUE_SPEED && v.s <= stopS + 0.5).length;
  }

  /** Start a junction mid-story: the measured queue already waiting, a few vehicles moving. */
  private seed(j: JunctionRuntime): void {
    j.seeded = true;
    j.lanes.arms.forEach((arm, i) => {
      if (!arm.inbound) return;
      const rt = j.arms[i];
      // Free space per motorbike slot, from the stop line backwards. A wide vehicle takes all slots.
      const tails: number[] = new Array(SLOTS).fill(arm.stopS);
      for (let k = 0; k < rt.target && j.vehicles.length < MAX_PER_JUNCTION; k++) {
        const cls = this.pickClass(j);
        const slot = this.slotFor(cls);
        const len = CLASS_DIMS[cls].length;
        const hit = slot === SLOTS ? [...tails.keys()] : [slot];
        const s = Math.min(...hit.map((l) => tails[l])) - len / 2;
        if (s < len) break;
        for (const l of hit) tails[l] = s - len / 2 - MIN_GAP_M;
        j.vehicles.push({ id: this.nextId++, cls, slot, phase: "in", arm: i, path: arm.inbound[slot], s, v: 0 });
      }
      rt.gateOpen = rt.target === 0;

      // Traffic already on its way in: about rate x travel time, spread behind the queue.
      const room = Math.min(...tails) - 6;
      const moving = Math.round(rt.ratePerS * (room / 7));
      for (let k = 0; k < moving && j.vehicles.length < MAX_PER_JUNCTION; k++) {
        const cls = this.pickClass(j);
        if (CLASS_DIMS[cls].wide && this.random() < 0.5) continue;
        const slot = this.slotFor(cls);
        const s = ((k + 0.3 + this.random() * 0.4) / moving) * room;
        if (s < CLASS_DIMS[cls].length) continue;
        j.vehicles.push({ id: this.nextId++, cls, slot, phase: "in", arm: i, path: arm.inbound[slot], s, v: CLASS_DIMS[cls].vmax * 0.7 });
      }
    });

    // And traffic leaving on every outbound lane.
    const inRates = j.arms.filter((_, i) => j.lanes.arms[i].inbound).map((a) => a.ratePerS);
    const outArms = j.lanes.arms.filter((a) => a.outbound);
    const outRate = outArms.length ? inRates.reduce((a, b) => a + b, 0) / outArms.length : 0;
    for (const arm of j.lanes.arms) {
      if (!arm.outbound) continue;
      const i = j.lanes.arms.indexOf(arm);
      const len = arm.outbound[SLOTS].length - EXIT_START_M;
      const n = Math.round(outRate * (len / 8));
      for (let k = 0; k < n && j.vehicles.length < MAX_PER_JUNCTION; k++) {
        const cls = this.pickClass(j);
        const slot = this.slotFor(cls);
        const s = EXIT_START_M + ((k + this.random()) / n) * len;
        j.vehicles.push({ id: this.nextId++, cls, slot, phase: "out", arm: i, path: arm.outbound[slot], s, v: CLASS_DIMS[cls].vmax });
      }
    }
  }

  private conflicts(a: Vehicle, b: Vehicle): boolean {
    return a.slot === b.slot || a.slot === SLOTS || b.slot === SLOTS;
  }

  private stepJunction(j: JunctionRuntime, h: number): void {
    const arms = j.lanes.arms;

    // Stop lines: an approach with a measured queue is metered, one vehicle a second and only while
    // more are queued than the feed says, so the queue holds at the measured size. Others flow freely.
    arms.forEach((arm, i) => {
      const rt = j.arms[i];
      if (!arm.inbound) return;
      rt.hold -= h;
      rt.gateOpen = rt.target <= 1 || (rt.hold <= 0 && this.queuedOn(j, i) > rt.target);
    });

    // Arrivals.
    arms.forEach((arm, i) => {
      const rt = j.arms[i];
      if (!arm.inbound || rt.label === "unknown") return;
      const waiting = this.waitingOn(j, i);
      const deficit = rt.target > 1 && waiting < rt.target ? 0.8 : 0; // fill a growing queue faster
      rt.spawnAcc += (rt.ratePerS + deficit) * h;
      if (rt.spawnAcc < 1 || j.vehicles.length >= MAX_PER_JUNCTION) return;
      const cls = this.pickClass(j);
      const slot = this.slotFor(cls);
      const len = CLASS_DIMS[cls].length;
      const blocked = j.vehicles.some(
        (v) => v.phase === "in" && v.arm === i && (v.slot === slot || v.slot === SLOTS || slot === SLOTS) && v.s - CLASS_DIMS[v.cls].length / 2 < len + MIN_GAP_M,
      );
      if (blocked) return; // try again next step; the arrival stays owed
      rt.spawnAcc -= 1;
      j.vehicles.push({ id: this.nextId++, cls, slot, phase: "in", arm: i, path: arm.inbound[slot], s: len / 2, v: CLASS_DIMS[cls].vmax * 0.8 });
    });

    // Car following on the approaches (front to back), free movement through and out.
    const inbound = j.vehicles.filter((v) => v.phase === "in").sort((a, b) => b.s - a.s);
    for (const v of inbound) {
      const dims = CLASS_DIMS[v.cls];
      const arm = arms[v.arm];
      let room = Infinity;
      for (const o of inbound) {
        if (o === v || o.arm !== v.arm || o.s <= v.s || !this.conflicts(v, o)) continue;
        room = Math.min(room, o.s - CLASS_DIMS[o.cls].length / 2 - (v.s + dims.length / 2) - MIN_GAP_M);
      }
      const front = v.s + dims.length / 2;
      if (!j.arms[v.arm].gateOpen && front <= arm.stopS + 0.3) room = Math.min(room, arm.stopS - front);
      const want = Math.min(dims.vmax, Math.sqrt(2 * COMFORT_DECEL * Math.max(0, room)));
      v.v += Math.max(-BRAKE * h, Math.min(ACCEL * h, want - v.v));
      if (v.v < 0) v.v = 0;
      v.s += Math.min(v.v * h, Math.max(0, room));
      if (v.s >= arm.stopS + 0.5) {
        const rt = j.arms[v.arm];
        if (rt.target > 1) {
          rt.hold = RELEASE_EVERY_S;
          rt.gateOpen = false;
        }
        this.release(j, v);
      }
    }

    for (const v of j.vehicles) {
      if (v.phase === "in") continue;
      const target = v.phase === "turn" ? TURN_SPEED : CLASS_DIMS[v.cls].vmax;
      v.v += Math.max(-BRAKE * h, Math.min(ACCEL * h, target - v.v));
      v.s += v.v * h;
      if (v.phase === "turn" && v.s >= v.path.length) {
        const out = v.arm >= 0 ? arms[v.arm].outbound : null;
        if (out) {
          v.phase = "out";
          v.path = out[v.slot];
          v.s = EXIT_START_M;
        }
      }
    }
    j.vehicles = j.vehicles.filter((v) => !(v.phase === "out" && v.s >= v.path.length) && !(v.phase === "turn" && v.s >= v.path.length));
  }

  /** A vehicle crosses the stop line: pick an exit and draw its turn through the junction. */
  private release(j: JunctionRuntime, v: Vehicle): void {
    const arms = j.lanes.arms;
    const exits = arms.map((_, i) => i).filter((i) => i !== v.arm && arms[i].outbound);
    const exit = exits.length ? exits[Math.floor(this.random() * exits.length)] : null;
    const here = pointAt(v.path, v.s);
    if (exit === null) {
      v.phase = "turn"; // nowhere to go on the mapped roads: leave straight on through and vanish
      v.arm = -1;
      v.path = curvePath([here.x, here.z], [here.x + here.dx * 10, here.z + here.dz * 10], [here.x + here.dx * 20, here.z + here.dz * 20], 2);
      v.s = 0;
      return;
    }
    const outPath = (arms[exit].outbound as Path[])[v.slot];
    const join = pointAt(outPath, EXIT_START_M);
    const c: Vec = j.lanes.center;
    v.phase = "turn";
    v.arm = exit;
    v.path = curvePath([here.x, here.z], [(c[0] + here.x + join.x) / 3, (c[1] + here.z + join.z) / 3], [join.x, join.z]);
    v.s = 0;
  }
}

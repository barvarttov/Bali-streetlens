import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Corridor, JunctionState } from "../liveSchema.ts";
import { COLORS, hex } from "../palette.ts";
import { buildCorridorLanes, carriagewayWidth, localFrame, makePath, offsetPath, pointAt, toLocal } from "./lanes.ts";
import { MAX_PER_JUNCTION, TrafficSim } from "./sim.ts";

const corridor = JSON.parse(readFileSync(new URL("../../../../config/corridor.json", import.meta.url), "utf8")) as Corridor;

test("local frame: 100 m east is x = +100, 100 m north is z = -100", () => {
  const f = localFrame([115.18, -8.76]);
  const east = toLocal(f, [115.18 + 100 / (111320 * Math.cos((8.76 * Math.PI) / 180)), -8.76]);
  const north = toLocal(f, [115.18, -8.76 + 100 / 110574]);
  assert.ok(Math.abs(east[0] - 100) < 0.6 && Math.abs(east[1]) < 0.01, `east ${east}`);
  assert.ok(Math.abs(north[1] + 100) < 0.6 && Math.abs(north[0]) < 0.01, `north ${north}`);
});

test("lanes keep left: driving north, a positive offset is to the west", () => {
  const north = makePath([[0, 0], [0, -50]]);
  const lane = offsetPath(north, 2);
  assert.equal(pointAt(lane, 10).x, -2);
});

test("every corridor arm gets lanes from the OSM oneway data, inbound ends near the centre", () => {
  const { junctions } = buildCorridorLanes(corridor);
  for (const j of junctions) {
    assert.ok(j.arms.some((a) => a.inbound), `${j.id} has no inbound lane`);
    assert.ok(j.arms.some((a) => a.outbound), `${j.id} has no outbound lane`);
    for (const a of j.arms) {
      if (!a.inbound) continue;
      const end = pointAt(a.inbound[2], a.inbound[2].length);
      const start = pointAt(a.inbound[2], 0);
      const dEnd = Math.hypot(end.x - j.center[0], end.z - j.center[1]);
      const dStart = Math.hypot(start.x - j.center[0], start.z - j.center[1]);
      assert.ok(dEnd < dStart, `${j.id}/${a.id} inbound runs away from the junction`);
    }
  }
});

function state(id: string, arm: string, label: "lancar" | "padat" | "macet", stopped: number, extra: Partial<JunctionState> = {}): JunctionState {
  return {
    id,
    camera_state: "live",
    updated_at: new Date().toISOString(),
    label,
    volume_per_min: 60,
    approaches: [{ arm, label, kind: label === "macet" ? "sustained_queue" : "flowing", stopped, stopped_for_s: 60, flow_per_min: 6 }],
    why: null,
    classes_15min: { motorcycle: 700, car: 250, bus: 10, truck: 40 },
    history: [],
    ...extra,
  };
}

test("a macet approach shows about the measured queue, in barak, and stays under the cap", () => {
  const { junctions } = buildCorridorLanes(corridor);
  const sim = new TrafficSim(junctions, 1);
  sim.setStates(new Map([["patung-kuda", state("patung-kuda", "kaja", "macet", 20)]]));
  for (let i = 0; i < 600; i++) sim.step(0.1); // one minute
  const q = sim.queued("patung-kuda", "kaja");
  assert.ok(q >= 14 && q <= 26, `queue ${q} should hover near 20`);
  const colors = sim.frame().map((v) => v.color);
  assert.ok(colors.includes(hex(COLORS.macet)));
  assert.ok(sim.count() <= MAX_PER_JUNCTION);
});

test("offline cameras show no vehicles; delayed cameras show grey ones", () => {
  const { junctions } = buildCorridorLanes(corridor);
  const sim = new TrafficSim(junctions, 2);
  sim.setStates(new Map([["patung-kuda", state("patung-kuda", "kaja", "macet", 12, { camera_state: "delayed" })]]));
  sim.step(0.1);
  assert.ok(sim.count("patung-kuda") > 0);
  assert.ok(sim.frame().every((v) => v.color === hex(COLORS.vehicleStale)));
  sim.setStates(new Map([["patung-kuda", state("patung-kuda", "kaja", "macet", 12, { camera_state: "offline", approaches: [] })]]));
  assert.equal(sim.count("patung-kuda"), 0);
});

test("vehicles flow through: after a few minutes of lancar, vehicles exist and none are stuck", () => {
  const { junctions } = buildCorridorLanes(corridor);
  const sim = new TrafficSim(junctions, 3);
  sim.setStates(new Map([["kedonganan", state("kedonganan", "kaja", "lancar", 0)]]));
  for (let i = 0; i < 1800; i++) sim.step(0.1);
  assert.ok(sim.count("kedonganan") > 0);
  assert.ok(sim.queued("kedonganan", "kaja") <= 3);
});

/** Distance from a point to a polyline, in the same local meters. */
function distToLine(p: [number, number], line: [number, number][]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1];
    const [bx, bz] = line[i];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (az + t * dz)));
  }
  return best;
}

test("at least 90% of vehicles sit on the paved road surface the map draws", () => {
  const { frame, junctions } = buildCorridorLanes(corridor);
  const sim = new TrafficSim(junctions, 4);
  const labels = ["macet", "padat", "lancar"] as const;
  sim.setStates(
    new Map(
      corridor.junctions.map((j, i) => [
        j.id,
        {
          ...state(j.id, j.arms[0].id, labels[i % 3], 12),
          approaches: j.arms.map((a, k) => ({ arm: a.id, label: labels[(i + k) % 3], kind: "flowing" as const, stopped: k === 0 ? 12 : 3, stopped_for_s: 60, flow_per_min: 8 })),
        },
      ]),
    ),
  );
  let on = 0;
  let total = 0;
  for (let step = 0; step < 1200; step++) {
    sim.step(0.1);
    if (step % 20) continue;
    for (const v of sim.frame()) {
      total++;
      const ok = corridor.junctions.some((j, ji) => {
        const c = junctions[ji].center;
        if (Math.hypot(v.x - c[0], v.z - c[1]) < 16) return true; // inside the junction box itself
        return j.arms.some((a) =>
          a.lines.some((l, li) => distToLine([v.x, v.z], l.map((pt) => toLocal(frame, pt))) <= carriagewayWidth(a, li) / 2 + 0.25),
        );
      });
      if (ok) on++;
    }
  }
  assert.ok(total > 200, `only ${total} samples`);
  if (process.env.SHOW_ONROAD) console.log(`on road: ${((on / total) * 100).toFixed(1)}% of ${total}`);
  assert.ok(on / total >= 0.9, `${((on / total) * 100).toFixed(1)}% on the road`);
});

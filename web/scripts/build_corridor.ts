// Builds config/corridor.json: the watched junctions of the south Bali corridor with their real
// road arms, taken from OpenStreetMap through the Overpass API.
// Each camera location (from the provincial CCTV portal) is snapped to the nearest intersection of
// differently named roads; every road leaving it becomes an arm with a stable direction id.
// Run: npm run corridor   (set OVERPASS_URL to use another Overpass instance)
// Data: © OpenStreetMap contributors, ODbL.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Stable arm ids, as config/corridor.json and backend/live.py already use them (kaja = north in south
// Bali, kangin = east, kelod = south, kauh = west). They are data keys only; the app shows compass words.
function armDirection(bearing: number, kajaBearing: number): string {
  const off = Math.abs((((bearing - kajaBearing) % 360) + 540) % 360 - 180);
  const ew = Math.sin((bearing * Math.PI) / 180) >= 0 ? "kangin" : "kauh";
  if (off <= 22.5) return "kaja";
  if (off >= 157.5) return "kelod";
  if (off < 67.5) return `kaja ${ew}`;
  if (off > 112.5) return `kelod ${ew}`;
  return ew;
}

const OVERPASS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass-api.de/api/interpreter"];
const KAJA_BEARING = 0; // south Bali: kaja (toward the mountains) is north. Needs a Balinese reviewer's confirmation.
const ARM_LENGTH_M = 160;

// Camera locations from balisatudata.baliprov.go.id/api/v1/report-cctv (2026-11-02).
const JUNCTIONS = [
  { id: "patung-kuda", name: "Simpang Patung Kuda", cameras: [{ id: "simpang-patung-kuda", lnglat: [115.179105, -8.744676] }] },
  {
    id: "underpass-ngurah-rai",
    name: "Underpass Ngurah Rai",
    cameras: [
      { id: "underpass-ngurah-rai-utara", lnglat: [115.182959, -8.7445615] },
      { id: "underpass-ngurah-rai-selatan", lnglat: [115.183008, -8.745413] },
    ],
  },
  { id: "kedonganan", name: "Simpang Kedonganan", cameras: [{ id: "simpang-kedonganan", lnglat: [115.178897, -8.761071] }] },
  { id: "unud", name: "Simpang UNUD", cameras: [{ id: "simpang-unud", lnglat: [115.178751, -8.781462] }] },
  { id: "taman-griya", name: "Simpang Taman Griya", cameras: [{ id: "simpang-taman-griya", lnglat: [115.187741, -8.783959] }] },
  { id: "pintu-tol", name: "Simpang Pintu Tol", cameras: [{ id: "simpang-pintu-tol", lnglat: [115.212275, -8.790174] }] },
] as const;

type LngLat = [number, number];
interface Way {
  id: number;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
  tags: Record<string, string>;
}

const metersBetween = (a: LngLat, b: LngLat): number => {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 110540);
};
const bearing = (a: LngLat, b: LngLat): number => {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180 / Math.PI + 360) % 360;
};
const shortName = (name: string) => name.replace(/^Jalan\s+/i, "Jl. ");

async function overpass(lnglat: readonly [number, number], classes: string): Promise<Way[]> {
  const [lng, lat] = lnglat;
  const query = `[out:json][timeout:25];way(around:120,${lat},${lng})[highway~"^(${classes})$"];out body geom;`;
  // Shared Overpass instances are often busy (502/504): retry with backoff, then try the next one.
  for (let attempt = 0; attempt < 6; attempt++) {
    const endpoint = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "User-Agent": "BaliStreetLens/0.1 (hackathon prototype)", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
      });
      if (res.ok) return ((await res.json()) as { elements: Way[] }).elements;
      console.warn(`  ${new URL(endpoint).host} answered HTTP ${res.status}, retrying`);
    } catch (err) {
      console.warn(`  ${new URL(endpoint).host} failed (${(err as Error).message}), retrying`);
    }
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  throw new Error("Overpass unavailable after 6 attempts; set OVERPASS_URL to another instance");
}

function buildJunction(camera: LngLat, ways: Way[]) {
  // Intersection nodes: shared by ways with different names (a dual carriageway shares its own name).
  const nodeWays = new Map<number, { at: LngLat; names: Set<string> }>();
  for (const w of ways) {
    w.nodes.forEach((id, i) => {
      const entry = nodeWays.get(id) ?? { at: [w.geometry[i].lon, w.geometry[i].lat] as LngLat, names: new Set<string>() };
      entry.names.add(w.tags.name ?? `#${w.id}`);
      nodeWays.set(id, entry);
    });
  }
  const crossings = [...nodeWays.values()].filter((n) => n.names.size >= 2);
  const nearest = crossings.sort((a, b) => metersBetween(camera, a.at) - metersBetween(camera, b.at))[0];
  const cluster = nearest ? crossings.filter((n) => metersBetween(nearest.at, n.at) <= 45) : [];
  const center: LngLat = cluster.length
    ? [cluster.reduce((s, n) => s + n.at[0], 0) / cluster.length, cluster.reduce((s, n) => s + n.at[1], 0) / cluster.length]
    : camera;

  // Arms: from each way's vertex nearest the centre, walk outwards in both directions.
  // Each line also records which way traffic runs on it, from OSM's oneway tag and the walk direction
  // (the walk goes outward from the junction): "in" toward the junction, "out" away, or "both".
  type Flow = "in" | "out" | "both";
  const raw: { road: string; line: LngLat[]; bearing: number; isLink: boolean; flow: Flow; lanes: number | null }[] = [];
  for (const w of ways) {
    const pts = w.geometry.map((g) => [g.lon, g.lat] as LngLat);
    let best = 0;
    pts.forEach((p, i) => (metersBetween(center, p) < metersBetween(center, pts[best]) ? (best = i) : 0));
    if (metersBetween(center, pts[best]) > 50) continue;
    for (const step of [1, -1]) {
      const line: LngLat[] = [pts[best]];
      let length = 0;
      for (let i = best + step; i >= 0 && i < pts.length && length < ARM_LENGTH_M; i += step) {
        length += metersBetween(line[line.length - 1], pts[i]);
        line.push(pts[i]);
      }
      const tip = line[line.length - 1];
      if (metersBetween(center, tip) < 40) continue;
      const probe = line.find((p) => metersBetween(center, p) >= 40) ?? tip;
      const oneway = w.tags.oneway === "yes" || w.tags.oneway === "1" ? 1 : w.tags.oneway === "-1" ? -1 : 0;
      const flow: Flow = oneway === 0 ? "both" : oneway * step > 0 ? "out" : "in";
      const lanes = Number.parseInt(w.tags.lanes ?? "", 10);
      raw.push({
        road: shortName(w.tags.name ?? "Jalan tanpa nama"),
        line,
        bearing: bearing(center, probe),
        isLink: w.tags.highway.endsWith("_link"),
        flow,
        lanes: Number.isFinite(lanes) ? lanes : null,
      });
    }
  }

  // Merge carriageways and pieces that leave in the same direction (within 30°).
  const arms: { dir: string; road: string; bearing: number; lines: LngLat[][]; flows: Flow[]; lanes: (number | null)[] }[] = [];
  for (const r of raw.filter((x) => !x.isLink).sort((a, b) => a.bearing - b.bearing)) {
    const same = arms.find((a) => Math.min(Math.abs(a.bearing - r.bearing), 360 - Math.abs(a.bearing - r.bearing)) < 30);
    if (same) {
      same.lines.push(r.line);
      same.flows.push(r.flow);
      same.lanes.push(r.lanes);
    } else {
      arms.push({ dir: armDirection(r.bearing, KAJA_BEARING), road: r.road, bearing: Math.round(r.bearing), lines: [r.line], flows: [r.flow], lanes: [r.lanes] });
    }
  }
  const round = (p: LngLat): LngLat => [Number(p[0].toFixed(6)), Number(p[1].toFixed(6))];
  return {
    center: round(center),
    roads: [...new Set(arms.map((a) => a.road))],
    arms: arms.map((a) => ({ ...a, id: a.dir.replace(" ", "-"), lines: a.lines.map((l) => l.map(round)) })),
  };
}

const out = [];
for (const j of JUNCTIONS) {
  const camera = j.cameras[0].lnglat;
  let ways = await overpass(camera, "trunk|primary|secondary|tertiary|unclassified|trunk_link|primary_link|secondary_link");
  let built = buildJunction([...camera], ways);
  if (built.arms.length < 3) {
    ways = await overpass(camera, "trunk|primary|secondary|tertiary|unclassified|residential|trunk_link|primary_link|secondary_link");
    built = buildJunction([...camera], ways);
  }
  console.log(`${j.name}: ${built.arms.length} arms (${built.arms.map((a) => `${a.dir} ${a.road}`).join("; ")})`);
  out.push({ id: j.id, name: j.name, cameras: j.cameras, ...built });
  await new Promise((r) => setTimeout(r, 1500)); // be polite to the shared Overpass instance
}

const file = join(import.meta.dirname, "..", "..", "config", "corridor.json");
writeFileSync(
  file,
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      source: "© OpenStreetMap contributors (ODbL), via Overpass API; camera locations from Bali Satu Data",
      kaja_bearing: KAJA_BEARING,
      junctions: out,
    },
    null,
    1,
  ) + "\n",
);
console.log(`wrote ${file}`);

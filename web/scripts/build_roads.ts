// Builds config/roads.json.gz: the road network of Bali province as a compact routable graph, for the
// route planner (backend/routing.py). Roads come from OpenStreetMap through the Overpass API.
//
// The graph keeps only the nodes where roads meet or end; each edge between two of them carries its
// length, road class, name, one-way flag and the shape in between (for drawing the route).
//
// Run:   npm run roads        (needs internet once; the output is committed so the demo works offline)
// Data:  © OpenStreetMap contributors, ODbL.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const OVERPASS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
const ROOT = join(import.meta.dirname, "..", "..");
const OUT = join(ROOT, "config", "roads.json.gz");

// Roads a motorbike or car can use. Bali Mandara toll road (motorway) has a motorbike lane, so it stays.
// Service roads (car parks, driveways) and tracks are left out: they bloat the graph and mislead routes.
const CLASSES = [
  "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
  "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
] as const;
type RoadClass = (typeof CLASSES)[number];

// One query for the whole island times out on the shared Overpass servers, so the island is fetched in
// tiles (cached in data/roads-cache, so a retry only fetches what's missing) and clipped to the province
// outline afterwards. A road crossing a tile edge comes back in both tiles; ids make that harmless.
const BBOX = { south: -8.9, west: 114.4, north: -8.03, east: 115.75 };
const GRID = { cols: 4, rows: 3 };
const CACHE = join(ROOT, "data", "roads-cache");
const FILTER = `["highway"~"^(${CLASSES.join("|")})$"]["access"!~"^(private|no)$"]["motor_vehicle"!~"^(private|no)$"]["area"!="yes"]`;

interface OsmNode { type: "node"; id: number; lat: number; lon: number }
interface OsmWay { type: "way"; id: number; nodes: number[]; tags: Record<string, string> }
type El = OsmNode | OsmWay;

/** A tile; when the servers keep refusing it, its four quarters instead (twice at most). */
async function fetchTile(s: number, w: number, n: number, e: number, depth = 0): Promise<El[]> {
  const attempts = depth < 2 ? 3 : 8;
  try {
    return await fetchOnce(s, w, n, e, attempts);
  } catch (err) {
    if (depth >= 2) throw err;
    console.warn(`  splitting (${s},${w} → ${n},${e}) into quarters`);
    const ms = +((s + n) / 2).toFixed(5);
    const mw = +((w + e) / 2).toFixed(5);
    const out: El[] = [];
    for (const [a, b, c, d] of [[s, w, ms, mw], [s, mw, ms, e], [ms, w, n, mw], [ms, mw, n, e]]) out.push(...(await fetchTile(a, b, c, d, depth + 1)));
    return out;
  }
}

async function fetchOnce(s: number, w: number, n: number, e: number, attempts: number): Promise<El[]> {
  const query = `[out:json][timeout:300];way(${s},${w},${n},${e})${FILTER};out body qt;>;out skel qt;`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const endpoint = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "User-Agent": "BaliStreetLens/0.1 (hackathon prototype)", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(400_000),
      });
      if (res.ok) return ((await res.json()) as { elements: El[] }).elements;
      console.warn(`  ${new URL(endpoint).host}: HTTP ${res.status}, retrying`);
    } catch (err) {
      console.warn(`  ${new URL(endpoint).host}: ${(err as Error).message}, retrying`);
    }
    await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)));
  }
  throw new Error(`Overpass unavailable after ${attempts} attempts; set OVERPASS_URL to another instance and run again`);
}

async function fetchIsland(): Promise<El[]> {
  mkdirSync(CACHE, { recursive: true });
  const all: El[] = [];
  const dx = (BBOX.east - BBOX.west) / GRID.cols;
  const dy = (BBOX.north - BBOX.south) / GRID.rows;
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      const s = +(BBOX.south + r * dy).toFixed(4);
      const w = +(BBOX.west + c * dx).toFixed(4);
      const n = +(s + dy).toFixed(4);
      const e = +(w + dx).toFixed(4);
      const file = join(CACHE, `${r}-${c}.json`);
      let els: El[];
      if (existsSync(file)) els = JSON.parse(readFileSync(file, "utf8")) as El[];
      else {
        console.log(`tile ${r * GRID.cols + c + 1}/${GRID.rows * GRID.cols} (${s},${w} → ${n},${e})…`);
        els = await fetchTile(s, w, n, e);
        writeFileSync(file, JSON.stringify(els));
      }
      for (const el of els) all.push(el);
    }
  }
  return all;
}

// Point in the province outline (even-odd rule over every ring).
const outline = JSON.parse(readFileSync(join(ROOT, "web", "src", "public", "bali-outline.json"), "utf8")) as {
  geometry: { coordinates: [number, number][][][] };
};
function inBali([x, y]: [number, number]): boolean {
  let inside = false;
  for (const poly of outline.geometry.coordinates) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
  }
  return inside;
}

const metersBetween = (a: [number, number], b: [number, number]): number => {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 110540);
};
const shortName = (name: string) => name.replace(/^Jalan\s+/i, "Jl. ").replace(/^Jln?\.?\s+/i, "Jl. ");

const elements = await fetchIsland();
const coords = new Map<number, [number, number]>();
const wayById = new Map<number, OsmWay>();
for (const el of elements) {
  if (el.type === "node") coords.set(el.id, [el.lon, el.lat]);
  else if (el.type === "way" && el.nodes.length >= 2) wayById.set(el.id, el);
}
// Keep roads with any point in Bali province (drops the Java coast inside the bounding box).
const ways = [...wayById.values()].filter((w) => w.nodes.some((id) => coords.has(id) && inBali(coords.get(id)!)));
console.log(`${ways.length} roads, ${coords.size} points`);

// A node is kept when roads meet there, when a road ends there, or when one road passes it twice (a loop).
const uses = new Map<number, number>();
for (const w of ways) {
  w.nodes.forEach((id, i) => {
    const endBonus = i === 0 || i === w.nodes.length - 1 ? 1 : 0;
    uses.set(id, (uses.get(id) ?? 0) + 1 + endBonus);
  });
}
const keptIndex = new Map<number, number>();
const nodes: number[] = []; // flat lng,lat × 1e6
const keep = (id: number): number => {
  let i = keptIndex.get(id);
  if (i === undefined) {
    const c = coords.get(id)!;
    i = nodes.length / 2;
    nodes.push(Math.round(c[0] * 1e6), Math.round(c[1] * 1e6));
    keptIndex.set(id, i);
  }
  return i;
};

const names: string[] = [""];
const nameIndex = new Map<string, number>([["", 0]]);
const nameOf = (tags: Record<string, string>): number => {
  // Names only: a bare route number ("1") means nothing to a rider.
  const raw = tags.name ?? "";
  const n = raw ? shortName(raw) : "";
  let i = nameIndex.get(n);
  if (i === undefined) {
    i = names.length;
    names.push(n);
    nameIndex.set(n, i);
  }
  return i;
};

// Edge: [from, to, length dm, class, name, oneway (1 = only from→to), shape as flat deltas of lng,lat × 1e6]
type Edge = [number, number, number, number, number, number, number[]];
const edges: Edge[] = [];
let skipped = 0;
for (const w of ways) {
  if (w.nodes.some((id) => !coords.has(id))) {
    skipped++;
    continue;
  }
  const cls = CLASSES.indexOf(w.tags.highway as RoadClass);
  const name = nameOf(w.tags);
  const ow = w.tags.oneway;
  const roundabout = w.tags.junction === "roundabout" || w.tags.junction === "circular";
  const oneway = ow === "yes" || ow === "1" || ow === "true" || (roundabout && ow !== "no") || w.tags.highway === "motorway" ? 1 : ow === "-1" ? -1 : 0;
  const ids = oneway === -1 ? [...w.nodes].reverse() : w.nodes;
  let start = 0;
  for (let i = 1; i < ids.length; i++) {
    const last = i === ids.length - 1;
    if (!last && (uses.get(ids[i]) ?? 0) < 2) continue;
    let length = 0;
    const shape: number[] = [];
    let px = Math.round(coords.get(ids[start])![0] * 1e6);
    let py = Math.round(coords.get(ids[start])![1] * 1e6);
    for (let k = start + 1; k <= i; k++) {
      length += metersBetween(coords.get(ids[k - 1])!, coords.get(ids[k])!);
      if (k < i) {
        const x = Math.round(coords.get(ids[k])![0] * 1e6);
        const y = Math.round(coords.get(ids[k])![1] * 1e6);
        shape.push(x - px, y - py);
        px = x;
        py = y;
      }
    }
    const a = keep(ids[start]);
    const b = keep(ids[i]);
    if (a !== b || length > 0) edges.push([a, b, Math.max(1, Math.round(length * 10)), cls, name, oneway !== 0 ? 1 : 0, shape]);
    start = i;
  }
}

const doc = {
  generated: new Date().toISOString(),
  source: "© OpenStreetMap contributors (ODbL), via Overpass API",
  classes: CLASSES,
  names,
  nodes,
  edges,
};
const json = JSON.stringify(doc);
const gz = gzipSync(json, { level: 9 });
writeFileSync(OUT, gz);
console.log(
  `${nodes.length / 2} nodes, ${edges.length} edges, ${names.length} road names` +
    (skipped ? `, ${skipped} roads skipped (missing points)` : "") +
    `\nwrote ${OUT} (${(gz.length / 1e6).toFixed(1)} MB gzipped, ${(json.length / 1e6).toFixed(1)} MB raw)`,
);

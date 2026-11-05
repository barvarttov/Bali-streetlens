// Builds web/src/public/bali-outline.json: the outline of Bali province (Nusa Penida included) from
// OpenStreetMap, as a simplified GeoJSON MultiPolygon. The map paints everything outside it as sea and
// hides place names outside it, so only Bali is visible (no Java, no Lombok).
//
// Run:   npm run outline     (needs internet; the output is committed so the demo works offline)
// Data:  © OpenStreetMap contributors, ODbL.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OVERPASS = process.env.OVERPASS_URL ?? "https://maps.mail.ru/osm/tools/overpass/api/interpreter";
const OUT = join(import.meta.dirname, "..", "src", "public", "bali-outline.json");
/** Douglas-Peucker tolerance in degrees (~30 m): fine enough that the coast doesn't visibly move. */
const TOLERANCE = 0.0003;

type Pt = [number, number];
interface Member { type: string; role: string; geometry?: { lat: number; lon: number }[] }

const query = `[out:json][timeout:120];
relation["boundary"="administrative"]["admin_level"="4"]["name"="Bali"];
out geom;`;
const res = await fetch(OVERPASS, { method: "POST", body: new URLSearchParams({ data: query }), headers: { "User-Agent": "bali-streetlens (hackathon)" } });
if (!res.ok) throw new Error(`Overpass ${res.status}`);
const rel = ((await res.json()) as { elements: { members: Member[] }[] }).elements[0];
if (!rel) throw new Error("Bali province relation not found");

// Join the outer ways end to end into closed rings.
const ways: Pt[][] = rel.members
  .filter((m) => m.type === "way" && m.role !== "inner" && m.geometry)
  .map((m) => m.geometry!.map((g) => [g.lon, g.lat] as Pt));
const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
const rings: Pt[][] = [];
while (ways.length) {
  let ring = ways.shift()!;
  for (let guard = 0; !same(ring[0], ring[ring.length - 1]) && guard < 10000; guard++) {
    const end = ring[ring.length - 1];
    const i = ways.findIndex((w) => same(w[0], end) || same(w[w.length - 1], end));
    if (i < 0) break;
    const w = ways.splice(i, 1)[0];
    ring = ring.concat((same(w[0], end) ? w : [...w].reverse()).slice(1));
  }
  if (same(ring[0], ring[ring.length - 1]) && ring.length > 3) rings.push(ring);
}

function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let dmax = 0;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > dmax) {
        dmax = d;
        best = i;
      }
    }
    if (dmax > tol && best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]).map(([x, y]) => [Number(x.toFixed(5)), Number(y.toFixed(5))] as Pt);
}

// A closed ring starts and ends on one point, which Douglas-Peucker can't measure against: simplify the
// open path and close it again. Short rings (the province is bounded at sea in a few dozen points) stay.
const round = (pts: Pt[]) => pts.map(([x, y]) => [Number(x.toFixed(5)), Number(y.toFixed(5))] as Pt);
const polys = rings
  .map((r) => {
    if (r.length < 500) return [round(r)];
    const open = simplify(r.slice(0, -1), TOLERANCE);
    return [[...open, open[0]]];
  })
  .filter((p) => p[0].length >= 4);
const geojson = { type: "MultiPolygon", coordinates: polys };
writeFileSync(OUT, JSON.stringify({ source: "© OpenStreetMap contributors, ODbL", geometry: geojson }) + "\n");
const all = polys.flatMap((p) => p[0]);
const xs = all.map((p) => p[0]);
const ys = all.map((p) => p[1]);
console.log(`${polys.length} rings, ${all.length} points, bbox ${Math.min(...xs)},${Math.min(...ys)} ${Math.max(...xs)},${Math.max(...ys)} -> ${OUT}`);

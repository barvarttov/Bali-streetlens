// Builds web/public/bathymetry.json: sea depth around Bali, so the map's sea gets bluer where it is
// deeper (Bali Sea to the north, Lombok Strait, the Indian Ocean down toward the Java Trench).
//
// Source: Natural Earth 1:10m bathymetry (public domain), one polygon set per depth: 0, 200, 1000 …
// 6000 m. Each set is "sea at least this deep", so the sets nest and are drawn shallow to deep.
// Every feature appears twice: o=0 is the whole clipped polygon (drawn under the land), and o=1 is
// only its part outside Bali province (drawn above the mask that hides Java and Lombok).
//
// Run:   npm run bathymetry    (needs internet once; the output is committed)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon } from "polygon-clipping";

const ROOT = join(import.meta.dirname, "..", "..");
const CACHE = join(ROOT, "data", "bathymetry-cache");
const OUT = join(ROOT, "web", "public", "bathymetry.json");
const LEVELS: [string, number][] = [
  ["L_0", 0], ["K_200", 200], ["J_1000", 1000], ["I_2000", 2000], ["H_3000", 3000], ["G_4000", 4000], ["F_5000", 5000], ["E_6000", 6000],
];
// Wider than anything the map can show (it can't pan off Bali).
const BOX: Polygon = [[[113.6, -10.0], [116.6, -10.0], [116.6, -7.1], [113.6, -7.1], [113.6, -10.0]]];

const outline = JSON.parse(readFileSync(join(ROOT, "web", "src", "public", "bali-outline.json"), "utf8")) as {
  geometry: { coordinates: MultiPolygon };
};
const province = outline.geometry.coordinates;

async function level(name: string): Promise<MultiPolygon[]> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${name}.geojson`);
  if (!existsSync(file)) {
    const url = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_bathymetry_${name}.geojson`;
    console.log(`downloading ${name}…`);
    const res = await fetch(url, { headers: { "User-Agent": "BaliStreetLens/0.1 (hackathon prototype)" } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(file, await res.text());
  }
  const fc = JSON.parse(readFileSync(file, "utf8")) as { features: { geometry: { type: string; coordinates: Polygon | MultiPolygon } }[] };
  return fc.features.map((f) => (f.geometry.type === "Polygon" ? [f.geometry.coordinates as Polygon] : (f.geometry.coordinates as MultiPolygon)));
}

// Bounding-box test first: most of the world's polygons are nowhere near Bali.
const [[bx0, by0], , [bx1, by1]] = BOX[0];
const touchesBox = (mp: MultiPolygon) =>
  mp.some((poly) => {
    const xs = poly[0].map((p) => p[0]);
    const ys = poly[0].map((p) => p[1]);
    return Math.min(...xs) <= bx1 && Math.max(...xs) >= bx0 && Math.min(...ys) <= by1 && Math.max(...ys) >= by0;
  });

const round = (mp: MultiPolygon): MultiPolygon =>
  mp
    .map((poly) => poly.map((ring) => ring.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4] as [number, number])))
    .filter((poly) => poly[0].length >= 4);

const features: object[] = [];
for (const [name, depth] of LEVELS) {
  const parts = (await level(name)).filter(touchesBox);
  if (!parts.length) continue;
  // Clip each polygon to the box on its own (intersection() of several would intersect them all).
  const clipped: MultiPolygon = parts.flatMap((part) => polygonClipping.intersection(BOX, part));
  if (!clipped.length) continue;
  const outside = polygonClipping.difference(clipped, province);
  features.push({ type: "Feature", properties: { d: depth, o: 0 }, geometry: { type: "MultiPolygon", coordinates: round(clipped) } });
  if (outside.length) features.push({ type: "Feature", properties: { d: depth, o: 1 }, geometry: { type: "MultiPolygon", coordinates: round(outside) } });
  console.log(`${depth} m: ${clipped.length} polygons`);
}

const json = JSON.stringify({ type: "FeatureCollection", source: "Natural Earth 1:10m bathymetry (public domain)", features });
writeFileSync(OUT, json + "\n");
console.log(`wrote ${OUT} (${(json.length / 1024).toFixed(0)} KB)`);

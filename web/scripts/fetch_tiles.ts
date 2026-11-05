// Copies the vector tiles Bali StreetLens needs from a Protomaps OpenStreetMap build into
// data/tiles/{z}/{x}/{y}.mvt, so the map is self-hosted and works with Wi-Fi off at the demo.
// Only small pieces of the planet file are read (HTTP range requests); nothing is executed.
//
// Run:   npm run tiles            (fetch the whole island, about 13 000 tiles on the first run)
//        npm run tiles -- --probe (print the tile schema only)
// Data:  © OpenStreetMap contributors, ODbL. Basemap schema by Protomaps.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PMTiles } from "pmtiles";

const BUILD = process.env.PMTILES_URL ?? "https://build.protomaps.com/20261101.pmtiles";
const OUT = join(import.meta.dirname, "..", "..", "data", "tiles");

// [minZoom, maxZoom, west, south, east, north]: the whole island (Nusa Penida included) at every zoom,
// so any area opens in 3D without internet. Tiles already on disk are skipped, so reruns are cheap.
// The backend also fetches and keeps any missing tile on demand while online (backend/tilecache.py).
const PLAN: [number, number, number, number, number, number][] = [[0, 15, 114.4, -8.88, 115.74, -8.04]];

function lngToX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}
function latToY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

const source = new PMTiles(BUILD);

if (process.argv.includes("--probe")) {
  const header = await source.getHeader();
  const meta = (await source.getMetadata()) as { vector_layers?: { id: string; fields?: Record<string, string> }[] };
  console.log(`zoom ${header.minZoom}-${header.maxZoom}`);
  for (const layer of meta.vector_layers ?? []) console.log(`${layer.id}: ${Object.keys(layer.fields ?? {}).join(", ")}`);
  process.exit(0);
}

const jobs: [number, number, number][] = [];
for (const [z0, z1, w, s, e, n] of PLAN) {
  for (let z = z0; z <= z1; z++) {
    for (let x = lngToX(w, z); x <= lngToX(e, z); x++) {
      for (let y = latToY(n, z); y <= latToY(s, z); y++) jobs.push([z, x, y]);
    }
  }
}

let done = 0;
let written = 0;
let bytes = 0;
async function worker(): Promise<void> {
  for (;;) {
    const job = jobs.shift();
    if (!job) return;
    const [z, x, y] = job;
    const file = join(OUT, String(z), String(x), `${y}.mvt`);
    if (!existsSync(file)) {
      const tile = await source.getZxy(z, x, y);
      if (tile?.data && tile.data.byteLength > 0) {
        mkdirSync(join(OUT, String(z), String(x)), { recursive: true });
        writeFileSync(file, new Uint8Array(tile.data));
        written++;
        bytes += tile.data.byteLength;
      }
    }
    if (++done % 100 === 0) console.log(`${done} tiles checked, ${written} written`);
  }
}

console.log(`${jobs.length} tiles to check from ${BUILD}`);
await Promise.all(Array.from({ length: 12 }, worker));
console.log(`done: ${written} tiles written (${(bytes / 1e6).toFixed(1)} MB) to ${OUT}`);

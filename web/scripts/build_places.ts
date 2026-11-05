// Builds web/public/places.json: the places "Mau ke mana?" can find anywhere in Bali (towns, villages,
// beaches, attractions, lakes, mountains, the airport), from OpenStreetMap via the Overpass API.
// Each entry gets the nearest town as context, so two villages with one name can be told apart.
//
// Run:   npm run places          (needs internet; the output is committed so the demo works offline)
// Data:  © OpenStreetMap contributors, ODbL.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OVERPASS = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const OUT = join(import.meta.dirname, "..", "public", "places.json");
const BBOX = "-8.9,114.4,-8.03,115.75"; // south,west,north,east

const query = `[out:json][timeout:120];
(
  node["place"~"^(city|town|village|suburb|neighbourhood|quarter|island)$"]["name"](${BBOX});
  nwr["natural"="beach"]["name"](${BBOX});
  nwr["aeroway"="aerodrome"]["name"](${BBOX});
  nwr["tourism"~"^(attraction|viewpoint|theme_park)$"]["name"](${BBOX});
  nwr["natural"~"^(volcano|peak)$"]["name"](${BBOX});
  nwr["water"="lake"]["name"](${BBOX});
  nwr["amenity"="marketplace"]["name"](${BBOX});
);
out center tags;`;

type Kind = "kota" | "desa" | "area" | "pantai" | "wisata" | "gunung" | "danau" | "bandara" | "pasar" | "pulau";
interface El { type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags: Record<string, string> }

function kindOf(t: Record<string, string>): Kind | null {
  if (t.aeroway === "aerodrome") return "bandara";
  if (t.natural === "beach") return "pantai";
  if (t.natural === "volcano" || t.natural === "peak") return "gunung";
  if (t.water === "lake") return "danau";
  if (t.amenity === "marketplace") return "pasar";
  if (t.tourism) return "wisata";
  if (t.place === "city" || t.place === "town") return "kota";
  if (t.place === "village") return "desa";
  if (t.place === "island") return "pulau";
  if (t.place) return "area";
  return null;
}

// Fly-to zoom per kind: a town fills the screen, an attraction is close enough to see its streets.
const ZOOM: Record<Kind, number> = { kota: 13, desa: 14.5, area: 15, pantai: 15, wisata: 16, gunung: 12.5, danau: 13.5, bandara: 14.2, pasar: 16.5, pulau: 12 };

const res = await fetch(OVERPASS, { method: "POST", body: new URLSearchParams({ data: query }), headers: { "User-Agent": "bali-streetlens (hackathon)" } });
if (!res.ok) throw new Error(`Overpass ${res.status}`);
const els = ((await res.json()) as { elements: El[] }).elements;

const seen = new Set<string>();
const places: { n: string; k: Kind; c: [number, number]; z: number; near?: string }[] = [];
for (const el of els) {
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  const kind = kindOf(el.tags);
  const name = (el.tags["name:id"] ?? el.tags.name ?? "").trim();
  if (lat === undefined || lng === undefined || !kind || !name || name.length > 60) continue;
  const key = `${name.toLowerCase()}|${kind}|${lng.toFixed(2)}|${lat.toFixed(2)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  places.push({ n: name, k: kind, c: [Number(lng.toFixed(5)), Number(lat.toFixed(5))], z: ZOOM[kind] });
}

// Regency seats OSM sometimes maps only as boundaries, never as a place node. Approximate town centres.
const SEATS: [string, number, number][] = [
  ["Singaraja", 115.088, -8.112], ["Denpasar", 115.2167, -8.65], ["Negara", 114.626, -8.357], ["Amlapura", 115.61, -8.45],
  ["Semarapura", 115.404, -8.534], ["Gianyar", 115.326, -8.541], ["Bangli", 115.355, -8.454], ["Tabanan", 115.126, -8.541],
  ["Mangupura", 115.19, -8.595],
];
for (const [n, lng, lat] of SEATS) {
  if (!places.some((p) => p.k === "kota" && p.n.toLowerCase() === n.toLowerCase())) places.push({ n, k: "kota", c: [lng, lat], z: ZOOM.kota });
}
// Peaks: only the named mountains people navigate by, not every surveyed hilltop.
for (let i = places.length - 1; i >= 0; i--) if (places[i].k === "gunung" && !/^(gunung|bukit|mount)(\s|$)/i.test(places[i].n)) places.splice(i, 1);

// Context: the nearest town (kota) that isn't the place itself.
const towns = places.filter((p) => p.k === "kota");
for (const p of places) {
  let best: { name: string; d: number } | null = null;
  for (const t of towns) {
    if (t === p) continue;
    const d = Math.hypot((t.c[0] - p.c[0]) * Math.cos((p.c[1] * Math.PI) / 180), t.c[1] - p.c[1]);
    if (!best || d < best.d) best = { name: t.n, d };
  }
  if (best && best.name !== p.n) p.near = best.name;
}

places.sort((a, b) => a.n.localeCompare(b.n, "id"));
writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), source: "© OpenStreetMap contributors, ODbL", places }) + "\n");
const byKind = places.reduce<Record<string, number>>((m, p) => ((m[p.k] = (m[p.k] ?? 0) + 1), m), {});
console.log(`${places.length} places -> ${OUT}`, byKind);

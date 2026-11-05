// Places anywhere in Bali for "Mau ke mana?" (web/public/places.json, built by `npm run places` from
// OpenStreetMap), the typo-tolerant matching shared with junction search, and distances.

import type { LngLat } from "../lib/liveSchema.ts";

export type PlaceKind = "kota" | "desa" | "area" | "pantai" | "wisata" | "gunung" | "danau" | "bandara" | "pasar" | "pulau";

export interface Place {
  /** Name as mapped in OSM. */
  n: string;
  k: PlaceKind;
  c: LngLat;
  /** Zoom to fly to. */
  z: number;
  /** Nearest town, for context ("dekat Gianyar"). */
  near?: string;
}

let loading: Promise<Place[]> | null = null;

/** Loads the index once (about 30 KB gzipped), on first use. */
export function loadPlaces(): Promise<Place[]> {
  loading ??= fetch("/places.json")
    .then((r) => (r.ok ? r.json() : { places: [] }))
    .then((d: { places: Place[] }) => d.places)
    .catch(() => {
      loading = null; // try again on the next focus
      return [];
    });
  return loading;
}

export const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(simpang|jalan|jl|underpass)\b\.?/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

function isSubsequence(q: string, tok: string): boolean {
  let i = 0;
  for (const ch of tok) if (ch === q[i]) i++;
  return i === q.length;
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * How well a query matches a name: 0 = no match, higher = better. Every query token must match a name
 * token as a prefix (best), one edit away (typos on a phone), or an Indonesian-style abbreviation
 * (same first letter, letters in order: "ptg" = patung).
 */
export function matchScore(query: string[], name: string): number {
  const tokens = normalize(name);
  if (tokens.length === 0) return 0;
  let score = 0;
  for (const q of query) {
    let best = 0;
    for (const tok of tokens) {
      if (tok === q) best = Math.max(best, 4);
      else if (tok.startsWith(q)) best = Math.max(best, 3);
      else if (q.length >= 4 && withinOneEdit(q, tok.slice(0, q.length + 1))) best = Math.max(best, 2);
      else if (q.length >= 3 && q[0] === tok[0] && isSubsequence(q, tok)) best = Math.max(best, 1);
    }
    if (best === 0) return 0;
    score += best;
  }
  // A name that starts with the query beats one that only contains it; shorter names win ties.
  if (tokens[0].startsWith(query[0])) score += 2;
  return score - tokens.length * 0.05;
}

const KIND_WEIGHT: Record<PlaceKind, number> = { kota: 3, bandara: 3, pantai: 1.5, danau: 1.5, gunung: 1.2, pulau: 1.5, wisata: 1, desa: 1, area: 1, pasar: 0.5 };

export function searchPlaces(places: Place[], query: string, limit = 7): Place[] {
  const q = normalize(query);
  if (q.length === 0) return [];
  const seen = new Set<string>();
  return places
    .map((p) => ({ p, s: matchScore(q, p.n) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s + KIND_WEIGHT[b.p.k] - (a.s + KIND_WEIGHT[a.p.k]) || a.p.n.localeCompare(b.p.n))
    .filter(({ p }) => {
      // The same name mapped twice a few hundred meters apart is one result.
      const key = `${p.n.toLowerCase()}|${p.c[0].toFixed(2)}|${p.c[1].toFixed(2)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map((x) => x.p);
}

/** Great-circle distance in km. */
export function distanceKm(a: LngLat, b: LngLat): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b[1] - a[1]);
  const dLng = r(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

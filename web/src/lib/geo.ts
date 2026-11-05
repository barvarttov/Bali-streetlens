// Latitude/longitude <-> the road-plane meters of a camera config (X east, Y north, from world_origin).
//
// Calibration points are measured on Google Maps' satellite view (right-click a landmark, copy its
// coordinates). Over the few hundred meters a camera sees, a local tangent plane is far more exact
// than any click: the WGS84 series below is good to millimeters at Bali's latitude.
//
// Pure (no DOM), runs in the browser and in Node 24 tests. Erasable syntax only.

import type { Meters } from "./schema.ts";

/** [longitude, latitude] in degrees, the order GeoJSON and MapLibre use. */
export type LngLat = [number, number];

/** Meters per degree of latitude and of longitude at a latitude (WGS84 ellipsoid series). */
export function metersPerDegree(latDeg: number): { lat: number; lng: number } {
  const p = (latDeg * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
    lng: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p),
  };
}

export function toLocalMeters(origin: LngLat, p: LngLat): Meters {
  const k = metersPerDegree(origin[1]);
  return [(p[0] - origin[0]) * k.lng, (p[1] - origin[1]) * k.lat];
}

export function fromLocalMeters(origin: LngLat, m: readonly [number, number]): LngLat {
  const k = metersPerDegree(origin[1]);
  return [origin[0] + m[0] / k.lng, origin[1] + m[1] / k.lat];
}

/** Generous box around the province (same as backend/main.py): anything outside is a typo. */
const BALI_BOX = { west: 114.3, south: -9.05, east: 115.95, north: -7.9 };

export function inBali([lng, lat]: LngLat): boolean {
  return lng >= BALI_BOX.west && lng <= BALI_BOX.east && lat >= BALI_BOX.south && lat <= BALI_BOX.north;
}

export type ParsedCoordinate = { kind: "lnglat"; value: LngLat } | { kind: "meters"; value: Meters };

/**
 * Reads what people paste:
 * - Google Maps' copied coordinates, latitude first: "-8.744676, 115.179105"
 * - a Google Maps link: ".../@-8.744676,115.179105,19z"
 * - longitude first also works, because in Bali the two can't be confused (|lng| > 90)
 * - meters from the origin, marked with "m": "3.5 m, 12 m"; Indonesian decimal commas need a
 *   semicolon between the two values: "3,5 m; 12 m"
 * Returns null for anything else, or for degrees outside Bali.
 */
export function parseCoordinate(text: string): ParsedCoordinate | null {
  const s = text.trim().replace(/−/g, "-");
  if (!s) return null;

  const link = s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (link) return pair(Number(link[1]), Number(link[2]), false);

  const isMeters = /\d\s*m\b/i.test(s);
  const parts = s.includes(";")
    ? s.split(";").map((p) => p.replace(/[^\d.,-]/g, "").replace(",", "."))
    : (s.match(/-?\d+(?:\.\d+)?/g) ?? []);
  if (parts.length !== 2) return null;
  return pair(Number(parts[0]), Number(parts[1]), isMeters);
}

function pair(x: number, y: number, isMeters: boolean): ParsedCoordinate | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (isMeters) return { kind: "meters", value: [x, y] };
  const lnglat: LngLat = Math.abs(x) > 90 ? [x, y] : [y, x];
  return inBali(lnglat) ? { kind: "lnglat", value: lnglat } : null;
}

/** Google Maps' own order and precision, so a value copied out reads like one copied in. */
export function formatLatLng([lng, lat]: LngLat): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

/** A Google Maps link that opens the satellite view on a point, zoomed in for picking landmarks. */
export function googleMapsSatelliteUrl([lng, lat]: LngLat): string {
  return `https://www.google.com/maps/@${lat.toFixed(6)},${lng.toFixed(6)},40m/data=!3m1!1e3`;
}

// The basemap for the Protomaps v4 tile schema (OpenStreetMap data), drawn as a Rupabumi-style
// topographic sheet: white land, pale sea and vegetation tints, white roads with fine casings, place
// names in spaced capitals. It stays quiet so the traffic colours MapView paints on top carry the eye.
//
// From zoom 15 up, road widths are true meters (they double with every zoom step), so the 3D vehicles,
// which are drawn in meters, always sit on a road of the right size.

import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";
import archivoLatin from "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2?url";
import archivoLatinExt from "@fontsource-variable/archivo/files/archivo-latin-ext-wdth-normal.woff2?url";

import { COLORS as c } from "../lib/palette.ts";
import outline from "./bali-outline.json";

// Only Bali is shown. Everything outside Bali province (Java, Lombok) is painted as sea, and place
// names outside it are hidden. The province is bounded at sea, mid-strait, so Nusa Penida stays.
const BALI_AREA = outline.geometry as unknown as GeoJSON.MultiPolygon;
const WORLD: GeoJSON.Position[] = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
const OUTSIDE_BALI: GeoJSON.Feature = {
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [WORLD, ...BALI_AREA.coordinates.map((poly) => [...poly[0]].reverse())] },
};
const inBali = ["within", BALI_AREA] as unknown as ExpressionSpecification;
const andInBali = (filter: unknown) => ["all", filter, inBali] as unknown as ExpressionSpecification;

/** Map labels are set in the UI face, rendered from the same self-hosted font files. */
export const MAP_FONT = { regular: "Archivo Regular", strong: "Archivo Strong" };

/** First label layer: runtime layers (focus dim, observed approaches) go below it. */
export const FIRST_LABEL_LAYER = "label-water";

/** Pixels per meter at zoom z, at Bali's latitude (512 px tiles). */
export const pxPerMeter = (z: number) => 2 ** z / 77372;

/**
 * Line width that is cartographic far out (the given px at zoom 9 and 12) and true `meters` from
 * zoom 15 up to 22, plus `extra` px (a casing's edge).
 */
export function roadWidth(px9: number, px12: number, meters: number, extra = 0): ExpressionSpecification {
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    9, px9 + extra * 0.4,
    12, px12 + extra * 0.6,
    15, Math.max(px12 * 1.6, meters * pxPerMeter(15)) + extra,
    22, meters * pxPerMeter(22) + extra,
  ] as ExpressionSpecification;
}

/** Like roadWidth, with highways (motorway, trunk) wider than other main roads, in one expression. */
function mainRoadWidth(highway: [number, number, number], other: [number, number, number], extra = 0): ExpressionSpecification {
  const at = (z: number, h: number, o: number) => [z, ["match", ["get", "kind"], "highway", h, o]];
  const w = (px9: number, px12: number, m: number) => [px9 + extra * 0.4, px12 + extra * 0.6, Math.max(px12 * 1.6, m * pxPerMeter(15)) + extra, m * pxPerMeter(22) + extra];
  const [h9, h12, h15, h22] = w(...highway);
  const [o9, o12, o15, o22] = w(...other);
  return ["interpolate", ["exponential", 2], ["zoom"], ...at(9, h9, o9), ...at(12, h12, o12), ...at(15, h15, o15), ...at(22, h22, o22)] as unknown as ExpressionSpecification;
}

const lines = ["==", ["geometry-type"], "LineString"] as ExpressionSpecification;
/** Fill for a depth band ("d" = at least this many meters): one step bluer per band. */
const DEPTH_FILL = [
  "step", ["get", "d"], c.depth[0],
  200, c.depth[200], 1000, c.depth[1000], 2000, c.depth[2000], 3000, c.depth[3000], 4000, c.depth[4000], 5000, c.depth[5000],
] as unknown as ExpressionSpecification;
const kind = (...kinds: string[]) => ["in", ["get", "kind"], ["literal", kinds]] as ExpressionSpecification;

export function mapStyle(origin: string): StyleSpecification {
  const abs = (url: string) => new URL(url, origin).href;
  const face = [
    { url: abs(archivoLatin), "unicode-range": ["U+0000-00FF", "U+0131", "U+0152-0153", "U+02BB-02BC", "U+02C6", "U+02DA", "U+02DC", "U+2000-206F", "U+20AC", "U+2122", "U+2191", "U+2193", "U+2212", "U+2215", "U+FEFF", "U+FFFD"] },
    { url: abs(archivoLatinExt), "unicode-range": ["U+0100-02AF", "U+1E00-1EFF", "U+2020", "U+20A0-20AB", "U+20AD-20C0", "U+2113", "U+2C60-2C7F", "U+A720-A7FF"] },
  ];
  return {
    version: 8,
    // Characters outside Archivo's coverage fall back to the Noto Sans glyphs kept in /glyphs.
    glyphs: `${origin}/glyphs/{fontstack}/{range}.pbf`,
    "font-faces": { [MAP_FONT.regular]: face, [MAP_FONT.strong]: face },
    sources: {
      osm: { type: "vector", tiles: [`${origin}/tiles/{z}/{x}/{y}.mvt`], minzoom: 0, maxzoom: 15 },
      "outside-bali": { type: "geojson", data: OUTSIDE_BALI },
      // Sea depth around Bali (npm run bathymetry): o=0 whole, o=1 only outside the province.
      bathymetry: { type: "geojson", data: abs("/bathymetry.json") },
    },
    layers: [
      { id: "sea", type: "background", paint: { "background-color": c.sea } },
      // Depth bands under the land: the precise OSM coastline is drawn over these coarse polygons, and the
      // shallowest band equals the background, so the seam never shows.
      { id: "bathymetry", type: "fill", source: "bathymetry", filter: ["==", ["get", "o"], 0], layout: { "fill-sort-key": ["get", "d"] }, paint: { "fill-color": DEPTH_FILL } },
      { id: "earth", type: "fill", source: "osm", "source-layer": "earth", paint: { "fill-color": c.land } },
      {
        id: "urban",
        type: "fill",
        source: "osm",
        "source-layer": "landuse",
        filter: kind("residential", "commercial", "industrial", "retail", "neighbourhood", "urban_area"),
        paint: { "fill-color": c.urban },
      },
      {
        id: "farmland",
        type: "fill",
        source: "osm",
        "source-layer": "landuse",
        filter: kind("farmland", "orchard", "grass", "golf_course", "cemetery", "allotments", "meadow", "village_green"),
        paint: { "fill-color": c.farmland },
      },
      {
        id: "green",
        type: "fill",
        source: "osm",
        "source-layer": "landuse",
        filter: kind("park", "forest", "wood", "scrub", "wetland"),
        paint: { "fill-color": c.park },
      },
      // Protected areas (national park, marine reserves around Nusa Penida) often reach far into the sea,
      // so they're a dashed boundary like on a printed sheet, not a fill that would paint the sea green.
      {
        id: "protected",
        type: "line",
        source: "osm",
        "source-layer": "landuse",
        minzoom: 8,
        filter: kind("nature_reserve", "national_park", "protected_area"),
        paint: {
          "line-color": c.protectedLine,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 14, 1.6] as ExpressionSpecification,
          "line-dasharray": [3, 2],
          "line-opacity": 0.8,
        },
      },
      {
        id: "sand",
        type: "fill",
        source: "osm",
        "source-layer": "landuse",
        filter: kind("beach", "sand"),
        paint: { "fill-color": c.sand },
      },
      {
        id: "airport",
        type: "fill",
        source: "osm",
        "source-layer": "landuse",
        filter: kind("aerodrome", "runway", "taxiway", "apron"),
        paint: { "fill-color": ["match", ["get", "kind"], ["runway", "taxiway"], c.airportRunway, c.airport] as ExpressionSpecification },
      },
      // Lakes and reservoirs only: the ocean is the depth bands above, so it must not be repainted flat here.
      {
        id: "water",
        type: "fill",
        source: "osm",
        "source-layer": "water",
        filter: ["all", ["!=", ["geometry-type"], "LineString"], ["!=", ["get", "kind"], "ocean"]],
        paint: { "fill-color": c.lake },
      },
      // The coastline as a fine printed rule: the water's edge, 1px of ink-blue.
      {
        id: "coast",
        type: "line",
        source: "osm",
        "source-layer": "earth",
        paint: { "line-color": c.waterLabel, "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.5, 14, 1] as ExpressionSpecification, "line-opacity": 0.55 },
      },
      {
        id: "water-line",
        type: "line",
        source: "osm",
        "source-layer": "water",
        filter: lines,
        paint: { "line-color": c.lake, "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 11, 0.6, 16, 3.5] as ExpressionSpecification },
      },
      {
        id: "path",
        type: "line",
        source: "osm",
        "source-layer": "roads",
        minzoom: 15,
        filter: ["all", lines, ["==", ["get", "kind"], "path"]],
        paint: { "line-color": c.path, "line-width": 1, "line-dasharray": [3, 2] },
      },
      {
        id: "minor-case",
        type: "line",
        source: "osm",
        "source-layer": "roads",
        minzoom: 12.5,
        filter: ["all", lines, kind("minor_road", "other")],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.roadCase, "line-width": roadWidth(0.4, 0.8, 5.5, 1.5) },
      },
      {
        id: "major-case",
        type: "line",
        source: "osm",
        "source-layer": "roads",
        filter: ["all", lines, kind("major_road", "highway")],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["step", ["zoom"], c.roadCaseMajor, 14, c.roadCase, 16, c.roadCaseMajor] as ExpressionSpecification,
          "line-width": mainRoadWidth([1.4, 2.6, 13], [0.9, 1.8, 9.5], 1.5),
        },
      },
      {
        id: "minor",
        type: "line",
        source: "osm",
        "source-layer": "roads",
        minzoom: 12.5,
        filter: ["all", lines, kind("minor_road", "other")],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.road, "line-width": roadWidth(0.2, 0.5, 5.5) },
      },
      {
        id: "major",
        type: "line",
        source: "osm",
        "source-layer": "roads",
        filter: ["all", lines, kind("major_road", "highway")],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": c.road,
          "line-width": mainRoadWidth([0.8, 1.8, 13], [0.4, 1.1, 9.5]),
        },
      },
      {
        id: "buildings-flat",
        type: "fill",
        source: "osm",
        "source-layer": "buildings",
        minzoom: 13.5,
        paint: { "fill-color": c.buildingFlat, "fill-outline-color": c.buildingOutline },
      },
      {
        id: "buildings-3d",
        type: "fill-extrusion",
        source: "osm",
        "source-layer": "buildings",
        minzoom: 13.5,
        paint: {
          "fill-extrusion-color": c.building,
          "fill-extrusion-height": ["coalesce", ["get", "height"], 6] as ExpressionSpecification,
          "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0] as ExpressionSpecification,
          "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 13.5, 0, 14.5, 0.95] as ExpressionSpecification,
          "fill-extrusion-vertical-gradient": true,
        },
      },
      { id: "outside-bali", type: "fill", source: "outside-bali", paint: { "fill-color": c.sea } },
      // The same depth bands again over the mask, outside the province only: the open sea beyond Bali keeps
      // its depth while Java and Lombok stay hidden (they show as the shallow-sea colour).
      { id: "bathymetry-outside", type: "fill", source: "bathymetry", filter: ["==", ["get", "o"], 1], layout: { "fill-sort-key": ["get", "d"] }, paint: { "fill-color": DEPTH_FILL } },
      {
        id: FIRST_LABEL_LAYER,
        type: "symbol",
        source: "osm",
        "source-layer": "water",
        filter: andInBali(["has", "name"]),
        layout: {
          "text-field": ["get", "name"],
          "text-font": [MAP_FONT.regular],
          "text-size": 12.5,
          "text-letter-spacing": 0.12,
          "symbol-placement": "point",
        },
        paint: { "text-color": c.waterLabel, "text-halo-color": "rgba(255, 255, 255, 0.85)", "text-halo-width": 1.4 },
      },
      {
        id: "label-road",
        type: "symbol",
        source: "osm",
        "source-layer": "roads",
        minzoom: 15,
        filter: andInBali(["all", lines, ["has", "name"], kind("major_road", "highway", "minor_road")]),
        layout: { "text-field": ["get", "name"], "text-font": [MAP_FONT.regular], "text-size": 12, "symbol-placement": "line", "text-max-angle": 30 },
        paint: { "text-color": c.label, "text-halo-color": c.road, "text-halo-width": 2 },
      },
      {
        id: "label-airport",
        type: "symbol",
        source: "osm",
        "source-layer": "pois",
        minzoom: 11,
        filter: andInBali(["==", ["get", "kind"], "aerodrome"]),
        layout: { "text-field": ["get", "name"], "text-font": [MAP_FONT.strong], "text-size": 12, "text-max-width": 9 },
        paint: { "text-color": c.labelStrong, "text-halo-color": c.labelHalo, "text-halo-width": 1.5 },
      },
      {
        id: "label-place",
        type: "symbol",
        source: "osm",
        "source-layer": "places",
        filter: andInBali(kind("locality", "neighbourhood", "macrohood", "region")),
        layout: {
          "text-field": ["get", "name"],
          "text-font": [MAP_FONT.strong],
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10.5, 14, 14] as ExpressionSpecification,
          "text-transform": "uppercase",
          "text-letter-spacing": 0.16,
          "text-max-width": 8,
        },
        paint: { "text-color": c.labelStrong, "text-halo-color": c.labelHalo, "text-halo-width": 1.5 },
      },
    ],
  };
}

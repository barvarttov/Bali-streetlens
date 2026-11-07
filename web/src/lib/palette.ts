// Lembar Rupabumi: the single source of colour for the UI, the MapLibre basemap and the Three.js
// vehicle layer. Light only. tokens.css mirrors the UI subset (keep in sync).
//
// The map reads like an official topographic sheet: white paper, iron-black ink, pale sea and
// vegetation tints, roads as white bands with fine casings. Colour does one job: traffic state, and
// only on roads a camera actually watches.
//   lancar  green   padat  amber   macet  red
// Black is the reserved ink for "you and your selection": the chosen junction, primary actions.
// State is never colour alone: marks differ by shape (ring / half / full / dashed) and carry a word.

export type TrafficLabel = "lancar" | "padat" | "macet" | "unknown";

export const COLORS = {
  // Paper and ink
  paper: "#FFFFFF",
  ink: "#15181B",
  ink2: "#4E555B",
  rule: "#D5D9DC",
  // Olive ink (tokens.css --ink): every line, box, fill and mark that used to be black.
  // Map text stays near-black (ink / labelStrong).
  accent: "#606C38",
  brand: "#606C38",
  onBrand: "#FFFFFF",
  // Basemap (user, 2026-11-04: "lebih berwarna", the sea bluer the deeper it is). The land tints stay
  // light, so the traffic greens/ambers/reds on watched roads still carry the eye.
  sea: "#A9D8F2", // shallow sea, 0-200 m, and everything the outside-Bali mask covers
  land: "#FBF8F0",
  park: "#BEDFA8", // forest, parks: far lighter than lancar green
  protectedLine: "#6E9E58", // dashed boundary of national parks and marine reserves
  farmland: "#DDEDB9", // sawah, fields
  sand: "#F4E2AE", // beaches
  urban: "#F1E9DC",
  airport: "#E4E6EC",
  airportRunway: "#C9CDD6",
  lake: "#8ECAEE",
  road: "#FFFFFF",
  roadCase: "#C8C0B2",
  roadCaseMajor: "#8F8676",
  path: "#B3AA9B",
  building: "#EFE6D8",
  buildingFlat: "#E5DBCA",
  buildingOutline: "#CFC3AE",
  label: "#4E555B",
  labelStrong: "#15181B",
  labelHalo: "#FFFFFF",
  waterLabel: "#174E78",
  dim: "#FFFFFF",
  // Sea depth (Natural Earth bathymetry): deeper is a deeper blue. Keyed by "at least this many meters".
  depth: { 0: "#A9D8F2", 200: "#86C5EC", 1000: "#61A9DE", 2000: "#448ECD", 3000: "#3075B9", 4000: "#225DA0", 5000: "#194A87" },
  // Traffic: fills and marks
  lancar: "#1F8A55",
  padat: "#E8A317",
  macet: "#D23B2E",
  unknown: "#9AA3A9",
  // Traffic: the same states as text on white (AA, >= 4.5:1)
  lancarText: "#16683F",
  padatText: "#8A5A00",
  macetText: "#B0281D",
  // Pale road-surface tints for a watched approach seen up close
  lancarTint: "#D6EEDF",
  padatTint: "#FBEBC8",
  macetTint: "#F7D5D1",
  unknownTint: "#E9ECEE",
  // Route planner: the chosen route in your-selection ink, alternatives in a mid grey
  route: "#606C38",
  routeAlt: "#8C959B",
  plate: "#606C38",
  plateText: "#FFFFFF",
  camera: "#FFFFFF",
  cameraStroke: "#4E555B",
  // A provincial camera that streams right now (AGA can count it): filled brand ink, white ring
  cameraLive: "#606C38",
  cameraLiveStroke: "#FFFFFF",
  // Three.js
  vehicleMoving: "#2B3238",
  vehicleStale: "#AEB5BA",
  skyLight: "#FFFFFF",
  groundLight: "#E6E9EB",
  hemiIntensity: 2.4,
  sunIntensity: 1.5,
} as const;

/** Colours under the team tools' old names, for the video overlay. */
export const PALETTE = {
  kapur: COLORS.paper,
  ijuk: COLORS.ink,
  kuning: COLORS.padat,
  barak: COLORS.macet,
  hijau: COLORS.lancar,
} as const;

/** Fill for a traffic state on the map (approach segments, queue bands). */
export function stateFill(label: TrafficLabel): string {
  return label === "lancar" ? COLORS.lancar : label === "padat" ? COLORS.padat : label === "macet" ? COLORS.macet : COLORS.unknown;
}

export const hex = (color: string) => Number.parseInt(color.slice(1), 16);

/**
 * Colour of one 3D vehicle (a 0xRRGGBB number for Three.js). Rules for the vehicle layer:
 * - Vehicle class (motor, mobil, bus, truk) is told apart by shape and size, never by colour.
 * - A moving vehicle is neutral graphite, always clear against the road.
 * - A vehicle stopped in a queue takes the queue's state colour, so a jam reads as a coloured tail
 *   even with the card closed. Stopped in a lancar approach (a short wait) stays neutral.
 * - When the camera reads "delayed" (data older than 10 s, format.ts STALE_MS), vehicles fade to a
 *   muted grey: never fake freshness.
 */
export function vehicleColor(stopped: boolean, queueLabel: TrafficLabel, stale: boolean): number {
  if (stale) return hex(COLORS.vehicleStale);
  if (stopped && queueLabel === "macet") return hex(COLORS.macet);
  if (stopped && queueLabel === "padat") return hex(COLORS.padat);
  return hex(COLORS.vehicleMoving);
}

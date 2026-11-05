// Compass directions in plain Indonesian (and English), the way any map app says them:
// utara, timur laut, timur, tenggara, selatan, barat daya, barat, barat laut.
// An approach is named by where its traffic comes FROM: an arm pointing south carries traffic
// "dari selatan". Runs in the browser and in Node 24.

export const COMPASS = ["utara", "timur laut", "timur", "tenggara", "selatan", "barat daya", "barat", "barat laut"] as const;
export type Compass = (typeof COMPASS)[number];

/** Compass word for a bearing in degrees clockwise from true north (8 sectors of 45°). */
export function compassDirection(bearingDeg: number): Compass {
  const b = ((bearingDeg % 360) + 360) % 360;
  return COMPASS[Math.round(b / 45) % 8];
}

/** Sort key that lists approaches clockwise starting from north. */
export function compassOrder(bearingDeg: number): number {
  return ((bearingDeg % 360) + 360) % 360;
}

export const COMPASS_WORD: Record<"id" | "en", Record<Compass, string>> = {
  id: {
    utara: "utara",
    "timur laut": "timur laut",
    timur: "timur",
    tenggara: "tenggara",
    selatan: "selatan",
    "barat daya": "barat daya",
    barat: "barat",
    "barat laut": "barat laut",
  },
  en: {
    utara: "north",
    "timur laut": "northeast",
    timur: "east",
    tenggara: "southeast",
    selatan: "south",
    "barat daya": "southwest",
    barat: "west",
    "barat laut": "northwest",
  },
};

/** One- or two-letter compass abbreviation, as printed on map plates: U, TL, T, TG, S, BD, B, BL. */
export const COMPASS_LETTER: Record<"id" | "en", Record<Compass, string>> = {
  id: { utara: "U", "timur laut": "TL", timur: "T", tenggara: "TG", selatan: "S", "barat daya": "BD", barat: "B", "barat laut": "BL" },
  en: { utara: "N", "timur laut": "NE", timur: "E", tenggara: "SE", selatan: "S", "barat daya": "SW", barat: "W", "barat laut": "NW" },
};

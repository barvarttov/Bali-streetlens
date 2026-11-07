// Smooth motion for live vehicles. A camera update arrives every second or two (every ~10 s on the hosted
// site), so a vehicle is not snapped or hopped to its new place: it moves there at constant speed over the
// time since the previous update, and is arriving just as the next one lands. The picture runs one update
// behind the camera, which is the price of motion that never stops.

export const MIN_GLIDE_MS = 400;
export const MAX_GLIDE_MS = 12_000;

/** How long to glide: the time between updates, kept within a sane range. */
export function glideDuration(sinceLastChangeMs: number): number {
  if (!Number.isFinite(sinceLastChangeMs)) return MIN_GLIDE_MS;
  return Math.min(MAX_GLIDE_MS, Math.max(MIN_GLIDE_MS, sinceLastChangeMs));
}

/** Progress 0..1 of a glide that started at `startMs` and lasts `durMs`. */
export function glideFraction(startMs: number, durMs: number, nowMs: number): number {
  if (durMs <= 0) return 1;
  return Math.min(1, Math.max(0, (nowMs - startMs) / durMs));
}

export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

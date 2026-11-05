// Numbers, durations and times in the visitor's language. Clock times are always WITA (Asia/Makassar).

import type { Lang, Translate } from "../i18n.tsx";
import type { CameraState, JunctionState } from "../lib/liveSchema.ts";

export function formatAge(ms: number, t: Translate): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 2) return t("justNow");
  if (s < 90) return t("secondsAgo", { n: s });
  return t("minutesAgo", { n: Math.round(s / 60) });
}

export function formatDuration(seconds: number, lang: Lang): string {
  if (seconds < 60) return lang === "id" ? `${seconds} dtk` : `${seconds} s`;
  const m = Math.round(seconds / 60);
  return lang === "id" ? `${m} mnt` : `${m} min`;
}

export function formatClock(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Makassar",
  }).format(new Date(iso));
}

export function formatNumber(n: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === "id" ? "id-ID" : "en-GB").format(n);
}

/** Live data older than this reads as delayed, whatever the server said. */
const STALE_MS = 10_000;

/** The honest camera state at this moment: a live camera whose data stops arriving becomes delayed. */
export function effectiveCameraState(j: JunctionState, nowServer: number): CameraState {
  if (j.camera_state === "live" && nowServer - Date.parse(j.updated_at) > STALE_MS) return "delayed";
  return j.camera_state;
}

/** Freshness line. Synthetic data never claims to be live: it says "Sintetis" in place of "Langsung". */
export function freshnessText(j: JunctionState, nowServer: number, t: Translate, lang: Lang, synthetic: boolean): string {
  const age = formatAge(nowServer - Date.parse(j.updated_at), t);
  const state = effectiveCameraState(j, nowServer);
  if (synthetic) {
    return state === "offline" ? t("syntheticOffline", { time: formatClock(j.updated_at, lang) }) : t("syntheticAge", { age });
  }
  switch (state) {
    case "live":
      return t("live", { age });
    case "delayed":
      return t("delayed", { age });
    case "replay":
      return t("replayAt", { time: formatClock(j.updated_at, lang) });
    case "offline":
      return t("offlineSince", { time: formatClock(j.updated_at, lang) });
  }
}

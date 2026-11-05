// Calls to backend/main.py. Every failure becomes an Error whose message can be shown as-is.

import { normalizeConfig } from "./config.ts";
import { indexObservations, validateObservations } from "./observations.ts";
import type { ObservationIndex } from "./observations.ts";
import type { CameraConfig, ClipInfo } from "./schema.ts";

const BACKEND_HINT = "Is the backend running? From the repo root: .venv\\Scripts\\python -m uvicorn backend.main:app --port 8000";

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(`Could not reach ${url}. ${BACKEND_HINT}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? "";
    } catch {
      detail = res.status >= 500 ? BACKEND_HINT : ""; // the Vite proxy answers 5xx with no JSON when the backend is down
    }
    throw new Error(`${url} returned HTTP ${res.status}${detail ? `. ${detail}` : ""}`);
  }
  return res.json();
}

export async function fetchClips(): Promise<ClipInfo[]> {
  const clips = await getJson("/api/clips");
  if (!Array.isArray(clips)) throw new Error("/api/clips did not return a list.");
  return clips as ClipInfo[];
}

export interface ClipData {
  index: ObservationIndex;
  /** null when the config could not be loaded; the reason is in configError. */
  config: CameraConfig | null;
  configError: string | null;
}

export async function loadClip(clipId: string): Promise<ClipData> {
  const id = encodeURIComponent(clipId);
  const [observations, config] = await Promise.allSettled([
    getJson(`/api/clips/${id}/observations`),
    getJson(`/api/clips/${id}/config`),
  ]);
  if (observations.status === "rejected") throw observations.reason;
  const index = indexObservations(validateObservations(observations.value));

  if (config.status === "rejected") {
    return { index, config: null, configError: errorMessage(config.reason) };
  }
  try {
    return { index, config: normalizeConfig(config.value), configError: null };
  } catch (err) {
    return { index, config: null, configError: errorMessage(err) };
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

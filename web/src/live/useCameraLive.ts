import { useEffect, useState } from "react";
import { liveApi, pageVisible, pollDelay } from "./api.ts";

// Real AGA counts for one provincial camera, for the public map's camera card. Opening the card asks the
// backend to analyse that camera; closing it stops the polling (the backend stops the camera ~45 s later).

export interface CameraLive {
  camera_state: "live" | "offline" | "connecting";
  updated_at?: string;
  counts: Record<string, number>;
  problem: string | null;
  refresh_s?: number; // set when the server analyses on demand (no torch): seconds between fresh frames
}

export type CameraLiveStatus =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string } // no AGA on this server, too many cameras, unknown camera
  | { kind: "ok"; data: CameraLive };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(liveApi(path), init);
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? "";
    } catch {
      /* not JSON: the hosted build has no such route */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function useCameraLive(cameraId: string): CameraLiveStatus {
  const [status, setStatus] = useState<CameraLiveStatus>({ kind: "loading" });

  useEffect(() => {
    let closed = false;
    setStatus({ kind: "loading" });
    const watch = () =>
      call(`/api/live/watch/${encodeURIComponent(cameraId)}`, { method: "POST" }).catch((e: Error) => {
        if (!closed) setStatus({ kind: "unavailable", reason: e.message });
      });
    void watch();
    const keep = window.setInterval(() => {
      if (pageVisible()) void watch();
    }, 20_000);
    // One request at a time (on the hosted site a poll may analyse a frame for a few seconds), never while hidden.
    let every = 1500;
    let timer = 0;
    const tick = () => {
      if (closed) return;
      if (!pageVisible()) {
        timer = window.setTimeout(tick, every);
        return;
      }
      call<CameraLive>(`/api/live/camera/${encodeURIComponent(cameraId)}`)
        .then((data) => {
          if (closed) return;
          every = pollDelay(1500, data.refresh_s);
          setStatus({ kind: "ok", data });
        })
        .catch(() => undefined) // the watch call reports real problems; a 404 just means "not started yet"
        .finally(() => {
          if (!closed) timer = window.setTimeout(tick, every);
        });
    };
    timer = window.setTimeout(tick, 300);
    return () => {
      closed = true;
      window.clearInterval(keep);
      window.clearTimeout(timer);
    };
  }, [cameraId]);

  return status;
}

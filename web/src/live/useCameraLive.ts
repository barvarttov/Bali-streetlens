import { useEffect, useState } from "react";

// Real AGA counts for one provincial camera, for the public map's camera card. Opening the card asks the
// backend to analyse that camera; closing it stops the polling (the backend stops the camera ~45 s later).

export interface CameraLive {
  camera_state: "live" | "offline" | "connecting";
  updated_at?: string;
  counts: Record<string, number>;
  problem: string | null;
}

export type CameraLiveStatus =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string } // no AGA on this server, too many cameras, unknown camera
  | { kind: "ok"; data: CameraLive };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
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
    const keep = window.setInterval(() => void watch(), 20_000);
    const poll = window.setInterval(() => {
      call<CameraLive>(`/api/live/camera/${encodeURIComponent(cameraId)}`)
        .then((data) => !closed && setStatus({ kind: "ok", data }))
        .catch(() => undefined); // the watch call reports real problems; a 404 just means "not started yet"
    }, 1500);
    return () => {
      closed = true;
      window.clearInterval(keep);
      window.clearInterval(poll);
    };
  }, [cameraId]);

  return status;
}

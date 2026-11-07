import { useEffect, useState } from "react";
import { normalizeConfig } from "../lib/config.ts";
import { calibrate, imageToWorld } from "../lib/homography.ts";
import type { Calibration } from "../lib/homography.ts";
import { fromLocalMeters } from "../lib/geo.ts";
import type { LngLat } from "../lib/geo.ts";
import type { VehicleClass } from "../lib/schema.ts";
import { liveApi, pageVisible, pollDelay } from "./api.ts";
import type { MapVehicle } from "./LiveVehicleLayer.ts";

// Live provincial cameras on the public map. The server says which cameras stream right now; opening one
// asks AGA to analyse it, and the card shows the counts while the map draws the vehicles in 3D around the
// camera. Closing the card stops the polling (a torch server stops the camera ~45 s later). Never a picture.

export interface CameraLive {
  camera_state: "live" | "offline" | "connecting";
  updated_at?: string;
  frame_size?: [number, number];
  objects?: { track_id: number; cls: VehicleClass; conf: number; ground_px: [number, number] }[];
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
      /* not JSON */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// ------------------------------------------------------------------ which cameras stream right now

export interface LiveCameraList {
  /** null while the first answer is on its way (or when the server could not be reached). */
  ids: Set<string> | null;
  modelReady: boolean;
}

const LIST_EVERY_MS = 5 * 60_000;

export function useLiveCameraList(): LiveCameraList {
  const [list, setList] = useState<LiveCameraList>({ ids: null, modelReady: false });
  useEffect(() => {
    let closed = false;
    const load = () => {
      if (!pageVisible()) return;
      call<{ model_ready: boolean; cameras: { id: string }[] }>("/api/live/cameras")
        .then((d) => !closed && setList({ ids: new Set(d.cameras.map((c) => c.id)), modelReady: d.model_ready }))
        .catch(() => undefined); // keep the last list; the map still works without live cameras
    };
    load();
    const timer = window.setInterval(load, LIST_EVERY_MS);
    return () => {
      closed = true;
      window.clearInterval(timer);
    };
  }, []);
  return list;
}

// ------------------------------------------------------------------ one camera's AGA result

export function useCameraLive(cameraId: string | null): CameraLiveStatus {
  const [status, setStatus] = useState<CameraLiveStatus>({ kind: "loading" });

  useEffect(() => {
    setStatus({ kind: "loading" });
    if (!cameraId) return;
    let closed = false;
    const watch = () =>
      call(`/api/live/watch/${encodeURIComponent(cameraId)}`, { method: "POST" }).catch((e: Error) => {
        if (!closed) setStatus({ kind: "unavailable", reason: e.message });
      });
    void watch();
    const keep = window.setInterval(() => {
      if (pageVisible()) void watch();
    }, 20_000);
    // One request at a time (on the hosted site a poll may analyse a frame for a few seconds), never while hidden.
    let every = 700;
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
          every = pollDelay(700, data.refresh_s);
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

// ------------------------------------------------------------------ where the vehicles go on the map

/** A calibrated camera with a known map origin gives measured positions. */
export interface Placement {
  cal: Calibration;
  origin: LngLat;
}

/** The camera's calibration, if the team made one (config/<id>.yaml with a map origin); otherwise null. */
export function useCameraPlacement(cameraId: string | null): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null);
  useEffect(() => {
    setPlacement(null);
    if (!cameraId) return;
    let cancelled = false;
    call<unknown>(`/api/cameras/${encodeURIComponent(cameraId)}/config`)
      .then((raw) => {
        const cfg = normalizeConfig(raw);
        const r = calibrate(cfg.calibration);
        if (!cancelled && r.ok && cfg.world_origin_lnglat) setPlacement({ cal: r.calibration, origin: cfg.world_origin_lnglat as LngLat });
      })
      .catch(() => undefined); // 404 = not calibrated yet
    return () => {
      cancelled = true;
    };
  }, [cameraId]);
  return placement;
}

// Without a calibration the position is a rough guess: the camera is assumed to look north at a road 30 m
// wide and 40 m deep, and the vehicles are drawn faded and enlarged so nobody takes them for measured.
const SKETCH_WIDTH_M = 60;
const SKETCH_DEPTH_M = 80;
const SKETCH_NEAR_M = 6;

export function placeVehicles(o: CameraLive, cameraLngLat: LngLat, placement: Placement | null): MapVehicle[] {
  const size = o.frame_size;
  if (!size || !o.objects) return [];
  return o.objects.map((v) => {
    const w = placement ? imageToWorld(placement.cal, v.ground_px) : null;
    const lnglat: LngLat =
      placement && w
        ? fromLocalMeters(placement.origin, w)
        : fromLocalMeters(cameraLngLat, [
            (v.ground_px[0] / size[0] - 0.5) * SKETCH_WIDTH_M,
            SKETCH_NEAR_M + (1 - v.ground_px[1] / size[1]) * SKETCH_DEPTH_M,
          ]);
    return { id: v.track_id, cls: v.cls, lnglat };
  });
}

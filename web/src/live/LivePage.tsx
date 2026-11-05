import { useEffect, useMemo, useRef, useState } from "react";
import { navigate, matchPath, usePath } from "../router.ts";
import { matchScore, normalize } from "../public/places.ts";
import { normalizeConfig } from "../lib/config.ts";
import { calibrate, imageToWorld } from "../lib/homography.ts";
import type { Calibration } from "../lib/homography.ts";
import { fromLocalMeters } from "../lib/geo.ts";
import type { LngLat } from "../lib/geo.ts";
import { LiveMap } from "./LiveMap.ts";
import type { MapVehicle } from "./LiveMap.ts";
import "./live.css";

// "CCTV langsung": search a location that has a live camera, then AGA (our own detector) reads that camera's
// stream on the server and the vehicles it finds are drawn in 3D here. No video is shown or stored.
// Positions are real meters only for a camera with a calibration (config/<id>.yaml); otherwise the scene is a
// labelled sketch, never presented as measured.

interface LiveCamera {
  id: string;
  name: string;
  lnglat: [number, number];
}
interface CameraList {
  model_ready: boolean;
  model: string;
  reason: string | null;
  cameras: LiveCamera[];
}
interface Observation {
  camera_id: string;
  camera_state: "live" | "offline" | "connecting";
  model: string;
  frame_size?: [number, number];
  updated_at?: string;
  objects: { track_id: number; cls: MapVehicle["cls"]; conf: number; ground_px: [number, number] }[];
  counts: Record<string, number>;
  problem: string | null;
}

const CLASS_LABEL: Record<string, string> = { motorcycle: "Motor", car: "Mobil", bus: "Bus", truck: "Truk" };
const WATCH_EVERY_MS = 20_000;
const POLL_MS = 700;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? "";
    } catch {
      /* no JSON body */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function LivePage() {
  const path = usePath();
  const cameraId = matchPath("/langsung/:id", path)?.id ?? null;
  const [list, setList] = useState<CameraList | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJson<CameraList>("/api/live/cameras")
      .then((d) => !cancelled && setList(d))
      .catch((e: Error) => !cancelled && setListError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const camera = list?.cameras.find((c) => c.id === cameraId) ?? null;

  return (
    <main className="live">
      <header className="live-head">
        <button type="button" className="live-back" onClick={() => navigate("/")}>
          Peta
        </button>
        <h1>CCTV langsung</h1>
        <p>Pilih lokasi yang kameranya sedang menyala. AGA membaca kamera itu dan kendaraannya digambar dalam 3D.</p>
      </header>
      <CameraSearch list={list} error={listError} selectedId={cameraId} />
      {list && !list.model_ready && (
        <p className="live-note is-warn" role="status">
          Model AGA belum bisa jalan di mesin ini: {list.reason ?? "tidak diketahui"}.
        </p>
      )}
      {cameraId && list && !camera && (
        <p className="live-note is-warn" role="status">
          Kamera ini sedang tidak menyala atau tidak dikenal. Pilih lokasi lain.
        </p>
      )}
      {camera && list?.model_ready && <Viewer key={camera.id} camera={camera} model={list.model} />}
    </main>
  );
}

function CameraSearch({ list, error, selectedId }: { list: CameraList | null; error: string | null; selectedId: string | null }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const results = useMemo(() => {
    if (!list) return [];
    const q = normalize(query);
    const all = list.cameras.map((c) => ({ c, s: q.length ? matchScore(q, c.name) : 1 })).filter((x) => x.s > 0);
    return all.sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name)).map((x) => x.c);
  }, [list, query]);

  if (error) return <p className="live-note is-warn" role="alert">Tidak bisa memuat daftar kamera: {error}</p>;
  if (!list) return <p className="live-note">Memeriksa kamera yang sedang menyala…</p>;
  return (
    <div className="live-search">
      <label htmlFor="live-q">Cari lokasi ({list.cameras.length} kamera menyala sekarang)</label>
      <input
        id="live-q"
        type="search"
        autoComplete="off"
        spellCheck={false}
        placeholder="Misalnya: catus pata, besakih, taman kota"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && (
        <ul className="live-results" role="listbox" aria-label="Kamera yang menyala">
          {results.length === 0 && <li className="live-empty">Tidak ada kamera menyala dengan nama itu.</li>}
          {results.map((c) => (
            <li key={c.id} role="option" aria-selected={c.id === selectedId}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                  navigate(`/langsung/${encodeURIComponent(c.id)}`);
                }}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Where the vehicles come from: a calibrated camera with a known map origin gives measured positions; anything
// else is a rough guess (the camera is assumed to look north, the road 30 m wide and 40 m deep) and is drawn faded.
interface Placement {
  cal: Calibration;
  origin: LngLat;
}
const SKETCH_WIDTH_M = 30;
const SKETCH_DEPTH_M = 40;
const SKETCH_NEAR_M = 6;

function place(o: Observation, camera: LiveCamera, placement: Placement | null): MapVehicle[] {
  const size = o.frame_size;
  if (!size) return [];
  return o.objects.map((v) => {
    const w = placement ? imageToWorld(placement.cal, v.ground_px) : null;
    const lnglat: LngLat =
      placement && w
        ? fromLocalMeters(placement.origin, w)
        : fromLocalMeters(camera.lnglat, [
            (v.ground_px[0] / size[0] - 0.5) * SKETCH_WIDTH_M,
            SKETCH_NEAR_M + (1 - v.ground_px[1] / size[1]) * SKETCH_DEPTH_M,
          ]);
    return { id: v.track_id, cls: v.cls, lnglat };
  });
}

function Viewer({ camera, model }: { camera: LiveCamera; model: string }) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LiveMap | null>(null);
  const [obs, setObs] = useState<Observation | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const placementRef = useRef<Placement | null>(null);

  // The camera's calibration, if the team made one. Without it (or without its map origin) positions are a guess.
  useEffect(() => {
    let cancelled = false;
    getJson<unknown>(`/api/cameras/${encodeURIComponent(camera.id)}/config`)
      .then((raw) => {
        const cfg = normalizeConfig(raw);
        const r = calibrate(cfg.calibration);
        if (!cancelled && r.ok && cfg.world_origin_lnglat) {
          const next = { cal: r.calibration, origin: cfg.world_origin_lnglat as LngLat };
          placementRef.current = next;
          setPlacement(next);
        }
      })
      .catch(() => undefined); // 404 = not calibrated yet
    return () => {
      cancelled = true;
    };
  }, [camera.id]);

  useEffect(() => {
    if (!host.current) return;
    const map = new LiveMap(host.current, camera.lnglat, setMapError);
    mapRef.current = map;
    return () => {
      map.dispose();
      mapRef.current = null;
    };
  }, [camera.lnglat]);

  useEffect(() => {
    mapRef.current?.setApproximate(!placement);
  }, [placement]);

  // Keep the server analysing this camera while the page is open, and poll the result.
  useEffect(() => {
    let closed = false;
    const watch = () =>
      getJson(`/api/live/watch/${encodeURIComponent(camera.id)}`, { method: "POST" })
        .then(() => setProblem(null))
        .catch((e: Error) => !closed && setProblem(e.message));
    void watch();
    const watchTimer = window.setInterval(() => void watch(), WATCH_EVERY_MS);
    const poll = window.setInterval(() => {
      getJson<Observation>(`/api/live/camera/${encodeURIComponent(camera.id)}`)
        .then((o) => {
          if (closed) return;
          setObs(o);
          mapRef.current?.setVehicles(place(o, camera, placementRef.current));
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      closed = true;
      window.clearInterval(watchTimer);
      window.clearInterval(poll);
    };
  }, [camera]);

  const state = problem ? "error" : (obs?.camera_state ?? "connecting");
  const stateText =
    state === "live" ? "Langsung" : state === "connecting" ? "Menghubungkan…" : state === "offline" ? "Kamera terputus" : "Gagal";

  return (
    <section className="live-viewer" aria-label={`Kembaran 3D ${camera.name}`}>
      <div className="live-bar">
        <h2>{camera.name}</h2>
        <span className={`live-state is-${state}`}>{stateText}</span>
      </div>
      <div className="live-scene" ref={host} />
      <dl className="live-counts">
        {["motorcycle", "car", "bus", "truck"].map((c) => (
          <div key={c}>
            <dt>{CLASS_LABEL[c]}</dt>
            <dd>{obs?.counts?.[c] ?? 0}</dd>
          </div>
        ))}
      </dl>
      {mapError && <p className="live-note is-warn" role="alert">Peta tidak bisa dimuat: {mapError}</p>}
      {problem && <p className="live-note is-warn" role="alert">{problem}</p>}
      {!problem && obs?.problem && <p className="live-note is-warn" role="status">Kamera: {obs.problem}</p>}
      <p className={`live-note${placement ? "" : " is-warn"}`}>
        {placement
          ? "Posisi kendaraan dihitung dari kalibrasi kamera ini."
          : "Kamera ini belum dikalibrasi. Kendaraan digambar samar dan diperbesar di sekitar titik kamera, dengan perkiraan kasar (kamera dianggap menghadap utara): jalur dan jarak belum tepat."}
      </p>
      <p className="live-note">
        Model: {obs?.model ?? model}, dilatih dari nol. Skor uji 0,47 mAP50 pada 84 bingkai CCTV; paling lemah saat hujan dan malam,
        jadi kendaraan bisa terlewat. Jalan dan gedung dari OpenStreetMap.
      </p>
    </section>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useClock } from "../hooks/useClock.ts";
import { calibrate } from "../lib/homography.ts";
import type { Calibration } from "../lib/homography.ts";
import type { ObservationIndex } from "../lib/observations.ts";
import type { CameraConfig } from "../lib/schema.ts";
import { buildWorldTracks, vehiclesAt } from "../lib/worldTracks.ts";
import type { WorldTracks } from "../lib/worldTracks.ts";
import type { TwinScene, TwinView } from "./twinScene.ts";

// The team tool's 3D twin (Person B). Pipeline: observations.json ground_px -> homography from the
// camera config -> meters on the road plane -> Three.js, on the shared video clock. In the public
// app the vehicles render as a MapLibre custom layer instead (one WebGL context, RANCANGAN-DESAIN.md §9).

/** Hold-out error above this is too high to show positions as more than a rough sketch (PLAN.md §9). */
const HIGH_ERROR_M = 1.0;

const num = (v: number, digits = 2) => v.toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });

interface Props {
  index: ObservationIndex | null;
  config: CameraConfig | null;
  /** Why the clip or its config could not be loaded, if so. */
  problem: string | null;
}

export function Scene3D({ index, config, problem }: Props) {
  const result = useMemo(() => (config ? calibrate(config.calibration) : null), [config]);
  const cal = result?.ok ? result.calibration : null;
  const world = useMemo(() => (index && cal ? buildWorldTracks(index, cal) : null), [index, cal]);

  if (!index || !config) {
    return <Placeholder title="Kembaran 3D" lines={[problem ?? "Memuat klip…"]} />;
  }
  if (!result?.ok) {
    const camera = config.camera_id;
    return (
      <Placeholder
        title="Kembaran 3D belum bisa digambar"
        lines={[
          result?.reason ?? "",
          `Isi calibration di config/${camera}.yaml: image_points_px dan world_points_m (minimal 4 pasang, sebaiknya 8–10, tersebar di seluruh jalan), plus 3 titik hold-out untuk mengukur galat.`,
          "Tanpa kalibrasi, posisi 3D tidak ditampilkan: lebih baik kosong daripada menebak.",
        ]}
      />
    );
  }
  return <Twin index={index} config={config} cal={cal!} world={world!} />;
}

function Placeholder({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="scene-placeholder">
      <p className="scene-placeholder-title">{title}</p>
      {lines.filter(Boolean).map((line) => (
        <p key={line} className="muted">
          {line}
        </p>
      ))}
    </div>
  );
}

function Twin({ index, config, cal, world }: { index: ObservationIndex; config: CameraConfig; cal: Calibration; world: WorldTracks }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<TwinScene | null>(null);
  const [view, setView] = useState<TwinView>("camera");
  const [azimuth, setAzimuth] = useState(0);
  const [webglError, setWebglError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let twin: TwinScene | null = null;
    let cancelled = false;
    setView("camera");
    setWebglError(null);
    // Three.js loads only when a clip with a calibration is opened, not with every team page.
    import("./twinScene.ts")
      .then(({ createTwinScene }) => {
        if (cancelled) return;
        twin = createTwinScene(host, world, cal, config, index.data.frame_size, { onAzimuth: setAzimuth });
        sceneRef.current = twin;
      })
      .catch((err) => !cancelled && setWebglError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
      twin?.dispose();
      sceneRef.current = null;
    };
  }, [world, cal, config, index]);

  const choose = (next: TwinView) => {
    setView(next);
    sceneRef.current?.setView(next);
  };

  if (webglError) {
    return <Placeholder title="Kembaran 3D tidak tersedia" lines={[`WebGL gagal dimulai di browser ini: ${webglError}`]} />;
  }

  const holdout =
    cal.holdoutMean === null
      ? { text: "Belum ada titik hold-out: galat posisi belum terukur.", warn: true }
      : {
          text: `Galat hold-out ${num(cal.holdoutMean)} m rata-rata, ${num(cal.holdoutMax!)} m maks (${cal.holdoutErrors.length} titik)`,
          warn: cal.holdoutMax! > HIGH_ERROR_M,
        };
  const dropped = world.dropped.aboveHorizon + world.dropped.outsideArea;

  return (
    <div className="scene-twin" ref={hostRef}>
      <div className="scene-hud scene-hud-top">
        <div className="scene-calibration">
          <p className={holdout.warn ? "scene-warn" : undefined}>{holdout.text}</p>
          <p className="muted tabular">
            Sisa fit {num(cal.fitRms)} m RMS · {cal.fitErrors.length} titik kalibrasi
            {holdout.warn && cal.holdoutMean !== null && " · tambah titik atau batasi ke bagian jalan yang datar"}
          </p>
        </div>
        <div className="scene-controls">
          <div className="scene-views" role="group" aria-label="Sudut pandang">
            <button type="button" aria-pressed={view === "camera"} onClick={() => choose("camera")}>
              Arah CCTV
            </button>
            <button type="button" aria-pressed={view === "top"} onClick={() => choose("top")}>
              Atas
            </button>
          </div>
          <span className="scene-compass" title="Arah utara" aria-label="Arah utara">
            <span style={{ transform: `rotate(${azimuth}rad)` }}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M8 1 L13 13 L8 10 L3 13 Z" />
              </svg>
            </span>
            U
          </span>
        </div>
      </div>
      <TwinReadout world={world} stopSpeed={config.queue.stop_speed_m_s} dropped={dropped} />
    </div>
  );
}

/** Live legend and counts at the frame on screen; re-renders with the clock (cheap), not per 3D frame. */
function TwinReadout({ world, stopSpeed, dropped }: { world: WorldTracks; stopSpeed: number; dropped: number }) {
  const { t } = useClock();
  let seen = 0;
  let missing = 0;
  let stopped = 0;
  for (const v of vehiclesAt(world, t)) {
    if (v.state === "observed") seen++;
    else missing++;
    if (v.state === "observed" && v.speed < stopSpeed) stopped++;
  }
  return (
    <div className="scene-hud scene-hud-bottom">
      <ul className="scene-legend">
        <li>
          <span className="swatch is-seen" aria-hidden="true" /> Terlacak <b className="tabular">{seen}</b>
          {stopped > 0 && <span className="muted tabular"> ({stopped} berhenti)</span>}
        </li>
        <li>
          <span className="swatch is-missing" aria-hidden="true" /> Celah pelacakan <b className="tabular">{missing}</b>
        </li>
        <li className="muted">
          <abbr title="Titik bawah-tengah tiap kotak diproyeksikan ke jalan yang dianggap datar. Kendaraan yang hilang dari pelacak tampil abu-abu paling lama 1 detik, lalu dihapus.">
            Posisi perkiraan
          </abbr>
        </li>
      </ul>
      {dropped > 0 && <p className="muted">{dropped} deteksi di luar area kalibrasi tidak digambar.</p>}
    </div>
  );
}

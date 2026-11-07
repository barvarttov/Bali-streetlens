import { useEffect, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import { useLang } from "../i18n.tsx";
import type { Lang } from "../i18n.tsx";
import { StateMark } from "./parts.tsx";

// The sheet's marginalia, live: coordinate ticks where whole minutes of longitude cross the top edge
// and latitude crosses the right edge, and a scale bar for the middle of the view. They move with the
// map, the way a printed sheet's graticule would if you could slide the paper.

interface Tick {
  pos: number; // px along the edge
  text: string;
}

// Tick spacings in degrees, from 1° down to 5 arc-seconds.
const INTERVALS = [1, 0.5, 0.25, 1 / 6, 1 / 12, 1 / 30, 1 / 60, 1 / 120, 1 / 240, 1 / 360, 1 / 720];

function formatDeg(value: number, interval: number, axis: "lat" | "lng", lang: Lang): string {
  const abs = Math.abs(value) + 1e-9;
  const d = Math.floor(abs);
  const mTotal = (abs - d) * 60;
  const m = Math.floor(mTotal);
  const s = Math.round((mTotal - m) * 60);
  const hemi = axis === "lng" ? (value >= 0 ? (lang === "id" ? "BT" : "E") : lang === "id" ? "BB" : "W") : value < 0 ? (lang === "id" ? "LS" : "S") : lang === "id" ? "LU" : "N";
  const sec = interval < 1 / 60 ? `${String(s).padStart(2, "0")}″` : "";
  return `${d}°${String(m).padStart(2, "0")}′${sec} ${hemi}`;
}

function edgeTicks(values: number[], step: number, axis: "lat" | "lng", lang: Lang): Tick[] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  if (!Number.isFinite(span) || span <= 0) return [];
  const interval = INTERVALS.find((i) => span / i >= 3) ?? INTERVALS[INTERVALS.length - 1];
  const ticks: Tick[] = [];
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    const ka = Math.floor(a / interval);
    const kb = Math.floor(b / interval);
    if (ka === kb) continue;
    const v = Math.max(ka, kb) * interval;
    const t = (v - a) / (b - a || 1);
    ticks.push({ pos: (i - 1 + t) * step, text: formatDeg(v, interval, axis, lang) });
  }
  return ticks;
}

const NICE = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];

export function MapFrame({ map }: { map: MlMap | null }) {
  const { lang } = useLang();
  const [top, setTop] = useState<Tick[]>([]);
  const [right, setRight] = useState<Tick[]>([]);
  // Grid lines only make sense on a flat, north-up sheet; tilted or turned, the ticks stay alone.
  const [flat, setFlat] = useState(true);

  useEffect(() => {
    if (!map) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const canvas = map.getCanvas();
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const N = 40;
      const lngs: number[] = [];
      const lats: number[] = [];
      for (let i = 0; i <= N; i++) {
        lngs.push(map.unproject([(i / N) * w, 2]).lng);
        lats.push(map.unproject([w - 2, (i / N) * h]).lat);
      }
      setTop(edgeTicks(lngs, w / N, "lng", lang));
      setRight(edgeTicks(lats, h / N, "lat", lang));
      setFlat(map.getPitch() < 3 && Math.abs(map.getBearing()) < 1);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    map.on("move", schedule);
    map.on("resize", schedule);
    return () => {
      map.off("move", schedule);
      map.off("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [map, lang]);

  return (
    <>
      <div className="graticule" aria-hidden="true">
        {flat && top.map((tk) => <span key={`gv${tk.text}`} className="grid-line grid-v" style={{ left: tk.pos }} />)}
        {flat && right.map((tk) => <span key={`gh${tk.text}`} className="grid-line grid-h" style={{ top: tk.pos }} />)}
        {top.map((tk) => (
          <span key={`t${tk.text}`} className="tick tick-top" style={{ left: tk.pos }}>
            {tk.text}
          </span>
        ))}
        {right.map((tk) => (
          <span key={`r${tk.text}`} className="tick tick-right" style={{ top: tk.pos }}>
            {tk.text}
          </span>
        ))}
      </div>
    </>
  );
}

/** Scale bar for the middle of the view: four alternating black and white segments, like a sheet's. */
export function ScaleBar({ map }: { map: MlMap | null }) {
  const [scale, setScale] = useState<{ px: number; label: string; ratio: string | null } | null>(null);
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const lat = map.getCenter().lat;
      const mpp = (78271.517 * Math.cos((lat * Math.PI) / 180)) / 2 ** map.getZoom();
      const meters = [...NICE].reverse().find((m) => m / mpp <= 110) ?? NICE[0];
      // Representative fraction on a 96 dpi screen (1 px = 0.2646 mm), rounded like a sheet's: 1:250.000.
      const rf = mpp / 0.0002646;
      const mag = 10 ** Math.floor(Math.log10(rf));
      const nice = Math.round(rf / (mag / 4)) * (mag / 4);
      setScale({ px: meters / mpp, label: meters >= 1000 ? `${meters / 1000} km` : `${meters} m`, ratio: map.getPitch() < 3 ? `1:${new Intl.NumberFormat("id-ID").format(nice)}` : null });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    map.on("move", schedule);
    map.on("pitch", schedule);
    return () => {
      map.off("move", schedule);
      map.off("pitch", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [map]);
  if (!scale) return null;
  return (
    <div className="scale" aria-hidden="true">
      {scale.ratio && <span className="scale-ratio">{scale.ratio}</span>}
      <span className="scale-bar" style={{ width: Math.round(scale.px) }}>
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="scale-labels" style={{ width: Math.round(scale.px) }}>
        <span>0</span>
        <span>{scale.label}</span>
      </span>
    </div>
  );
}

/** The sheet's key: what each printed mark means, the live cameras, and the provincial cameras layer. */
export function MapKey({
  showCameras,
  onToggleCameras,
  liveCount,
}: {
  showCameras: boolean;
  onToggleCameras: () => void;
  /** How many provincial cameras stream right now; null until known. */
  liveCount: number | null;
}) {
  const { t, lang } = useLang();
  return (
    <section className="map-key" aria-label={t("legendLabel")}>
      <ul className="key-marks">
        {(["lancar", "padat", "macet", "unknown"] as const).map((l) => (
          <li key={l}>
            <StateMark label={l} size={14} />
            {t(l)}
          </li>
        ))}
      </ul>
      {liveCount !== null && liveCount > 0 && (
        <span className="key-live">
          <span className="key-live-dot" aria-hidden="true" />
          {lang === "id" ? `Kamera langsung (${liveCount})` : `Live cameras (${liveCount})`}
        </span>
      )}
      <label className="key-cameras">
        <input type="checkbox" checked={showCameras} onChange={onToggleCameras} />
        <span className="key-camera-dot" aria-hidden="true" />
        {t("camerasToggle")}
      </label>
    </section>
  );
}

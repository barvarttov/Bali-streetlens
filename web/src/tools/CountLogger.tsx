import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, ArrowLeft, DownloadSimple } from "@phosphor-icons/react";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { SyntheticBanner } from "../components/SyntheticBanner.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { VideoPane } from "../components/VideoPane.tsx";
import { errorMessage, fetchClips, loadClip } from "../lib/api.ts";
import type { ClipData } from "../lib/api.ts";
import { clock } from "../lib/clock.ts";
import { VEHICLE_CLASSES } from "../lib/schema.ts";
import type { ClipInfo, VehicleClass } from "../lib/schema.ts";
import { useClock } from "../hooks/useClock.ts";
import { navigate } from "../router.ts";
import { useTransportKeys } from "./useTransportKeys.ts";

// Manual-count logger for the accuracy evaluation (RANCANGAN-DESAIN.md §6).
// Two people count each clip independently; every key press logs one line crossing at the frame on
// screen. The CSV goes to eval/manual_events_<clip>_<annotator>.csv and is matched to the automatic
// crossings (±1 s) by vision/evaluate.py.

interface CountEvent {
  frame: number;
  t: number;
  cls: VehicleClass;
  line: string;
  dir: "in" | "out";
}

const KEYS: Record<string, VehicleClass> = { m: "motorcycle", c: "car", b: "bus", t: "truck" };
const CLASS_NAMES: Record<VehicleClass, string> = { motorcycle: "Motor", car: "Mobil", bus: "Bus", truck: "Truk" };
const RATES = [0.25, 0.5, 1];

const storageKey = (clip: string, who: string) => `streetlens.count.${clip}.${who.trim().toLowerCase()}`;

function loadEvents(clip: string, who: string): CountEvent[] {
  try {
    const raw = localStorage.getItem(storageKey(clip, who));
    return raw ? (JSON.parse(raw) as CountEvent[]) : [];
  } catch {
    return [];
  }
}

export function CountLogger({ clipId }: { clipId: string }) {
  const [clip, setClip] = useState<ClipInfo | null>(null);
  const [data, setData] = useState<ClipData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [annotator, setAnnotator] = useState("");
  const [events, setEvents] = useState<CountEvent[]>([]);
  const [lineIndex, setLineIndex] = useState(0);
  const [rate, setRate] = useState(0.5);
  const [flash, setFlash] = useState<string | null>(null);
  const { frame, t } = useClock();
  useTransportKeys();

  useEffect(() => {
    let cancelled = false;
    fetchClips()
      .then((list) => !cancelled && setClip(list.find((c) => c.id === clipId) ?? null))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    loadClip(clipId)
      .then((loaded) => !cancelled && setData(loaded))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [clipId]);

  const ready = annotator.trim().length > 0;
  useEffect(() => {
    if (ready) setEvents(loadEvents(clipId, annotator));
  }, [clipId, annotator, ready]);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(storageKey(clipId, annotator), JSON.stringify(events));
    } catch {
      /* storage full or blocked: the export button still works */
    }
  }, [events, clipId, annotator, ready]);

  useEffect(() => clock.setPlaybackRate(rate), [rate, data]);

  const lines = data?.config?.count_lines ?? [];
  const line = lines[lineIndex]?.id ?? "count_line";

  // Count keys. Refs keep the handler stable while it reads the latest frame and line.
  const latest = useRef({ frame, t, line, ready });
  latest.current = { frame, t, line, ready };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (/^[1-9]$/.test(key)) {
        setLineIndex(Number(key) - 1);
        return;
      }
      if (key === "z") {
        setEvents((list) => list.slice(0, -1));
        return;
      }
      const cls = KEYS[key];
      if (!cls || !latest.current.ready) return;
      e.preventDefault();
      const { frame: f, t: time, line: l } = latest.current;
      const dir = e.shiftKey ? "out" : "in";
      setEvents((list) => [...list, { frame: f, t: time, cls, line: l, dir }]);
      setFlash(`${CLASS_NAMES[cls]} · ${dir === "in" ? "masuk" : "keluar"}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), 700);
    return () => window.clearTimeout(id);
  }, [flash, events.length]);

  const tallies = useMemo(() => {
    const out: Record<string, number> = {};
    for (const ev of events) out[`${ev.cls}/${ev.dir}`] = (out[`${ev.cls}/${ev.dir}`] ?? 0) + 1;
    return out;
  }, [events]);

  const exportCsv = () => {
    const rows = ["clip,annotator,frame,t,cls,line,dir", ...events.map((ev) => [clipId, annotator.trim(), ev.frame, ev.t.toFixed(3), ev.cls, ev.line, ev.dir].join(","))];
    const blob = new Blob([rows.join("\n") + "\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `manual_events_${clipId}_${annotator.trim().toLowerCase().replace(/\s+/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const isSynthetic = clip?.source === "synthetic";
  return (
    <div className="tool">
      {isSynthetic && <SyntheticBanner />}
      <header className="tool-bar">
        <button type="button" className="back" onClick={() => navigate("/tim")}>
          <ArrowLeft size={18} weight="bold" aria-hidden="true" />
          Alat tim
        </button>
        <h1 className="tool-title">Penghitung manual · {clipId}</h1>
        {clip && <StatusBadge status={clip.status} reason={clip.reason} />}
        <label className="annotator">
          <span>Nama penghitung</span>
          <input value={annotator} onChange={(e) => setAnnotator(e.target.value)} placeholder="mis. Ayu" autoComplete="off" />
        </label>
      </header>

      <main className="logger-workspace">
        <section className="tool-panel video-panel" aria-label="Video kamera (khusus tim)">
          {data && clip?.video_url ? (
            <VideoPane videoUrl={clip.video_url} index={data.index} config={data.config} showBoxes={false} showGeometry onVideoError={setError} />
          ) : (
            <div className="pane-empty">{error ?? "Memuat klip…"}</div>
          )}
          {flash && (
            <div className="logged-flash" aria-hidden="true">
              {flash}
            </div>
          )}
        </section>

        <aside className="tool-panel logger-panel" aria-label="Penghitungan">
          {!ready && <p className="logger-hint">Isi nama penghitung dulu. Setiap orang menghitung sendiri, lalu hasilnya dibandingkan.</p>}

          <h2 className="panel-title">Tombol</h2>
          <ul className="key-legend">
            {Object.entries(KEYS).map(([key, cls]) => (
              <li key={key}>
                <kbd>{key.toUpperCase()}</kbd> {CLASS_NAMES[cls]}
              </li>
            ))}
            <li>
              <kbd>Shift</kbd> + tombol = arah keluar
            </li>
            <li>
              <kbd>Z</kbd> batalkan terakhir
            </li>
          </ul>

          <h2 className="panel-title">Garis hitung</h2>
          <div className="line-choice" role="radiogroup" aria-label="Garis hitung">
            {(lines.length ? lines : [{ id: "count_line" }]).map((l, i) => (
              <button key={l.id} type="button" role="radio" aria-checked={i === lineIndex} className="chip" onClick={() => setLineIndex(i)}>
                {i + 1} · {l.id}
              </button>
            ))}
          </div>

          <h2 className="panel-title">Hitungan · {events.length}</h2>
          <table className="tally">
            <thead>
              <tr>
                <th scope="col">Kelas</th>
                <th scope="col">Masuk</th>
                <th scope="col">Keluar</th>
              </tr>
            </thead>
            <tbody>
              {VEHICLE_CLASSES.map((cls) => (
                <tr key={cls}>
                  <th scope="row">{CLASS_NAMES[cls]}</th>
                  <td>{tallies[`${cls}/in`] ?? 0}</td>
                  <td>{tallies[`${cls}/out`] ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <ol className="event-log" reversed aria-label="Catatan terakhir">
            {events
              .slice(-8)
              .reverse()
              .map((ev, i) => (
                <li key={`${ev.frame}-${i}`} className="tabular">
                  f{ev.frame} · {ev.t.toFixed(2)} dtk · {CLASS_NAMES[ev.cls]} · {ev.line} · {ev.dir === "in" ? "masuk" : "keluar"}
                </li>
              ))}
          </ol>

          <div className="logger-actions">
            <button type="button" className="btn" onClick={() => setEvents((l) => l.slice(0, -1))} disabled={events.length === 0}>
              <ArrowCounterClockwise size={18} weight="bold" aria-hidden="true" /> Batalkan
            </button>
            <button type="button" className="btn btn-primary" onClick={exportCsv} disabled={events.length === 0}>
              <DownloadSimple size={18} weight="bold" aria-hidden="true" /> Ekspor CSV
            </button>
          </div>
        </aside>
      </main>

      <footer className="tool-panel timeline-panel">
        <Timeline disabled={!data} />
        <div className="rate-choice" role="radiogroup" aria-label="Kecepatan">
          {RATES.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={r === rate} className="chip" onClick={() => setRate(r)}>
              {r}×
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}

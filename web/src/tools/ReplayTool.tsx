import { useEffect, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { MetricsPanel } from "../components/MetricsPanel.tsx";
import { Scene3D } from "../components/Scene3D.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { SyntheticBanner } from "../components/SyntheticBanner.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { VideoPane } from "../components/VideoPane.tsx";
import { errorMessage, fetchClips, loadClip } from "../lib/api.ts";
import type { ClipData } from "../lib/api.ts";
import type { ClipInfo, ClipStatus } from "../lib/schema.ts";
import { navigate } from "../router.ts";
import { useTransportKeys } from "./useTransportKeys.ts";

/** Team tool: play an analysed clip with its boxes, geometry and the shared clock (raw video, team only). */
export function ReplayTool({ clipId }: { clipId: string }) {
  const [clip, setClip] = useState<ClipInfo | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [data, setData] = useState<ClipData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [showBoxes, setShowBoxes] = useState(true);
  const [showGeometry, setShowGeometry] = useState(true);
  useTransportKeys();

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    setVideoError(null);
    fetchClips()
      .then((list) => !cancelled && setClip(list.find((c) => c.id === clipId) ?? null))
      .catch((err) => !cancelled && setListError(errorMessage(err)));
    loadClip(clipId)
      .then((loaded) => !cancelled && setData(loaded))
      .catch((err) => !cancelled && setLoadError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [clipId]);

  // The badge reports the worst thing we know: backend, file, then playback problems override the server's status.
  let status: ClipStatus = clip?.status ?? "unavailable";
  let reason = clip?.reason ?? "";
  if (listError) [status, reason] = ["unavailable", listError];
  else if (loadError) [status, reason] = ["unavailable", loadError];
  else if (videoError) [status, reason] = ["unavailable", videoError];

  const isSynthetic = clip?.source === "synthetic" || data?.index.data.source === "synthetic";
  const canPlay = data !== null && !!clip?.video_url && !videoError;

  return (
    <div className="tool">
      {isSynthetic && <SyntheticBanner />}
      <header className="tool-bar">
        <button type="button" className="back" onClick={() => navigate("/tim")}>
          <ArrowLeft size={18} weight="bold" aria-hidden="true" />
          Alat tim
        </button>
        <h1 className="tool-title">Pemutar analisis · {clipId}</h1>
        <StatusBadge status={status} reason={reason} />
        <span className="status-reason">{reason}</span>
        {clip?.model && (
          <span className="clip-meta tabular">
            {clip.model} · {clip.tracker} · {clip.fps} fps · {clip.frame_size?.join("×")}
          </span>
        )}
      </header>

      <main className="tool-workspace">
        <section className="tool-panel video-panel" aria-label="Video kamera (khusus tim)">
          {data && clip?.video_url ? (
            <VideoPane
              videoUrl={clip.video_url}
              index={data.index}
              config={data.config}
              showBoxes={showBoxes}
              showGeometry={showGeometry}
              onVideoError={setVideoError}
            />
          ) : (
            <div className="pane-empty">{status === "unavailable" ? reason : "Memuat klip…"}</div>
          )}
          {data?.configError && <div className="pane-warning">Konfigurasi kamera tidak termuat: {data.configError}</div>}
        </section>
        <section className="tool-panel scene-panel" aria-label="Kembaran 3D">
          <Scene3D
            index={data?.index ?? null}
            config={data?.config ?? null}
            problem={loadError ?? (data?.configError ? `Konfigurasi kamera tidak termuat: ${data.configError}` : null)}
          />
        </section>
        <aside className="tool-panel metrics-panel" aria-label="Metrik">
          <MetricsPanel index={data?.index ?? null} />
        </aside>
      </main>

      <footer className="tool-panel timeline-panel">
        <Timeline disabled={!canPlay} />
        <div className="layer-toggles">
          <label>
            <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} /> Kotak
          </label>
          <label>
            <input type="checkbox" checked={showGeometry} onChange={(e) => setShowGeometry(e.target.checked)} /> Garis &amp; area
          </label>
        </div>
      </footer>
    </div>
  );
}

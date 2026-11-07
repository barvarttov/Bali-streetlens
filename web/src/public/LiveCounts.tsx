import { useLang } from "../i18n.tsx";
import { useCameraLive } from "../live/useCameraLive.ts";
import type { CameraLiveStatus } from "../live/useCameraLive.ts";

// Real vehicle counts from AGA (our own detector) for one provincial camera, shown on a card.
// Opening the card asks the backend to analyse that camera; closing it stops. Nothing here is a
// lancar/padat/macet label: that needs a calibrated camera with stop lines and queue areas.

interface Props {
  live: CameraLiveStatus;
  cameraId: string;
  /** True on a junction card whose label and arms are still synthetic: say which part is real. */
  besideSynthetic?: boolean;
}

export function LiveCounts({ live, besideSynthetic = false }: Props) {
  const { lang } = useLang();
  const id = lang === "id";
  const counting = live.kind === "ok" && live.data.camera_state === "live";
  const names: [string, string][] = [
    ["motorcycle", id ? "Motor" : "Motorbikes"],
    ["car", id ? "Mobil" : "Cars"],
    ["bus", "Bus"],
    ["truck", id ? "Truk" : "Trucks"],
  ];

  if (!counting) {
    return (
      <>
        {live.kind === "ok" && live.data.camera_state === "connecting" && (
          <p className="why-sentence">{id ? "Menghubungkan ke kamera…" : "Connecting to the camera…"}</p>
        )}
        {live.kind === "ok" && live.data.camera_state === "offline" && (
          <p className="why-sentence">{id ? "Kamera ini sedang mati atau tidak mengirim gambar." : "This camera is off or sends no picture."}</p>
        )}
        {live.kind === "unavailable" && besideSynthetic && (
          <p className="why-sentence">{id ? "Hitungan nyata dari AGA belum tersedia sekarang." : "The real AGA count is not available right now."}</p>
        )}
      </>
    );
  }

  return (
    <>
      <p className="state-summary">{id ? "Hitungan nyata dari kamera, oleh AGA" : "Real count from the camera, by AGA"}</p>
      <dl className="camera-live-counts">
        {names.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{live.data.counts[key] ?? 0}</dd>
          </div>
        ))}
      </dl>
      <p className="why-sentence">
        {besideSynthetic
          ? id
            ? "Angka di atas nyata: kendaraan yang terlihat di gambar sekarang, bukan arus per menit. Label lancar/padat/macet dan rincian lajur di bawah masih data sintetis."
            : "The numbers above are real: the vehicles in the picture right now, not a flow per minute. The lancar/padat/macet label and the arm details below are still synthetic."
          : id
            ? "Ini kendaraan yang terlihat di gambar sekarang, bukan arus per menit, dan belum ada label lancar/padat/macet karena kamera ini belum dikonfigurasi. AGA bisa melewatkan kendaraan, terutama saat hujan dan malam."
            : "These are the vehicles in the picture right now, not a flow per minute, and there is no lancar/padat/macet label because this camera is not configured yet. AGA can miss vehicles, especially in rain and at night."}
      </p>
    </>
  );
}

/** The junction card's version: it owns the polling, so the card only mounts this when a camera exists. */
export function JunctionLiveCounts({ cameraId }: { cameraId: string }) {
  const live = useCameraLive(cameraId);
  return <LiveCounts live={live} cameraId={cameraId} besideSynthetic />;
}

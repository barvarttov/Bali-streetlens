import { useLang } from "../i18n.tsx";
import type { TrafficLabel } from "../lib/liveSchema.ts";
import { useCameraLive } from "../live/useCameraLive.ts";
import type { CameraLiveStatus } from "../live/useCameraLive.ts";
import { StateWord } from "./parts.tsx";

// What a provincial camera sees right now, in plain words for anyone: "Malam ini jalan di sini sepi dan
// lancar." plus how many motorbikes, cars, buses and trucks are in view. The words come from how many
// vehicles are in the picture (no queue is measured), so they never say "macet".

const QUIET_MAX = 3; // up to this many vehicles in view: quiet
const BUSY_MIN = 10; // from this many: busy

/** Part of the day in Bali (WITA). */
function partOfDay(now: Date, id: boolean): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Makassar" }).format(now));
  if (hour >= 4 && hour < 11) return id ? "Pagi" : "This morning";
  if (hour >= 11 && hour < 15) return id ? "Siang" : "This afternoon";
  if (hour >= 15 && hour < 18) return id ? "Sore" : "This evening";
  return id ? "Malam" : "Tonight";
}

export function trafficSentence(total: number, now: Date, id: boolean): { label: TrafficLabel; text: string } {
  const when = partOfDay(now, id);
  const self = id ? `${when} ini` : when;
  if (total <= QUIET_MAX) return { label: "lancar", text: id ? `${self} jalan di sini sepi dan lancar.` : `${self} the road here is quiet and moving.` };
  if (total < BUSY_MIN) return { label: "lancar", text: id ? `${self} jalan di sini cukup ramai, tetap lancar.` : `${self} the road here is fairly busy but moving.` };
  return { label: "padat", text: id ? `${self} jalan di sini ramai.` : `${self} the road here is busy.` };
}

interface Props {
  live: CameraLiveStatus;
  cameraId: string;
  /** On a junction card: the junction's own words stay; this only adds what the camera sees now. */
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
          <p className="why-sentence">{id ? "Membuka kamera…" : "Opening the camera…"}</p>
        )}
        {live.kind === "ok" && live.data.camera_state === "offline" && (
          <p className="why-sentence">{id ? "Kamera ini sedang tidak menyala." : "This camera is off right now."}</p>
        )}
      </>
    );
  }

  const counts = live.data.counts;
  const total = names.reduce((n, [key]) => n + (counts[key] ?? 0), 0);
  const verdict = trafficSentence(total, new Date(), id);
  return (
    <>
      {!besideSynthetic && <StateWord label={verdict.label} size="md" />}
      {!besideSynthetic && <p className="state-summary">{verdict.text}</p>}
      <p className={besideSynthetic ? "state-summary" : "why-sentence"}>
        {id ? "Kendaraan yang terlihat di kamera sekarang" : "Vehicles in view right now"}
      </p>
      <dl className="camera-live-counts">
        {names.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{counts[key] ?? 0}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** The junction card's version: it owns the polling, so the card only mounts this when a camera exists. */
export function JunctionLiveCounts({ cameraId }: { cameraId: string }) {
  const live = useCameraLive(cameraId);
  return <LiveCounts live={live} cameraId={cameraId} besideSynthetic />;
}

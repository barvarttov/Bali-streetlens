import { ArrowLeft, Check, Info, Minus, Question, ShareNetwork, Signpost, X } from "@phosphor-icons/react";
import { useState } from "react";
import type { ReactNode } from "react";
import { useLang } from "../i18n.tsx";
import { compassOrder } from "../lib/direction.ts";
import type { CameraLiveStatus } from "../live/useCameraLive.ts";
import { JUNCTION_CAMERA } from "./junctionCameras.ts";
import { JunctionLiveCounts, LiveCounts } from "./LiveCounts.tsx";
import { LABEL_RANK } from "../lib/liveSchema.ts";
import type { Camera, Corridor, Junction, JunctionState, LngLat, TrafficLabel } from "../lib/liveSchema.ts";
import { effectiveCameraState, formatAge, formatDuration, formatNumber, freshnessText } from "./format.ts";
import { DirLetter, StateMark, StateWord, useCompass } from "./parts.tsx";
import { distanceKm } from "./places.ts";

// The card's views: an area (what a search landed on), one junction, the evidence behind its label,
// and a provincial camera that isn't analysed yet. Each is one column of the sheet's margin: a title
// block, then sections divided by 1px rules.

/** Where a search (or the corridor mark) landed. */
export interface Area {
  name: string;
  /** "Desa · dekat Gianyar", already translated. */
  sub?: string;
  center: LngLat;
}

function CardHead({ title, sub, onBack, backLabel, onClose }: { title: string; sub?: ReactNode; onBack?: () => void; backLabel?: string; onClose?: () => void }) {
  const { t } = useLang();
  return (
    <header className={`card-head${onClose ? " has-close" : ""}`}>
      {onBack && (
        <div className="card-nav">
          <button type="button" className="text-btn" onClick={onBack}>
            <ArrowLeft size={18} weight="bold" aria-hidden="true" />
            {backLabel ?? t("back")}
          </button>
        </div>
      )}
      {onClose && (
        <button type="button" className="icon-btn card-close" onClick={onClose} aria-label={t("close")}>
          <X size={20} weight="bold" aria-hidden="true" />
        </button>
      )}
      <h2 className="card-title" id="card-title">
        {title}
      </h2>
      {sub && <p className="card-sub">{sub}</p>}
    </header>
  );
}

// ---------------------------------------------------------------- area

interface AreaProps {
  area: Area;
  corridor: Corridor;
  cameras: Camera[];
  states: Map<string, JunctionState>;
  nowServer: number;
  synthetic: boolean;
  lastUpdate: number | null;
  showCameras: boolean;
  onToggleCameras: () => void;
  /** Provincial cameras streaming right now; the ones near this area are listed and open on the map. */
  liveCameras: Camera[];
  onSelectCamera: (id: string) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Opens the route planner with this area as the destination (not offered for the corridor). */
  onRoute?: () => void;
}

export const HERE_KM = 6;

export function AreaView({
  area,
  corridor,
  cameras,
  states,
  nowServer,
  synthetic,
  lastUpdate,
  showCameras,
  onToggleCameras,
  liveCameras,
  onSelectCamera,
  onSelect,
  onClose,
  onRoute,
}: AreaProps) {
  const { t, lang } = useLang();
  const withDist = corridor.junctions.map((j) => ({ j, s: states.get(j.id), km: distanceKm(area.center, j.center) }));
  const here = withDist
    .filter((x) => x.km <= HERE_KM)
    .sort((a, b) => LABEL_RANK[b.s?.label ?? "unknown"] - LABEL_RANK[a.s?.label ?? "unknown"] || a.j.name.localeCompare(b.j.name));
  const nearest = here.length ? [] : [...withDist].sort((a, b) => a.km - b.km).slice(0, 3);
  const camsNear = cameras.filter((c) => !c.analyzed && distanceKm(area.center, c.lnglat) <= 3).length;
  const liveNear = liveCameras
    .map((c) => ({ c, km: distanceKm(area.center, c.lnglat) }))
    .filter((x) => x.km <= HERE_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, 8);
  const liveSection = liveNear.length > 0 && (
    <section className="card-section">
      <h3 className="section-title">{lang === "id" ? "Kamera langsung di sekitar sini" : "Live cameras nearby"}</h3>
      <ul className="junction-index">
        {liveNear.map(({ c, km }) => (
          <li key={c.id}>
            <button type="button" className="index-row" onClick={() => onSelectCamera(c.id)}>
              <span className="camera-live-dot index-live-dot" aria-hidden="true" />
              <span className="index-main">
                <span className="index-name">{c.name}</span>
                <span className="index-sub">{lang === "id" ? "Hitungan AGA + kendaraan 3D di peta" : "AGA count + 3D vehicles on the map"}</span>
              </span>
              <span className="index-side">
                <span className="index-state is-live">{lang === "id" ? "Langsung" : "Live"}</span>
                <span className="index-fresh">{t("km", { n: formatNumber(Math.round(km * 10) / 10, lang) })}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  const sub = here.length
    ? `${t("watchedHere", { n: here.length })}${lastUpdate !== null ? ` · ${t("updated", { age: formatAge(nowServer - lastUpdate, t) })}` : ""}`
    : area.sub;
  return (
    <article className="area" aria-labelledby="card-title">
      <CardHead title={area.name} sub={sub} onClose={onClose} />
      {onRoute && (
        <section className="card-section actions route-cta">
          <button type="button" className="btn btn-primary" onClick={onRoute}>
            <Signpost size={18} weight="bold" aria-hidden="true" />
            {t("routeHere")}
          </button>
        </section>
      )}
      {here.length > 0 ? (
        <section className="card-section">
          <h3 className="section-title">{t("watchedTitle")}</h3>
          <JunctionIndex rows={here} nowServer={nowServer} synthetic={synthetic} onSelect={onSelect} />
        </section>
      ) : null}
      {liveSection}
      {here.length > 0 ? null : (
        <>
          <section className="card-section">
            <p className="none-here">{t("noneHere")}</p>
            {camsNear > 0 && (
              <p className="cams-near">
                {t("camerasNear", { n: camsNear })}{" "}
                <button type="button" className="link-btn" onClick={onToggleCameras}>
                  {showCameras ? t("hideCameras") : t("showCameras")}
                </button>
              </p>
            )}
          </section>
          <section className="card-section">
            <h3 className="section-title">{t("nearestTitle")}</h3>
            <JunctionIndex
              rows={nearest}
              nowServer={nowServer}
              synthetic={synthetic}
              onSelect={onSelect}
              aside={(km) => t("km", { n: formatNumber(Math.round(km), lang) })}
            />
          </section>
        </>
      )}
    </article>
  );
}

function worstApproach(s: JunctionState | undefined) {
  if (!s) return null;
  return [...s.approaches].sort((a, b) => LABEL_RANK[b.label] - LABEL_RANK[a.label] || b.stopped_for_s - a.stopped_for_s)[0] ?? null;
}

const totalFlow = (s: JunctionState) => s.approaches.reduce((n, a) => n + a.flow_per_min, 0);

/** One line that answers "what's happening here", from the worst approach. */
function useSummary(): (junction: Junction, s: JunctionState | undefined) => string {
  const { t, lang } = useLang();
  const compass = useCompass();
  return (junction, s) => {
    const a = worstApproach(s);
    if (!s || !a) return "";
    const arm = junction.arms.find((x) => x.id === a.arm);
    const dir = arm ? compass(arm.bearing).word : "";
    if (a.label === "macet") return t("summaryQueue", { dur: formatDuration(a.stopped_for_s, lang), dir });
    if (a.label === "padat") return t("summaryStopped", { n: a.stopped, dir });
    return t("summaryFlow", { n: totalFlow(s) });
  };
}

function JunctionIndex({
  rows,
  nowServer,
  synthetic,
  onSelect,
  aside,
}: {
  rows: { j: Junction; s: JunctionState | undefined; km: number }[];
  nowServer: number;
  synthetic: boolean;
  onSelect: (id: string) => void;
  aside?: (km: number) => string;
}) {
  const { t, lang } = useLang();
  const summary = useSummary();
  return (
    <ul className="junction-index">
      {rows.map(({ j, s, km }) => {
        const label: TrafficLabel = s?.label ?? "unknown";
        const offline = !s || effectiveCameraState(s, nowServer) === "offline";
        return (
          <li key={j.id}>
            <button type="button" className="index-row" onClick={() => onSelect(j.id)}>
              <StateMark label={label} size={22} />
              <span className="index-main">
                <span className="index-name">{j.name.replace(/^Simpang\s+/i, "")}</span>
                <span className="index-sub">
                  {offline ? (s ? freshnessText(s, nowServer, t, lang, synthetic) : t("noData")) : label === "lancar" && s ? t("indexFlow", { n: totalFlow(s) }) : summary(j, s)}
                </span>
              </span>
              <span className="index-side">
                <span className={`index-state is-${label}`}>{t(label)}</span>
                <span className="index-fresh">{aside ? aside(km) : s && !offline ? formatAge(nowServer - Date.parse(s.updated_at), t) : ""}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- junction

interface JunctionProps {
  junction: Junction;
  state: JunctionState | undefined;
  nowServer: number;
  synthetic: boolean;
  onBack: () => void;
  /** Back button text when "Kembali" doesn't lead to the area list (e.g. back to the routes). */
  backLabel?: string;
  onWhy: () => void;
  onRoute: () => void;
}

/** Queue bars share one scale: the full bar is this many minutes. Length is duration. */
const BAR_FULL_S = 20 * 60;

export function JunctionDetail({ junction, state, nowServer, synthetic, onBack, backLabel, onWhy, onRoute }: JunctionProps) {
  const { t, lang } = useLang();
  const compass = useCompass();
  const summary = useSummary();
  const [shared, setShared] = useState(false);
  const label: TrafficLabel = state?.label ?? "unknown";
  const offline = !state || effectiveCameraState(state, nowServer) === "offline";
  const arms = [...junction.arms].sort((a, b) => compassOrder(a.bearing) - compassOrder(b.bearing));

  const share = async () => {
    const url = `${window.location.origin}/simpang/${junction.id}`;
    const text = `${junction.name}: ${t(label).toUpperCase()}`;
    try {
      if (navigator.share) await navigator.share({ title: junction.name, text, url });
      else {
        await navigator.clipboard.writeText(`${text} ${url}`);
        setShared(true);
        window.setTimeout(() => setShared(false), 3000);
      }
    } catch {
      /* the visitor closed the share sheet */
    }
  };

  const freshness = state ? freshnessText(state, nowServer, t, lang, synthetic) : "";
  const camState = synthetic ? "synthetic" : state ? effectiveCameraState(state, nowServer) : "offline";
  return (
    <article className="junction" aria-labelledby="card-title">
      <CardHead title={junction.name} sub={junction.roads.join(" × ")} onBack={onBack} backLabel={backLabel} />

      <section className="card-section state-block">
        <div className="state-line">
          <StateWord label={label} size="lg" />
          <span className={`fresh is-${camState}`}>
            <span className="fresh-dot" aria-hidden="true" />
            {freshness}
          </span>
        </div>
        {!offline && <p className="state-summary">{summary(junction, state)}</p>}
        {offline && <p className="state-summary">{t("offlineBody")}</p>}
      </section>

      {synthetic && JUNCTION_CAMERA[junction.id] && (
        <section className="card-section">
          <JunctionLiveCounts cameraId={JUNCTION_CAMERA[junction.id]} />
        </section>
      )}

      {!offline && (
        <section className="card-section">
          <h3 className="section-title">{t("approachesTitle")}</h3>
          <ul className="approaches">
            {arms.map((arm) => {
              const a = state?.approaches.find((x) => x.arm === arm.id);
              const { word, letter } = compass(arm.bearing);
              const al: TrafficLabel = a?.label ?? "unknown";
              const fact = !a
                ? t("noData")
                : a.label === "macet"
                  ? t("factQueue", { dur: formatDuration(a.stopped_for_s, lang) })
                  : a.label === "padat"
                    ? t("factStopped", { n: a.stopped })
                    : t("factFlow", { n: a.flow_per_min });
              const bar = !a ? 0 : a.label === "lancar" ? 0 : Math.min(1, a.label === "macet" ? a.stopped_for_s / BAR_FULL_S : Math.max(0.04, a.stopped / 40));
              return (
                <li key={arm.id} className={`approach is-${al}`}>
                  <DirLetter letter={letter} />
                  <span className="approach-main">
                    <span className="approach-from">{t("approachFrom", { dir: word })}</span>
                    {bar > 0 && (
                      <span className="approach-bar" aria-hidden="true">
                        <span style={{ width: `${bar * 100}%` }} />
                      </span>
                    )}
                  </span>
                  <span className="approach-fact">{fact}</span>
                  <span className={`approach-state is-${al}`}>{t(al)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {state && <HistoryStrip history={state.history} />}

      {state?.classes_15min && !offline && <ClassMix classes={state.classes_15min} />}

      <section className="card-section actions">
        {!offline && label !== "unknown" && (
          <button type="button" className="btn btn-primary" onClick={onWhy}>
            <Question size={18} weight="bold" aria-hidden="true" />
            {t("why", { label: t(label).toLowerCase() })}
          </button>
        )}
        <button type="button" className="btn" onClick={onRoute}>
          <Signpost size={18} weight="bold" aria-hidden="true" />
          {t("routeHere")}
        </button>
        <button type="button" className="btn" onClick={share}>
          <ShareNetwork size={18} weight="bold" aria-hidden="true" />
          {shared ? t("shared") : t("share")}
        </button>
        <p className="visually-hidden" role="status" aria-live="polite">
          {shared ? t("shared") : ""}
        </p>
      </section>

      <footer className="card-notes">
        <p>
          <Info size={14} weight="bold" aria-hidden="true" />
          <span>
            {!offline && <>{t("vehicles3dSim")} </>}
            {t("accuracy")}
          </span>
        </p>
      </footer>
    </article>
  );
}

function HistoryStrip({ history }: { history: JunctionState["history"] }) {
  const { t } = useLang();
  const counts = new Map<string, number>();
  for (const h of history) counts.set(h, (counts.get(h) ?? 0) + 1);
  const parts = [...counts.entries()].map(([k, n]) =>
    k === "none" ? t("historyNone", { n }) : t("historyPart", { n, label: t(k as TrafficLabel).toLowerCase() }),
  );
  return (
    <section className="card-section history">
      <h3 className="section-title">{t("history")}</h3>
      <div className="history-cells" role="img" aria-label={t("historySummary", { parts: parts.join(", ") })}>
        {history.map((h, i) => (
          <span key={i} className={`cell is-${h}`} />
        ))}
      </div>
      <p className="history-axis" aria-hidden="true">
        <span>{t("historyStart")}</span>
        <span>{t("now")}</span>
      </p>
    </section>
  );
}

function ClassMix({ classes }: { classes: NonNullable<JunctionState["classes_15min"]> }) {
  const { t, lang } = useLang();
  const order = ["motorcycle", "car", "truck", "bus"] as const; // motorbikes first: most of Bali's traffic
  const total = Math.max(1, order.reduce((s, k) => s + classes[k], 0));
  return (
    <section className="card-section classes">
      <h3 className="section-title">{t("classesTitle")}</h3>
      <div className="mix-bar" aria-hidden="true">
        {order.map((k) => (
          <span key={k} className={`mix-${k}`} style={{ flexGrow: classes[k] / total }} />
        ))}
      </div>
      <dl className="mix-key">
        {order.map((k) => (
          <div key={k}>
            <dt>
              <span className={`mix-swatch mix-${k}`} aria-hidden="true" />
              {t(k)}
            </dt>
            <dd>{formatNumber(classes[k], lang)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------- why

interface WhyProps {
  junction: Junction;
  state: JunctionState | undefined;
  synthetic: boolean;
  onBack: () => void;
}

export function WhyView({ junction, state, synthetic, onBack }: WhyProps) {
  const { t, lang } = useLang();
  const compass = useCompass();
  const why = state?.why;
  const label: TrafficLabel = state?.label ?? "unknown";
  const arm = junction.arms.find((a) => a.id === why?.arm);
  const dir = arm ? compass(arm.bearing).word : "";

  let sentence = "";
  if (why?.kind === "sustained_queue")
    sentence = t("whySustained", { n: why.stopped, min: why.min_stopped_s, dir, dur: formatDuration(why.stopped_for_s, lang) });
  else if (why?.kind === "red_light_stop") sentence = t("whyRedLight", { n: why.stopped, dir, sus: why.sustained_after_s });
  else sentence = t("whyFlowing");

  return (
    <article className="why" aria-labelledby="card-title">
      <CardHead title={t("whyTitle", { label: t(label).toLowerCase() })} sub={junction.name} onBack={onBack} backLabel={t("whyCloseLabel")} />
      <section className="card-section">
        <StateWord label={label} size="md" />
        <p className="why-sentence">{sentence}</p>
      </section>
      {why && <WhyRules why={why} label={label} />}
      <footer className="card-notes">
        <p>
          <Info size={14} weight="bold" aria-hidden="true" />
          {t("whyMode")}
        </p>
        <p>
          <Info size={14} weight="bold" aria-hidden="true" />
          {synthetic ? t("whySourceSynthetic") : t("whySource")}
        </p>
      </footer>
    </article>
  );
}

/**
 * The three rules as a checklist that leads to the label, in order: a queue (enough vehicles stopped),
 * a lasting queue (long enough), and vehicles still crossing while it lasts (so not a red light).
 * The flow rule only counts once the queue has lasted; before that it is "not judged".
 */
function WhyRules({ why, label }: { why: NonNullable<JunctionState["why"]>; label: TrafficLabel }) {
  const { t, lang } = useLang();
  const queue = why.stopped >= why.min_vehicles;
  const lasting = queue && why.stopped_for_s >= why.sustained_after_s;
  const rows: { name: string; now: string; rule: string; met: boolean | null }[] = [
    { name: t("whyStopped", { min: why.min_stopped_s }), now: String(why.stopped), rule: t("whyRuleStopped", { n: why.min_vehicles }), met: queue },
    { name: t("whyQueueFor"), now: formatDuration(why.stopped_for_s, lang), rule: t("whyRuleQueue", { sus: why.sustained_after_s }), met: queue ? lasting : null },
    { name: t("whyFlow"), now: t("perMin", { n: why.flow_per_min }), rule: t("whyRuleFlow"), met: lasting ? why.flow_per_min > 0 : null },
  ];
  const verdict = label === "macet" ? t("whyVerdictMacet") : label === "padat" ? t("whyVerdictPadat", { sus: why.sustained_after_s }) : t("whyVerdictLancar");
  return (
    <section className="card-section">
      <table className="why-table">
        <thead>
          <tr>
            <th scope="col">{t("whyRule")}</th>
            <th scope="col">{t("whyNow")}</th>
            <th scope="col" className="why-met-col">
              {t("whyMet")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className={r.met === null ? "is-not-judged" : undefined}>
              <th scope="row">
                <span className="why-name">{r.name}</span>
                <span className="why-rule">{r.rule}</span>
              </th>
              <td>{r.now}</td>
              <td className={`why-met is-${r.met === null ? "na" : r.met ? "yes" : "no"}`}>
                {r.met === null ? <Minus size={16} weight="bold" aria-hidden="true" /> : r.met ? <Check size={16} weight="bold" aria-hidden="true" /> : <X size={16} weight="bold" aria-hidden="true" />}
                <span className="visually-hidden">{r.met === null ? t("whyNotJudged") : r.met ? t("whyYes") : t("whyNo")}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="why-verdict">{verdict}</p>
    </section>
  );
}

// ---------------------------------------------------------------- un-analysed camera

export function CameraInfo({
  camera,
  live,
  calibrated,
  road,
  viewDirection = false,
  onBack,
}: {
  camera: Camera;
  /** AGA on this camera, or null when it is not streaming right now (or AGA is unavailable). */
  live: CameraLiveStatus | null;
  calibrated: boolean;
  /** Without a calibration: the nearest OSM road the vehicles are laid along (null: none within 150 m). */
  road: { name: string | null } | null;
  /** The camera's position and viewing direction are known (not a calibration). */
  viewDirection?: boolean;
  onBack: () => void;
}) {
  const { t, lang } = useLang();
  const id = lang === "id";
  const roadName = road?.name ?? (id ? "jalan terdekat" : "the nearest road");
  const counting = live?.kind === "ok" && live.data.camera_state === "live";
  const refresh = live?.kind === "ok" ? live.data.refresh_s : undefined;
  return (
    <article className="camera-info" aria-labelledby="card-title">
      <CardHead title={camera.name} sub={t("camSource")} onBack={onBack} />
      <section className="card-section">
        {counting ? (
          <>
            <LiveCounts live={live} cameraId={camera.id} />
            <p className="why-sentence">
              {calibrated
                ? id
                  ? "Kendaraan 3D di peta ditempatkan dari kalibrasi kamera ini."
                  : "The 3D vehicles on the map are placed from this camera's calibration."
                : viewDirection
                  ? id
                    ? "Kendaraan 3D di peta dibentangkan dari posisi kamera ke arah pandangnya. Kamera ini belum dikalibrasi, jadi letak tepatnya perkiraan; jumlahnya nyata."
                    : "The 3D vehicles on the map are laid out from the camera toward where it looks. It is not calibrated yet, so the exact spots are estimates; the number is real."
                  : road
                  ? id
                    ? `Kendaraan 3D di peta ditaruh di sepanjang ${roadName}, jalan terdekat dari titik kamera. Kamera ini belum dikalibrasi, jadi letak tepatnya perkiraan; jumlahnya nyata.`
                    : `The 3D vehicles on the map are laid along ${roadName}, the road nearest the camera. It is not calibrated yet, so the exact spots are estimates; the number is real.`
                  : id
                    ? "Kendaraan 3D di peta digambar di sekitar titik kamera. Kamera ini belum dikalibrasi, jadi jalur dan jaraknya hanya perkiraan; jumlahnya nyata."
                    : "The 3D vehicles on the map are drawn around the camera. It is not calibrated yet, so lanes and distances are only a guess; the number is real."}
            </p>
            {refresh && (
              <p className="why-sentence">
                {id
                  ? `Diperbarui sekitar setiap ${refresh} detik (AGA berjalan di server tanpa GPU).`
                  : `Updated about every ${refresh} s (AGA runs on a server without a GPU).`}
              </p>
            )}
          </>
        ) : (
          <>
            <StateWord label="unknown" size="md" />
            <p className="state-summary">{t("camTitle")}</p>
            <p className="why-sentence">{t("camBody")}</p>
            {(live === null || live.kind === "unavailable") && (
              <p className="why-sentence">
                {id ? "Kamera ini sedang tidak menyala, jadi AGA belum bisa menghitungnya." : "This camera is not streaming right now, so AGA cannot count it."}
              </p>
            )}
            {(live?.kind === "loading" || (live?.kind === "ok" && live.data.camera_state === "connecting")) && (
              <p className="why-sentence">{id ? "Menghubungkan ke kamera…" : "Connecting to the camera…"}</p>
            )}
            {live?.kind === "ok" && live.data.camera_state === "offline" && (
              <p className="why-sentence">
                {live.data.problem?.startsWith("batas")
                  ? id
                    ? "Batas analisis AGA untuk sementara tercapai. Coba lagi nanti."
                    : "AGA's analysis limit is reached for now. Try again later."
                  : id
                    ? "Kamera ini sedang mati atau tidak mengirim gambar."
                    : "This camera is off or sends no picture."}
              </p>
            )}
          </>
        )}
      </section>
    </article>
  );
}

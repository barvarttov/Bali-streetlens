import { ArrowClockwise, ArrowSquareOut, Crosshair, Info, MapTrifold, Warning } from "@phosphor-icons/react";
import type { StringKey } from "../i18n.tsx";
import { useLang } from "../i18n.tsx";
import { LABEL_RANK } from "../lib/liveSchema.ts";
import type { Corridor, JunctionState, TrafficLabel } from "../lib/liveSchema.ts";
import { effectiveCameraState } from "./format.ts";
import { StateMark, useCompass } from "./parts.tsx";
import { formatDistance, googleMapsUrl } from "./route.ts";
import type { Endpoint, RouteOption, RoutePassedJunction, RouteRequest } from "./route.ts";

// The route card: what's still missing, the search, or up to three routes (A, B, C) ranked by what we
// recommend. Each route names its main road, its length and the watched junctions it passes with
// their live state. The chosen route's junctions are listed in full, then Google Maps takes over
// turn-by-turn guidance. No travel times: they haven't been measured.

export const ROUTE_LETTERS = ["A", "B", "C"] as const;

interface Props {
  corridor: Corridor;
  states: Map<string, JunctionState>;
  nowServer: number;
  from: Endpoint | null;
  to: Endpoint | null;
  request: RouteRequest;
  selected: number;
  /** The labels each route's junctions had when the routes were calculated. */
  labelsAtRequest: string;
  onSelect: (index: number) => void;
  onMyLocation: () => void;
  onPickOnMap: (field: "from" | "to") => void;
  onRecalculate: () => void;
}

/** The live label of the approach a route enters a junction by (the junction's label if unknown). */
export function passedLabel(p: RoutePassedJunction, states: Map<string, JunctionState>, nowServer: number): TrafficLabel {
  const s = states.get(p.id);
  if (!s || effectiveCameraState(s, nowServer) === "offline") return "unknown";
  return s.approaches.find((a) => a.arm === p.arm)?.label ?? s.label;
}

export function labelsKey(routes: RouteOption[], states: Map<string, JunctionState>, nowServer: number): string {
  return routes.map((r) => r.junctions.map((p) => passedLabel(p, states, nowServer)).join(",")).join("|");
}

export function RouteView({ corridor, states, nowServer, from, to, request, selected, labelsAtRequest, onSelect, onMyLocation, onPickOnMap, onRecalculate }: Props) {
  const { t, lang } = useLang();
  const compass = useCompass();
  const junctionName = (id: string) => (corridor.junctions.find((j) => j.id === id)?.name ?? id).replace(/^Simpang\s+/i, "");

  if (!from || !to) {
    const missing = !from ? "from" : "to";
    return (
      <article className="route-card" aria-labelledby="card-title">
        <header className="card-head">
          <h2 className="card-title" id="card-title">
            {missing === "from" ? t("needFrom") : t("needTo")}
          </h2>
          <p className="card-sub">{missing === "from" ? t("needFromBody", { name: to?.name ?? "" }) : t("needToBody")}</p>
        </header>
        <section className="card-section actions">
          {missing === "from" && (
            <button type="button" className="btn btn-primary" onClick={onMyLocation}>
              <Crosshair size={18} weight="bold" aria-hidden="true" />
              {t("useMyLocation")}
            </button>
          )}
          <button type="button" className="btn" onClick={() => onPickOnMap(missing)}>
            <MapTrifold size={18} weight="bold" aria-hidden="true" />
            {t("pickOnMap")}
          </button>
        </section>
      </article>
    );
  }

  if (request.status === "loading" || request.status === "idle") {
    return (
      <article className="route-card" aria-labelledby="card-title" aria-busy="true">
        <header className="card-head">
          <h2 className="card-title" id="card-title">
            {t("routeSearching")}
          </h2>
          <p className="card-sub">{t("routeBetween", { from: from.name, to: to.name })}</p>
        </header>
        <ul className="route-options is-loading" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="route-option skeleton">
              <span className="route-letter" />
              <span className="route-main">
                <span className="sk sk-1" />
                <span className="sk sk-2" />
              </span>
            </li>
          ))}
        </ul>
      </article>
    );
  }

  if (request.status === "error") {
    return (
      <article className="route-card" aria-labelledby="card-title">
        <header className="card-head">
          <h2 className="card-title" id="card-title">
            {t("routeErrTitle")}
          </h2>
          <p className="card-sub">{t("routeBetween", { from: from.name, to: to.name })}</p>
        </header>
        <section className="card-section">
          <p className="route-error" role="alert">
            <Warning size={20} weight="bold" aria-hidden="true" />
            <span>{t(`routeErr_${request.code}` as StringKey, { msg: request.message })}</span>
          </p>
        </section>
        <section className="card-section actions">
          {(request.code === "network" || request.code === "other" || request.code === "no_route") && (
            <button type="button" className="btn btn-primary" onClick={onRecalculate}>
              <ArrowClockwise size={18} weight="bold" aria-hidden="true" />
              {t("retry")}
            </button>
          )}
          {(request.code === "far_from_road" || request.code === "no_route" || request.code === "same_place") && (
            // Re-pick the end that came from the map (most likely the one to move), else the destination.
            <button type="button" className="btn" onClick={() => onPickOnMap(from.kind === "map" && to.kind !== "map" ? "from" : "to")}>
              <MapTrifold size={18} weight="bold" aria-hidden="true" />
              {t("pickOnMap")}
            </button>
          )}
        </section>
      </article>
    );
  }

  const { routes } = request.result;
  const route = routes[Math.min(selected, routes.length - 1)];
  const changed = labelsKey(routes, states, nowServer) !== labelsAtRequest;

  // Why A is recommended: a padat/macet junction the other routes pass and A doesn't.
  const avoided = (() => {
    const own = new Set(routes[0].junctions.map((p) => p.id));
    const worst = new Map<string, TrafficLabel>();
    for (const r of routes.slice(1)) {
      for (const p of r.junctions) {
        const l = passedLabel(p, states, nowServer);
        if (!own.has(p.id) && (l === "macet" || l === "padat") && LABEL_RANK[l] > LABEL_RANK[worst.get(p.id) ?? "unknown"]) worst.set(p.id, l);
      }
    }
    if (!worst.size) return null;
    const label = [...worst.values()].includes("macet") ? "macet" : "padat";
    const names = [...worst.entries()].filter(([, l]) => l === label).map(([id]) => junctionName(id));
    return t("routeAvoids", { label: t(label).toLowerCase(), names: names.join(", ") });
  })();

  return (
    <article className="route-card" aria-labelledby="card-title">
      <header className="card-head">
        <h2 className="card-title" id="card-title">
          {routes.length === 1 ? t("routesTitleOne") : t("routesTitle", { n: routes.length })}
        </h2>
        <p className="card-sub">{t("routeBetween", { from: from.name, to: to.name })}</p>
      </header>

      {changed && (
        <section className="card-section route-changed" role="status">
          <p>{t("routeChanged")}</p>
          <button type="button" className="btn btn-sm" onClick={onRecalculate}>
            <ArrowClockwise size={16} weight="bold" aria-hidden="true" />
            {t("routeRecalc")}
          </button>
        </section>
      )}

      <ul className="route-options" role="radiogroup" aria-label={t("routeOptionsLabel")}>
        {routes.map((r, i) => {
          const letter = ROUTE_LETTERS[i];
          const via = r.via ? t("routeVia", { road: r.via }) : t("routeViaNone");
          const dist = formatDistance(r.distance_m, lang);
          const isSel = r === route;
          // One mark per junction, worst first, de-duplicated (a route can cross one twice).
          const seen = new Map<string, TrafficLabel>();
          for (const p of r.junctions) {
            const l = passedLabel(p, states, nowServer);
            if (LABEL_RANK[l] >= LABEL_RANK[seen.get(p.id) ?? "unknown"]) seen.set(p.id, l);
          }
          const all = [...seen.entries()].sort((a, b) => LABEL_RANK[b[1]] - LABEL_RANK[a[1]]);
          // Keep the row short: every junction that needs attention by name, the clear ones as a count.
          const marks = all.length <= 2 ? all : all.filter(([, l]) => l !== "lancar");
          const clear = all.length - marks.length;
          return (
            <li key={i}>
              <button
                type="button"
                role="radio"
                aria-checked={isSel}
                className={`route-option${isSel ? " is-selected" : ""}`}
                onClick={() => onSelect(i)}
                aria-label={t("routeOptionLabel", { letter, via, dist })}
              >
                <span className="route-letter" aria-hidden="true">
                  {letter}
                </span>
                <span className="route-main">
                  <span className="route-via">{via}</span>
                  {i === 0 && routes.length > 1 && (
                    <span className="route-rec">
                      <strong>{t("routeRecommended")}</strong>
                      {avoided ? ` · ${avoided}` : ""}
                    </span>
                  )}
                  <span className="route-junctions">
                    {all.length === 0 && <span className="route-none">{t("routeNoWatched")}</span>}
                    {marks.map(([id, l]) => (
                      <span key={id} className="route-j">
                        <StateMark label={l} size={14} />
                        <span>{junctionName(id)}</span>
                        <span className={`route-j-state is-${l}`}>{t(l)}</span>
                      </span>
                    ))}
                    {clear > 0 && (
                      <span className="route-j">
                        <StateMark label="lancar" size={14} />
                        <span>{marks.length ? t("routeMoreClear", { n: clear }) : t("routeAllClear", { n: clear })}</span>
                      </span>
                    )}
                  </span>
                </span>
                <span className="route-dist">{dist}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <section className="card-section route-detail" aria-label={t("routeDetailLabel", { letter: ROUTE_LETTERS[routes.indexOf(route)] })}>
        {route.junctions.length > 0 && (
          <>
            <h3 className="section-title">{t("routeWatchedTitle", { letter: ROUTE_LETTERS[routes.indexOf(route)] })}</h3>
            <ol className="route-steps">
              {route.junctions.map((p, k) => {
                const j = corridor.junctions.find((x) => x.id === p.id);
                const arm = j?.arms.find((a) => a.id === p.arm);
                const l = passedLabel(p, states, nowServer);
                return (
                  <li key={`${p.id}-${k}`} className="route-step">
                    <StateMark label={l} size={20} />
                    <span className="index-main">
                      <span className="index-name">{junctionName(p.id)}</span>
                      <span className="index-sub">{arm ? t("routeEnterFrom", { dir: compass(arm.bearing).word }) : (j?.roads.join(" × ") ?? "")}</span>
                    </span>
                    <span className={`index-state is-${l}`}>{t(l)}</span>
                  </li>
                );
              })}
            </ol>
          </>
        )}
        {route.roads.length > 0 && (
          <p className="route-roads">
            <span className="route-roads-label">{t("routeRoads")}</span> {route.roads.slice(0, 3).join(" · ")}
          </p>
        )}
        <div className="actions">
          <a
            className="btn btn-primary"
            href={googleMapsUrl(request.result.from.lnglat, request.result.to.lnglat, route)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ArrowSquareOut size={18} weight="bold" aria-hidden="true" />
            {t("openGoogle")}
          </a>
        </div>
      </section>

      <footer className="card-notes">
        <p>
          <Info size={14} weight="bold" aria-hidden="true" />
          <span>{t("routeNoTime")}</span>
        </p>
        <p>
          <Info size={14} weight="bold" aria-hidden="true" />
          <span>{t("routeCoverage", { n: corridor.junctions.length })}</span>
        </p>
      </footer>
    </article>
  );
}

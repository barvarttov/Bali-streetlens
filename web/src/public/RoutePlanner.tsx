import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowsDownUp, Crosshair, MapPin, MapTrifold, X } from "@phosphor-icons/react";
import { useLang } from "../i18n.tsx";
import type { StringKey } from "../i18n.tsx";
import { LABEL_RANK } from "../lib/liveSchema.ts";
import type { Corridor, JunctionState } from "../lib/liveSchema.ts";
import { StateMark } from "./parts.tsx";
import { loadPlaces, matchScore, normalize, searchPlaces } from "./places.ts";
import type { Place } from "./places.ts";
import type { Endpoint } from "./route.ts";

// The route planner's two fields, "Dari" and "Ke", in one ruled box that replaces the search bar.
// Each field is a combobox: empty, it offers "Lokasi saya" and "Pilih di peta" first, then the watched
// junctions; typing searches the same places as "Mau ke mana?".

export type Field = "from" | "to";

interface Props {
  corridor: Corridor;
  states: Map<string, JunctionState>;
  from: Endpoint | null;
  to: Endpoint | null;
  /** Field to focus when the planner opens (the one still missing). */
  focus: Field | null;
  onFocused: () => void;
  onChange: (field: Field, value: Endpoint) => void;
  onMyLocation: (field: Field) => void;
  onPickOnMap: (field: Field) => void;
  onSwap: () => void;
  onClose: () => void;
}

type Option =
  | { kind: "me" }
  | { kind: "map" }
  | { kind: "junction"; id: string; name: string; sub: string; c: [number, number] }
  | { kind: "place"; place: Place };

export function RoutePlanner({ corridor, states, from, to, focus, onFocused, onChange, onMyLocation, onPickOnMap, onSwap, onClose }: Props) {
  const { t } = useLang();
  const listId = useId();
  const [active, setActive] = useState<Field | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [places, setPlaces] = useState<Place[]>([]);
  const inputs = { from: useRef<HTMLInputElement>(null), to: useRef<HTMLInputElement>(null) };

  useEffect(() => {
    void loadPlaces().then(setPlaces);
  }, []);

  useEffect(() => {
    if (!focus) return;
    inputs[focus].current?.focus();
    onFocused();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const options = useMemo<Option[]>(() => {
    const q = normalize(query);
    const label = (id: string) => states.get(id)?.label ?? "unknown";
    const junctions: Option[] = corridor.junctions
      .map((j) => ({ j, s: q.length ? matchScore(q, `${j.name} ${j.roads.join(" ")}`) : 1 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || LABEL_RANK[label(b.j.id)] - LABEL_RANK[label(a.j.id)])
      .map(({ j }) => ({ kind: "junction", id: j.id, name: j.name, sub: j.roads.join(" × "), c: j.center }));
    if (q.length === 0) return [{ kind: "me" }, { kind: "map" }, ...junctions];
    return [...junctions, ...searchPlaces(places, query, 8).map((place) => ({ kind: "place" as const, place })), { kind: "map" }];
  }, [query, corridor, places, states]);

  const close = () => {
    setActive(null);
    setQuery("");
  };
  const choose = (field: Field, o: Option) => {
    close();
    inputs[field].current?.blur();
    if (o.kind === "me") onMyLocation(field);
    else if (o.kind === "map") onPickOnMap(field);
    else if (o.kind === "junction") onChange(field, { name: o.name, lnglat: o.c, kind: "junction" });
    else onChange(field, { name: o.place.n, lnglat: o.place.c, kind: "place" });
  };

  const placeSub = (p: Place) => {
    const kind = t(`kind_${p.k}` as StringKey);
    const parts = [p.n.toLowerCase().includes(kind.toLowerCase()) ? "" : kind, p.near ? t("near", { name: p.near }) : ""];
    return parts.filter(Boolean).join(" · ");
  };

  const field = (f: Field, value: Endpoint | null) => {
    const id = `${listId}-${f}`;
    const editing = active === f;
    return (
      <div className={`plan-field is-${f}${editing ? " is-editing" : ""}`}>
        <span className={`plan-mark mark-${f}`} aria-hidden="true" />
        <label htmlFor={id} className="plan-label">
          {f === "from" ? t("routeFromLabel") : t("routeToLabel")}
        </label>
        <input
          ref={inputs[f]}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={editing}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={editing && options[cursor] ? `${listId}-o${cursor}` : undefined}
          placeholder={f === "from" ? t("routeFromPlaceholder") : t("routeToPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          value={editing ? query : (value?.name ?? "")}
          onFocus={(e) => {
            setActive(f);
            setQuery("");
            setCursor(0);
            e.currentTarget.select();
          }}
          onBlur={() => window.setTimeout(() => setActive((a) => (a === f ? null : a)), 120)}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, options.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter" && options[cursor]) {
              e.preventDefault();
              choose(f, options[cursor]);
            } else if (e.key === "Escape") {
              close();
              e.currentTarget.blur();
            }
          }}
        />
      </div>
    );
  };

  const firstPlace = options.findIndex((o) => o.kind === "place");
  const firstJunction = options.findIndex((o) => o.kind === "junction");
  return (
    <div className={`planner${active ? " is-open" : ""}`} role="search" aria-label={t("routeTitle")}>
      <div className="plan-box">
        <div className="plan-fields">
          {field("from", from)}
          {field("to", to)}
        </div>
        <div className="plan-tools">
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("routeClose")}>
            <X size={20} weight="bold" aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" onClick={onSwap} aria-label={t("routeSwap")} disabled={!from && !to}>
            <ArrowsDownUp size={20} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </div>
      {active && (
        <ul id={listId} role="listbox" className="search-results plan-results" aria-label={active === "from" ? t("routeFromLabel") : t("routeToLabel")}>
          {options.map((o, i) => [
            i === firstJunction || i === firstPlace ? (
              <li key={`group-${o.kind}`} role="presentation" className="search-group">
                {o.kind === "junction" ? t("groupJunctions") : t("groupPlaces")}
              </li>
            ) : null,
            <li
              key={o.kind === "junction" ? o.id : o.kind === "place" ? `${o.place.n}-${o.place.c.join()}` : o.kind}
              id={`${listId}-o${i}`}
              role="option"
              aria-selected={i === cursor}
              className={`${i === cursor ? "is-active" : ""}${o.kind === "me" || o.kind === "map" ? " is-special" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(active, o)}
            >
              {o.kind === "me" ? (
                <>
                  <Crosshair size={20} weight="bold" className="result-pin is-ink" aria-hidden="true" />
                  <span className="result-main">
                    <span className="result-name">{t("myLocation")}</span>
                    <span className="result-sub">{t("myLocationSub")}</span>
                  </span>
                </>
              ) : o.kind === "map" ? (
                <>
                  <MapTrifold size={20} weight="bold" className="result-pin is-ink" aria-hidden="true" />
                  <span className="result-main">
                    <span className="result-name">{t("pickOnMap")}</span>
                    <span className="result-sub">{t("pickOnMapSub")}</span>
                  </span>
                </>
              ) : o.kind === "junction" ? (
                <>
                  <StateMark label={states.get(o.id)?.label ?? "unknown"} size={18} />
                  <span className="result-main">
                    <span className="result-name">{o.name}</span>
                    <span className="result-sub">{o.sub}</span>
                  </span>
                  <span className={`result-state is-${states.get(o.id)?.label ?? "unknown"}`}>{t(states.get(o.id)?.label ?? "unknown")}</span>
                </>
              ) : (
                <>
                  <MapPin size={20} weight="bold" className="result-pin" aria-hidden="true" />
                  <span className="result-main">
                    <span className="result-name">{o.place.n}</span>
                    <span className="result-sub">{placeSub(o.place)}</span>
                  </span>
                </>
              )}
            </li>,
          ])}
        </ul>
      )}
    </div>
  );
}

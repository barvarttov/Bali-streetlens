import { useEffect, useId, useMemo, useState } from "react";
import { MagnifyingGlass, MapPin, Signpost, VideoCamera, X } from "@phosphor-icons/react";
import { useLang } from "../i18n.tsx";
import type { StringKey } from "../i18n.tsx";
import { LABEL_RANK } from "../lib/liveSchema.ts";
import type { Camera, Corridor, JunctionState } from "../lib/liveSchema.ts";
import { StateMark } from "./parts.tsx";
import { loadPlaces, matchScore, normalize, searchPlaces } from "./places.ts";
import type { Place } from "./places.ts";

// "Mau ke mana?": one field for any place in Bali, the watched junctions and the provincial cameras that
// stream right now. Focusing it with nothing typed lists the watched junctions, worst first, then the live
// cameras, so each of them is reachable without the map.

interface Props {
  corridor: Corridor;
  states: Map<string, JunctionState>;
  /** Provincial cameras streaming right now (AGA can count them). */
  liveCameras: Camera[];
  onPickJunction: (id: string) => void;
  onPickCamera: (id: string) => void;
  onPickPlace: (place: Place) => void;
  /** Opens the route planner. */
  onRoute: () => void;
}

type Result =
  | { kind: "junction"; id: string; name: string; sub: string }
  | { kind: "camera"; id: string; name: string }
  | { kind: "place"; place: Place };

export function SearchBar({ corridor, states, liveCameras, onPickJunction, onPickCamera, onPickPlace, onRoute }: Props) {
  const { t, lang, setLang } = useLang();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [places, setPlaces] = useState<Place[]>([]);

  useEffect(() => {
    if (open && places.length === 0) void loadPlaces().then(setPlaces);
  }, [open, places.length]);

  const results = useMemo<Result[]>(() => {
    const q = normalize(query);
    const label = (id: string) => states.get(id)?.label ?? "unknown";
    const junctions: Result[] = corridor.junctions
      .map((j) => ({ j, s: q.length ? matchScore(q, `${j.name} ${j.roads.join(" ")}`) : 1 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || LABEL_RANK[label(b.j.id)] - LABEL_RANK[label(a.j.id)])
      .map(({ j }) => ({ kind: "junction", id: j.id, name: j.name, sub: j.roads.join(" × ") }));
    const cameras: Result[] = liveCameras
      .map((c) => ({ c, s: q.length ? matchScore(q, c.name) : 1 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name))
      .map(({ c }) => ({ kind: "camera", id: c.id, name: c.name }));
    if (q.length === 0) return [...junctions, ...cameras];
    return [...junctions, ...cameras, ...searchPlaces(places, query).map((place) => ({ kind: "place" as const, place }))];
  }, [query, corridor, places, states, liveCameras]);

  const choose = (r: Result) => {
    setOpen(false);
    setQuery("");
    (document.activeElement as HTMLElement | null)?.blur();
    if (r.kind === "junction") onPickJunction(r.id);
    else if (r.kind === "camera") onPickCamera(r.id);
    else onPickPlace(r.place);
  };

  const firstOfKind = (i: number) => i === 0 || results[i - 1].kind !== results[i].kind;
  const groupLabel = (kind: Result["kind"]) =>
    kind === "junction" ? t("groupJunctions") : kind === "camera" ? (lang === "id" ? "Kamera langsung" : "Live cameras") : t("groupPlaces");
  // "Pantai · dekat Kuta", without repeating a kind the name already says ("Pantai Kuta").
  const placeSub = (p: Place) => {
    const kind = t(`kind_${p.k}` as StringKey);
    const parts = [p.n.toLowerCase().includes(kind.toLowerCase()) ? "" : kind, p.near ? t("near", { name: p.near }) : ""];
    return parts.filter(Boolean).join(" · ");
  };
  return (
    <div className={`search${open ? " is-open" : ""}`}>
      <div className="search-field">
        <MagnifyingGlass size={22} weight="bold" aria-hidden="true" />
        <label htmlFor={`${listId}-input`} className="visually-hidden">
          {t("searchLabel")}
        </label>
        <input
          id={`${listId}-input`}
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
          placeholder={t("searchPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && results[active]) {
              e.preventDefault();
              choose(results[active]);
            } else if (e.key === "Escape") {
              setQuery("");
              setOpen(false);
            }
          }}
        />
        {query && (
          <button type="button" className="search-clear" onClick={() => setQuery("")} aria-label={t("clearSearch")}>
            <X size={18} weight="bold" aria-hidden="true" />
          </button>
        )}
        <button type="button" className="search-route" onClick={onRoute} aria-label={t("routeButtonLabel")} title={t("routeButtonLabel")}>
          <Signpost size={20} weight="bold" aria-hidden="true" />
          <span className="search-route-text">{t("routeButton")}</span>
        </button>
        <div className="lang-toggle" role="group" aria-label={t("langLabel")}>
          <button type="button" aria-pressed={lang === "id"} onClick={() => setLang("id")} lang="id">
            ID
          </button>
          <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")} lang="en">
            EN
          </button>
        </div>
      </div>
      {open && (
        <ul id={listId} role="listbox" className="search-results" aria-label={t("searchLabel")}>
          {results.length === 0 && (
            <li role="presentation" className="search-empty">
              {t("searchNoResult")}
            </li>
          )}
          {results.map((r, i) => [
            firstOfKind(i) ? (
              <li key={`group-${r.kind}`} role="presentation" className="search-group">
                {groupLabel(r.kind)}
              </li>
            ) : null,
            <li
              key={r.kind === "place" ? `${r.place.n}-${r.place.c.join()}` : `${r.kind}-${r.id}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "is-active" : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(r)}
            >
              {r.kind === "junction" ? (
                <>
                  <StateMark label={states.get(r.id)?.label ?? "unknown"} size={18} />
                  <span className="result-main">
                    <span className="result-name">{r.name}</span>
                    <span className="result-sub">{r.sub}</span>
                  </span>
                  <span className={`result-state is-${states.get(r.id)?.label ?? "unknown"}`}>{t(states.get(r.id)?.label ?? "unknown")}</span>
                </>
              ) : r.kind === "camera" ? (
                <>
                  <VideoCamera size={20} weight="bold" className="result-pin result-live" aria-hidden="true" />
                  <span className="result-main">
                    <span className="result-name">{r.name}</span>
                    <span className="result-sub">{lang === "id" ? "Kamera CCTV · langsung" : "CCTV camera · live"}</span>
                  </span>
                </>
              ) : (
                <>
                  <MapPin size={20} weight="bold" className="result-pin" aria-hidden="true" />
                  <span className="result-main">
                    <span className="result-name">{r.place.n}</span>
                    <span className="result-sub">{placeSub(r.place)}</span>
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

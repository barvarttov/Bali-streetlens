import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { Marker } from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import { useLang } from "../i18n.tsx";
import type { StringKey } from "../i18n.tsx";
import { matchPath, navigate, usePath } from "../router.ts";
import type { JunctionState, LngLat } from "../lib/liveSchema.ts";
import { useLive, useNow, useStaticData } from "./data.ts";
import { formatClock } from "./format.ts";
import { MapControls } from "./MapControls.tsx";
import { MapFrame, MapKey, ScaleBar } from "./MapFrame.tsx";
import { BALI_LAND, MapView, corridorBounds, corridorCenter, prefersReducedMotion } from "./MapView.tsx";
import type { Insets } from "./MapView.tsx";
import { distanceKm, loadPlaces } from "./places.ts";
import type { Place } from "./places.ts";
import { routeBounds, useRoutes } from "./route.ts";
import type { Endpoint } from "./route.ts";
import { ChatCircleText } from "@phosphor-icons/react";
import { ChatPanel } from "./ChatPanel.tsx";
import { RoutePlanner } from "./RoutePlanner.tsx";
import type { Field } from "./RoutePlanner.tsx";
import { RouteView, labelsKey } from "./RouteView.tsx";
import { SearchBar } from "./SearchBar.tsx";
import { Sheet, useIsDesktop } from "./Sheet.tsx";
import type { Detent } from "./Sheet.tsx";
import { AreaView, CameraInfo, HERE_KM, JunctionDetail, WhyView } from "./views.tsx";
import type { Area } from "./views.tsx";
import "./public.css";

const BALI = { west: 114.3, east: 115.95, south: -9.05, north: -7.9 };
/** Desktop card: left offset + width, and the frame's margin (keep in sync with public.css). */
const CARD_LEFT = 36;
const CARD_W = 400;
/** Desktop chat panel width (keep in sync with --chat-w in public.css). */
const CHAT_W = 380;

export function PublicApp() {
  const { t, lang } = useLang();
  const path = usePath();
  const desktop = useIsDesktop();
  const [attempt, setAttempt] = useState(0);
  const { data, error } = useStaticData(attempt);
  const live = useLive();
  const now = useNow();
  const nowServer = now + live.clockOffset;

  const [map, setMap] = useState<MlMap | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [detent, setDetent] = useState<Detent>("half");
  const [sheetInset, setSheetInset] = useState(0);
  const [allCameras, setAllCameras] = useState(false);
  const [mode3d, setMode3d] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [area, setArea] = useState<Area | null>(null);
  const userMarker = useRef<Marker | null>(null);

  // Route planner state. The ends survive leaving the planner (to look at a junction on the way),
  // so coming back shows the same routes.
  const routeMode = path === "/rute";
  const [routeFrom, setRouteFrom] = useState<Endpoint | null>(null);
  const [routeTo, setRouteTo] = useState<Endpoint | null>(null);
  const [routeAttempt, setRouteAttempt] = useState(0);
  const [selectedRoute, setSelectedRoute] = useState(0);
  const [planFocus, setPlanFocus] = useState<Field | null>(null);
  const [picking, setPicking] = useState<Field | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [labelsAtRequest, setLabelsAtRequest] = useState("");
  const cameFromRoute = useRef(false);
  const pinRef = useRef<HTMLDivElement>(null);
  const request = useRoutes(routeFrom, routeTo, routeAttempt);

  // The full-height sheet stops below the search bar; measure where it ends (phones).
  const topbarRef = useRef<HTMLDivElement>(null);
  const [topReserve, setTopReserve] = useState(88);
  useLayoutEffect(() => {
    const bottom = Math.round(topbarRef.current?.getBoundingClientRect().bottom ?? 88);
    if (bottom !== topReserve) setTopReserve(bottom);
  });

  const corridor = data?.corridor ?? null;
  const states = useMemo(() => new Map<string, JunctionState>((live.snapshot?.junctions ?? []).map((j) => [j.id, j])), [live.snapshot]);
  const corridorArea = useMemo<Area | null>(() => (corridor ? { name: t("corridorTitle"), center: corridorCenter(corridor) } : null), [corridor, t]);

  const whyMatch = matchPath("/simpang/:id/kenapa", path);
  const junctionMatch = matchPath("/simpang/:id", path) ?? whyMatch;
  const cameraMatch = matchPath("/kamera/:id", path);
  const junction = corridor?.junctions.find((j) => j.id === junctionMatch?.id) ?? null;
  const camera = data?.cameras.find((c) => c.id === cameraMatch?.id) ?? null;

  // Unknown junction or camera in the URL: back to the island rather than a blank card.
  useEffect(() => {
    if (!data) return;
    if ((junctionMatch && !junction) || (cameraMatch && !camera)) navigate("/", { replace: true });
  }, [data, junctionMatch, junction, cameraMatch, camera]);

  // A shared junction link opens inside the corridor, so "Kembali" lands on its list.
  useEffect(() => {
    if (junction && !area && corridorArea) setArea(corridorArea);
  }, [junction, area, corridorArea]);

  // Announce state changes of the selected junction only, as one sentence.
  const [announcement, setAnnouncement] = useState("");
  const lastLabel = useRef<{ id: string; label: string } | null>(null);
  const selectedState = junction ? states.get(junction.id) : undefined;
  useEffect(() => {
    if (!junction || !selectedState) return;
    const prev = lastLabel.current;
    if (prev && prev.id === junction.id && prev.label !== selectedState.label && selectedState.label !== "unknown") {
      setAnnouncement(t("announce", { name: junction.name, label: t(selectedState.label).toLowerCase() }));
    }
    lastLabel.current = { id: junction.id, label: selectedState.label };
  }, [junction, selectedState, t]);

  const synthetic = live.snapshot?.source === "synthetic";
  const hasCard = !!(corridor && (routeMode || junction || camera || area)) && !picking;

  // What the search bar, the card and the sheet cover, so flights land in the open part of the map.
  const insets: Insets = desktop
    ? { top: Math.max(110, topReserve + 16), bottom: 112, left: hasCard ? CARD_LEFT + CARD_W + 24 : 40, right: chatOpen ? 96 + CHAT_W + 12 : 96 }
    : { top: topReserve + 8, bottom: hasCard ? sheetInset + 16 : 24, left: 16, right: 72 };
  const duration = () => (prefersReducedMotion() ? 0 : 900);

  const showArea = (next: Area, fly: () => void) => {
    if (path !== "/") navigate("/");
    setArea(next);
    setDetent("half");
    fly();
  };
  const showCorridor = () => {
    if (!corridor || !corridorArea) return;
    showArea(corridorArea, () =>
      map?.fitBounds(corridorBounds(corridor), { padding: insetsFor(true), pitch: mode3d ? 45 : 0, bearing: 0, duration: duration() }),
    );
  };
  // Insets as they will be once the card is open (it opens in the same render as the flight).
  const insetsFor = (card: boolean): Insets =>
    desktop ? { ...insets, left: card ? CARD_LEFT + CARD_W + 24 : 40 } : { ...insets, bottom: card ? Math.round(window.innerHeight * 0.52) + 16 : 24 };

  const pickPlace = (place: Place) => {
    const sub = [t(`kind_${place.k}` as StringKey), place.near ? t("near", { name: place.near }) : ""].filter(Boolean).join(" · ");
    // When the card will list junctions near the place, frame the place and all of them together, so
    // every junction the card names is in the open map. Otherwise fly to the place itself.
    const listed = corridor?.junctions.filter((j) => distanceKm(place.c, j.center) <= HERE_KM) ?? [];
    showArea({ name: place.n, sub, center: place.c }, () => {
      if (!map) return;
      if (listed.length) {
        const pts = [place.c, ...listed.map((j) => j.center)];
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const pad = 0.004;
        map.fitBounds([[Math.min(...xs) - pad, Math.min(...ys) - pad], [Math.max(...xs) + pad, Math.max(...ys) + pad]], {
          padding: insetsFor(true),
          pitch: mode3d ? 40 : 0,
          bearing: 0,
          maxZoom: 16,
          duration: duration(),
        });
      } else {
        map.flyTo({ center: place.c, zoom: place.z, pitch: mode3d ? (place.z >= 14 ? 50 : 35) : 0, padding: insetsFor(true), duration: duration(), essential: true });
      }
    });
  };
  const select = (id: string) => {
    if (!area && corridorArea) setArea(corridorArea);
    cameFromRoute.current = routeMode;
    setDetent("half");
    navigate(`/simpang/${id}`);
  };
  const backToArea = () => {
    if (cameFromRoute.current) {
      cameFromRoute.current = false;
      navigate("/rute");
      return;
    }
    navigate("/");
    const a = area ?? corridorArea;
    if (!a || !corridor) return;
    setArea(a);
    if (a === corridorArea || a.name === corridorArea?.name) {
      map?.fitBounds(corridorBounds(corridor), { padding: insets, pitch: mode3d ? 45 : 0, duration: duration() });
    } else {
      map?.flyTo({ center: a.center, zoom: 14.5, pitch: mode3d ? 45 : 0, padding: insets, duration: duration() });
    }
  };
  const closeCard = () => {
    setArea(null);
    if (path !== "/") navigate("/");
    map?.fitBounds(BALI_LAND, { padding: { top: 100, bottom: 60, left: 40, right: 80 }, pitch: 0, bearing: 0, duration: duration() });
  };

  /** Asks for the device's position (only when the visitor taps), marks it, and hands it on. */
  const findMe = (then: (p: LngLat) => void) => {
    if (!navigator.geolocation) return setNotice(t("locateDenied"));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { longitude: lng, latitude: lat } = pos.coords;
        if (lng < BALI.west || lng > BALI.east || lat < BALI.south || lat > BALI.north) return setNotice(t("locateOutside"));
        if (map) {
          userMarker.current?.remove();
          const el = document.createElement("div");
          el.className = "user-dot";
          userMarker.current = new Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
        }
        then([lng, lat]);
      },
      () => setNotice(t("locateDenied")),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };
  const locate = () => findMe((p) => map?.flyTo({ center: p, zoom: 16, padding: insets, duration: duration() }));
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(id);
  }, [notice]);

  // ------------------------------------------------------------ route planner

  /** Opens the planner, optionally with the destination already set. */
  const startRoute = (to: Endpoint | null) => {
    if (to) setRouteTo(to);
    // Typing a destination needs the keyboard; a missing start is one tap on the card, so on a phone
    // the keyboard isn't forced open for it.
    const missing: Field | null = !to && !routeTo ? "to" : !routeFrom ? "from" : null;
    setPlanFocus(missing === "to" || (missing === "from" && desktop) ? missing : null);
    setDetent("half");
    cameFromRoute.current = false;
    navigate("/rute");
  };
  const closeRoute = () => {
    setPicking(null);
    navigate("/");
  };
  const setEnd = (field: Field, value: Endpoint) => (field === "from" ? setRouteFrom(value) : setRouteTo(value));
  const locateFor = (field: Field) => findMe((p) => setEnd(field, { name: t("myLocation"), lnglat: p, kind: "me" }));
  const swapEnds = () => {
    setRouteFrom(routeTo);
    setRouteTo(routeFrom);
  };
  const startPick = (field: Field) => {
    setPicking(field);
    // Start from the end already chosen, if any, so the pin only has to move a little.
    const near = (field === "from" ? routeFrom : routeTo) ?? (field === "from" ? routeTo : routeFrom);
    if (map && near && map.getZoom() < 14) map.flyTo({ center: near.lnglat, zoom: 15, pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: duration() });
    else map?.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 0 });
  };
  const confirmPick = async () => {
    const field = picking;
    const pin = pinRef.current;
    if (!field || !pin || !map) return;
    const canvas = map.getCanvas().getBoundingClientRect();
    const r = pin.getBoundingClientRect();
    const ll = map.unproject([r.left + r.width / 2 - canvas.left, r.bottom - canvas.top]);
    const p: LngLat = [ll.lng, ll.lat];
    setPicking(null);
    const places = await loadPlaces();
    const nearest = places.reduce<{ p: Place | null; km: number }>((best, pl) => {
      const km = distanceKm(p, pl.c);
      return km < best.km ? { p: pl, km } : best;
    }, { p: null, km: 2.5 });
    setEnd(field, { name: nearest.p ? t("pickedNear", { name: nearest.p.n }) : t("pickedPlain"), lnglat: p, kind: "map" });
  };

  // New routes: choose A, remember the junction states they were ranked with, frame them all.
  useEffect(() => {
    if (request.status !== "ok") return;
    setSelectedRoute(0);
    setLabelsAtRequest(labelsKey(request.result.routes, states, nowServer));
    setAnnouncement(t("routeFound", { n: request.result.routes.length }));
    // states and nowServer are read at the moment the routes arrive, on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  useEffect(() => {
    if (!routeMode || request.status !== "ok" || !map) return;
    const pad = insetsFor(true);
    map.fitBounds(routeBounds(request.result), {
      padding: { top: pad.top + 24, bottom: pad.bottom + 24, left: pad.left + 24, right: pad.right + 16 },
      pitch: 0,
      bearing: 0,
      maxZoom: 16.5,
      duration: duration(),
    });
    // only when new routes arrive or the planner reopens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, routeMode, map]);

  let content = null;
  if (corridor && routeMode) {
    content = (
      <RouteView
        corridor={corridor}
        states={states}
        nowServer={nowServer}
        from={routeFrom}
        to={routeTo}
        request={request}
        selected={selectedRoute}
        labelsAtRequest={labelsAtRequest}
        onSelect={setSelectedRoute}
        onMyLocation={() => locateFor("from")}
        onPickOnMap={startPick}
        onRecalculate={() => setRouteAttempt((a) => a + 1)}
      />
    );
  } else if (corridor && whyMatch && junction) {
    content = <WhyView junction={junction} state={states.get(junction.id)} synthetic={synthetic} onBack={() => navigate(`/simpang/${junction.id}`)} />;
  } else if (corridor && junction) {
    content = (
      <JunctionDetail
        junction={junction}
        state={states.get(junction.id)}
        nowServer={nowServer}
        synthetic={synthetic}
        onBack={backToArea}
        backLabel={cameFromRoute.current ? t("backToRoutes") : undefined}
        onWhy={() => navigate(`/simpang/${junction.id}/kenapa`)}
        onRoute={() => startRoute({ name: junction.name, lnglat: junction.center, kind: "junction" })}
      />
    );
  } else if (camera) {
    content = <CameraInfo camera={camera} onBack={() => (area ? navigate("/") : closeCard())} />;
  } else if (corridor && data && area) {
    content = (
      <AreaView
        area={area}
        corridor={corridor}
        cameras={data.cameras}
        states={states}
        nowServer={nowServer}
        synthetic={synthetic}
        lastUpdate={live.snapshot ? Date.parse(live.snapshot.generated_at) : null}
        showCameras={allCameras}
        onToggleCameras={() => setAllCameras((v) => !v)}
        onSelect={select}
        onClose={closeCard}
        onRoute={area === corridorArea ? undefined : () => startRoute({ name: area.name, lnglat: area.center, kind: "place" })}
      />
    );
  }

  const sheetCovers = !desktop && hasCard;
  const routeOnMap = routeMode && request.status === "ok" ? request.result : null;
  return (
    <div
      className={`public${hasCard ? " has-card" : ""}${routeMode ? " is-routing" : ""}${picking ? " is-picking" : ""}${chatOpen ? " has-chat" : ""}`}
      style={{ "--panel-top": `${topReserve + 8}px` } as React.CSSProperties}
    >
      {/* DOM order is the keyboard order: search, the card, map controls, then the map. */}
      <div className="topbar" ref={topbarRef}>
        {corridor && picking ? (
          <div className="pick-bar" role="status">
            <p>{t(`pickHint_${picking}`)}</p>
            <button type="button" className="text-btn" onClick={() => setPicking(null)}>
              {t("pickCancel")}
            </button>
          </div>
        ) : corridor && routeMode ? (
          <RoutePlanner
            corridor={corridor}
            states={states}
            from={routeFrom}
            to={routeTo}
            focus={planFocus}
            onFocused={() => setPlanFocus(null)}
            onChange={setEnd}
            onMyLocation={locateFor}
            onPickOnMap={startPick}
            onSwap={swapEnds}
            onClose={closeRoute}
          />
        ) : (
          corridor && <SearchBar corridor={corridor} states={states} onPickJunction={select} onPickPlace={pickPlace} onRoute={() => startRoute(null)} />
        )}
      </div>

      {hasCard && (
        <Sheet
          detent={detent}
          onDetent={setDetent}
          onVisibleHeight={setSheetInset}
          topReserve={topReserve}
          label={routeMode ? t("routeTitle") : (junction?.name ?? area?.name ?? "")}
        >
          {content}
        </Sheet>
      )}

      {chatOpen && corridor && (
        <ChatPanel
          corridor={corridor}
          states={states}
          synthetic={synthetic}
          fullScreen={!desktop}
          onClose={() => setChatOpen(false)}
          onOpenJunction={(id) => {
            if (!desktop) setChatOpen(false);
            select(id);
          }}
          onOpenRoute={(from, to) => {
            if (!desktop) setChatOpen(false);
            setRouteFrom(from);
            setRouteTo(to);
            setPlanFocus(null);
            setDetent("half");
            cameFromRoute.current = false;
            navigate("/rute");
          }}
        />
      )}

      <div className="frame-ui" hidden={(sheetCovers && detent === "full") || !!picking}>
        <div className="right-rail">
          <MapControls map={map} mode3d={mode3d} onToggle3d={() => setMode3d((v) => !v)} onLocate={locate} />
          {!chatOpen && corridor && (
            <button type="button" className="chat-open" onClick={() => setChatOpen(true)} aria-label={t("chatOpenLabel")} title={t("chatOpenLabel")}>
              <ChatCircleText size={20} weight="bold" aria-hidden="true" />
              <span>{t("chatOpen")}</span>
            </button>
          )}
        </div>
        <div className="map-foot" style={sheetCovers ? { bottom: sheetInset + 12 } : undefined}>
          <MapKey showCameras={allCameras} onToggleCameras={() => setAllCameras((v) => !v)} />
          <ScaleBar map={map} />
        </div>
      </div>

      <div className="map-area">
        {corridor && data && !mapError && (
          <MapView
            corridor={corridor}
            cameras={data.cameras}
            states={states}
            nowServer={nowServer}
            synthetic={synthetic}
            selectedId={junction?.id ?? null}
            showAllCameras={allCameras}
            mode3d={mode3d}
            insets={insets}
            onSelect={select}
            onSelectCorridor={showCorridor}
            onSelectCamera={(id) => {
              setDetent("half");
              navigate(`/kamera/${id}`);
            }}
            onMap={setMap}
            onError={setMapError}
            route={routeOnMap}
            selectedRoute={selectedRoute}
            onSelectRoute={setSelectedRoute}
          />
        )}
        <MapFrame map={map} />
        {picking && (
          <>
            <div className={`pick-pin is-${picking}`} ref={pinRef} aria-hidden="true">
              <span className="pick-head" />
              <span className="pick-stem" />
            </div>
            <button type="button" className="btn btn-primary pick-confirm" onClick={() => void confirmPick()}>
              {t("pickConfirm")}
            </button>
          </>
        )}
        {synthetic && !picking && (
          <p className="tag-synthetic" role="note">
            <span className="tag-long">{t("synthetic")}</span>
            <span className="tag-short" aria-hidden="true">
              {t("syntheticShort")}
            </span>
          </p>
        )}
        {(notice || (!live.connected && live.snapshot)) && (
          <p className="toast" role="status">
            {notice ?? t("connectionLost", { time: formatClock(live.snapshot!.generated_at, lang) })}
          </p>
        )}
        {!data && !error && <p className="map-message">{t("loading")}</p>}
        {(error || mapError) && (
          <div className="map-message">
            <p>{t("loadFailed", { reason: error ?? mapError ?? "" })}</p>
            {error && (
              <button type="button" className="btn" onClick={() => setAttempt((a) => a + 1)}>
                {t("retry")}
              </button>
            )}
          </div>
        )}
      </div>

      <p className="attribution">{t("mapAttribution")}</p>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import { Crosshair, Minus, Plus } from "@phosphor-icons/react";
import { useLang } from "../i18n.tsx";
import { COMPASS_LETTER, COMPASS_WORD, compassDirection } from "../lib/direction.ts";
import { prefersReducedMotion } from "./MapView.tsx";

// One ruled column of square controls, like the boxes in a sheet's margin: north, 3D/2D, my
// location, zoom. The north needle turns 1:1 with the map; tapping it faces north again.

interface Props {
  map: MlMap | null;
  mode3d: boolean;
  onToggle3d: () => void;
  onLocate: () => void;
}

export function MapControls({ map, mode3d, onToggle3d, onLocate }: Props) {
  const { t, lang } = useLang();
  const needle = useRef<SVGGElement>(null);
  const [facing, setFacing] = useState(0);

  useEffect(() => {
    if (!map) return;
    const update = () => {
      const b = map.getBearing();
      needle.current?.setAttribute("transform", `rotate(${-b} 22 24)`);
      const sector = Math.round(((b % 360) + 360) % 360 / 45) * 45;
      setFacing((prev) => (prev === sector ? prev : sector));
    };
    update();
    map.on("rotate", update);
    return () => {
      map.off("rotate", update);
    };
  }, [map]);

  const dir = compassDirection(facing);
  const ease = (opts: Parameters<MlMap["easeTo"]>[0]) => map?.easeTo({ ...opts, duration: prefersReducedMotion() ? 0 : 400 });
  return (
    <div className="map-controls" role="group">
      <button
        type="button"
        className="ctl ctl-north"
        onClick={() => ease({ bearing: 0 })}
        aria-label={t("compassLabel", { dir: COMPASS_WORD[lang][dir] })}
        disabled={!map}
      >
        <svg viewBox="0 0 44 48" width="44" height="48" aria-hidden="true" focusable="false">
          <g ref={needle}>
            <text x="22" y="10" textAnchor="middle" className="north-letter">
              {COMPASS_LETTER[lang].utara}
            </text>
            <path d="M22 13 L28 26 L22 23.5 L16 26 Z" className="needle-n" />
            <path d="M22 35 L28 26 L22 28.5 L16 26 Z" className="needle-s" />
          </g>
        </svg>
      </button>
      <button type="button" className="ctl ctl-text" aria-pressed={mode3d} onClick={onToggle3d} aria-label={mode3d ? t("toggle3d") : t("toggle2d")}>
        {mode3d ? "3D" : "2D"}
      </button>
      <button type="button" className="ctl" onClick={onLocate} aria-label={t("locate")}>
        <Crosshair size={22} weight="bold" aria-hidden="true" />
      </button>
      <button type="button" className="ctl ctl-zoom" onClick={() => map?.zoomIn({ duration: prefersReducedMotion() ? 0 : 250 })} aria-label={t("zoomIn")} disabled={!map}>
        <Plus size={20} weight="bold" aria-hidden="true" />
      </button>
      <button type="button" className="ctl ctl-zoom" onClick={() => map?.zoomOut({ duration: prefersReducedMotion() ? 0 : 250 })} aria-label={t("zoomOut")} disabled={!map}>
        <Minus size={20} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}

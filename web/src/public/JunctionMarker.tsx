import { useEffect, useRef, useState } from "react";
import { useLang } from "../i18n.tsx";
import { volumeStep } from "../lib/liveSchema.ts";
import type { Junction, JunctionState } from "../lib/liveSchema.ts";
import { freshnessText } from "./format.ts";
import { StateMark } from "./parts.tsx";

const SIZES = [22, 28, 34] as const;

interface Props {
  junction: Junction;
  state: JunctionState | undefined;
  nowServer: number;
  synthetic: boolean;
  selected: boolean;
  dimmed: boolean;
  onSelect: () => void;
}

/** A watched junction on the map: its printed state mark, sized by volume, with its name lettered beside it. */
export function JunctionMarker({ junction, state, nowServer, synthetic, selected, dimmed, onSelect }: Props) {
  const { t, lang } = useLang();
  const label = state?.label ?? "unknown";
  const size = SIZES[volumeStep(state?.volume_per_min ?? null)];

  // One ring pulse when the state changes (never looping; CSS turns it off for reduced motion).
  const previous = useRef(label);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (previous.current !== label && previous.current !== "unknown") setPulse((n) => n + 1);
    previous.current = label;
  }, [label]);

  const shortName = junction.name.replace(/^Simpang\s+/i, "");
  const fresh = state ? freshnessText(state, nowServer, t, lang, synthetic) : "";
  return (
    <button
      type="button"
      data-junction={junction.id}
      data-label={label}
      className={`junction-marker is-${label}${selected ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}`}
      onClick={onSelect}
      aria-label={t("markerLabel", { name: junction.name, label: t(label), fresh })}
      aria-pressed={selected}
    >
      <span className="marker-shape" style={{ width: size, height: size }}>
        <StateMark label={label} size={size} selected={selected} />
        {pulse > 0 && <span key={pulse} className="marker-pulse" aria-hidden="true" />}
      </span>
      <span className="marker-name" aria-hidden="true">
        {shortName}
      </span>
    </button>
  );
}

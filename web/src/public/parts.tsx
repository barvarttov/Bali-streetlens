// Small shared pieces of the public app. State is always mark + word + colour, printed like a map
// legend: ring = lancar, half = padat, full = macet, dashed ring = no data.

import { useLang } from "../i18n.tsx";
import { COMPASS_LETTER, COMPASS_WORD, compassDirection } from "../lib/direction.ts";
import type { TrafficLabel } from "../lib/liveSchema.ts";

export function StateMark({ label, size = 18, selected = false }: { label: TrafficLabel; size?: number; selected?: boolean }) {
  // Drawn on a 24-unit grid; the selected keyline sits outside it.
  return (
    <svg className={`state-mark is-${label}`} width={size} height={size} viewBox="-4 -4 32 32" aria-hidden="true" focusable="false">
      {selected && <circle cx="12" cy="12" r="15" className="keyline" />}
      <circle cx="12" cy="12" r="10" className="body" />
      {label === "padat" && <path d="M12 2 A10 10 0 0 0 12 22 Z" className="half" />}
    </svg>
  );
}

/** The state as a printed word in its colour, with its mark. */
export function StateWord({ label, size = "md" }: { label: TrafficLabel; size?: "sm" | "md" | "lg" }) {
  const { t } = useLang();
  const markSize = size === "lg" ? 30 : size === "md" ? 16 : 12;
  return (
    <span className={`state-word is-${label} size-${size}`}>
      <StateMark label={label} size={markSize} />
      <span>{t(label)}</span>
    </span>
  );
}

/** Where traffic on an arm comes from, from the arm's bearing: word ("selatan") and letter ("S"). */
export function useCompass(): (bearing: number) => { word: string; letter: string } {
  const { lang } = useLang();
  return (bearing) => {
    const c = compassDirection(bearing);
    return { word: COMPASS_WORD[lang][c], letter: COMPASS_LETTER[lang][c] };
  };
}

/** The compass letter in a ruled square, like a sheet's direction index. */
export function DirLetter({ letter }: { letter: string }) {
  return (
    <span className="dir-letter" aria-hidden="true">
      {letter}
    </span>
  );
}

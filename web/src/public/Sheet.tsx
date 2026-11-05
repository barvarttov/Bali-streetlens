import { useEffect, useRef, useState } from "react";
import type { PointerEvent as RPointerEvent, ReactNode } from "react";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { useLang } from "../i18n.tsx";

// Phone: a bottom sheet with three detents that follows the finger and springs to the nearest one.
// Desktop (>= 1024px): the same content in a fixed 400px left panel.
// The expand/collapse button is the non-drag alternative for keyboard and switch users.

export type Detent = "peek" | "half" | "full";
const ORDER: Detent[] = ["peek", "half", "full"];
const PEEK_PX = 248;

export function useIsDesktop(): boolean {
  const query = "(min-width: 1024px)";
  const [desktop, setDesktop] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

function useViewportHeight(): number {
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return h;
}

interface Props {
  detent: Detent;
  onDetent: (detent: Detent) => void;
  /** Visible height in px (phone), so the map can keep its focus above the sheet. */
  onVisibleHeight: (px: number) => void;
  /** Pixels at the top that stay uncovered at full height (the search bar and chips). */
  topReserve: number;
  label: string;
  children: ReactNode;
}

export function Sheet({ detent, onDetent, onVisibleHeight, topReserve, label, children }: Props) {
  const { t } = useLang();
  const desktop = useIsDesktop();
  const vh = useViewportHeight();
  const half = Math.round(vh * 0.52);
  const heights: Record<Detent, number> = {
    peek: Math.min(PEEK_PX, vh * 0.42),
    half,
    full: Math.max(half + 48, vh - topReserve - 8),
  };
  const full = heights.full;
  const [drag, setDrag] = useState<number | null>(null); // visible height while dragging
  const start = useRef<{ y: number; h: number; t: number } | null>(null);

  const visible = desktop ? 0 : (drag ?? heights[detent]);
  useEffect(() => {
    if (drag === null) onVisibleHeight(desktop ? 0 : heights[detent]);
    // heights derive from vh and detent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detent, vh, desktop, drag === null]);

  const onPointerDown = (e: RPointerEvent) => {
    // The toggle button handles its own click; capturing its pointer would swallow that click.
    if (desktop || (e.target as HTMLElement).closest("button")) return;
    start.current = { y: e.clientY, h: heights[detent], t: performance.now() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: RPointerEvent) => {
    if (!start.current) return;
    const h = Math.min(full, Math.max(heights.peek * 0.6, start.current.h + (start.current.y - e.clientY)));
    if (Math.abs(h - start.current.h) > 4) setDrag(h);
  };
  const onPointerUp = (e: RPointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || drag === null) {
      setDrag(null);
      return;
    }
    const velocity = (s.y - e.clientY) / Math.max(1, performance.now() - s.t); // px/ms, + = upwards
    const projected = drag + velocity * 180;
    const next = ORDER.reduce((best, d) => (Math.abs(heights[d] - projected) < Math.abs(heights[best] - projected) ? d : best), "peek" as Detent);
    setDrag(null);
    onDetent(next);
  };

  const canExpand = detent !== "full";
  return (
    <section
      className={`sheet${desktop ? " is-panel" : ""}${drag !== null ? " is-dragging" : ""} detent-${detent}`}
      aria-label={label}
      style={desktop ? undefined : { height: full, transform: `translateY(${full - visible}px)` }}
    >
      {!desktop && (
        <div className="sheet-grip" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <span className="grip-bar" aria-hidden="true" />
          <button
            type="button"
            className="sheet-toggle"
            onClick={() => onDetent(canExpand ? ORDER[ORDER.indexOf(detent) + 1] : "peek")}
            aria-label={canExpand ? t("expandSheet") : t("collapseSheet")}
          >
            {canExpand ? <CaretUp size={18} weight="bold" aria-hidden="true" /> : <CaretDown size={18} weight="bold" aria-hidden="true" />}
          </button>
        </div>
      )}
      <div className="sheet-body" style={desktop ? undefined : { maxHeight: Math.max(0, visible - 36) }}>
        {children}
      </div>
    </section>
  );
}

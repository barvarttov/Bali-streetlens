import { useEffect } from "react";
import { clock } from "../lib/clock.ts";

/** Space = play/pause, ←/→ = one frame, Shift+←/→ = one second. Ignored while typing in a field. */
export function useTransportKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
      const fps = clock.framesPerSecond;
      if (e.key === " " && tag !== "BUTTON") {
        e.preventDefault();
        clock.toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        clock.step(e.shiftKey ? -fps : -1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        clock.step(e.shiftKey ? fps : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

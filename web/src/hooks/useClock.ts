import { useSyncExternalStore } from "react";
import { clock } from "../lib/clock.ts";
import type { ClockSnapshot } from "../lib/clock.ts";

/** Re-renders the component whenever the frame on screen (or play state) changes. */
export function useClock(): ClockSnapshot {
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot);
}

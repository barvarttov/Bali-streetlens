// Corridor geometry, the camera list and the live junction state, as React hooks.

import { useEffect, useState } from "react";
import type { Camera, Corridor, LiveSnapshot } from "../lib/liveSchema.ts";

export interface StaticData {
  corridor: Corridor;
  cameras: Camera[];
}

export function useStaticData(attempt: number): { data: StaticData | null; error: string | null } {
  const [state, setState] = useState<{ data: StaticData | null; error: string | null }>({ data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchJson<Corridor>("/api/corridor"), fetchJson<{ cameras: Camera[] }>("/api/cameras")])
      .then(([corridor, cams]) => !cancelled && setState({ data: { corridor, cameras: cams.cameras }, error: null }))
      .catch((err: Error) => !cancelled && setState({ data: null, error: err.message }));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return state;
}

export interface LiveState {
  snapshot: LiveSnapshot | null;
  /** serverTime - clientTime in ms, so ages are right even when the phone clock is off. */
  clockOffset: number;
  connected: boolean;
  /** Client time (ms) the last snapshot arrived. */
  receivedAt: number;
}

export function useLive(): LiveState {
  const [state, setState] = useState<LiveState>({ snapshot: null, clockOffset: 0, connected: true, receivedAt: 0 });

  useEffect(() => {
    let closed = false;
    const accept = (snapshot: LiveSnapshot) => {
      if (closed) return;
      const now = Date.now();
      setState({ snapshot, clockOffset: Date.parse(snapshot.generated_at) - now, connected: true, receivedAt: now });
    };

    fetchJson<LiveSnapshot>("/api/live/snapshot").then(accept).catch(() => undefined);
    const source = new EventSource("/api/live/stream");
    source.onmessage = (event) => accept(JSON.parse(event.data) as LiveSnapshot);
    // EventSource reconnects by itself; meanwhile the UI keeps the last data and says it's stale.
    source.onerror = () => !closed && setState((s) => ({ ...s, connected: false }));
    return () => {
      closed = true;
      source.close();
    };
  }, []);

  return state;
}

/** Re-renders once per second, for "3 dtk lalu" style text. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

async function fetchJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(`no connection to ${url}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? "";
    } catch {
      /* not JSON */
    }
    throw new Error(detail || `${url} answered HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

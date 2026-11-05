import { useState } from "react";
import { useClock } from "../hooks/useClock.ts";
import { clock } from "../lib/clock.ts";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

export function Timeline({ disabled }: { disabled: boolean }) {
  const { frame, t, playing, ready } = useClock();
  const lastFrame = clock.totalFrames - 1;
  const fps = clock.framesPerSecond;
  // While dragging, show where the thumb is rather than the (slightly delayed) frame on screen.
  const [dragFrame, setDragFrame] = useState<number | null>(null);
  const off = disabled || !ready;

  return (
    <div className="timeline">
      <div className="transport">
        <button type="button" onClick={() => clock.step(-fps)} disabled={off} title="Mundur 1 dtk (Shift+←)">
          −1 dtk
        </button>
        <button type="button" onClick={() => clock.step(-1)} disabled={off} title="Frame sebelumnya (←)">
          −1 f
        </button>
        <button type="button" className="play" onClick={() => clock.toggle()} disabled={off} title="Putar / jeda (Spasi)">
          {playing ? "Jeda" : "Putar"}
        </button>
        <button type="button" onClick={() => clock.step(1)} disabled={off} title="Frame berikutnya (→)">
          +1 f
        </button>
        <button type="button" onClick={() => clock.step(fps)} disabled={off} title="Maju 1 dtk (Shift+→)">
          +1 dtk
        </button>
      </div>
      <input
        className="scrubber"
        type="range"
        min={0}
        max={Math.max(lastFrame, 0)}
        step={1}
        value={dragFrame ?? frame}
        disabled={off}
        aria-label="Posisi video"
        onChange={(e) => {
          const target = Number(e.target.value);
          setDragFrame(target);
          clock.seekToFrame(target);
        }}
        onPointerUp={() => setDragFrame(null)}
        onKeyUp={() => setDragFrame(null)}
        onBlur={() => setDragFrame(null)}
      />
      <div className="readout mono" aria-live="off">
        <span>{formatTime(t)}</span>
        <span className="muted">
          frame {frame} / {lastFrame}
        </span>
      </div>
    </div>
  );
}

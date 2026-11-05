import { useEffect, useRef, useState } from "react";
import { clock } from "../lib/clock.ts";
import type { ObservationIndex } from "../lib/observations.ts";
import type { CameraConfig } from "../lib/schema.ts";
import { drawOverlay } from "./overlay.ts";

interface Props {
  videoUrl: string;
  index: ObservationIndex;
  config: CameraConfig | null;
  showBoxes: boolean;
  showGeometry: boolean;
  onVideoError: (message: string) => void;
}

const MEDIA_ERRORS: Record<number, string> = {
  1: "playback was aborted",
  2: "a network error interrupted the download",
  3: "the file could not be decoded",
  4: "the format is not supported or the file was not found",
};

/** The video is the master clock; the canvas on top draws boxes and geometry for the frame on screen. */
export function VideoPane({ videoUrl, index, config, showBoxes, showGeometry, onVideoError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sizeWarning, setSizeWarning] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    clock.attach(video, index.data.fps, index.frameCount);
    return () => clock.detach();
  }, [index, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const draw = () =>
      drawOverlay(canvas, video, index, config, clock.getSnapshot().frame, { showBoxes, showGeometry });
    const unsubscribe = clock.subscribe(draw);
    const resize = new ResizeObserver(draw);
    resize.observe(canvas);
    video.addEventListener("loadedmetadata", draw);
    draw();
    return () => {
      unsubscribe();
      resize.disconnect();
      video.removeEventListener("loadedmetadata", draw);
    };
  }, [index, config, showBoxes, showGeometry]);

  const checkSize = () => {
    const video = videoRef.current;
    if (!video) return;
    const [fw, fh] = index.data.frame_size;
    const mismatch = video.videoWidth !== fw || video.videoHeight !== fh;
    setSizeWarning(
      mismatch
        ? `Video is ${video.videoWidth}×${video.videoHeight} but the analysis says ${fw}×${fh}. ` +
            "Boxes may be misaligned: analyze and play the same normalized file."
        : null,
    );
  };

  const reportError = () => {
    const code = videoRef.current?.error?.code ?? 0;
    onVideoError(`Video failed to load: ${MEDIA_ERRORS[code] ?? "unknown error"}.`);
  };

  return (
    <div className="video-pane">
      <video
        ref={videoRef}
        src={videoUrl}
        muted
        playsInline
        preload="auto"
        onLoadedMetadata={checkSize}
        onError={reportError}
      />
      <canvas ref={canvasRef} className="video-overlay" aria-hidden="true" />
      {sizeWarning && <div className="pane-warning">{sizeWarning}</div>}
    </div>
  );
}

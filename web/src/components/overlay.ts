// Draws boxes and camera geometry on the canvas that sits over the <video> (team tools only).
// All inputs are in the video's pixel space (frame_size); this maps them into the letterboxed
// rectangle where the browser actually shows the video (object-fit: contain).
// Palette rule: red and yellow mean traffic state, so the overlay uses lime-white strokes on a
// black casing, which reads on any video, and tells classes apart by letter.

import type { ObservationIndex } from "../lib/observations.ts";
import type { CameraConfig, Px, VehicleClass } from "../lib/schema.ts";
import { PALETTE } from "../lib/palette.ts";

export const CLASS_LETTER: Record<VehicleClass, string> = { motorcycle: "M", car: "C", bus: "B", truck: "T" };

const KAPUR = PALETTE.kapur;
const IJUK = PALETTE.ijuk;

export interface OverlayOptions {
  showBoxes: boolean;
  showGeometry: boolean;
}

export function drawOverlay(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  index: ObservationIndex,
  config: CameraConfig | null,
  frame: number,
  options: OverlayOptions,
): void {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  const [fw, fh] = index.data.frame_size;
  const vw = video.videoWidth || fw;
  const vh = video.videoHeight || fh;
  const scale = Math.min(cw / vw, ch / vh);
  const ox = (cw - vw * scale) / 2;
  const oy = (ch - vh * scale) / 2;
  const sx = (vw * scale) / fw;
  const sy = (vh * scale) / fh;
  const P = (p: Px): Px => [ox + p[0] * sx, oy + p[1] * sy];

  if (options.showGeometry && config) drawGeometry(ctx, config, P);
  if (options.showBoxes) drawBoxes(ctx, index, frame, P);
}

/** A path stroked twice: black casing, lime-white core. */
function cased(ctx: CanvasRenderingContext2D, core: number, dash: number[] = []): void {
  ctx.setLineDash(dash);
  ctx.strokeStyle = IJUK;
  ctx.lineWidth = core + 2.5;
  ctx.stroke();
  ctx.strokeStyle = KAPUR;
  ctx.lineWidth = core;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawGeometry(ctx: CanvasRenderingContext2D, config: CameraConfig, P: (p: Px) => Px): void {
  ctx.lineJoin = "round";
  if (config.road_polygon_px.length > 2) {
    tracePolygon(ctx, config.road_polygon_px.map(P));
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(247,247,244,0.55)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const region of config.queue_regions) {
    if (region.polygon_px.length < 3) continue;
    const pts = region.polygon_px.map(P);
    tracePolygon(ctx, pts);
    ctx.fillStyle = "rgba(247,247,244,0.12)";
    ctx.fill();
    cased(ctx, 1.5, [8, 5]);
    label(ctx, region.id, pts[0][0] + 4, pts[0][1] + 16);
  }

  for (const line of config.count_lines) {
    const [a, b] = line.px.map(P);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    cased(ctx, 3);

    // Arrow showing the "in" direction: the left side of p1 -> p2 as seen on screen (y down).
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const [nx, ny] = [dy / len, -dx / len];
    const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const tip: Px = [mx + nx * 26, my + ny * 26];
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(tip[0], tip[1]);
    ctx.lineTo(tip[0] - nx * 8 + ny * 6, tip[1] - ny * 8 - nx * 6);
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(tip[0] - nx * 8 - ny * 6, tip[1] - ny * 8 + nx * 6);
    cased(ctx, 2);
    label(ctx, `${line.id} (masuk)`, tip[0] + 6, tip[1] + 4);
  }
}

function drawBoxes(ctx: CanvasRenderingContext2D, index: ObservationIndex, frame: number, P: (p: Px) => Px): void {
  for (const obj of index.byFrame[frame] ?? []) {
    const [x1, y1] = P([obj.bbox_px[0], obj.bbox_px[1]]);
    const [x2, y2] = P([obj.bbox_px[2], obj.bbox_px[3]]);
    ctx.beginPath();
    ctx.rect(x1, y1, x2 - x1, y2 - y1);
    cased(ctx, 1.5);
    const [gx, gy] = P(obj.ground_px);
    ctx.beginPath();
    ctx.arc(gx, gy, 3, 0, Math.PI * 2);
    ctx.fillStyle = KAPUR;
    ctx.fill();
    ctx.strokeStyle = IJUK;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    label(ctx, `${CLASS_LETTER[obj.cls]}${obj.track_id}`, x1, y1 - 3);
  }
}

function tracePolygon(ctx: CanvasRenderingContext2D, pts: Px[]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.font = "800 11px 'Archivo Variable', system-ui, sans-serif";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = IJUK;
  ctx.fillRect(x - 2, y - 11, w + 5, 14);
  ctx.fillStyle = KAPUR;
  ctx.fillText(text, x, y);
}

// Canvas drawing for the calibration tool (/tim/kalibrasi). Everything arrives in image pixels and
// is mapped through the view (zoom + pan). Marks follow the team overlay: white strokes on a dark
// casing so they read on any camera picture; the olive ink fills the fit points (your picks);
// traffic colours never appear, because here nothing is a traffic state.

import { COLORS } from "../lib/palette.ts";
import { imageToWorld, worldToImage } from "../lib/homography.ts";
import type { Calibration } from "../lib/homography.ts";
import type { CountLine, Meters, Px, QueueRegion } from "../lib/schema.ts";

export interface View {
  scale: number;
  ox: number;
  oy: number;
}

export const toScreen = (v: View, [x, y]: readonly [number, number]): [number, number] => [v.ox + x * v.scale, v.oy + y * v.scale];
export const toImage = (v: View, [x, y]: readonly [number, number]): Px => [(x - v.ox) / v.scale, (y - v.oy) / v.scale];

export interface DrawPoint {
  id: number;
  kind: "fit" | "holdout";
  label: string;
  px: Px;
  /** Where the fitted homography puts this point's measured world position, in image pixels. */
  reprojected: Px | null;
  /** Error in meters, null while the point has no coordinate or there is no fit. */
  error: number | null;
}

export type Selection =
  | { kind: "point"; id: number }
  | { kind: "road"; index: number }
  | { kind: "line"; line: number; end: 0 | 1 }
  | { kind: "queue"; queue: number; index: number };

export interface Scene {
  image: CanvasImageSource | null;
  imageSize: [number, number] | null;
  view: View;
  calibration: Calibration | null;
  showGrid: boolean;
  points: DrawPoint[];
  road: Px[];
  lines: CountLine[];
  queues: QueueRegion[];
  pending: Px[];
  pendingKind: "line" | "queue" | null;
  hover: Px | null;
  selected: Selection | null;
  targetM: number;
}

const WHITE: string = COLORS.paper;
const CASE: string = "rgba(5, 9, 12, 0.72)";
const INK = COLORS.accent;
const FONT = '"Archivo Variable", Archivo, system-ui, sans-serif';

export function drawScene(canvas: HTMLCanvasElement, s: Scene): void {
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
  ctx.fillStyle = "#05090c";
  ctx.fillRect(0, 0, cw, ch);
  if (!s.image || !s.imageSize) return;

  const v = s.view;
  ctx.imageSmoothingEnabled = v.scale < 2; // past 2x, show real pixels: you are aiming at them
  ctx.drawImage(s.image, v.ox, v.oy, s.imageSize[0] * v.scale, s.imageSize[1] * v.scale);

  if (s.calibration && s.showGrid) drawGrid(ctx, s);
  drawRoad(ctx, s);
  s.queues.forEach((q, i) => drawQueue(ctx, s, q, i));
  s.lines.forEach((l, i) => drawLine(ctx, s, l, i));
  drawPending(ctx, s);
  for (const p of s.points) drawPoint(ctx, s, p);
  if (s.hover) drawCrosshair(ctx, s, s.hover);
}

function cased(ctx: CanvasRenderingContext2D, path: () => void, width: number, color = WHITE, dash: number[] = []) {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.setLineDash([]);
  ctx.strokeStyle = CASE;
  ctx.lineWidth = width + 2.5;
  ctx.beginPath();
  path();
  ctx.stroke();
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  path();
  ctx.stroke();
  ctx.setLineDash([]);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill = WHITE, bg = CASE) {
  ctx.font = `700 12px ${FONT}`;
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = bg;
  ctx.fillRect(x, y - 9, w, 18);
  ctx.fillStyle = fill;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 5, y + 0.5);
}

/** 1, 2, 5, 10 ... meters so the grid keeps about a dozen lines across the calibrated area. */
export function gridStep(cal: Calibration): number {
  const b = cal.bounds;
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
  const raw = span / 10;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
}

/** The road plane's metric grid, projected back onto the picture: straight, even squares mean a good fit. */
function drawGrid(ctx: CanvasRenderingContext2D, s: Scene) {
  const cal = s.calibration!;
  const step = gridStep(cal);
  const margin = step * 2;
  const b = cal.bounds;
  const x0 = Math.floor((b.minX - margin) / step) * step;
  const x1 = Math.ceil((b.maxX + margin) / step) * step;
  const y0 = Math.floor((b.minY - margin) / step) * step;
  const y1 = Math.ceil((b.maxY + margin) / step) * step;
  const toPx = (m: Meters): [number, number] | null => {
    const p = worldToImage(cal, m);
    if (!p || !imageToWorld(cal, p)) return null; // behind the horizon
    return toScreen(s.view, p);
  };
  const polyline = (from: Meters, to: Meters) => {
    const n = 24;
    let started = false;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = toPx([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
      if (!p) {
        started = false;
        continue;
      }
      if (started) ctx.lineTo(p[0], p[1]);
      else ctx.moveTo(p[0], p[1]);
      started = true;
    }
  };

  ctx.globalAlpha = 0.6;
  for (let x = x0; x <= x1 + 1e-9; x += step) cased(ctx, () => polyline([x, y0], [x, y1]), 0.75);
  for (let y = y0; y <= y1 + 1e-9; y += step) cased(ctx, () => polyline([x0, y], [x1, y]), 0.75);
  ctx.globalAlpha = 1;

  // The origin and the two axes, so "X east, Y north" is visible on the picture itself.
  const o = toPx([0, 0]);
  const ex = toPx([step, 0]);
  const ny = toPx([0, step]);
  if (o && ex && ny) {
    cased(ctx, () => {
      ctx.moveTo(o[0], o[1]);
      ctx.lineTo(ex[0], ex[1]);
      ctx.moveTo(o[0], o[1]);
      ctx.lineTo(ny[0], ny[1]);
    }, 2.5);
    label(ctx, "X timur", ex[0] + 6, ex[1]);
    label(ctx, "Y utara", ny[0] + 6, ny[1]);
    label(ctx, "0, 0", o[0] + 6, o[1] + 14);
  }
  const tag = `grid ${String(step).replace(".", ",")} m`;
  label(ctx, tag, 12, ctx.canvas.clientHeight - 20);
}

function polygonPath(ctx: CanvasRenderingContext2D, v: View, pts: readonly Px[], close: boolean) {
  pts.forEach((p, i) => {
    const [x, y] = toScreen(v, p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  if (close) ctx.closePath();
}

function handle(ctx: CanvasRenderingContext2D, x: number, y: number, active: boolean) {
  const r = active ? 6 : 4;
  ctx.fillStyle = CASE;
  ctx.fillRect(x - r - 1.5, y - r - 1.5, 2 * r + 3, 2 * r + 3);
  ctx.fillStyle = active ? INK : WHITE;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}

function drawRoad(ctx: CanvasRenderingContext2D, s: Scene) {
  if (s.road.length === 0) return;
  if (s.road.length >= 3) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.10)";
    ctx.beginPath();
    polygonPath(ctx, s.view, s.road, true);
    ctx.fill();
  }
  cased(ctx, () => polygonPath(ctx, s.view, s.road, s.road.length >= 3), 1.5);
  s.road.forEach((p, i) => {
    const [x, y] = toScreen(s.view, p);
    handle(ctx, x, y, s.selected?.kind === "road" && s.selected.index === i);
  });
  const top = s.road.reduce((a, p) => (p[1] < a[1] ? p : a));
  const [lx, ly] = toScreen(s.view, top);
  label(ctx, "jalan", lx + 8, ly - 14);
}

function drawQueue(ctx: CanvasRenderingContext2D, s: Scene, q: QueueRegion, qi: number) {
  if (q.polygon_px.length < 2) return;
  ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
  ctx.beginPath();
  polygonPath(ctx, s.view, q.polygon_px, true);
  ctx.fill();
  cased(ctx, () => polygonPath(ctx, s.view, q.polygon_px, true), 1.5, WHITE, [6, 5]);
  q.polygon_px.forEach((p, i) => {
    const [x, y] = toScreen(s.view, p);
    handle(ctx, x, y, s.selected?.kind === "queue" && s.selected.queue === qi && s.selected.index === i);
  });
  const c = q.polygon_px.reduce((a, p) => [a[0] + p[0] / q.polygon_px.length, a[1] + p[1] / q.polygon_px.length], [0, 0]);
  const [x, y] = toScreen(s.view, c as Px);
  label(ctx, q.id, x - 30, y);
}

/** A directed count line: arrow at p2, and a short tick on the "in" side (left of the arrow on screen). */
function drawLine(ctx: CanvasRenderingContext2D, s: Scene, l: CountLine, li: number) {
  const [a, b] = l.px.map((p) => toScreen(s.view, p));
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Left of the arrow as seen on screen (y down): rotate the direction by -90°.
  const lx = uy;
  const ly = -ux;
  const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const head = 11;
  cased(ctx, () => {
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.moveTo(b[0] - ux * head + lx * head * 0.55, b[1] - uy * head + ly * head * 0.55);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(b[0] - ux * head - lx * head * 0.55, b[1] - uy * head - ly * head * 0.55);
    ctx.moveTo(mid[0], mid[1]);
    ctx.lineTo(mid[0] + lx * 16, mid[1] + ly * 16);
  }, 2.5);
  label(ctx, "masuk", mid[0] + lx * 22 - 4, mid[1] + ly * 22);
  [a, b].forEach(([x, y], end) => handle(ctx, x, y, s.selected?.kind === "line" && s.selected.line === li && s.selected.end === end));
  label(ctx, l.id, a[0] + 8, a[1] + 14);
}

function drawPending(ctx: CanvasRenderingContext2D, s: Scene) {
  if (s.pending.length === 0) return;
  const pts = s.hover ? [...s.pending, s.hover] : s.pending;
  cased(ctx, () => polygonPath(ctx, s.view, pts, false), 1.5, WHITE, [4, 4]);
  s.pending.forEach((p, i) => {
    const [x, y] = toScreen(s.view, p);
    handle(ctx, x, y, i === 0 && s.pendingKind === "queue" && s.pending.length >= 3);
  });
}

function drawPoint(ctx: CanvasRenderingContext2D, s: Scene, p: DrawPoint) {
  const [x, y] = toScreen(s.view, p.px);
  const selected = s.selected?.kind === "point" && s.selected.id === p.id;
  const over = p.error != null && p.error > s.targetM;

  // Residual: from the picked pixel to where the fit puts the measured coordinate.
  if (p.reprojected) {
    const [rx, ry] = toScreen(s.view, p.reprojected);
    if (Math.hypot(rx - x, ry - y) > 1.5) {
      cased(ctx, () => {
        ctx.moveTo(x, y);
        ctx.lineTo(rx, ry);
      }, 1.25, WHITE, [3, 3]);
      ctx.fillStyle = WHITE;
      ctx.beginPath();
      ctx.arc(rx, ry, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const r = selected ? 9 : 7;
  if (p.kind === "fit") {
    ctx.fillStyle = CASE;
    ctx.fillRect(x - r - 2, y - r - 2, 2 * r + 4, 2 * r + 4);
    ctx.fillStyle = INK;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    ctx.fillStyle = WHITE;
    ctx.fillRect(x - 1, y - 1, 2, 2); // the exact pixel
  } else {
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = CASE;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = WHITE;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = WHITE;
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }
  if (selected) {
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - r - 4.5, y - r - 4.5, 2 * r + 9, 2 * r + 9);
  }
  const tag = p.error == null ? p.label : `${p.label} · ${p.error.toFixed(2).replace(".", ",")} m${over ? " !" : ""}`;
  label(ctx, tag, x + r + 6, y - r - 2, over ? CASE : WHITE, over ? WHITE : CASE);
}

function drawCrosshair(ctx: CanvasRenderingContext2D, s: Scene, p: Px) {
  const [x, y] = toScreen(s.view, p);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 14, y + 0.5);
  ctx.lineTo(x - 4, y + 0.5);
  ctx.moveTo(x + 4, y + 0.5);
  ctx.lineTo(x + 14, y + 0.5);
  ctx.moveTo(x + 0.5, y - 14);
  ctx.lineTo(x + 0.5, y - 4);
  ctx.moveTo(x + 0.5, y + 4);
  ctx.lineTo(x + 0.5, y + 14);
  ctx.stroke();
}

/** The handle under a screen position, nearest first, within `radius` CSS pixels. */
export function hitTest(s: Pick<Scene, "view" | "points" | "road" | "lines" | "queues">, screen: [number, number], radius = 10): Selection | null {
  let best: { sel: Selection; d: number } | null = null;
  const consider = (sel: Selection, p: Px) => {
    const [x, y] = toScreen(s.view, p);
    const d = Math.hypot(x - screen[0], y - screen[1]);
    if (d <= radius && (!best || d < best.d)) best = { sel, d };
  };
  for (const p of s.points) consider({ kind: "point", id: p.id }, p.px);
  s.road.forEach((p, index) => consider({ kind: "road", index }, p));
  s.lines.forEach((l, line) => l.px.forEach((p, end) => consider({ kind: "line", line, end: end as 0 | 1 }, p)));
  s.queues.forEach((q, queue) => q.polygon_px.forEach((p, index) => consider({ kind: "queue", queue, index }, p)));
  return (best as { sel: Selection } | null)?.sel ?? null;
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ArrowLeft, ArrowsLeftRight, CornersOut, Copy, DownloadSimple, ImageSquare, MapTrifold, Trash } from "@phosphor-icons/react";
import { calibrate, imageToWorld, MIN_POINTS, worldToImage } from "../lib/homography.ts";
import type { Calibration } from "../lib/homography.ts";
import { normalizeConfig } from "../lib/config.ts";
import { configToYaml } from "../lib/configYaml.ts";
import { COMPASS_WORD, compassDirection } from "../lib/direction.ts";
import { formatLatLng, fromLocalMeters, googleMapsSatelliteUrl, parseCoordinate, toLocalMeters } from "../lib/geo.ts";
import type { LngLat } from "../lib/geo.ts";
import type { Corridor, Junction } from "../lib/liveSchema.ts";
import type { CameraConfig, CountLine, Meters, Px, QueueRegion } from "../lib/schema.ts";
import { navigate } from "../router.ts";
import { drawScene, gridStep, hitTest, toImage, toScreen } from "./calibDraw.ts";
import type { DrawPoint, Selection, View } from "./calibDraw.ts";

/** PLAN.md section 2: calibration error under 1.5 m on the hold-out points. */
const TARGET_M = 1.5;
const RECOMMENDED_FIT = 8;
const RECOMMENDED_HOLDOUT = 3;
const STORE_PREFIX = "streetlens.kalibrasi.";
const STORE_LAST = `${STORE_PREFIX}terakhir`;

type Tab = "kalibrasi" | "garis" | "simpan";
type Mode = "fit" | "holdout" | "road" | "line" | "queue" | "none";

interface CalPoint {
  id: number;
  kind: "fit" | "holdout";
  px: Px;
  /** What was typed or pasted: Google Maps "lat, lng", or "x m, y m". */
  coord: string;
}

interface Draft {
  cameraId: string;
  name: string;
  googleMapsUrl: string | null;
  origin: string;
  originNote: string;
  points: CalPoint[];
  road: Px[];
  lines: CountLine[];
  queues: QueueRegion[];
  imageSize: [number, number] | null;
  /** signal / queue / counting from a loaded config, kept as they were. */
  base: Pick<CameraConfig, "signal" | "queue" | "counting"> | null;
  nextId: number;
}

interface CameraOption {
  id: string;
  lnglat: LngLat;
  junction: Junction;
}

const emptyDraft = (cameraId = ""): Draft => ({
  cameraId,
  name: "",
  googleMapsUrl: null,
  origin: "",
  originNote: "",
  points: [],
  road: [],
  lines: [],
  queues: [],
  imageSize: null,
  base: null,
  nextId: 1,
});

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // private window or full storage: the draft just isn't remembered
  }
}
function loadDraft(cameraId: string): Draft | null {
  const raw = readStore(STORE_PREFIX + cameraId);
  if (!raw) return null;
  try {
    return { ...emptyDraft(cameraId), ...(JSON.parse(raw) as Partial<Draft>), cameraId };
  } catch {
    return null;
  }
}

/** A config/<camera>.yaml (served as JSON) back into an editable draft. */
function draftFromConfig(raw: unknown): Draft {
  const c = normalizeConfig(raw);
  const origin = c.world_origin_lnglat ?? null;
  const coordText = (m: Meters) => (origin ? formatLatLng(fromLocalMeters(origin, m)) : `${m[0]} m, ${m[1]} m`);
  let id = 1;
  const points: CalPoint[] = [
    ...c.calibration.image_points_px.map((px, i) => ({ id: id++, kind: "fit" as const, px, coord: coordText(c.calibration.world_points_m[i]) })),
    ...c.calibration.holdout_image_px.map((px, i) => ({ id: id++, kind: "holdout" as const, px, coord: coordText(c.calibration.holdout_world_m[i]) })),
  ];
  const note = (c.world_origin ?? "").replace(/\s*\(-?\d+\.\d+, -?\d+\.\d+\)\s*$/, "");
  return {
    ...emptyDraft(c.camera_id),
    name: c.name,
    googleMapsUrl: c.google_maps_url,
    origin: origin ? formatLatLng(origin) : "",
    originNote: note,
    points,
    road: c.road_polygon_px,
    lines: c.count_lines,
    queues: c.queue_regions,
    imageSize: c.image_size_px ?? null,
    base: { signal: c.signal, queue: c.queue, counting: c.counting },
    nextId: id,
  };
}

const fmt = (n: number, digits = 2) => n.toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtM = (n: number) => `${fmt(n)} m`;
const fmtPx = (p: Px) => `${fmt(p[0], 0)}, ${fmt(p[1], 0)}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");

function uniqueId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}_${i}`)) return `${base}_${i}`;
}

function fitView(size: [number, number], cw: number, ch: number): View {
  const scale = Math.min(cw / size[0], ch / size[1]) * 0.98;
  return { scale, ox: (cw - size[0] * scale) / 2, oy: (ch - size[1] * scale) / 2 };
}

const MODE_HINT: Record<Mode, string> = {
  fit: "Klik tanda yang juga terlihat di satelit Google Maps: sudut zebra cross, ujung marka, sudut trotoar. Lalu tempel koordinatnya.",
  holdout: "Titik hold-out tidak dipakai untuk menghitung. Pilih 3 tanda lain yang tersebar, untuk menguji galat sebenarnya.",
  road: "Klik keliling tepi jalan yang terlihat. Poligon menutup sendiri.",
  line: "Klik dua titik: awal lalu ujung panah. Kendaraan yang menyeberang ke kiri panah dihitung masuk.",
  queue: "Klik keliling area tempat antrean terbentuk di belakang garis henti. Klik titik pertama atau tekan Enter untuk menutup.",
  none: "Seret titik untuk merapikan. Untuk menambah, kembali ke tab Kalibrasi atau Garis & area.",
};

export function CalibrationTool() {
  const [corridor, setCorridor] = useState<Corridor | null>(null);
  const [corridorError, setCorridorError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => {
    const last = readStore(STORE_LAST);
    return (last && loadDraft(last)) || emptyDraft();
  });
  const [loadNote, setLoadNote] = useState<string | null>(null);
  const [image, setImage] = useState<{ source: CanvasImageSource; size: [number, number]; name: string } | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("kalibrasi");
  const [mode, setMode] = useState<Mode>("fit");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [pending, setPending] = useState<Px[]>([]);
  const [hover, setHover] = useState<Px | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [view, setView] = useState<View>({ scale: 1, ox: 0, oy: 0 });
  const [focusPoint, setFocusPoint] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const fitted = useRef(true);
  const spaceDown = useRef(false);
  const drag = useRef<{ kind: "handle"; sel: Selection } | { kind: "pan"; x: number; y: number; view: View } | null>(null);

  useEffect(() => {
    fetch("/api/corridor")
      .then((r) => (r.ok ? (r.json() as Promise<Corridor>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setCorridor)
      .catch((err: Error) => setCorridorError(`Daftar kamera koridor tidak termuat (${err.message}). Ketik ID kamera sendiri.`));
  }, []);

  // Remember the draft on every change, per camera.
  useEffect(() => {
    if (!draft.cameraId) return;
    writeStore(STORE_PREFIX + draft.cameraId, JSON.stringify(draft));
    writeStore(STORE_LAST, draft.cameraId);
  }, [draft]);

  const cameras = useMemo<CameraOption[]>(
    () => corridor?.junctions.flatMap((j) => j.cameras.map((c) => ({ id: c.id, lnglat: c.lnglat, junction: j }))) ?? [],
    [corridor],
  );
  const camera = cameras.find((c) => c.id === draft.cameraId) ?? null;

  const update = useCallback((fn: (d: Draft) => Draft) => setDraft((d) => fn(d)), []);

  // ------------------------------------------------------------------ derived geometry
  const originParsed = parseCoordinate(draft.origin);
  const origin: LngLat | null = originParsed?.kind === "lnglat" ? originParsed.value : null;

  const worldOf = useCallback(
    (p: CalPoint): { m: Meters | null; problem: string | null } => {
      if (!p.coord.trim()) return { m: null, problem: null };
      const c = parseCoordinate(p.coord);
      if (!c) return { m: null, problem: "Tidak dikenali. Tempel “lat, lng” dari Google Maps." };
      if (c.kind === "meters") return { m: c.value, problem: null };
      if (!origin) return { m: null, problem: "Isi titik asal (0, 0) dulu." };
      return { m: toLocalMeters(origin, c.value), problem: null };
    },
    [origin],
  );

  const solved = useMemo(() => {
    const fit = draft.points.filter((p) => p.kind === "fit").map((p) => ({ p, ...worldOf(p) }));
    const hold = draft.points.filter((p) => p.kind === "holdout").map((p) => ({ p, ...worldOf(p) }));
    const fitOk = fit.filter((x) => x.m);
    const holdOk = hold.filter((x) => x.m);
    const errors = new Map<number, number>();
    let calibration: Calibration | null = null;
    let reason: string | null = null;
    if (fitOk.length < MIN_POINTS) {
      reason = `Butuh minimal ${MIN_POINTS} titik fit yang sudah berkoordinat (disarankan ${RECOMMENDED_FIT}–10). Sekarang ${fitOk.length}.`;
    } else {
      const result = calibrate({
        image_points_px: fitOk.map((x) => x.p.px),
        world_points_m: fitOk.map((x) => x.m!),
        holdout_image_px: holdOk.map((x) => x.p.px),
        holdout_world_m: holdOk.map((x) => x.m!),
      });
      if (result.ok) {
        calibration = result.calibration;
        fitOk.forEach((x, i) => errors.set(x.p.id, result.calibration.fitErrors[i]));
        holdOk.forEach((x, i) => errors.set(x.p.id, result.calibration.holdoutErrors[i]));
      } else {
        reason = /straight line|repeated/.test(result.reason)
          ? "Titik-titik fit terlalu berdekatan atau segaris. Sebar ke seluruh jalan: dekat, jauh, kiri, kanan."
          : result.reason;
      }
    }
    return { fit, hold, fitOk, holdOk, errors, calibration, reason };
  }, [draft.points, worldOf]);
  const cal = solved.calibration;

  const labels = useMemo(() => {
    const out = new Map<number, string>();
    let f = 0;
    let h = 0;
    for (const p of draft.points) out.set(p.id, p.kind === "fit" ? String(++f) : `H${++h}`);
    return out;
  }, [draft.points]);

  const drawPoints = useMemo<DrawPoint[]>(
    () =>
      draft.points.map((p) => {
        const m = worldOf(p).m;
        return {
          id: p.id,
          kind: p.kind,
          label: labels.get(p.id) ?? "",
          px: p.px,
          reprojected: cal && m ? worldToImage(cal, m) : null,
          error: solved.errors.get(p.id) ?? null,
        };
      }),
    [draft.points, labels, cal, solved.errors, worldOf],
  );

  const verdict = useMemo(() => {
    if (!cal) return { pass: false, title: "Belum terkalibrasi", detail: solved.reason ?? "" };
    if (solved.holdOk.length < RECOMMENDED_HOLDOUT) {
      return {
        pass: false,
        title: "Belum teruji",
        detail: `Fit jalan, tapi galat sebenarnya baru terukur dengan ${RECOMMENDED_HOLDOUT} titik hold-out. Sekarang ${solved.holdOk.length}.`,
      };
    }
    const max = cal.holdoutMax!;
    if (max <= TARGET_M) return { pass: true, title: "Lolos", detail: `Galat hold-out terbesar ${fmtM(max)}, di bawah target ${fmtM(TARGET_M)}.` };
    const worst = solved.holdOk.reduce((a, b) => ((solved.errors.get(b.p.id) ?? 0) > (solved.errors.get(a.p.id) ?? 0) ? b : a));
    return {
      pass: false,
      title: "Belum lolos",
      detail: `Galat terbesar ${fmtM(max)} di ${labels.get(worst.p.id)}. Cek ulang klik dan koordinatnya, atau tambah titik fit di dekatnya.`,
    };
  }, [cal, solved, labels]);

  // ------------------------------------------------------------------ config + YAML
  const config = useMemo<CameraConfig>(() => {
    const base = draft.base ?? normalizeConfig({ camera_id: "x" });
    return {
      camera_id: draft.cameraId || "kamera_baru",
      name: draft.name || draft.cameraId || "Kamera baru",
      google_maps_url: draft.googleMapsUrl,
      world_origin: origin ? `${draft.originNote.trim() || "Titik asal"} (${formatLatLng(origin)})` : draft.originNote || undefined,
      world_origin_lnglat: origin,
      image_size_px: draft.imageSize,
      road_polygon_px: draft.road,
      count_lines: draft.lines,
      queue_regions: draft.queues,
      calibration: {
        image_points_px: solved.fitOk.map((x) => x.p.px),
        world_points_m: solved.fitOk.map((x) => x.m!),
        holdout_image_px: solved.holdOk.map((x) => x.p.px),
        holdout_world_m: solved.holdOk.map((x) => x.m!),
      },
      signal: base.signal,
      queue: base.queue,
      counting: base.counting,
    };
  }, [draft, origin, solved]);

  const yaml = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const notes = [
      `Camera config for ${config.name}. Written by the calibration tool (/tim/kalibrasi) on ${today}.`,
      "X east, Y north, in meters from world_origin. World points measured on Google Maps satellite view.",
    ];
    if (draft.imageSize) notes.push(`Pixels picked on a ${draft.imageSize[0]}x${draft.imageSize[1]} image: the analysed video must have this frame size.`);
    if (cal) {
      const hold = cal.holdoutMax == null ? "no hold-out points" : `hold-out mean ${cal.holdoutMean!.toFixed(2)} m, max ${cal.holdoutMax.toFixed(2)} m`;
      notes.push(`Fit RMS ${cal.fitRms.toFixed(2)} m, ${hold} (target < ${TARGET_M} m).`);
    }
    return configToYaml(config, { world_origin_lnglat: origin, image_size_px: draft.imageSize, notes });
  }, [config, draft.imageSize, cal, origin]);

  // ------------------------------------------------------------------ camera choice
  const chooseCamera = async (id: string) => {
    const cameraId = slug(id);
    setSelected(null);
    setPending([]);
    setLoadNote(null);
    if (!cameraId) {
      setDraft(emptyDraft());
      return;
    }
    const saved = loadDraft(cameraId);
    if (saved) {
      setDraft(saved);
      setLoadNote("Draf sebelumnya di browser ini dibuka lagi.");
      return;
    }
    const opt = cameras.find((c) => c.id === cameraId);
    const fresh: Draft = {
      ...emptyDraft(cameraId),
      name: opt ? opt.junction.name : "",
      googleMapsUrl: opt ? googleMapsSatelliteUrl(opt.lnglat) : null,
      origin: opt ? formatLatLng(opt.lnglat) : "",
      originNote: opt ? "Posisi kamera menurut Bali Satu Data" : "",
    };
    setDraft(fresh);
    try {
      const res = await fetch(`/api/cameras/${encodeURIComponent(cameraId)}/config`);
      if (res.ok) {
        setDraft(draftFromConfig(await res.json()));
        setLoadNote(`config/${cameraId}.yaml dibuka untuk dilanjutkan.`);
      }
    } catch {
      // backend unreachable: start fresh
    }
  };

  // ------------------------------------------------------------------ image / video
  const openFile = async (file: File) => {
    setFileError(null);
    if (file.type.startsWith("video/")) {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      setVideoUrl(URL.createObjectURL(file));
      return;
    }
    if (!file.type.startsWith("image/")) {
      setFileError("Buka gambar (PNG, JPG) atau video (MP4) dari kamera.");
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      showImage(bitmap, [bitmap.width, bitmap.height], file.name);
    } catch {
      setFileError("Gambar ini tidak bisa dibuka. Coba simpan ulang sebagai PNG.");
    }
  };

  const showImage = (source: CanvasImageSource, size: [number, number], name: string) => {
    setImage({ source, size, name });
    fitted.current = true;
    update((d) => ({ ...d, imageSize: d.imageSize ?? size }));
  };

  const grabFrame = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const bitmap = await createImageBitmap(v);
    const t = v.currentTime.toFixed(1).replace(".", ",");
    showImage(bitmap, [bitmap.width, bitmap.height], `frame ${t} dtk`);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
  };

  const onFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void openFile(f);
    e.target.value = "";
  };

  const sizeMismatch = image && draft.imageSize && (draft.imageSize[0] !== image.size[0] || draft.imageSize[1] !== image.size[1]);

  // ------------------------------------------------------------------ canvas
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => {
      if (image && fitted.current) setView(fitView(image.size, stage.clientWidth, stage.clientHeight));
      else setView((v) => ({ ...v }));
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [image]);

  useEffect(() => {
    const stage = stageRef.current;
    if (image && stage && fitted.current) setView(fitView(image.size, stage.clientWidth, stage.clientHeight));
  }, [image]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const id = requestAnimationFrame(() =>
      drawScene(canvas, {
        image: image?.source ?? null,
        imageSize: image?.size ?? null,
        view,
        calibration: cal,
        showGrid,
        points: drawPoints,
        road: draft.road,
        lines: draft.lines,
        queues: draft.queues,
        pending,
        pendingKind: mode === "line" || mode === "queue" ? mode : null,
        hover,
        selected,
        targetM: TARGET_M,
      }),
    );
    return () => cancelAnimationFrame(id);
  }, [image, view, cal, showGrid, drawPoints, draft.road, draft.lines, draft.queues, pending, mode, hover, selected]);

  // Wheel zoom around the cursor (needs a non-passive listener to stop the page scrolling).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      fitted.current = false;
      setView((v) => {
        const scale = Math.min(24, Math.max(0.1, v.scale * Math.exp(-e.deltaY * 0.0015)));
        const k = scale / v.scale;
        return { scale, ox: sx - (sx - v.ox) * k, oy: sy - (sy - v.oy) * k };
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [image]);

  const screenOf = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };
  const clampPx = (p: Px): Px =>
    image ? [Math.min(image.size[0], Math.max(0, p[0])), Math.min(image.size[1], Math.max(0, p[1]))] : p;

  const finishQueue = useCallback(() => {
    setPending((pts) => {
      if (pts.length < 3) return pts;
      update((d) => {
        const id = uniqueId(d.lines[0] ? `${d.lines[0].id}_antrean` : "antrean", d.queues.map((q) => q.id));
        return { ...d, queues: [...d.queues, { id, polygon_px: pts, stop_line: d.lines[0]?.id ?? "" }] };
      });
      return [];
    });
  }, [update]);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!image) return;
    const screen = screenOf(e);
    // Keep focus where it is (or where we put it): a mousedown on the canvas would move it to <body>.
    e.preventDefault();
    canvasRef.current!.setPointerCapture(e.pointerId);
    if (e.button === 1 || spaceDown.current || e.altKey) {
      drag.current = { kind: "pan", x: screen[0], y: screen[1], view };
      return;
    }
    if (e.button !== 0) return;
    const hit = hitTest({ view, points: drawPoints, road: draft.road, lines: draft.lines, queues: draft.queues }, screen);
    const p = clampPx(toImage(view, screen));

    if (mode === "queue" && pending.length >= 3) {
      const [fx, fy] = toScreen(view, pending[0]);
      if (Math.hypot(fx - screen[0], fy - screen[1]) <= 10) {
        finishQueue();
        return;
      }
    }
    if (hit && pending.length === 0) {
      setSelected(hit);
      drag.current = { kind: "handle", sel: hit };
      if (hit.kind === "point") {
        const pt = draft.points.find((x) => x.id === hit.id);
        if (pt) setTab("kalibrasi");
      }
      return;
    }

    if (mode === "fit" || mode === "holdout") {
      const id = draft.nextId;
      update((d) => ({ ...d, nextId: d.nextId + 1, points: [...d.points, { id, kind: mode, px: p, coord: "" }] }));
      setSelected({ kind: "point", id });
      setFocusPoint(id);
    } else if (mode === "road") {
      update((d) => ({ ...d, road: [...d.road, p] }));
      setSelected({ kind: "road", index: draft.road.length });
    } else if (mode === "line") {
      if (pending.length === 0) setPending([p]);
      else {
        const a = pending[0];
        setPending([]);
        update((d) => ({ ...d, lines: [...d.lines, { id: uniqueId("garis", d.lines.map((l) => l.id)), px: [a, p] }] }));
      }
    } else if (mode === "queue") {
      setPending((pts) => [...pts, p]);
    } else {
      setSelected(null);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!image) return;
    const screen = screenOf(e);
    const d = drag.current;
    if (d?.kind === "pan") {
      fitted.current = false;
      setView({ scale: d.view.scale, ox: d.view.ox + screen[0] - d.x, oy: d.view.oy + screen[1] - d.y });
      return;
    }
    const p = clampPx(toImage(view, screen));
    setHover(p);
    if (d?.kind === "handle") moveHandle(d.sel, p);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    drag.current = null;
    canvasRef.current?.releasePointerCapture(e.pointerId);
  };

  const moveHandle = (sel: Selection, p: Px) => {
    update((d) => {
      if (sel.kind === "point") return { ...d, points: d.points.map((x) => (x.id === sel.id ? { ...x, px: p } : x)) };
      if (sel.kind === "road") return { ...d, road: d.road.map((x, i) => (i === sel.index ? p : x)) };
      if (sel.kind === "line") {
        return { ...d, lines: d.lines.map((l, i) => (i === sel.line ? { ...l, px: (sel.end === 0 ? [p, l.px[1]] : [l.px[0], p]) as [Px, Px] } : l)) };
      }
      return {
        ...d,
        queues: d.queues.map((q, i) => (i === sel.queue ? { ...q, polygon_px: q.polygon_px.map((x, j) => (j === sel.index ? p : x)) } : q)),
      };
    });
  };

  const removeSelected = useCallback(() => {
    if (!selected) return;
    update((d) => {
      if (selected.kind === "point") return { ...d, points: d.points.filter((x) => x.id !== selected.id) };
      if (selected.kind === "road") return { ...d, road: d.road.filter((_, i) => i !== selected.index) };
      if (selected.kind === "line") {
        const gone = d.lines[selected.line]?.id;
        return {
          ...d,
          lines: d.lines.filter((_, i) => i !== selected.line),
          queues: d.queues.map((q) => (q.stop_line === gone ? { ...q, stop_line: "" } : q)),
        };
      }
      const q = d.queues[selected.queue];
      if (!q) return d;
      if (q.polygon_px.length <= 3) return { ...d, queues: d.queues.filter((_, i) => i !== selected.queue) };
      return {
        ...d,
        queues: d.queues.map((x, i) => (i === selected.queue ? { ...x, polygon_px: x.polygon_px.filter((_, j) => j !== selected.index) } : x)),
      };
    });
    setSelected(null);
  }, [selected, update]);

  const fitToStage = useCallback(() => {
    const stage = stageRef.current;
    if (!image || !stage) return;
    fitted.current = true;
    setView(fitView(image.size, stage.clientWidth, stage.clientHeight));
  }, [image]);

  // Keyboard: only when nobody is typing in a field.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.code === "Space") {
        spaceDown.current = true;
        if (image) e.preventDefault();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selected) {
          e.preventDefault();
          removeSelected();
        }
      } else if (e.key === "Escape") {
        setPending([]);
        setSelected(null);
      } else if (e.key === "Enter" && mode === "queue") {
        finishQueue();
      } else if (e.key === "f" || e.key === "F") {
        fitToStage();
      } else if (e.key === "g" || e.key === "G") {
        setShowGrid((s) => !s);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [image, selected, mode, removeSelected, finishQueue, fitToStage]);

  useEffect(() => {
    if (focusPoint == null) return;
    const el = inputs.current.get(focusPoint);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
      setFocusPoint(null);
    }
  }, [focusPoint, draft.points]);

  const switchTab = (t: Tab) => {
    setTab(t);
    setPending([]);
    if (t === "kalibrasi" && mode !== "fit" && mode !== "holdout") setMode("fit");
    if (t === "garis" && mode !== "road" && mode !== "line" && mode !== "queue") setMode("line");
    if (t === "simpan") setMode("none");
  };

  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const order: Tab[] = ["kalibrasi", "garis", "simpan"];
    const i = order.indexOf(tab);
    if (e.key === "ArrowRight") switchTab(order[(i + 1) % 3]);
    if (e.key === "ArrowLeft") switchTab(order[(i + 2) % 3]);
  };

  const download = () => {
    const blob = new Blob([yaml], { type: "text/yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${config.camera_id}.yaml`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(yaml);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const worldUnderCursor = cal && hover ? imageToWorld(cal, hover) : null;
  const fitCount = solved.fit.length;
  const holdCount = solved.hold.length;

  return (
    <div className="tool calib">
      <header className="tool-bar">
        <button type="button" className="back" onClick={() => navigate("/tim")}>
          <ArrowLeft size={18} weight="bold" aria-hidden="true" />
          Alat tim
        </button>
        <h1 className="tool-title">Kalibrasi kamera{draft.cameraId ? ` · ${draft.cameraId}` : ""}</h1>
        <span className={`calib-verdict${verdict.pass ? " is-pass" : ""}`}>
          <span className={`calib-mark ${verdict.pass ? "is-full" : cal ? "is-half" : "is-ring"}`} aria-hidden="true" />
          {verdict.title}
          {cal?.holdoutMax != null && <span className="muted tabular"> · hold-out maks {fmtM(cal.holdoutMax)}</span>}
        </span>
      </header>

      <main className="calib-workspace">
        <section className="tool-panel calib-stage-panel" aria-label="Gambar kamera">
          <div className="calib-modebar">
            <div className="calib-modes" role="group" aria-label="Alat gambar">
              {tab === "kalibrasi" && (
                <>
                  <ModeButton mode="fit" current={mode} onPick={setMode}>
                    Titik fit <span className="tabular">{fitCount}</span>
                  </ModeButton>
                  <ModeButton mode="holdout" current={mode} onPick={setMode}>
                    Hold-out <span className="tabular">{holdCount}</span>
                  </ModeButton>
                </>
              )}
              {tab === "garis" && (
                <>
                  <ModeButton mode="road" current={mode} onPick={(m) => (setPending([]), setMode(m))}>
                    Poligon jalan
                  </ModeButton>
                  <ModeButton mode="line" current={mode} onPick={(m) => (setPending([]), setMode(m))}>
                    Garis hitung
                  </ModeButton>
                  <ModeButton mode="queue" current={mode} onPick={(m) => (setPending([]), setMode(m))}>
                    Area antrean
                  </ModeButton>
                </>
              )}
              {tab === "simpan" && <span className="calib-modes-note">Merapikan</span>}
            </div>
            <div className="calib-view-tools">
              <label className="calib-toggle" title="G">
                <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} disabled={!cal} />
                Grid {cal ? `${String(gridStep(cal)).replace(".", ",")} m` : "meter"}
              </label>
              <button type="button" className="calib-icon-btn" onClick={fitToStage} disabled={!image} title="Paskan gambar (F)" aria-label="Paskan gambar">
                <CornersOut size={18} aria-hidden="true" />
              </button>
              <button type="button" className="calib-icon-btn" onClick={() => fileRef.current?.click()} title="Buka gambar atau video lain" aria-label="Buka gambar atau video lain">
                <ImageSquare size={18} aria-hidden="true" />
              </button>
            </div>
          </div>
          <p className="calib-hint">{image ? MODE_HINT[mode] : "Mulai dengan gambar dari kamera ini."}</p>

          <div
            ref={stageRef}
            className={`calib-stage${dragOver ? " is-drop" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) void openFile(f);
            }}
          >
            <canvas
              ref={canvasRef}
              className={`calib-canvas mode-${mode}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => setHover(null)}
              onDoubleClick={() => mode === "queue" && finishQueue()}
              onContextMenu={(e) => e.preventDefault()}
              aria-label="Gambar kamera untuk kalibrasi. Klik untuk menaruh titik."
            />
            {videoUrl && (
              <div className="calib-video">
                <video ref={videoRef} src={videoUrl} controls muted playsInline />
                <div className="calib-video-bar">
                  <span>Putar atau geser ke frame yang jalannya paling jelas dan sepi.</span>
                  <button type="button" className="btn btn-primary" onClick={() => void grabFrame()}>
                    Pakai frame ini
                  </button>
                </div>
              </div>
            )}
            {!image && !videoUrl && (
              <div className="calib-empty">
                <p className="calib-empty-title">Seret tangkapan layar CCTV atau video ke sini</p>
                <p className="muted">
                  Ambil dari siaran kamera dengan ukuran aslinya, sama dengan video yang nanti dianalisis. Gambar hanya dibuka di browser ini, tidak diunggah.
                </p>
                <button type="button" className="btn btn-primary" onClick={() => fileRef.current?.click()}>
                  <ImageSquare size={20} aria-hidden="true" />
                  Pilih gambar atau video
                </button>
                {fileError && <p className="calib-error">{fileError}</p>}
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={onFileInput} />
          </div>

          <footer className="calib-readout tabular">
            <span>
              {image ? `${image.name} · ${image.size[0]} × ${image.size[1]} px · ${Math.round(view.scale * 100)}%` : "Belum ada gambar"}
            </span>
            {hover && (
              <span>
                x {fmt(hover[0], 1)} · y {fmt(hover[1], 1)}
                {worldUnderCursor && ` → X ${fmt(worldUnderCursor[0])} m · Y ${fmt(worldUnderCursor[1])} m`}
              </span>
            )}
            <span className="calib-keys">
              <kbd>Scroll</kbd> zoom <kbd>Spasi</kbd>+seret geser <kbd>Del</kbd> hapus <kbd>Esc</kbd> batal
            </span>
          </footer>
          {sizeMismatch && (
            <div className="pane-warning">
              Gambar ini {image!.size[0]} × {image!.size[1]} px, tapi titik di draf ini dipilih pada gambar {draft.imageSize![0]} × {draft.imageSize![1]} px. Buka gambar
              berukuran sama, atau{" "}
              <button type="button" className="link-btn" onClick={() => update((d) => ({ ...d, imageSize: image!.size }))}>
                pakai ukuran baru
              </button>
              .
            </div>
          )}
        </section>

        <aside className="tool-panel calib-side" aria-label="Pengaturan kalibrasi">
          <div className="calib-tabs" role="tablist" aria-label="Langkah" onKeyDown={onTabKey}>
            {(
              [
                ["kalibrasi", "Kalibrasi"],
                ["garis", "Garis & area"],
                ["simpan", "Simpan"],
              ] as const
            ).map(([t, name]) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`tab-${t}`}
                aria-selected={tab === t}
                aria-controls={`panel-${t}`}
                tabIndex={tab === t ? 0 : -1}
                onClick={() => switchTab(t)}
              >
                {name}
              </button>
            ))}
          </div>

          <div className="calib-side-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === "kalibrasi" && (
              <>
                <section className="calib-section">
                  <h2 className="panel-title">Kamera</h2>
                  <label className="calib-field">
                    <span>Kamera koridor</span>
                    <select value={camera ? camera.id : draft.cameraId ? "__lain" : ""} onChange={(e) => void chooseCamera(e.target.value === "__lain" ? "kamera_baru" : e.target.value)}>
                      <option value="">Pilih kamera…</option>
                      {corridor?.junctions.map((j) => (
                        <optgroup key={j.id} label={j.name}>
                          {j.cameras.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.id}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                      <option value="__lain">Kamera lain…</option>
                    </select>
                  </label>
                  {corridorError && <p className="calib-note">{corridorError}</p>}
                  {draft.cameraId && !camera && (
                    <label className="calib-field">
                      <span>ID kamera</span>
                      <input
                        value={draft.cameraId}
                        onChange={(e) => update((d) => ({ ...d, cameraId: slug(e.target.value) }))}
                        spellCheck={false}
                      />
                    </label>
                  )}
                  {draft.cameraId && (
                    <label className="calib-field">
                      <span>Nama</span>
                      <input value={draft.name} onChange={(e) => update((d) => ({ ...d, name: e.target.value }))} placeholder="Simpang Patung Kuda, menghadap utara" />
                    </label>
                  )}
                  {loadNote && <p className="calib-note">{loadNote}</p>}
                </section>

                <section className="calib-section">
                  <h2 className="panel-title">Titik asal (0, 0)</h2>
                  <label className="calib-field">
                    <span>Koordinat</span>
                    <input
                      value={draft.origin}
                      onChange={(e) => update((d) => ({ ...d, origin: e.target.value }))}
                      placeholder="lat, lng dari Google Maps"
                      spellCheck={false}
                      aria-invalid={!!draft.origin.trim() && !origin}
                    />
                  </label>
                  {draft.origin.trim() && !origin && <p className="calib-error">Tempel “lat, lng” dari Google Maps, di dalam Bali.</p>}
                  <label className="calib-field">
                    <span>Keterangan</span>
                    <input value={draft.originNote} onChange={(e) => update((d) => ({ ...d, originNote: e.target.value }))} placeholder="Sudut barat laut zebra cross utara" />
                  </label>
                  <div className="calib-row-actions">
                    {origin && (
                      <a className="calib-link" href={googleMapsSatelliteUrl(origin)} target="_blank" rel="noreferrer">
                        <MapTrifold size={16} aria-hidden="true" />
                        Buka satelit Google Maps
                      </a>
                    )}
                    {solved.fit[0] && parseCoordinate(solved.fit[0].p.coord)?.kind === "lnglat" && (
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() =>
                          update((d) => ({ ...d, origin: solved.fit[0].p.coord, originNote: d.originNote || "Titik fit 1" }))
                        }
                      >
                        Pakai titik 1 sebagai (0, 0)
                      </button>
                    )}
                  </div>
                  <p className="calib-note">
                    Di Google Maps: tampilan satelit, klik kanan tanda di jalan, klik koordinatnya untuk menyalin. Lima desimal ≈ 1 m, jadi perbesar sampai tanda terlihat jelas.
                  </p>
                </section>

                <section className="calib-section">
                  <h2 className="panel-title">
                    Titik <span className="muted tabular">{fitCount} fit · {holdCount} hold-out</span>
                  </h2>
                  {draft.points.length === 0 ? (
                    <p className="calib-note">
                      Belum ada titik. Taruh {RECOMMENDED_FIT}–10 titik fit yang tersebar (dekat, jauh, kiri, kanan), lalu {RECOMMENDED_HOLDOUT} hold-out.
                    </p>
                  ) : (
                    <table className="calib-points">
                      <thead>
                        <tr>
                          <th scope="col">Titik</th>
                          <th scope="col">Piksel</th>
                          <th scope="col">Koordinat</th>
                          <th scope="col" className="num">
                            Galat
                          </th>
                          <th scope="col">
                            <span className="sr-only">Hapus</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...solved.fit, ...solved.hold].map(({ p, problem }) => {
                          const err = solved.errors.get(p.id);
                          const isSel = selected?.kind === "point" && selected.id === p.id;
                          return (
                            <tr key={p.id} className={isSel ? "is-selected" : undefined} onClick={() => setSelected({ kind: "point", id: p.id })}>
                              <th scope="row">
                                <span className={`calib-pt ${p.kind}`}>{labels.get(p.id)}</span>
                              </th>
                              <td className="tabular">{fmtPx(p.px)}</td>
                              <td>
                                <input
                                  ref={(el) => {
                                    if (el) inputs.current.set(p.id, el);
                                    else inputs.current.delete(p.id);
                                  }}
                                  value={p.coord}
                                  onChange={(e) => update((d) => ({ ...d, points: d.points.map((x) => (x.id === p.id ? { ...x, coord: e.target.value } : x)) }))}
                                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                                  onFocus={() => setSelected({ kind: "point", id: p.id })}
                                  placeholder="lat, lng"
                                  spellCheck={false}
                                  aria-label={`Koordinat titik ${labels.get(p.id)}`}
                                  aria-invalid={!!problem}
                                  title={problem ?? undefined}
                                />
                                {problem && <span className="calib-cell-error">{problem}</span>}
                              </td>
                              <td className={`num tabular${err != null && err > TARGET_M ? " is-over" : ""}`}>
                                {err != null ? fmt(err) : "–"}
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="calib-icon-btn is-small"
                                  aria-label={`Hapus titik ${labels.get(p.id)}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    update((d) => ({ ...d, points: d.points.filter((x) => x.id !== p.id) }));
                                  }}
                                >
                                  <Trash size={15} aria-hidden="true" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </section>

                <section className="calib-section">
                  <h2 className="panel-title">Hasil</h2>
                  <div className={`calib-result${verdict.pass ? " is-pass" : ""}`}>
                    <p className="calib-result-title">
                      <span className={`calib-mark ${verdict.pass ? "is-full" : cal ? "is-half" : "is-ring"}`} aria-hidden="true" />
                      {verdict.title}
                    </p>
                    <p>{verdict.detail}</p>
                  </div>
                  {cal && (
                    <dl className="calib-stats tabular">
                      <div>
                        <dt>Sisa fit (RMS)</dt>
                        <dd>{fmtM(cal.fitRms)}</dd>
                      </div>
                      <div>
                        <dt>Hold-out rata-rata</dt>
                        <dd>{cal.holdoutMean != null ? fmtM(cal.holdoutMean) : "–"}</dd>
                      </div>
                      <div>
                        <dt>Hold-out terbesar</dt>
                        <dd className={cal.holdoutMax != null && cal.holdoutMax > TARGET_M ? "is-over" : undefined}>
                          {cal.holdoutMax != null ? fmtM(cal.holdoutMax) : "–"}
                        </dd>
                      </div>
                      <div>
                        <dt>Target</dt>
                        <dd>&lt; {fmtM(TARGET_M)}</dd>
                      </div>
                    </dl>
                  )}
                  {cal && <PlanView cal={cal} points={draft.points} worldOf={worldOf} labels={labels} road={draft.road} lines={draft.lines} />}
                </section>
              </>
            )}

            {tab === "garis" && (
              <>
                <section className="calib-section">
                  <h2 className="panel-title">
                    Poligon jalan <span className="muted tabular">{draft.road.length} titik</span>
                  </h2>
                  <p className="calib-note">Batas jalan yang terlihat. Deteksi di luar poligon diabaikan.</p>
                  {draft.road.length > 0 && (
                    <button type="button" className="link-btn" onClick={() => update((d) => ({ ...d, road: [] }))}>
                      Hapus poligon
                    </button>
                  )}
                </section>

                <section className="calib-section">
                  <h2 className="panel-title">
                    Garis hitung <span className="muted tabular">{draft.lines.length}</span>
                  </h2>
                  <p className="calib-note">Satu garis per arah datang, melintang di garis henti. Panah digambar dari kiri ke kanan berarti kendaraan yang bergerak ke atas gambar dihitung masuk.</p>
                  <ul className="calib-list">
                    {draft.lines.map((l, i) => (
                      <li key={i} className={selected?.kind === "line" && selected.line === i ? "is-selected" : undefined}>
                        <div className="calib-list-row">
                          <input
                            className="calib-id"
                            value={l.id}
                            aria-label="ID garis"
                            spellCheck={false}
                            onChange={(e) => {
                              const id = slug(e.target.value) || l.id;
                              update((d) => ({
                                ...d,
                                lines: d.lines.map((x, j) => (j === i ? { ...x, id } : x)),
                                queues: d.queues.map((q) => (q.stop_line === l.id ? { ...q, stop_line: id } : q)),
                              }));
                            }}
                          />
                          <button
                            type="button"
                            className="calib-icon-btn is-small"
                            title="Balik arah panah"
                            aria-label={`Balik arah ${l.id}`}
                            onClick={() => update((d) => ({ ...d, lines: d.lines.map((x, j) => (j === i ? { ...x, px: [x.px[1], x.px[0]] } : x)) }))}
                          >
                            <ArrowsLeftRight size={15} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="calib-icon-btn is-small"
                            aria-label={`Hapus ${l.id}`}
                            onClick={() => {
                              update((d) => ({
                                ...d,
                                lines: d.lines.filter((_, j) => j !== i),
                                queues: d.queues.map((q) => (q.stop_line === l.id ? { ...q, stop_line: "" } : q)),
                              }));
                              setSelected(null);
                            }}
                          >
                            <Trash size={15} aria-hidden="true" />
                          </button>
                        </div>
                        <label className="calib-field is-inline">
                          <span>Arah datang</span>
                          <select
                            value={l.approach ?? ""}
                            onChange={(e) => update((d) => ({ ...d, lines: d.lines.map((x, j) => (j === i ? { ...x, approach: e.target.value || undefined } : x)) }))}
                          >
                            <option value="">Belum dipilih</option>
                            {camera?.junction.arms.map((a) => (
                              <option key={a.id} value={a.id}>
                                dari {COMPASS_WORD.id[compassDirection(a.bearing)]} · {a.road}
                              </option>
                            ))}
                            {l.approach && !camera?.junction.arms.some((a) => a.id === l.approach) && <option value={l.approach}>{l.approach}</option>}
                          </select>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="calib-section">
                  <h2 className="panel-title">
                    Area antrean <span className="muted tabular">{draft.queues.length}</span>
                  </h2>
                  <p className="calib-note">Di belakang garis henti, tempat kendaraan berhenti menunggu.</p>
                  <ul className="calib-list">
                    {draft.queues.map((q, i) => (
                      <li key={i} className={selected?.kind === "queue" && selected.queue === i ? "is-selected" : undefined}>
                        <div className="calib-list-row">
                          <input
                            className="calib-id"
                            value={q.id}
                            aria-label="ID area antrean"
                            spellCheck={false}
                            onChange={(e) => update((d) => ({ ...d, queues: d.queues.map((x, j) => (j === i ? { ...x, id: slug(e.target.value) || x.id } : x)) }))}
                          />
                          <button
                            type="button"
                            className="calib-icon-btn is-small"
                            aria-label={`Hapus ${q.id}`}
                            onClick={() => {
                              update((d) => ({ ...d, queues: d.queues.filter((_, j) => j !== i) }));
                              setSelected(null);
                            }}
                          >
                            <Trash size={15} aria-hidden="true" />
                          </button>
                        </div>
                        <label className="calib-field is-inline">
                          <span>Garis henti</span>
                          <select
                            value={q.stop_line}
                            aria-invalid={!q.stop_line}
                            onChange={(e) => update((d) => ({ ...d, queues: d.queues.map((x, j) => (j === i ? { ...x, stop_line: e.target.value } : x)) }))}
                          >
                            <option value="">Pilih garis…</option>
                            {draft.lines.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.id}
                              </option>
                            ))}
                          </select>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {mode === "queue" && pending.length > 0 && (
                    <p className="calib-note">
                      {pending.length} titik.{" "}
                      {pending.length >= 3 ? (
                        <button type="button" className="link-btn" onClick={finishQueue}>
                          Tutup area
                        </button>
                      ) : (
                        "Butuh minimal 3."
                      )}
                    </p>
                  )}
                </section>
              </>
            )}

            {tab === "simpan" && (
              <>
                <section className="calib-section">
                  <h2 className="panel-title">Periksa</h2>
                  <ul className="calib-checks">
                    <Check ok={verdict.pass}>Galat hold-out di bawah {fmtM(TARGET_M)}</Check>
                    <Check ok={solved.fitOk.length >= RECOMMENDED_FIT}>
                      {RECOMMENDED_FIT}+ titik fit (sekarang {solved.fitOk.length})
                    </Check>
                    <Check ok={draft.road.length >= 3}>Poligon jalan</Check>
                    <Check ok={draft.lines.length > 0 && draft.lines.every((l) => l.approach)}>Garis hitung dengan arah datang</Check>
                    <Check ok={draft.queues.every((q) => q.stop_line)}>Setiap area antrean punya garis henti</Check>
                  </ul>
                  {draft.imageSize && (
                    <p className="calib-note">
                      Titik dipilih pada gambar {draft.imageSize[0]} × {draft.imageSize[1]} px. Video yang dianalisis harus berukuran sama, atau semua piksel ini meleset.
                    </p>
                  )}
                </section>
                <section className="calib-section">
                  <h2 className="panel-title">config/{config.camera_id}.yaml</h2>
                  <div className="calib-save">
                    <button type="button" className="btn btn-primary" onClick={download} disabled={!draft.cameraId}>
                      <DownloadSimple size={20} aria-hidden="true" />
                      Unduh YAML
                    </button>
                    <button type="button" className="btn" onClick={() => void copy()}>
                      <Copy size={20} aria-hidden="true" />
                      {copied ? "Tersalin" : "Salin"}
                    </button>
                  </div>
                  <p className="calib-note">Taruh di folder config/ lalu commit. Pemutar analisis langsung memakainya untuk kembaran 3D.</p>
                  <pre className="calib-yaml" tabIndex={0} aria-label="Isi file YAML">
                    {yaml}
                  </pre>
                </section>
                {draft.cameraId && (
                  <section className="calib-section">
                    <button
                      type="button"
                      className="link-btn is-danger"
                      onClick={() => {
                        if (window.confirm(`Hapus semua titik, garis, dan area untuk ${draft.cameraId}? Draf di browser ini ikut terhapus.`)) {
                          writeStore(STORE_PREFIX + draft.cameraId, null);
                          setDraft({ ...emptyDraft(draft.cameraId), name: draft.name, googleMapsUrl: draft.googleMapsUrl, origin: draft.origin, originNote: draft.originNote });
                          setSelected(null);
                        }
                      }}
                    >
                      Mulai ulang kamera ini
                    </button>
                  </section>
                )}
              </>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function ModeButton({ mode, current, onPick, children }: { mode: Mode; current: Mode; onPick: (m: Mode) => void; children: ReactNode }) {
  return (
    <button type="button" className="chip" aria-pressed={mode === current} onClick={() => onPick(mode)}>
      {children}
    </button>
  );
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className={ok ? "is-ok" : undefined}>
      <span className={`calib-mark ${ok ? "is-full" : "is-ring"}`} aria-hidden="true" />
      <span className="sr-only">{ok ? "Beres: " : "Belum: "}</span>
      {children}
    </li>
  );
}

/** Top-down plan in meters, north up: does the layout of the picked points look like the real junction? */
function PlanView({
  cal,
  points,
  worldOf,
  labels,
  road,
  lines,
}: {
  cal: Calibration;
  points: CalPoint[];
  worldOf: (p: CalPoint) => { m: Meters | null };
  labels: Map<number, string>;
  road: Px[];
  lines: CountLine[];
}) {
  const W = 344;
  const H = 220;
  const pad = 22;
  const pts = points.map((p) => ({ p, m: worldOf(p).m })).filter((x): x is { p: CalPoint; m: Meters } => !!x.m);
  const roadM = road.map((p) => imageToWorld(cal, p)).filter((m): m is Meters => !!m);
  const linesM = lines.map((l) => l.px.map((p) => imageToWorld(cal, p))).filter((l): l is Meters[] => l.every(Boolean));
  const all = [...pts.map((x) => x.m), ...roadM, ...linesM.flat(), [0, 0] as Meters];
  const minX = Math.min(...all.map((m) => m[0]));
  const maxX = Math.max(...all.map((m) => m[0]));
  const minY = Math.min(...all.map((m) => m[1]));
  const maxY = Math.max(...all.map((m) => m[1]));
  const k = Math.min((W - 2 * pad) / Math.max(maxX - minX, 1), (H - 2 * pad) / Math.max(maxY - minY, 1));
  const cx = (W - (maxX - minX) * k) / 2;
  const cy = (H - (maxY - minY) * k) / 2;
  const sx = (x: number) => cx + (x - minX) * k;
  const sy = (y: number) => H - (cy + (y - minY) * k);
  const step = gridStep(cal);
  const bar = step * Math.max(1, Math.round(60 / (step * k)));

  return (
    <figure className="calib-plan">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Denah titik dalam meter, utara di atas">
        {roadM.length >= 3 && <polygon className="plan-road" points={roadM.map((m) => `${sx(m[0])},${sy(m[1])}`).join(" ")} />}
        {linesM.map((l, i) => (
          <line key={i} className="plan-line" x1={sx(l[0][0])} y1={sy(l[0][1])} x2={sx(l[1][0])} y2={sy(l[1][1])} />
        ))}
        <g className="plan-origin">
          <line x1={sx(0)} y1={sy(0)} x2={sx(0) + 18} y2={sy(0)} />
          <line x1={sx(0)} y1={sy(0)} x2={sx(0)} y2={sy(0) - 18} />
          <text x={sx(0) + 21} y={sy(0) + 4}>X</text>
          <text x={sx(0) - 3} y={sy(0) - 22}>Y</text>
        </g>
        {pts.map(({ p, m }) =>
          p.kind === "fit" ? (
            <g key={p.id} className="plan-pt">
              <rect x={sx(m[0]) - 4} y={sy(m[1]) - 4} width={8} height={8} />
              <text x={sx(m[0]) + 7} y={sy(m[1]) + 4}>{labels.get(p.id)}</text>
            </g>
          ) : (
            <g key={p.id} className="plan-pt is-holdout">
              <circle cx={sx(m[0])} cy={sy(m[1])} r={4.5} />
              <text x={sx(m[0]) + 7} y={sy(m[1]) + 4}>{labels.get(p.id)}</text>
            </g>
          ),
        )}
        <g className="plan-scale">
          <line x1={W - pad - bar * k} y1={H - 10} x2={W - pad} y2={H - 10} />
          <text x={W - pad} y={H - 15} textAnchor="end">
            {String(bar).replace(".", ",")} m
          </text>
        </g>
        <g className="plan-north">
          <path d={`M ${pad} 26 L ${pad + 5} 14 L ${pad + 10} 26 Z`} />
          <text x={pad + 5} y={38} textAnchor="middle">
            U
          </text>
        </g>
      </svg>
      <figcaption className="calib-note">Denah dari atas, utara di atas. Bentuknya harus mirip simpang di satelit.</figcaption>
    </figure>
  );
}

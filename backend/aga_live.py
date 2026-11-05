"""Live CCTV analysis with AGA, our own detector (trained from scratch, see aga/).

A visitor picks a camera; the backend then reads that camera's public HLS stream, runs AGA on the newest
frame about twice a second, tracks vehicles and keeps the latest result in memory. The browser polls that
result and draws it in 3D. No frame is stored or served: only boxes, classes and temporary track ids leave
this module (the same rule as docs/schema.md: no plates, no faces, no raw video).

Design notes
- Only camera ids from config/cameras.json are ever used, and the stream URL is built from such an id, so a
  request can never make the server fetch an arbitrary address.
- Which cameras are live is checked by asking each camera's playlist (a few KB), not by decoding video.
- At most MAX_WATCHERS cameras are analysed at once, and a camera nobody polls for IDLE_STOP_S seconds stops.
- torch and OpenCV are optional: without them the rest of the backend works and `status()` says why.
"""

from __future__ import annotations

import os
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

ROOT = Path(__file__).resolve().parent.parent
WEIGHTS = ROOT / "models" / "AGA_Model_cctv6.pt"
STREAM = "https://transcode.baliprov.go.id/cctv/{ch}/index.m3u8"
MODEL_NAME = "AGA (cctv6)"

MAX_WATCHERS = 3
IDLE_STOP_S = 45.0
STALE_S = 15.0  # no new frame for this long: the camera counts as offline
PROCESS_EVERY_S = 0.5
CONF = 0.3
PROBE_TTL_S = 600.0
PROBE_TIMEOUT_S = 6.0
VEHICLE_CLASSES = ("motorcycle", "car", "bus", "truck")

FrameSource = Callable[[str], Iterator[Any]]  # camera id -> iterator of BGR frames (blocks while waiting)
DetectFn = Callable[[Any], list[dict[str, Any]]]  # BGR frame -> [{"cls", "conf", "bbox_px"}]


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def probe_playlist(camera_id: str, timeout: float = PROBE_TIMEOUT_S) -> bool:
    """True when the camera's HLS playlist answers with a real playlist."""
    req = urllib.request.Request(STREAM.format(ch=camera_id), headers={"User-Agent": "BaliStreetLens-student-project"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200 and b"#EXTM3U" in r.read(4096)
    except Exception:
        return False


def load_aga_detector() -> tuple[Optional[DetectFn], Optional[str]]:
    """The AGA detector, or (None, reason) when torch/OpenCV/weights are missing."""
    try:
        import torch  # noqa: F401

        from aga.infer import detect, load_aga
    except Exception as err:  # not installed on this machine
        return None, f"AGA needs torch and OpenCV on the vision machine ({type(err).__name__}: {err})"
    if not WEIGHTS.exists():
        return None, f"weights not found: {WEIGHTS.name}"
    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model, cfg = load_aga(WEIGHTS, device)

    def run(frame: Any) -> list[dict[str, Any]]:
        return detect(model, cfg, frame, conf=CONF, device=device)

    return run, None


def open_stream(camera_id: str) -> Iterator[Any]:
    """Frames from the live stream. Yields the NEWEST frame each time it is asked (older ones are dropped)."""
    os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rw_timeout;10000000")
    import cv2

    cap = cv2.VideoCapture(STREAM.format(ch=camera_id), cv2.CAP_FFMPEG)
    try:
        if not cap.isOpened():
            return
        last = 0.0
        while True:
            ok, frame = cap.read()
            if not ok:
                return
            now = time.time()
            if now - last >= PROCESS_EVERY_S:
                last = now
                yield frame
    finally:
        cap.release()


class _Watcher(threading.Thread):
    """Reads one camera, detects, tracks, and keeps the latest observation."""

    def __init__(self, camera_id: str, detect: DetectFn, source: FrameSource, tracker_factory: Callable[[], Any]):
        super().__init__(daemon=True, name=f"aga-live-{camera_id}")
        self.camera_id = camera_id
        self._detect = detect
        self._source = source
        self._tracker = tracker_factory()
        self._lock = threading.Lock()
        self._state: Optional[dict[str, Any]] = None
        self.last_poll = time.time()
        self.stop = threading.Event()

    def snapshot(self) -> Optional[dict[str, Any]]:
        with self._lock:
            return dict(self._state) if self._state else None

    def run(self) -> None:
        backoff = 2.0
        while not self.stop.is_set():
            got_frame = False
            try:
                for frame in self._source(self.camera_id):
                    got_frame = True
                    backoff = 2.0
                    if self.stop.is_set() or time.time() - self.last_poll > IDLE_STOP_S:
                        self.stop.set()
                        break
                    self._process(frame)
            except Exception as err:  # keep the watcher alive; report it in the state
                self._fail(f"{type(err).__name__}: {err}")
            if self.stop.is_set():
                break
            if not got_frame:
                self._fail("stream did not deliver frames")
            self.stop.wait(backoff)
            backoff = min(backoff * 2, 30.0)

    def _fail(self, reason: str) -> None:
        with self._lock:
            prev = self._state or {}
            self._state = {**prev, "camera_id": self.camera_id, "model": MODEL_NAME, "problem": reason, "objects": prev.get("objects", [])}

    def _process(self, frame: Any) -> None:
        from vision.tracker import Det  # local import: needs scipy, only on the vision machine
        import numpy as np

        h, w = frame.shape[:2]
        dets = [d for d in self._detect(frame) if d["cls"] in VEHICLE_CLASSES]  # never anything else (no persons)
        tracked = self._tracker.update([Det(np.array(d["bbox_px"], float), float(d["conf"]), d["cls"]) for d in dets])
        objects = []
        for track_id, idx in tracked:
            x1, y1, x2, y2 = (float(v) for v in dets[idx]["bbox_px"])
            objects.append({
                "track_id": int(track_id), "cls": dets[idx]["cls"], "conf": round(float(dets[idx]["conf"]), 3),
                "bbox_px": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                "ground_px": [round((x1 + x2) / 2, 1), round(y2, 1)],
            })
        now = time.time()
        counts = {c: sum(1 for o in objects if o["cls"] == c) for c in VEHICLE_CLASSES}
        with self._lock:
            self._state = {
                "schema_version": 1, "camera_id": self.camera_id, "source": "live", "model": MODEL_NAME,
                "frame_size": [int(w), int(h)], "updated_at": _iso(now), "t": now,
                "objects": objects, "counts": counts, "problem": None,
            }


class LiveCameras:
    def __init__(self, cameras: list[dict[str, Any]], detect: Optional[DetectFn] = None, reason: Optional[str] = None,
                 source: FrameSource = open_stream, probe: Callable[[str], bool] = probe_playlist,
                 tracker_factory: Optional[Callable[[], Any]] = None):
        self._cameras = {c["id"]: c for c in cameras}
        self._detect = detect
        self._reason = reason
        self._source = source
        self._probe = probe
        if tracker_factory is None:
            def tracker_factory() -> Any:
                from vision.tracker import Tracker

                return Tracker()
        self._tracker_factory = tracker_factory
        self._lock = threading.Lock()
        self._watchers: dict[str, _Watcher] = {}
        self._probed: tuple[float, list[str]] = (0.0, [])

    @classmethod
    def from_environment(cls, cameras: list[dict[str, Any]]) -> "LiveCameras":
        detect, reason = load_aga_detector()
        return cls(cameras, detect, reason)

    def status(self) -> dict[str, Any]:
        return {"model_ready": self._detect is not None, "model": MODEL_NAME, "reason": self._reason}

    def live_ids(self, now: Optional[float] = None) -> list[str]:
        """Camera ids whose stream answers right now (cached for PROBE_TTL_S)."""
        now = time.time() if now is None else now
        with self._lock:
            stamp, ids = self._probed
        if ids and now - stamp < PROBE_TTL_S:
            return ids
        with ThreadPoolExecutor(max_workers=6) as pool:
            alive = list(pool.map(self._probe, self._cameras))
        ids = [cid for cid, ok in zip(self._cameras, alive) if ok]
        with self._lock:
            self._probed = (now, ids)
        return ids

    def cameras(self) -> list[dict[str, Any]]:
        if self._detect is None:  # no AGA here (e.g. the hosted build): listing cameras would only slow the answer
            return []
        live = set(self.live_ids())
        return [{"id": c["id"], "name": c["name"], "lnglat": c["lnglat"]} for c in self._cameras.values() if c["id"] in live]

    def watch(self, camera_id: str) -> str:
        """Starts (or keeps) analysing a camera. Returns "started" | "running"; raises KeyError/RuntimeError."""
        if camera_id not in self._cameras:
            raise KeyError(camera_id)
        if self._detect is None:
            raise RuntimeError(self._reason or "the AGA model is not available on this machine")
        with self._lock:
            w = self._watchers.get(camera_id)
            if w is not None and w.is_alive() and not w.stop.is_set():
                w.last_poll = time.time()
                return "running"
            self._watchers = {k: v for k, v in self._watchers.items() if v.is_alive() and not v.stop.is_set()}
            if len(self._watchers) >= MAX_WATCHERS:
                raise OverflowError(f"at most {MAX_WATCHERS} cameras can be analysed at once")
            w = _Watcher(camera_id, self._detect, self._source, self._tracker_factory)
            self._watchers[camera_id] = w
        w.start()
        return "started"

    def observation(self, camera_id: str) -> Optional[dict[str, Any]]:
        """Latest result for a watched camera, or None if it is not being watched."""
        with self._lock:
            w = self._watchers.get(camera_id)
        if w is None:
            return None
        w.last_poll = time.time()
        state = w.snapshot()
        if state is None:
            return {"camera_id": camera_id, "source": "live", "model": MODEL_NAME, "camera_state": "connecting",
                    "objects": [], "counts": {c: 0 for c in VEHICLE_CLASSES}, "problem": None}
        age = time.time() - state.get("t", 0) if "t" in state else None
        state = dict(state)
        state["camera_state"] = "live" if age is not None and age <= STALE_S else "offline"
        state.pop("t", None)
        return state

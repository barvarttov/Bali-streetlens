"""AGA without torch: the same detector, exported to ONNX, run with onnxruntime + numpy.

Used where torch is not installed, in particular the hosted site (Vercel), so the public map gets real AGA
counts even when the vision machine is off. models/AGA_Model_cctv6.onnx is exported from AGA_Model_cctv6.pt by
tools/export_aga_onnx.py; the graph already applies the sigmoid and the 3x3 peak picking of aga/decode.py, so
this file only does letterboxing, top-k and box maths (the same numbers as aga/infer.py + aga/decode.py).

Frames come from `grab_frame`: the newest ~2.5 s fMP4 segment of a camera's HLS stream, decoded with PyAV.
Only its first frame is used and nothing is stored; only boxes and classes leave this module.
"""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
ONNX_WEIGHTS = ROOT / "models" / "AGA_Model_cctv6.onnx"
STREAM = "https://transcode.baliprov.go.id/cctv/{ch}/index.m3u8"
UA = {"User-Agent": "BaliStreetLens-student-project"}
PAD = 114
TOP_K = 100
MAX_SEGMENT_BYTES = 8_000_000  # a 2.5 s 1080p segment is ~0.6 MB; refuse anything absurd


def letterbox_rgb(rgb: np.ndarray, size: int) -> tuple[np.ndarray, float, int, int]:
    """Same geometry as aga.data.letterbox (grey 114 padding, centred), for an RGB array."""
    h, w = rgb.shape[:2]
    r = size / max(h, w)
    nh, nw = max(1, round(h * r)), max(1, round(w * r))
    try:
        import cv2

        resized = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_AREA if r < 1 else cv2.INTER_LINEAR)
    except ImportError:  # hosted build: no OpenCV, PyAV's swscale does the same resize
        import av

        frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(rgb), format="rgb24")
        resized = frame.reformat(width=nw, height=nh, format="rgb24", interpolation="AREA" if r < 1 else "BILINEAR").to_ndarray()
    canvas = np.full((size, size, 3), PAD, np.uint8)
    px, py = (size - nw) // 2, (size - nh) // 2
    canvas[py:py + nh, px:px + nw] = resized
    return canvas, r, px, py


def decode(heat: np.ndarray, wh: np.ndarray, off: np.ndarray, stride: int, conf: float) -> list[tuple[list[float], float, int]]:
    """numpy port of aga.decode.decode for one image whose heatmap is already sigmoid + peak-picked."""
    c, h, w = heat.shape
    flat = heat.reshape(-1)
    k = min(TOP_K, flat.size)
    idx = np.argpartition(-flat, k - 1)[:k]
    idx = idx[np.argsort(-flat[idx], kind="stable")]
    idx = idx[flat[idx] >= conf]
    cls = idx // (h * w)
    pix = idx % (h * w)
    ys, xs = (pix // w).astype(np.float32), (pix % w).astype(np.float32)
    bw = np.exp(np.minimum(wh[0].reshape(-1)[pix], 8))
    bh = np.exp(np.minimum(wh[1].reshape(-1)[pix], 8))
    cx, cy = xs + off[0].reshape(-1)[pix], ys + off[1].reshape(-1)[pix]
    boxes = np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], axis=1) * stride
    return [(b.tolist(), float(flat[i]), int(ci)) for b, i, ci in zip(boxes, idx, cls)]


def load_onnx_detector(conf: float) -> tuple[Optional[Callable[[np.ndarray], list[dict[str, Any]]]], Optional[str]]:
    """detect(rgb frame) -> [{"cls", "conf", "bbox_px"}] in frame pixels, or (None, reason)."""
    try:
        import onnxruntime as ort
    except Exception as err:
        return None, f"AGA needs torch or onnxruntime ({type(err).__name__}: {err})"
    if not ONNX_WEIGHTS.exists():
        return None, f"weights not found: {ONNX_WEIGHTS.name}"
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1  # the hosted function has one vCPU
    opts.inter_op_num_threads = 1
    session = ort.InferenceSession(str(ONNX_WEIGHTS), opts, providers=["CPUExecutionProvider"])
    meta = json.loads(session.get_modelmeta().custom_metadata_map["aga_config"])
    size, stride, classes = meta["input_size"], meta["stride"], meta["classes"]

    def detect(rgb: np.ndarray) -> list[dict[str, Any]]:
        canvas, r, px, py = letterbox_rgb(rgb, size)
        x = (canvas.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        heat, wh, off = session.run(None, {"image": x})
        out = []
        for (x1, y1, x2, y2), score, ci in decode(heat[0], wh[0], off[0], stride, conf):
            out.append({"cls": classes[ci], "conf": score,
                        "bbox_px": [(x1 - px) / r, (y1 - py) / r, (x2 - px) / r, (y2 - py) / r]})
        return out

    return detect, None


def _get(url: str, timeout: float, limit: int = 200_000) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ValueError("response too large")
    return data


def _uris(playlist: str) -> list[str]:
    return [line.strip() for line in playlist.splitlines() if line.strip() and not line.startswith("#")]


def grab_frame(camera_id: str, timeout: float = 8.0) -> np.ndarray:
    """The first frame (RGB) of the newest complete segment of a camera's stream.

    The camera id must already be checked against config/cameras.json; every URL fetched here is the
    provincial stream server's, built from that id and the server's own playlists (same host only)."""
    import av

    master_url = STREAM.format(ch=camera_id)
    master = _get(master_url, timeout).decode("utf-8", "replace")
    media_url = urllib.parse.urljoin(master_url, _uris(master)[0]) if "#EXT-X-STREAM-INF" in master else master_url
    media = master if media_url == master_url else _get(media_url, timeout).decode("utf-8", "replace")
    segments = _uris(media)
    if not segments:
        raise ValueError("playlist has no segments")
    init = re.search(r'#EXT-X-MAP:URI="([^"]+)"', media)
    host = urllib.parse.urlsplit(master_url).netloc
    urls = ([urllib.parse.urljoin(media_url, init.group(1))] if init else []) + [urllib.parse.urljoin(media_url, segments[-1])]
    if any(urllib.parse.urlsplit(u).netloc != host for u in urls):
        raise ValueError("playlist points to another host")
    data = b"".join(_get(u, timeout, MAX_SEGMENT_BYTES) for u in urls)
    import io

    with av.open(io.BytesIO(data)) as container:
        for frame in container.decode(video=0):
            return frame.to_ndarray(format="rgb24")
    raise ValueError("segment had no video frame")

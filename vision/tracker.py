"""A small ByteTrack-style multi-object tracker (our own code, works with any detector).

Idea from ByteTrack (Zhang et al. 2022): match confident detections to existing tracks first, then
let low-confidence detections rescue tracks that are still unmatched, and only start NEW tracks
from confident detections. Association is by IoU against each track's linearly predicted box.

IDs are temporary and only meaningful inside one clip. A track that is lost for more than
`max_missed` processed frames is deleted: we never keep drawing a ghost.
"""
from typing import List, NamedTuple, Tuple

import numpy as np
from scipy.optimize import linear_sum_assignment


class Det(NamedTuple):
    box: np.ndarray  # xyxy, pixels
    conf: float
    cls: str


class Track:
    def __init__(self, track_id: int, box: np.ndarray):
        self.id = track_id
        self.box = box.astype(float)
        self.vel = np.zeros(4)  # per processed frame
        self.missed = 0

    def predicted(self) -> np.ndarray:
        return self.box + self.vel * (self.missed + 1)


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)))
    ix = np.clip(np.minimum(a[:, None, 2], b[None, :, 2]) - np.maximum(a[:, None, 0], b[None, :, 0]), 0, None)
    iy = np.clip(np.minimum(a[:, None, 3], b[None, :, 3]) - np.maximum(a[:, None, 1], b[None, :, 1]), 0, None)
    inter = ix * iy
    area_a = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1])
    area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / np.maximum(area_a[:, None] + area_b[None, :] - inter, 1e-9)


def associate(tracks: List[Track], boxes: np.ndarray, min_iou: float) -> Tuple[List[Tuple[int, int]], List[int], List[int]]:
    """Optimal one-to-one matching on IoU. Returns (pairs of (track idx, det idx), free tracks, free dets)."""
    if not tracks or len(boxes) == 0:
        return [], list(range(len(tracks))), list(range(len(boxes)))
    iou = iou_matrix(np.array([t.predicted() for t in tracks]), boxes)
    rows, cols = linear_sum_assignment(1.0 - iou)
    pairs = [(r, c) for r, c in zip(rows, cols) if iou[r, c] >= min_iou]
    used_r, used_c = {r for r, _ in pairs}, {c for _, c in pairs}
    return pairs, [i for i in range(len(tracks)) if i not in used_r], [j for j in range(len(boxes)) if j not in used_c]


class Tracker:
    def __init__(self, high=0.4, low=0.1, iou_high=0.3, iou_low=0.5, max_missed=15):
        self.high, self.low, self.iou_high, self.iou_low, self.max_missed = high, low, iou_high, iou_low, max_missed
        self.tracks: List[Track] = []
        self._next_id = 1

    def _hit(self, track: Track, box: np.ndarray):
        steps = track.missed + 1
        track.vel = 0.5 * track.vel + 0.5 * (box - track.box) / steps
        track.box, track.missed = box.astype(float), 0

    def update(self, dets: List[Det]) -> List[Tuple[int, int]]:
        """Feed one processed frame. Returns [(track_id, detection index)] for detections matched or started."""
        boxes = np.array([d.box for d in dets], float).reshape(-1, 4)
        hi = [i for i, d in enumerate(dets) if d.conf >= self.high]
        lo = [i for i, d in enumerate(dets) if self.low <= d.conf < self.high]
        out: List[Tuple[int, int]] = []

        pairs, free_tracks, free_hi = associate(self.tracks, boxes[hi], self.iou_high)
        for t_idx, d_idx in pairs:
            self._hit(self.tracks[t_idx], boxes[hi[d_idx]])
            out.append((self.tracks[t_idx].id, hi[d_idx]))

        remaining = [self.tracks[i] for i in free_tracks]
        pairs2, still_free, _ = associate(remaining, boxes[lo], self.iou_low)
        for t_idx, d_idx in pairs2:
            self._hit(remaining[t_idx], boxes[lo[d_idx]])
            out.append((remaining[t_idx].id, lo[d_idx]))
        for i in still_free:
            remaining[i].missed += 1

        for j in free_hi:  # only confident detections may start a track
            track = Track(self._next_id, boxes[hi[j]])
            self._next_id += 1
            self.tracks.append(track)
            out.append((track.id, hi[j]))

        self.tracks = [t for t in self.tracks if t.missed <= self.max_missed]
        return out

"""Tests for live AGA analysis with a fake detector and a fake camera.
Run from the repo root: .venv/Scripts/python -m unittest backend.test_aga_live"""

import json
import time
import unittest
from pathlib import Path

import numpy as np

from backend import aga_live

CAMERAS = json.loads((Path(__file__).resolve().parent.parent / "config" / "cameras.json").read_text(encoding="utf-8"))["cameras"]
CAM = CAMERAS[0]["id"]


class _FakeTracker:
    """Gives every detection a stable id equal to its index, like a tracker that matched everything."""

    def update(self, dets):
        return [(i + 1, i) for i in range(len(dets))]


def _frames(_camera_id):
    for _ in range(1000):
        yield np.zeros((720, 1280, 3), np.uint8)
        time.sleep(0.01)


def _detect(_frame):
    return [
        {"cls": "motorcycle", "conf": 0.9, "bbox_px": [100.0, 200.0, 140.0, 280.0]},
        {"cls": "car", "conf": 0.8, "bbox_px": [400.0, 300.0, 600.0, 420.0]},
        {"cls": "person", "conf": 0.9, "bbox_px": [10.0, 10.0, 20.0, 40.0]},  # must never be reported
    ]


def make(**kw):
    args = dict(detect=_detect, source=_frames, probe=lambda c: True, tracker_factory=_FakeTracker)
    args.update(kw)
    return aga_live.LiveCameras(CAMERAS, **args)


def wait_for(fn, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.02)
    return None


class LiveCamerasTest(unittest.TestCase):
    def test_only_live_cameras_are_listed(self):
        live_one = {CAM}
        cams = make(probe=lambda c: c in live_one)
        self.assertEqual([c["id"] for c in cams.cameras()], [CAM])

    def test_unknown_camera_is_refused_and_never_probed_as_url(self):
        cams = make()
        with self.assertRaises(KeyError):
            cams.watch("../../etc/passwd")

    def test_model_missing_is_a_clear_error(self):
        cams = make(detect=None, reason="no torch")
        self.assertFalse(cams.status()["model_ready"])
        with self.assertRaises(RuntimeError):
            cams.watch(CAM)

    def test_watch_produces_observations_without_persons(self):
        cams = make()
        try:
            self.assertEqual(cams.watch(CAM), "started")
            self.assertEqual(cams.watch(CAM), "running")
            obs = wait_for(lambda: (lambda o: o if o and o.get("objects") else None)(cams.observation(CAM)))
            self.assertIsNotNone(obs)
            self.assertEqual(obs["camera_state"], "live")
            self.assertEqual(obs["frame_size"], [1280, 720])
            self.assertEqual({o["cls"] for o in obs["objects"]}, {"motorcycle", "car"})
            moto = next(o for o in obs["objects"] if o["cls"] == "motorcycle")
            self.assertEqual(moto["ground_px"], [120.0, 280.0])  # bottom-center, as in docs/schema.md
            self.assertEqual(obs["counts"]["motorcycle"], 1)
            self.assertNotIn("t", obs)
        finally:
            cams._watchers[CAM].stop.set()

    def test_not_watched_returns_none(self):
        self.assertIsNone(make().observation(CAM))

    def test_at_most_max_watchers(self):
        cams = make()
        ids = [c["id"] for c in CAMERAS[: aga_live.MAX_WATCHERS + 1]]
        try:
            for cid in ids[:-1]:
                cams.watch(cid)
            with self.assertRaises(OverflowError):
                cams.watch(ids[-1])
        finally:
            for w in cams._watchers.values():
                w.stop.set()

    def test_stream_that_never_delivers_reports_a_problem(self):
        cams = make(source=lambda c: iter(()))
        try:
            cams.watch(CAM)
            obs = wait_for(lambda: (lambda o: o if o and o.get("problem") else None)(cams.observation(CAM)))
            self.assertIsNotNone(obs)
            self.assertEqual(obs["camera_state"], "offline")
            self.assertEqual(obs["objects"], [])
        finally:
            cams._watchers[CAM].stop.set()


if __name__ == "__main__":
    unittest.main()

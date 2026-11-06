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

    def test_old_list_is_served_while_a_new_one_is_probed(self):
        calls = []
        cams = make(probe=lambda c: calls.append(c) or True)
        first = cams.live_ids(now=1000.0)
        n = len(calls)
        stale = cams.live_ids(now=1000.0 + aga_live.PROBE_TTL_S + 1)  # expired: must answer at once with the old list
        self.assertEqual(stale, first)
        wait_for(lambda: len(calls) > n)
        self.assertGreater(len(calls), n)

    def test_unknown_camera_is_refused_and_never_probed_as_url(self):
        cams = make()
        with self.assertRaises(KeyError):
            cams.watch("../../etc/passwd")

    def test_no_model_lists_no_cameras_and_never_probes(self):
        def boom(_c):
            raise AssertionError("must not probe without a model")

        self.assertEqual(make(detect=None, reason="no torch", probe=boom).cameras(), [])

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


class OnDemandTest(unittest.TestCase):
    """Without torch (the hosted site): one fresh frame per refresh, no threads, and a CPU budget."""

    def make(self, **kw):
        self.grabs = []

        def grab(cid):
            self.grabs.append(cid)
            return np.zeros((1080, 1920, 3), np.uint8)

        return make(grab=grab, **kw)

    def test_watch_needs_no_thread_and_poll_analyses_once_per_refresh(self):
        cams = self.make()
        self.assertEqual(cams.watch(CAM), "running")
        self.assertEqual(cams._watchers, {})
        obs = cams.observation(CAM)
        self.assertEqual(obs["camera_state"], "live")
        self.assertEqual(obs["frame_size"], [1920, 1080])
        self.assertEqual({o["cls"] for o in obs["objects"]}, {"motorcycle", "car"})  # never the person
        self.assertEqual(obs["refresh_s"], aga_live.REFRESH_S)
        self.assertNotIn("t", obs)
        cams.observation(CAM)
        self.assertEqual(len(self.grabs), 1)  # within REFRESH_S the cached result is served

    def test_any_known_camera_can_be_polled_without_watch(self):
        cams = self.make()
        self.assertIsNotNone(cams.observation(CAM))  # the poll may reach another server instance than the watch
        self.assertIsNone(cams.observation("../../etc/passwd"))
        self.assertEqual(self.grabs, [CAM])

    def test_same_vehicle_keeps_its_id(self):
        cams = self.make()
        first = cams.observation(CAM)
        cams._results[CAM]["t"] -= aga_live.REFRESH_S + 1
        second = cams.observation(CAM)
        self.assertEqual(len(self.grabs), 2)
        ids = lambda o: {x["cls"]: x["track_id"] for x in o["objects"]}  # noqa: E731
        self.assertEqual(ids(first), ids(second))

    def test_budget_stops_analysis_but_keeps_answering(self):
        cams = self.make()
        cams._spent = [time.time()] * aga_live.MAX_PER_HOUR
        obs = cams.observation(CAM)
        self.assertEqual(self.grabs, [])
        self.assertEqual(obs["camera_state"], "offline")
        self.assertIn("batas analisis", obs["problem"])

    def test_a_broken_stream_is_reported_not_raised(self):
        def grab(_cid):
            raise TimeoutError("stream timed out")

        obs = make(grab=grab).observation(CAM)
        self.assertEqual(obs["camera_state"], "offline")
        self.assertEqual(obs["objects"], [])
        self.assertIn("TimeoutError", obs["problem"])

    def test_match_ids_by_overlap_and_class(self):
        prev = [{"track_id": 7, "cls": "car", "bbox_px": [0, 0, 10, 10]}]
        dets = [{"cls": "car", "bbox_px": [1, 1, 11, 11]}, {"cls": "motorcycle", "bbox_px": [0, 0, 10, 10]}]
        ids, nxt = aga_live._match_ids(prev, dets, 20)
        self.assertEqual(ids, [7, 20])
        self.assertEqual(nxt, 21)


class OnnxDecodeTest(unittest.TestCase):
    def test_decode_matches_the_torch_decoder_maths(self):
        from backend.aga_onnx import decode

        heat = np.zeros((4, 8, 8), np.float32)
        heat[1, 2, 3] = 0.9  # a car centred at cell (x=3, y=2)
        heat[0, 5, 5] = 0.1  # below the threshold
        wh = np.zeros((2, 8, 8), np.float32)
        wh[:, 2, 3] = np.log(2.0)  # 2 x 2 cells
        off = np.zeros((2, 8, 8), np.float32)
        off[:, 2, 3] = 0.5
        out = decode(heat, wh, off, stride=4, conf=0.3)
        self.assertEqual(len(out), 1)
        box, score, cls = out[0]
        self.assertEqual(cls, 1)
        self.assertAlmostEqual(score, 0.9, places=5)
        np.testing.assert_allclose(box, [10.0, 6.0, 18.0, 14.0], atol=1e-5)  # centre (3.5, 2.5) cells * 4


if __name__ == "__main__":
    unittest.main()

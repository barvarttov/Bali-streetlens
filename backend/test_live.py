"""Tests for the synthetic live feed. Run from the repo root: .venv\\Scripts\\python -m unittest backend.test_live"""

import json
import unittest
from pathlib import Path

from backend import live

CORRIDOR = json.loads((Path(__file__).resolve().parent.parent / "config" / "corridor.json").read_text(encoding="utf-8"))
NOON = 1_793_664_000.0  # a fixed instant, so every run sees the same scenario


class SyntheticLiveTest(unittest.TestCase):
    def test_deterministic(self):
        self.assertEqual(live.snapshot(CORRIDOR, NOON), live.snapshot(CORRIDOR, NOON))

    def test_shape_and_history(self):
        snap = live.snapshot(CORRIDOR, NOON)
        self.assertEqual(snap["source"], "synthetic")
        self.assertEqual({j["id"] for j in snap["junctions"]}, {j["id"] for j in CORRIDOR["junctions"]})
        for j in snap["junctions"]:
            self.assertEqual(len(j["history"]), live.HISTORY_MINUTES)

    def test_junction_label_is_worst_approach(self):
        for minute in range(0, 120, 7):
            for j in live.snapshot(CORRIDOR, NOON + minute * 60)["junctions"]:
                if j["camera_state"] == "offline":
                    continue
                worst = max((a["label"] for a in j["approaches"]), key=live.LABEL_RANK.__getitem__)
                self.assertEqual(j["label"], worst)
                self.assertEqual(j["history"][-1], j["label"])  # the last history minute is now

    def test_offline_camera_is_honest(self):
        found = False
        for minute in range(0, 60):
            for j in live.snapshot(CORRIDOR, NOON + minute * 60)["junctions"]:
                if j["camera_state"] == "offline":
                    found = True
                    self.assertEqual(j["label"], "unknown")
                    self.assertEqual(j["approaches"], [])
                    self.assertIsNone(j["why"])
                    self.assertEqual(j["history"][-1], "none")
        self.assertTrue(found, "the scenario should include an offline camera within an hour")

    def test_macet_means_sustained_queue(self):
        for minute in range(0, 120):
            for j in live.snapshot(CORRIDOR, NOON + minute * 60)["junctions"]:
                for a in j["approaches"]:
                    if a["label"] == "macet":
                        self.assertGreaterEqual(a["stopped"], live.MIN_VEHICLES)
                        self.assertGreaterEqual(a["stopped_for_s"], live.SUSTAINED_AFTER_S)
                        self.assertGreater(a["flow_per_min"], 0)  # still crossing: not a red light
                    if a["label"] == "padat":
                        # The "why" view says the queue hasn't lasted SUSTAINED_AFTER_S; the numbers must agree.
                        self.assertLess(a["stopped_for_s"], live.SUSTAINED_AFTER_S)


if __name__ == "__main__":
    unittest.main()

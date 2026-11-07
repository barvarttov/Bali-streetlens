"""The nearest road for an uncalibrated camera: a line through the road's nearest point, main roads preferred.
Run from the repo root: .venv/Scripts/python -m unittest backend.test_camera_road"""

import math
import os
import unittest

os.environ.setdefault("AGA_ONNX", "0")

from fastapi.testclient import TestClient

from backend.main import ROADS_FILE, app


def meters(a, b):
    k = math.cos(math.radians(a[1]))
    return math.hypot((b[0] - a[0]) * 111320 * k, (b[1] - a[1]) * 110540)


@unittest.skipUnless(ROADS_FILE.is_file(), "needs config/roads.json.gz")
class CameraRoad(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_catus_pata_lies_on_a_main_road(self):
        r = self.client.get("/api/cameras/catus-pata/road")
        self.assertEqual(r.status_code, 200)
        road = r.json()
        self.assertIn(road["class"], ("primary", "secondary", "trunk", "tertiary"))
        self.assertLess(road["distance_m"], 30)
        line = road["line"]
        self.assertGreaterEqual(len(line), 2)
        self.assertEqual(line[road["snap_index"]], road["snap"])
        length = sum(meters(a, b) for a, b in zip(line, line[1:]))
        self.assertGreater(length, 60)  # about 70 m each way, less only where the road ends
        self.assertLessEqual(length, 141)

    def test_unknown_camera_is_404(self):
        self.assertEqual(self.client.get("/api/cameras/..etc..passwd/road").status_code, 404)
        self.assertEqual(self.client.get("/api/cameras/no-such-camera/road").status_code, 404)

    def test_beach_camera_far_from_roads_is_404(self):
        self.assertEqual(self.client.get("/api/cameras/pantai-kuta-c05-cctv1/road").status_code, 404)

    def test_route_is_open_through_the_tunnel(self):
        r = self.client.get("/api/cameras/catus-pata/road", headers={"host": "x.trycloudflare.com"})
        self.assertEqual(r.status_code, 200)


if __name__ == "__main__":
    unittest.main()

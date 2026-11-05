"""Tests for the route planner on a small made-up street grid.

Run from the repo root: .venv\\Scripts\\python -m unittest backend.test_routing
"""

import gzip
import json
import tempfile
import unittest
from pathlib import Path

from backend import routing

STEP = 0.002  # ~220 m between grid streets
X0, Y0 = 115.0, -8.5  # the grid's centre junction
N = 5  # 5 × 5 streets


def _grid_file(folder: Path) -> Path:
    nodes: list[int] = []
    edges: list[list] = []
    names = ["", *[f"Jl. Baris {r}" for r in range(N)], *[f"Jl. Lajur {c}" for c in range(N)], "Jl. Pulau"]
    classes = ["residential"]
    idx = lambda r, c: r * N + c  # noqa: E731
    for r in range(N):
        for c in range(N):
            nodes += [round((X0 + (c - 2) * STEP) * 1e6), round((Y0 + (r - 2) * STEP) * 1e6)]
    for r in range(N):
        for c in range(N):
            if c + 1 < N:
                edges.append([idx(r, c), idx(r, c + 1), 2200, 0, 1 + r, 0, []])
            if r + 1 < N:
                edges.append([idx(r, c), idx(r + 1, c), 2200, 0, 1 + N + c, 0, []])
    # A separate square of road far away: an island no road reaches.
    base = len(nodes) // 2
    for dx, dy in [(0, 0), (1, 0), (1, 1), (0, 1)]:
        nodes += [round((X0 + 0.1 + dx * STEP) * 1e6), round((Y0 + dy * STEP) * 1e6)]
    for a, b in [(0, 1), (1, 2), (2, 3), (3, 0)]:
        edges.append([base + a, base + b, 2200, 0, len(names) - 1, 0, []])
    path = folder / "roads.json.gz"
    path.write_bytes(gzip.compress(json.dumps({"classes": classes, "names": names, "nodes": nodes, "edges": edges}).encode()))
    return path


CORRIDOR = {
    "junctions": [
        {
            "id": "tengah",
            "center": [X0, Y0],
            "arms": [
                {"id": "kaja", "bearing": 0},
                {"id": "kangin", "bearing": 90},
                {"id": "kelod", "bearing": 180},
                {"id": "kauh", "bearing": 270},
            ],
        }
    ]
}


def _snapshot(kelod_label: str) -> dict:
    arms = ["kaja", "kangin", "kelod", "kauh"]
    return {
        "junctions": [
            {
                "id": "tengah",
                "camera_state": "live",
                "approaches": [{"arm": a, "label": kelod_label if a == "kelod" else "lancar"} for a in arms],
            }
        ]
    }


class RouterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._old_min = routing.MIN_COMPONENT
        routing.MIN_COMPONENT = 1  # the test grid is tiny
        cls.tmp = tempfile.TemporaryDirectory()
        cls.router = routing.Router(_grid_file(Path(cls.tmp.name)))

    @classmethod
    def tearDownClass(cls):
        routing.MIN_COMPONENT = cls._old_min
        cls.tmp.cleanup()

    south = (X0, Y0 - 2 * STEP)
    north = (X0, Y0 + 2 * STEP)

    def test_straight_route_passes_the_junction_when_clear(self):
        result = self.router.route(self.south, self.north, CORRIDOR, _snapshot("lancar"))
        first = result["routes"][0]
        self.assertAlmostEqual(first["distance_m"], 4 * 220, delta=1)
        self.assertEqual(first["junctions"], [{"id": "tengah", "arm": "kelod"}])
        self.assertEqual(first["via"], "Jl. Lajur 2")
        self.assertEqual(first["geometry"][0], [self.south[0], self.south[1]])
        self.assertEqual(first["geometry"][-1], [self.north[0], self.north[1]])

    def test_jammed_approach_is_avoided_by_the_first_route(self):
        result = self.router.route(self.south, self.north, CORRIDOR, _snapshot("macet"))
        first = result["routes"][0]
        self.assertNotIn({"id": "tengah", "arm": "kelod"}, first["junctions"])
        self.assertGreater(first["distance_m"], 4 * 220)

    def test_alternatives_are_different_and_not_much_longer(self):
        result = self.router.route((X0 - 2 * STEP, Y0 - 2 * STEP), (X0 + 2 * STEP, Y0 + 2 * STEP), CORRIDOR, _snapshot("lancar"))
        routes = result["routes"]
        self.assertGreaterEqual(len(routes), 2)
        self.assertLessEqual(len(routes), routing.MAX_ROUTES)
        geoms = [{tuple(p) for p in r["geometry"]} for r in routes]
        for i in range(len(geoms)):
            for j in range(i + 1, len(geoms)):
                self.assertNotEqual(geoms[i], geoms[j])
        self.assertTrue(all(r["distance_m"] <= routes[0]["distance_m"] * routing.MAX_STRETCH for r in routes))
        self.assertTrue(all(len(r["waypoints"]) == 2 for r in routes))

    def test_unreachable_island(self):
        with self.assertRaises(routing.RouteError) as ctx:
            self.router.route(self.south, (X0 + 0.1, Y0), CORRIDOR, _snapshot("lancar"))
        self.assertEqual(ctx.exception.code, "no_road")

    def test_far_from_any_road(self):
        with self.assertRaises(routing.RouteError) as ctx:
            self.router.route(self.south, (X0 - 0.2, Y0 - 0.2), CORRIDOR, _snapshot("lancar"))
        self.assertEqual(ctx.exception.code, "far_from_road")


if __name__ == "__main__":
    unittest.main()

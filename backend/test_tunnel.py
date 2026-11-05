"""The public tunnel exposes only the live-camera routes, and only the project's own sites may call them.
Run from the repo root: .venv/Scripts/python -m unittest backend.test_tunnel"""

import unittest

from fastapi.testclient import TestClient

from backend.main import app

TUNNEL = {"host": "random-words.trycloudflare.com"}


class TunnelGuard(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_live_routes_pass_through_the_tunnel(self):
        r = self.client.get("/api/live/cameras", headers=TUNNEL)
        self.assertEqual(r.status_code, 200)

    def test_other_routes_are_hidden_behind_the_tunnel(self):
        for path in ("/api/clips", "/api/assistant", "/api/cameras", "/api/cameras/x/observations"):
            self.assertEqual(self.client.get(path, headers=TUNNEL).status_code, 404, path)
        # the same request from inside (no tunnel header) is not blocked by the guard
        self.assertNotEqual(self.client.get("/api/clips").status_code, 404)

    def test_cloudflare_header_alone_also_counts_as_tunnel(self):
        r = self.client.get("/api/clips", headers={"cf-connecting-ip": "203.0.113.9"})
        self.assertEqual(r.status_code, 404)

    def test_only_project_sites_get_cors(self):
        ok = self.client.get("/api/live/cameras", headers={"origin": "https://bali-streetlens.vercel.app"})
        self.assertEqual(ok.headers.get("access-control-allow-origin"), "https://bali-streetlens.vercel.app")
        bad = self.client.get("/api/live/cameras", headers={"origin": "https://evil.example.com"})
        self.assertIsNone(bad.headers.get("access-control-allow-origin"))


if __name__ == "__main__":
    unittest.main()

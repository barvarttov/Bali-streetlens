"""The app's HTML answers page routes, never a missing script: a stale build hash after a deploy must be a 404,
or the browser runs HTML as JavaScript and the page stays white.
Run from the repo root: .venv/Scripts/python -m unittest backend.test_spa"""

import os
import unittest

os.environ.setdefault("AGA_ONNX", "0")

from fastapi.testclient import TestClient

from backend.main import WEB_DIST, app


@unittest.skipUnless((WEB_DIST / "index.html").is_file(), "needs web/dist (npm run build)")
class SpaFallback(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_page_routes_get_the_app(self):
        for path in ("/", "/kamera/catus-pata", "/simpang/patung-kuda", "/langsung/x"):
            r = self.client.get(path)
            self.assertEqual(r.status_code, 200, path)
            self.assertIn("text/html", r.headers["content-type"], path)

    def test_missing_script_is_a_real_404(self):
        for path in ("/assets/index-oldhash.js", "/assets/PublicApp-gone.js", "/missing.css"):
            r = self.client.get(path)
            self.assertEqual(r.status_code, 404, path)
            self.assertNotIn("text/html", r.headers.get("content-type", ""), path)


if __name__ == "__main__":
    unittest.main()
